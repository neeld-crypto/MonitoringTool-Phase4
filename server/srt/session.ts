import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { constants, setPriority } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import type { HlsInfo, LinkStats, ScteMessage, SessionState, SrtConfig, SrtSnapshot } from '../../src/srt/types.ts';
import { HlsProbe, type StreamCue } from './hls-probe.ts';
import { AvDetector, SILENCE_MIN_SEC, SILENCE_NOISE_DB, friendlyError } from './av-detect.ts';
import { parseLinkStats } from './link-stats.ts';
import { TsAnalyzer } from './ts-analyzer.ts';

export const PREVIEW_PATH = '/__srt/hls/';

export interface SessionOptions {
  ffmpegPath: string;
  /** Path to srt-live-transmit, or null to use ffmpeg's own SRT input (no link statistics). */
  srtLiveTransmitPath: string | null;
  /** Directory the HLS preview is written to (cleared on start). */
  previewDir: string;
  /** URL prefix the preview directory is served under (default `/__srt/hls/`). */
  previewUrlBase?: string;
  /** JPEG the monitoring ffmpeg keeps overwriting with a small picture of the stream (the wall thumbnail). */
  thumbPath?: string;
}

const HOST_RE = /^[A-Za-z0-9_.:[\]-]{1,253}$/;

/** Validates untrusted JSON from the browser into a SrtConfig. Throws with a user-facing message. */
export function validateConfig(raw: unknown): SrtConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mode = o.mode === 'caller' ? 'caller' : o.mode === 'listener' ? 'listener' : o.mode === 'multicast' ? 'multicast' : o.mode === 'hls' ? 'hls' : null;
  if (!mode) throw new Error('mode must be "listener", "caller", "multicast" or "hls"');
  if (mode === 'hls') {
    let u: URL;
    try {
      u = new URL(typeof o.url === 'string' ? o.url.trim() : '');
    } catch {
      throw new Error('Enter the playlist address, for example https://example.com/live/master.m3u8');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The playlist address must start with http:// or https://');
    if (u.href.length > 2048) throw new Error('The playlist address is too long');
    return {
      mode,
      host: u.hostname,
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      url: u.href,
      latencyMs: 120,
      transcodePreview: false,
      lightAnalysis: o.lightAnalysis !== false,
    };
  }
  if (mode === 'multicast') {
    const group = typeof o.host === 'string' ? o.host.trim() : '';
    const octets = group.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255) || octets[0] < 224 || octets[0] > 239) {
      throw new Error('Enter an IPv4 multicast group between 224.0.0.0 and 239.255.255.255 (for example 239.1.1.1)');
    }
    const port = Number(o.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1-65535');
    const iface = typeof o.iface === 'string' ? o.iface.trim() : '';
    if (iface && !/^\d{1,3}(\.\d{1,3}){3}$/.test(iface)) throw new Error('Network interface must be an IPv4 address of this computer, or blank');
    return { mode, host: group, port, iface: iface || undefined, latencyMs: 120, transcodePreview: o.transcodePreview === true, lightAnalysis: o.lightAnalysis !== false };
  }
  const host = typeof o.host === 'string' && o.host.trim() ? o.host.trim() : mode === 'listener' ? '0.0.0.0' : '';
  if (!HOST_RE.test(host)) throw new Error(mode === 'caller' ? 'A valid remote host is required for caller mode' : 'Invalid bind address');
  const port = Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1-65535');
  const latencyMs = o.latencyMs === undefined || o.latencyMs === '' ? 120 : Number(o.latencyMs);
  if (!Number.isFinite(latencyMs) || latencyMs < 20 || latencyMs > 60_000) throw new Error('latency must be 20-60000 ms');
  const passphrase = typeof o.passphrase === 'string' && o.passphrase ? o.passphrase : undefined;
  if (passphrase && (passphrase.length < 10 || passphrase.length > 79)) throw new Error('SRT passphrase must be 10-79 characters');
  const streamId = typeof o.streamId === 'string' && o.streamId ? o.streamId : undefined;
  if (streamId && streamId.length > 512) throw new Error('stream ID is too long');
  return { mode, host, port, latencyMs: Math.round(latencyMs), passphrase, streamId, transcodePreview: o.transcodePreview === true, lightAnalysis: o.lightAnalysis !== false };
}

function srtQuery(c: SrtConfig, latencyUnit: number): string {
  const q = [`mode=${c.mode}`, `latency=${c.latencyMs * latencyUnit}`];
  if (c.passphrase) q.push(`passphrase=${encodeURIComponent(c.passphrase)}`, 'pbkeylen=16');
  if (c.streamId) q.push(`streamid=${encodeURIComponent(c.streamId)}`);
  return q.join('&');
}

/** ffmpeg's libsrt takes latency in microseconds. */
export const ffmpegSrtUrl = (c: SrtConfig) => `srt://${c.host}:${c.port}?${srtQuery(c, 1000)}`;
/** srt-live-transmit takes latency in milliseconds. */
export const liveTransmitSrtUrl = (c: SrtConfig) => `srt://${c.host}:${c.port}?${srtQuery(c, 1)}`;

let liveTransmitCache: string | null | undefined;
/** Finds srt-live-transmit (SRT_LIVE_TRANSMIT_PATH or PATH). */
export function findLiveTransmit(): string | null {
  if (liveTransmitCache !== undefined) return liveTransmitCache;
  const candidates = [
    process.env.SRT_LIVE_TRANSMIT_PATH,
    'srt-live-transmit',
    // Where `pacman -S mingw-w64-x86_64-srt` puts it on Windows (MSYS2).
    ...(process.platform === 'win32' ? ['C:/msys64/mingw64/bin/srt-live-transmit.exe', 'C:/msys64/ucrt64/bin/srt-live-transmit.exe'] : []),
  ].filter((c): c is string => Boolean(c));
  liveTransmitCache = candidates.find((c) => runnable(c)) ?? null;
  return liveTransmitCache;
}

/**
 * A full path that exists is taken as is: probing it with `-version` can exceed any short timeout the
 * first time a large .exe is run (virus scan), which would wrongly report it as missing. Bare names
 * are looked up on PATH by trying to run them.
 */
function runnable(path: string): boolean {
  if (isAbsolute(path)) return existsSync(path);
  return !spawnSync(path, ['-version'], { timeout: 20_000, windowsHide: true }).error;
}

export function ffmpegAvailable(path: string): boolean {
  return runnable(path);
}

/** Width of the wall thumbnails. Small on purpose: tens of them are on screen at once. */
export const THUMB_WIDTH = 320;

/**
 * Peak level of every half second, per channel, printed by `ametadata` to ffmpeg's own stderr (`pipe:2`) as
 * `lavfi.astats.<n>.Peak_level=<dB>`. The backslash is the filter-option escape for the colon in `pipe:2`
 * (written twice because this is a JS string).
 */
export const AUDIO_METER_FILTERS =
  "aresample=16000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1:measure_overall=none:measure_perchannel=Peak_level,ametadata=mode=print:direct=1:file='pipe\\:2'";

/** ffmpeg arguments for one attempt. Exported for tests. */
export function buildFfmpegArgs(cfg: SrtConfig, opts: { viaLiveTransmit: boolean; thumbPath?: string; inputUrl?: string }): string[] {
  // Damaged packets are NOT discarded (-fflags +discardcorrupt): on lossy feeds that also throws away the
  // packets carrying the video's SPS/PPS, and then nothing decodes at all (black picture).
  const light = cfg.lightAnalysis !== false;
  const args = ['-hide_banner', '-nostdin', '-nostats', '-y', '-loglevel', 'info', '-analyzeduration', '3000000', '-probesize', '3000000'];
  // The decoder only feeds the black-frame / silence checks. Light mode decodes keyframes only and skips
  // the deblocking filter; either way two decoder threads are plenty (more just cost memory).
  args.push('-threads', '2');
  if (light) args.push('-skip_frame', 'nokey', '-skip_loop_filter', 'all');
  const hls = cfg.mode === 'hls';
  // A live playlist is read at its own pace; `-re` makes a finished (VOD) one play at real time too instead of being
  // decoded as fast as possible. `-rw_timeout` ends a connection that stops answering so the session can retry.
  if (hls) args.push('-re', '-rw_timeout', '15000000', '-i', opts.inputUrl ?? cfg.url ?? '');
  else if (opts.viaLiveTransmit) args.push('-f', 'mpegts', '-i', 'pipe:0');
  else args.push('-i', ffmpegSrtUrl(cfg));

  // 1) Raw transport stream for the MPEG-TS analyser (only when ffmpeg owns the SRT socket;
  //    with srt-live-transmit the analyser reads the untouched bytes straight off the wire).
  if (!opts.viaLiveTransmit && !hls) args.push('-map', '0', '-c', 'copy', '-ignore_unknown', '-flush_packets', '1', '-pcr_period', '20', '-f', 'mpegts', 'pipe:1');

  // 2) Black-frame and silence detection. One output so a stream without video or without
  //    audio still works: each filter only applies to a stream of its own type.
  //    The audio chain also prints the peak level of every half second to stderr (`pipe:2`) for the wall's meters.
  args.push(
    '-map', '0:v:0?', '-map', '0:a:0?',
    // Shrink the picture before measuring it; the brightness thresholds are relative, so the result is the same.
    // A frame is black only when 98% of it is near-black (luma < 20; true black is 16): a dark scene or a partly black picture is not.
    '-vf', 'scale=160:90:flags=fast_bilinear,blackframe=amount=98:threshold=20',
    '-af', `${AUDIO_METER_FILTERS},silencedetect=n=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SEC}`,
    '-f', 'null', '-',
  );

  // 3) Wall thumbnail, from the frames the decoder already produces: one small picture a second. Light mode only
  //    decodes keyframes, so the picture really changes once per GOP and the `fps` filter repeats it in between
  //    (a few KB a second). `fps` rather than `-fps_mode`, which ffmpeg older than 5.1 (Ubuntu 22.04's 4.4) rejects.
  if (opts.thumbPath) {
    args.push(
      '-map', '0:v:0?',
      '-vf', `fps=1,scale=${THUMB_WIDTH}:-2:flags=fast_bilinear`,
      '-q:v', '8', '-f', 'image2', '-update', '1', '-atomic_writing', '1', opts.thumbPath,
    );
  }

  return args;
}

/**
 * ffmpeg arguments for the on-demand viewer: it reads the transport stream the monitor already has and
 * makes a browser-safe HLS preview. Whatever the source is (MPEG-2, HEVC, interlaced, AC-3, damaged
 * frames), the browser gets clean H.264 / AAC with a keyframe every second, which is what makes it play
 * continuously where a plain copy of the stream stutters or fails (VLC tolerates what browsers do not).
 */
export function buildViewerArgs(previewDir: string): string[] {
  return [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error',
    '-fflags', '+genpts', '-err_detect', 'ignore_err',
    '-analyzeduration', '2000000', '-probesize', '2000000',
    '-f', 'mpegts', '-i', 'pipe:0',
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-vf', "yadif=deint=interlaced,scale='min(1280,iw)':-2,format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-b:v', '3M', '-maxrate', '4M', '-bufsize', '6M',
    '-force_key_frames', 'expr:gte(t,n_forced*1)', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000', '-af', 'aresample=async=1:first_pts=0',
    '-max_muxing_queue_size', '1024',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
    '-hls_segment_filename', join(previewDir, 'seg%05d.ts'),
    join(previewDir, 'index.m3u8'),
  ];
}

/** SRT hands data over in bursts; a small UDP receive buffer (Windows: 64 KB) would drop part of each burst. */
function growReceiveBuffer(socket: dgram.Socket) {
  try {
    socket.setRecvBufferSize(8 * 1024 * 1024);
  } catch {
    /* keep the system default */
  }
}

const STALL_MS = 2000;
/** How often an HLS playlist is re-read for the freshness check. */
const HLS_POLL_MS = 3000;
/** Stop feeding the viewer when it falls this far behind (bytes queued), instead of growing memory. */
const VIEWER_MAX_QUEUE = 8 * 1024 * 1024;

/** Monitoring should never starve the rest of the computer (or the browser playing the preview). */
function lowerPriority(p: ChildProcess) {
  try {
    if (p.pid) setPriority(p.pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* process already gone, or not permitted */
  }
}

export interface SessionEvents {
  tick: [SrtSnapshot];
  state: [SrtSnapshot];
  connected: [SrtSnapshot];
  disconnected: [string];
  scte: [ScteMessage];
  /** HLS: an ad tag in the playlist (the counterpart of `scte`, which carries raw transport-stream sections). */
  cue: [StreamCue];
  error: [string];
  log: [string];
}

/**
 * One monitoring session: owns the SRT socket (through ffmpeg or srt-live-transmit),
 * feeds the analysers, writes the HLS preview and restarts itself after a drop so
 * a listener keeps waiting for the encoder to come back.
 */
export class SrtSession extends EventEmitter<SessionEvents> {
  private state: SessionState = 'idle';
  private cfg: SrtConfig | null = null;
  private ingest: SrtSnapshot['ingest'] = null;
  private ts = new TsAnalyzer();
  private av = new AvDetector();
  private link: LinkStats | null = null;
  private procs: ChildProcess[] = [];
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = true;
  private startedAt: number | null = null;
  private connectedAt: number | null = null;
  private waitingSince: number | null = null;
  private attemptAt = 0;
  private lastDataAt: number | null = null;
  private connections = 0;
  private lastError: string | null = null;
  private previewReady = false;
  private thumbAt: number | null = null;
  private viewer: ChildProcess | null = null;
  private watching = false;
  private viewerRetry: NodeJS.Timeout | null = null;
  private recentScte = new Map<string, number>();
  private failures = 0;
  private probe: HlsProbe | null = null;
  private probing = false;
  private lastPollAt = 0;

  constructor(private readonly opts: SessionOptions) {
    super();
  }

  get running(): boolean {
    return !this.stopped;
  }

  start(cfg: SrtConfig): void {
    if (!this.stopped) throw new Error('A session is already running');
    this.cfg = cfg;
    this.stopped = false;
    this.startedAt = Date.now();
    this.waitingSince = this.startedAt;
    this.connectedAt = null;
    this.connections = 0;
    this.failures = 0;
    this.lastError = null;
    this.ingest = cfg.mode === 'hls' ? 'hls' : cfg.mode === 'multicast' ? 'udp' : this.opts.srtLiveTransmitPath ? 'srt-live-transmit' : 'ffmpeg';
    this.timer = setInterval(() => this.tick(), 1000);
    this.attempt();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = this.retry = null;
    this.killProcesses();
    this.probe = null;
    this.clearPreview();
    this.clearThumb();
    this.setState('idle');
  }

  snapshot(): SrtSnapshot {
    const perf = performance.now();
    const active = this.state === 'connected' || this.state === 'stalled';
    return {
      state: this.state,
      config: this.cfg ? { ...this.cfg, passphrase: this.cfg.passphrase ? '********' : undefined } : null,
      ingest: this.ingest,
      linkStatsAvailable: this.ingest === 'srt-live-transmit',
      tsSource: this.ingest === 'hls' ? null : this.ingest === 'ffmpeg' ? 'remuxed' : this.ingest ? 'wire' : null,
      startedAt: this.startedAt,
      connectedAt: this.connectedAt,
      connections: this.connections,
      msSinceData: active && this.lastDataAt !== null ? perf - this.lastDataAt : null,
      waitingForMs: !this.stopped && !active && this.waitingSince !== null ? Date.now() - this.waitingSince : null,
      link: this.link,
      ts: this.ingest !== 'hls' && (active || this.ts.packets) ? this.ts.snapshot(perf) : null,
      hls: this.ingest === 'hls' ? this.hlsInfo() : null,
      av: active ? this.av.stats() : null,
      previewUrl: this.ingest !== 'hls' && this.previewReady && active ? `${this.opts.previewUrlBase ?? PREVIEW_PATH}index.m3u8` : null,
      thumbAt: active ? this.thumbAt : null,
      lastError: this.lastError,
      now: Date.now(),
    };
  }

  // ---------------------------------------------------------------- internals

  private setState(state: SessionState) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', this.snapshot());
  }

  private clearPreview() {
    this.previewReady = false;
    try {
      rmSync(this.opts.previewDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  /** Forget the wall thumbnail (a new attempt, or the channel stopped): an old picture must not look live. */
  private clearThumb() {
    this.thumbAt = null;
    if (!this.opts.thumbPath) return;
    try {
      rmSync(this.opts.thumbPath, { force: true });
    } catch {
      /* best effort */
    }
  }

  private checkThumb() {
    if (!this.opts.thumbPath) return;
    try {
      const at = Math.round(statSync(this.opts.thumbPath).mtimeMs);
      if (at >= this.attemptAt) this.thumbAt = at;
    } catch {
      /* not written yet */
    }
  }

  /** Start or stop the browser preview (only the channel being looked at has one). */
  setWatching(on: boolean): void {
    if (this.watching === on) return;
    this.watching = on;
    if (this.ingest === 'hls') return;
    if (on) {
      if (!this.stopped && this.procs.length) this.startViewer();
    } else {
      this.killViewer();
      this.clearPreview();
    }
  }

  private killViewer() {
    if (this.viewerRetry) clearTimeout(this.viewerRetry);
    this.viewerRetry = null;
    const v = this.viewer;
    this.viewer = null;
    this.previewReady = false;
    if (v) {
      v.removeAllListeners('close');
      v.stdin?.destroy();
      v.kill();
    }
  }

  private startViewer() {
    this.killViewer();
    if (this.stopped || !this.watching) return;
    try {
      rmSync(this.opts.previewDir, { recursive: true, force: true });
      mkdirSync(this.opts.previewDir, { recursive: true });
    } catch {
      /* best effort */
    }
    const v = spawn(this.opts.ffmpegPath, buildViewerArgs(this.opts.previewDir), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    this.viewer = v;
    lowerPriority(v);
    v.stdin!.on('error', () => undefined);
    v.on('error', (err) => this.emit('log', `preview: could not start ffmpeg: ${err.message}`));
    createInterface({ input: v.stderr! }).on('line', (line) => this.emit('log', `preview: ${line}`));
    v.on('close', () => {
      if (this.viewer !== v) return;
      this.viewer = null;
      this.previewReady = false;
      // Bad input can end it: try again shortly while someone is still watching.
      if (this.watching && !this.stopped) this.viewerRetry = setTimeout(() => this.startViewer(), 2000);
    });
  }

  private killProcesses() {
    this.killViewer();
    for (const p of this.procs) {
      p.removeAllListeners('close');
      p.kill();
    }
    this.procs = [];
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
  }

  private attempt(): void {
    if (this.stopped || !this.cfg) return;
    const cfg = this.cfg;
    this.killProcesses();
    this.clearPreview();
    this.clearThumb();
    mkdirSync(this.opts.previewDir, { recursive: true });
    if (this.opts.thumbPath) mkdirSync(dirname(this.opts.thumbPath), { recursive: true });
    this.ts = new TsAnalyzer({ onScte: (sec, pid) => this.onScte(sec, pid) });
    this.av = new AvDetector({ keyframesOnly: cfg.lightAnalysis !== false });
    this.link = null;
    this.lastDataAt = null;
    this.connectedAt = null;
    this.attemptAt = Date.now();
    this.setState(this.connections ? 'reconnecting' : 'starting');

    if (cfg.mode === 'hls') {
      void this.attemptHls(cfg);
      return;
    }
    this.spawnMonitor(cfg);
  }

  private spawnMonitor(cfg: SrtConfig, inputUrl?: string) {
    const udp = cfg.mode === 'multicast';
    const hls = cfg.mode === 'hls';
    const viaLive = !hls && (udp || this.opts.srtLiveTransmitPath !== null);
    const ff = spawn(this.opts.ffmpegPath, buildFfmpegArgs(cfg, { viaLiveTransmit: viaLive, thumbPath: this.opts.thumbPath, inputUrl }), {
      stdio: [viaLive ? 'pipe' : 'ignore', viaLive || hls ? 'ignore' : 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.procs = [ff];
    lowerPriority(ff);
    if (this.watching && !hls) this.startViewer();
    ff.on('error', (err) => this.failed(`Could not start ffmpeg: ${err.message}`));
    ff.on('close', (code) => this.processEnded(`ffmpeg exited${code ? ` with code ${code}` : ''}`));
    createInterface({ input: ff.stderr! }).on('line', (line) => this.onFfmpegLine(line));

    if (viaLive) {
      ff.stdin!.on('error', () => undefined); // EPIPE when ffmpeg exits first
      if (udp) this.startMulticast(cfg, ff);
      else this.startLiveTransmit(cfg, ff);
    } else if (hls) {
      this.setState('waiting');
    } else {
      ff.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
      this.setState('waiting');
    }
  }

  /** HLS: read the playlist, pick the cheapest rendition for the wall, then decode that one. */
  private async attemptHls(cfg: SrtConfig) {
    const probe = new HlsProbe(cfg.url ?? '');
    this.probe = probe;
    this.setState(this.connections ? 'reconnecting' : 'starting');
    try {
      await probe.resolve();
      for (const cue of probe.drainCues()) this.emit('cue', cue);
    } catch (err) {
      if (this.stopped || this.probe !== probe) return;
      this.failed(err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.stopped || this.probe !== probe) return;
    this.spawnMonitor(cfg, probe.inputUrl);
  }

  /** How the playlist is doing, for the snapshot (null until it has been read). */
  private hlsInfo(): HlsInfo | null {
    return this.probe ? this.probe.info() : null;
  }

  /**
   * Once a second for HLS: fetch the playlist (every few seconds) and treat "the playlist got a new segment" as the
   * data heartbeat, so a stream that stops publishing raises the same "no signal" alert an SRT drop does.
   */
  private tickHls() {
    const probe = this.probe;
    if (!probe) return;
    if (!this.probing && Date.now() - this.lastPollAt >= HLS_POLL_MS) {
      this.probing = true;
      this.lastPollAt = Date.now();
      void probe.poll().finally(() => {
        this.probing = false;
        for (const cue of probe.drainCues()) this.emit('cue', cue);
      });
    }
    const stale = probe.staleMs();
    if (stale !== null && probe.unreachable) {
      this.lastError = `The playlist cannot be fetched: ${probe.error ?? 'no answer'}`;
    }
    // A healthy playlist only moves once per segment (and is only read every few seconds), so that much silence is normal.
    const allowed = (probe.info().targetDuration ?? 6) * 1000 + HLS_POLL_MS;
    this.lastDataAt = performance.now() - (stale === null ? 0 : Math.max(0, stale - allowed));
    if (this.state === 'stalled' && performance.now() - this.lastDataAt <= this.stallMs()) this.setState('connected');
  }

  /** UDP: join the multicast group ourselves and feed the datagrams to the analyser and ffmpeg. */
  private startMulticast(cfg: SrtConfig, ff: ChildProcess) {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('error', (err) => this.failed(`UDP socket error: ${err.message}`));
    socket.on('message', (msg) => {
      this.onData(msg);
      if (ff.stdin?.writable) ff.stdin.write(msg);
    });
    socket.bind(cfg.port, () => {
      if (this.stopped || this.socket !== socket) return;
      growReceiveBuffer(socket);
      try {
        socket.addMembership(cfg.host, cfg.iface);
      } catch (err) {
        this.failed(`Could not join multicast group ${cfg.host}${cfg.iface ? ` on ${cfg.iface}` : ''}: ${err instanceof Error ? err.message : err}`);
        return;
      }
      this.setState('waiting');
    });
  }

  private startLiveTransmit(cfg: SrtConfig, ff: ChildProcess) {
    const socket = dgram.createSocket('udp4');
    this.socket = socket;
    socket.on('error', (err) => this.failed(`UDP relay error: ${err.message}`));
    socket.on('message', (msg) => {
      this.onData(msg);
      if (ff.stdin?.writable) ff.stdin.write(msg);
    });
    socket.bind(0, '127.0.0.1', () => {
      if (this.stopped || this.socket !== socket) return;
      growReceiveBuffer(socket);
      const port = socket.address().port;
      const lt = spawn(
        this.opts.srtLiveTransmitPath!,
        [liveTransmitSrtUrl(cfg), `udp://127.0.0.1:${port}`, '-s:1000', '-pf:json', '-chunk:1316'],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      this.procs.push(lt);
      lowerPriority(lt);
      lt.on('error', (err) => this.failed(`Could not start srt-live-transmit: ${err.message}`));
      lt.on('close', (code) => this.processEnded(`srt-live-transmit exited${code ? ` with code ${code}` : ''}`));
      createInterface({ input: lt.stdout! }).on('line', (line) => {
        const stats = parseLinkStats(line);
        if (stats) this.link = stats;
      });
      createInterface({ input: lt.stderr! }).on('line', (line) => {
        if (/error|fail|reject|timeout|passphrase/i.test(line)) this.noteError(line);
        this.emit('log', `srt-live-transmit: ${line}`);
      });
      this.setState('waiting');
    });
  }

  private noteError(line: string) {
    this.lastError = friendlyError(line);
  }

  private onFfmpegLine(line: string) {
    this.av.feed(line);
    if (this.av.lastError && this.av.lastError !== this.lastError) this.lastError = this.av.lastError;
    if (/^Input #0/.test(line)) this.markConnected();
    if (/error|failed|invalid|corrupt/i.test(line) && !/blackframe|silencedetect/.test(line)) this.emit('log', `ffmpeg: ${line}`);
  }

  private onData(chunk: Uint8Array) {
    const v = this.viewer;
    if (v?.stdin?.writable && v.stdin.writableLength < VIEWER_MAX_QUEUE) v.stdin.write(chunk);
    const now = performance.now();
    this.lastDataAt = now;
    this.ts.push(chunk, now);
    this.markConnected();
  }

  private markConnected() {
    if (this.stopped) return;
    if (this.connectedAt === null) {
      this.connectedAt = Date.now();
      this.waitingSince = null;
      this.connections++;
      this.failures = 0;
      this.lastError = null;
      this.setState('connected');
      this.emit('connected', this.snapshot());
    } else if (this.state === 'stalled') {
      this.setState('connected');
    }
  }

  private onScte(section: Uint8Array, pid: number) {
    const key = Buffer.from(section).toString('base64');
    const now = Date.now();
    const seen = this.recentScte.get(key);
    // Encoders repeat each splice a few times for redundancy.
    if (seen !== undefined && now - seen < 10_000) return;
    this.recentScte.set(key, now);
    for (const [k, t] of this.recentScte) if (now - t > 60_000) this.recentScte.delete(k);
    this.emit('scte', { raw: key, pid, receivedAt: now });
  }

  private tick() {
    if (this.stopped) return;
    const perf = performance.now();
    if (this.ingest === 'hls') this.tickHls();
    else this.ts.tick(perf);
    if (
      this.state === 'connected' &&
      this.lastDataAt !== null &&
      perf - this.lastDataAt > this.stallMs()
    ) {
      this.setState('stalled');
    }
    if (this.ingest !== 'hls' && !this.previewReady) this.checkPreview();
    this.checkThumb();
    this.emit('tick', this.snapshot());
  }

  /** Silence (beyond what `tickHls` already allows for) after which the feed counts as stalled. */
  private stallMs(): number {
    return STALL_MS;
  }

  private checkPreview() {
    try {
      const playlist = join(this.opts.previewDir, 'index.m3u8');
      if (!existsSync(playlist)) return;
      const segments = readFileSync(playlist, 'utf8').split('\n').filter((l) => l.startsWith('#EXTINF')).length;
      if (segments >= 2 && readdirSync(this.opts.previewDir).some((f) => f.endsWith('.ts'))) this.previewReady = true;
    } catch {
      /* playlist being rewritten */
    }
  }

  private failed(message: string) {
    this.lastError = message;
    this.emit('error', message);
    this.processEnded(message);
  }

  private processEnded(reason: string) {
    if (this.stopped) return;
    // One of the two processes ended: tear down the pair and start over.
    const wasConnected = this.connectedAt !== null;
    this.killProcesses();
    if (wasConnected) this.emit('disconnected', this.lastError ?? reason);
    else this.failures++;
    this.connectedAt = null;
    this.lastDataAt = null;
    this.waitingSince ??= Date.now();
    this.setState('reconnecting');
    // Back off when the very first connection attempts keep failing (bad address, wrong passphrase…).
    const lived = Date.now() - this.attemptAt;
    const delay = !wasConnected && lived < 3000 ? Math.min(1000 * 2 ** Math.min(this.failures, 3), 8000) : 1000;
    if (!wasConnected) this.emit('log', `${reason}${this.lastError ? `: ${this.lastError}` : ''}. Retrying in ${delay / 1000} s`);
    this.retry = setTimeout(() => this.attempt(), delay);
  }
}
