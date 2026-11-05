import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Recorder, SEGMENT_FILE, buildRecordArgs, listSegments, pruneSegments, segmentStart } from '../src/services/srt/recorder.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pulse-rec-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const touch = (name, ageMs, bytes = 10) => {
  const file = join(dir, name);
  writeFileSync(file, Buffer.alloc(bytes));
  const t = new Date(Date.now() - ageMs);
  utimesSync(file, t, t);
};

describe('recording segments', () => {
  it('copies the stream into timed segment files without re-encoding', () => {
    const args = buildRecordArgs('/rec/ch1', 600);
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('copy');
    expect(args[args.indexOf('-segment_time') + 1]).toBe('600');
    expect(args).toContain('-strftime');
    expect(args.at(-1)).toMatch(/%Y%m%d_%H%M%S\.ts$/);
  });

  it('only accepts its own file names (no path tricks)', () => {
    expect(SEGMENT_FILE.test('20261103_143000.ts')).toBe(true);
    for (const bad of ['../x.ts', '20261103_143000.ts/..', 'a.ts', '20261103_143000.mp4', '']) expect(SEGMENT_FILE.test(bad)).toBe(false);
  });

  it('reads the start time from the name', () => {
    expect(segmentStart('20261103_143005.ts')).toBe(new Date(2026, 10, 3, 14, 30, 5).getTime());
    expect(segmentStart('nope.ts')).toBeNull();
  });

  it('lists segments newest first and ignores other files', () => {
    touch('20261103_140000.ts', 0, 100);
    touch('20261103_141000.ts', 0, 200);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const list = listSegments(dir);
    expect(list.map((s) => s.name)).toEqual(['20261103_141000.ts', '20261103_140000.ts']);
    expect(list[0].size).toBe(200);
  });

  it('treats a missing folder as empty', () => {
    expect(listSegments(join(dir, 'nothing'))).toEqual([]);
  });

  it('deletes only segments older than the keep time', () => {
    mkdirSync(dir, { recursive: true });
    touch('20261101_100000.ts', 25 * 3600_000);
    touch('20261103_100000.ts', 1 * 3600_000);
    expect(pruneSegments(dir, 24 * 3600_000)).toBe(1);
    expect(listSegments(dir).map((s) => s.name)).toEqual(['20261103_100000.ts']);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('recorder with a real ffmpeg', () => {
  /** Plays a small test stream into the recorder for `seconds` and returns once ffmpeg has finished the files. */
  const record = (segmentSec, seconds) =>
    new Promise((resolve) => {
      const logs = [];
      const rec = new Recorder({ ffmpegPath: 'ffmpeg', dir, segmentSec, keepHours: 24, onLog: (l) => logs.push(l) });
      rec.start();
      const src = spawn(
        'ffmpeg',
        ['-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
          '-t', String(seconds), '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      src.stdout.on('data', (c) => rec.write(c));
      src.on('close', () => {
        rec.stop();
        setTimeout(() => resolve({ logs, active: rec.active }), 3500);
      });
    });

  // ffmpeg reads about 5 s of the feed to probe it and then writes that burst at once, and files are named by the
  // second they are opened. The app's shortest segment is 5 minutes, so these tests use one long segment.
  it('writes a playable transport-stream file that holds the whole feed', async () => {
    const { logs, active } = await record(300, 8);
    const files = listSegments(dir);
    expect(files).toHaveLength(1);
    expect(logs).toEqual([]);
    expect(active).toBe(false);
    const [f] = files;
    expect(f.size).toBeGreaterThan(100_000);
    // Every MPEG-TS packet starts with the sync byte 0x47.
    const head = readFileSync(join(dir, f.name)).subarray(0, 188 * 4);
    expect([0, 188, 376, 564].map((i) => head[i])).toEqual([0x47, 0x47, 0x47, 0x47]);
    // Stopping closes the file properly: nothing of the 8 s feed is lost.
    if (hasFfprobe) {
      const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(dir, f.name)]);
      expect(Number(String(out.stdout).trim())).toBeGreaterThan(7);
    }
  }, 30_000);

  it('can be stopped and started again without mixing up files', async () => {
    await record(60, 3);
    const first = listSegments(dir).length;
    await new Promise((r) => setTimeout(r, 1100));
    await record(60, 3);
    expect(listSegments(dir).length).toBe(first + 1);
  }, 30_000);
});
