import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';


/** Segment files are named by their start time (server local time), e.g. 20261103_143000.ts. */
export const SEGMENT_FILE = /^\d{8}_\d{6}\.ts$/;
/** Old segments are looked for this often while recording. */
const PRUNE_MS = 60_000;
/** The recorder is a side job: if ffmpeg falls this far behind, bytes are dropped rather than queued without limit. */
const MAX_QUEUE = 8 * 1024 * 1024;
/** Time ffmpeg gets to finish the last segment after its input is closed. */
const FINISH_MS = 3000;

/**
 * ffmpeg arguments that copy the incoming transport stream (nothing is re-encoded) into files of about
 * `segmentSec` seconds. Cuts happen on the first keyframe after that time, so a file is a little longer than asked.
 * Exported for tests.
 */
export function buildRecordArgs(dir, segmentSec) {
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-loglevel',
    'error',
    '-fflags',
    '+genpts',
    '-f',
    'mpegts',
    '-i',
    'pipe:0',
    '-map',
    '0',
    '-c',
    'copy',
    '-ignore_unknown',
    '-f',
    'segment',
    '-segment_time',
    String(segmentSec),
    '-reset_timestamps',
    '1',
    '-strftime',
    '1',
    join(dir, '%Y%m%d_%H%M%S.ts'),
  ];
}

/** Start time of a segment from its file name. */
export function segmentStart(name) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.ts$/.exec(name);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

/** The segments in `dir`, newest first. A missing folder is an empty list. */
export function listSegments(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => SEGMENT_FILE.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const st = statSync(join(dir, name));
      out.push({ name, size: st.size, startAt: segmentStart(name) ?? Math.round(st.birthtimeMs), modifiedAt: Math.round(st.mtimeMs) });
    } catch {
      /* removed meanwhile */
    }
  }
  return out.sort((a, b) => b.startAt - a.startAt);
}

/** Deletes segments whose last write is older than `keepMs`. Returns how many went. */
export function pruneSegments(dir, keepMs, now = Date.now()) {
  let removed = 0;
  for (const s of listSegments(dir)) {
    if (now - s.modifiedAt <= keepMs) continue;
    try {
      rmSync(join(dir, s.name), { force: true });
      removed++;
    } catch {
      /* in use or already gone */
    }
  }
  return removed;
}

/** One ffmpeg that writes the bytes it is fed into timed segment files. */
export class Recorder {
  opts;
  proc = null;
  timer = null;
  error = null;
  constructor(opts) {
    this.opts = opts;
  }
  get active() {
    return this.proc !== null;
  }
  start() {
    if (this.proc) return;
    const { ffmpegPath, dir, segmentSec, keepHours, onLog, onExit, onSpawn } = this.opts;
    this.error = null;
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.error = `Cannot create the recordings folder: ${err instanceof Error ? err.message : err}`;
      onLog?.(this.error);
      onExit?.();
      return;
    }
    const keepMs = keepHours * 3600_000;
    pruneSegments(dir, keepMs);
    const p = spawn(ffmpegPath, buildRecordArgs(dir, segmentSec), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    this.proc = p;
    onSpawn?.(p);
    p.stdin.on('error', () => undefined);
    createInterface({ input: p.stderr }).on('line', (line) => {
      this.error = line;
      onLog?.(line);
    });
    p.on('error', (err) => {
      this.error = `Could not start ffmpeg: ${err.message}`;
      onLog?.(this.error);
    });
    p.on('close', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      onLog?.(`recorder stopped unexpectedly${code ? ` (code ${code})` : ''}`);
      onExit?.();
    });
    this.timer = setInterval(() => pruneSegments(dir, keepMs), PRUNE_MS);
    this.timer.unref();
  }
  write(chunk) {
    const s = this.proc?.stdin;
    if (s?.writable && s.writableLength < MAX_QUEUE) s.write(chunk);
  }
  /** Ends the input so ffmpeg can close the last segment properly, and kills it if it does not. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    p.removeAllListeners('close');
    p.stdin?.end();
    setTimeout(() => p.kill(), FINISH_MS).unref();
  }
}
