import { join } from 'node:path';
import { cueDirection, cueDuration, parseScte35, summarizeScte35 } from '../../src/scte/scte35.ts';
import { kindLabel, type Alert, type AlertThresholds, type ChannelKind, type ChannelStatus, type SrtConfig, type SrtSnapshot } from '../../src/srt/types.ts';
import { AlertEngine, EvalHistory, evaluate } from './alerts.ts';
import type { LogLevel } from './daily-log.ts';
import { SrtSession, validateConfig } from './session.ts';

/** What a channel needs from the monitor that owns it. */
export interface ChannelHost {
  broadcast(event: string, data: unknown): void;
  /** Sends a raised / cleared / event alert to the shared webhook and email channels. */
  notify(alert: Alert): void;
  log(channel: number, name: string, level: LogLevel, category: string, text: string, alert?: boolean, kind?: ChannelKind): void;
  /** Persist names, rules and last-used connection settings. */
  persist(): void;
}

export interface ChannelInit {
  kind: ChannelKind;
  name: string;
  thresholds: AlertThresholds;
  config: SrtConfig | null;
}

export interface ChannelOptions {
  ffmpegPath: string;
  srtLiveTransmitPath: string | null;
  /** Parent preview folder; each channel writes its HLS to `<dir>/ch<id>` and its wall thumbnail to `<dir>/thumb/<id>.jpg`. */
  previewRoot: string;
}

/** Condensed one-line state, written to the log every STATS_LOG_MS. */
const STATS_LOG_MS = 30_000;
/** Identical process messages are logged once per this many ms. */
const REPEAT_MS = 10_000;

/** One monitored SRT feed: its session, rules, alert engine and name. */
export class SrtChannel {
  readonly session: SrtSession;
  readonly kind: ChannelKind;
  name: string;
  thresholds: AlertThresholds;
  /** Last connection settings used (without secrets), to pre-fill the form and for "Start all". */
  config: SrtConfig | null;
  private readonly engine: AlertEngine;
  private readonly hist = new EvalHistory();
  private reportedError: string | null = null;
  private lastErrorAt = 0;
  private lastStatsLog = 0;
  private lastState = '';
  private repeats = new Map<string, { at: number; count: number }>();

  constructor(
    readonly id: number,
    init: ChannelInit,
    private readonly host: ChannelHost,
    opts: ChannelOptions,
  ) {
    this.kind = init.kind;
    this.name = init.name;
    this.thresholds = init.thresholds;
    this.config = init.config;
    this.session = new SrtSession({
      ffmpegPath: opts.ffmpegPath,
      srtLiveTransmitPath: opts.srtLiveTransmitPath,
      previewDir: join(opts.previewRoot, `ch${id}`),
      previewUrlBase: `/__srt/hls/ch${id}/`,
      thumbPath: join(opts.previewRoot, 'thumb', `${id}.jpg`),
    });
    this.engine = new AlertEngine((alert, notify) => {
      const a: Alert = { ...alert, channelId: this.id, channelName: this.name };
      this.host.broadcast('alert', a);
      const label = a.state === 'cleared' ? 'RECOVERED' : a.severity.toUpperCase();
      this.log(a.severity === 'critical' ? 'ERROR' : a.severity === 'warning' ? 'WARN' : 'INFO', 'alert', `${label} ${a.rule} — ${a.message}`, true);
      if (notify) this.host.notify(a);
    });
    this.wire();
  }

  private get proto(): 'SRT' | 'UDP' | 'HLS' {
    return kindLabel(this.kind);
  }

  private log(level: LogLevel, category: string, text: string, alert = false) {
    this.host.log(this.id, this.name, level, category, text, alert, this.kind);
  }

  private wire() {
    const s = this.session;
    s.on('tick', (snap) => {
      this.hist.record(snap, snap.now);
      this.engine.apply(evaluate(snap, this.thresholds, this.hist, snap.now), snap.now);
      this.reportError(snap);
      this.host.broadcast('snapshot', { ch: this.id, snapshot: snap });
      this.logStats(snap);
    });
    s.on('state', (snap) => {
      if (snap.state !== this.lastState) {
        this.log('INFO', 'state', `${this.lastState || 'idle'} → ${snap.state}${snap.lastError ? ` (${snap.lastError})` : ''}`);
        this.lastState = snap.state;
      }
      this.host.broadcast('snapshot', { ch: this.id, snapshot: snap });
    });
    s.on('connected', (snap) => {
      this.hist.reset();
      this.reportedError = null;
      const c = snap.config;
      this.engine.event(
        'connected',
        'info',
        snap.connections > 1 ? `${this.proto} stream reconnected` : `${this.proto} stream connected${c ? ` (${c.mode} ${c.host}:${c.port})` : ''}`,
        snap.now,
      );
    });
    s.on('disconnected', (reason) => {
      const now = Date.now();
      this.engine.clearAll(now);
      this.engine.event('disconnected', 'critical', `${this.proto} stream disconnected: ${reason}`, now);
    });
    s.on('scte', (m) => {
      let summary = 'SCTE-35 message';
      let direction: string = 'other';
      let duration: number | undefined;
      let crcValid = true;
      try {
        const sec = parseScte35(m.raw);
        summary = summarizeScte35(sec);
        direction = cueDirection(sec);
        duration = cueDuration(sec);
        crcValid = sec.crcValid;
      } catch (err) {
        summary = `Undecodable SCTE-35: ${err instanceof Error ? err.message : err}`;
      }
      this.host.broadcast('scte', { ch: this.id, ...m, summary, direction, duration, crcValid });
      this.raiseScte(direction, summary, crcValid, m.receivedAt, duration, m.pid);
    });
    s.on('cue', (c) => {
      this.host.broadcast('scte', { ch: this.id, raw: '', pid: 0, source: 'hls', ...c });
      this.raiseScte(c.direction, c.summary, c.crcValid, c.receivedAt, c.duration);
    });
    s.on('log', (line) => this.processLine(line));
    // Without a listener an 'error' event would throw and take the whole server down.
    s.on('error', (message) => this.log('ERROR', 'process', message));
  }

  /** An alert (or just a log line, when SCTE-35 alerts are off) for one marker. */
  private raiseScte(direction: string, summary: string, crcValid: boolean, receivedAt: number, duration?: number, pid?: number) {
    if (this.thresholds.scteEvents) {
      this.engine.event('scte', crcValid ? 'info' : 'warning', `SCTE-35 ${direction.toUpperCase()}: ${summary}`, receivedAt, {
        ...(pid !== undefined ? { pid } : {}),
        ...(duration !== undefined ? { durationSec: Number(duration.toFixed(1)) } : {}),
      });
    } else {
      this.log('INFO', 'scte35', `${direction.toUpperCase()}: ${summary}`);
    }
  }

  /**
   * ffmpeg repeats the same complaint for every damaged frame (thousands per minute on a lossy feed).
   * The first of each kind is logged at once; repeats within REPEAT_MS are only counted.
   */
  private processLine(line: string) {
    const now = Date.now();
    const kind = line.replace(/0x[0-9a-f]+|[0-9a-f]{12,}/gi, 'H').replace(/\d+/g, 'N');
    const seen = this.repeats.get(kind);
    if (seen && now - seen.at < REPEAT_MS) {
      seen.count++;
      return;
    }
    const more = seen?.count ? ` (+${seen.count} similar in the last ${Math.round((now - seen.at) / 1000)} s)` : '';
    this.repeats.set(kind, { at: now, count: 0 });
    if (this.repeats.size > 200) this.repeats.clear();
    this.host.broadcast('log', { ch: this.id, at: now, line: line + more });
    this.log('WARN', 'process', line + more);
  }

  /** Raise a one-shot alert for each new connection / protocol error (e.g. wrong passphrase). */
  private reportError(snap: SrtSnapshot) {
    if (snap.state === 'connected' || snap.state === 'stalled' || !snap.lastError) return;
    if (snap.lastError === this.reportedError && snap.now - this.lastErrorAt < 60_000) return;
    this.reportedError = snap.lastError;
    this.lastErrorAt = snap.now;
    this.engine.event('srt_error', 'critical', `${this.proto} connection problem: ${snap.lastError}`, snap.now);
  }

  private logStats(snap: SrtSnapshot) {
    if (snap.now - this.lastStatsLog < STATS_LOG_MS) return;
    this.lastStatsLog = snap.now;
    if (snap.state === 'idle') return;
    const parts = [`state=${snap.state}`];
    if (snap.ts) parts.push(`bitrate=${Math.round(snap.ts.bitrateKbps)}kbps`, `cc=${snap.ts.ccErrors}`);
    if (snap.link) {
      parts.push(`rtt=${snap.link.rttMs ?? '-'}ms`, `lost=${snap.link.lost}`, `dropped=${snap.link.dropped}`, `retrans=${snap.link.retransmitted}`);
    }
    if (snap.av?.video || snap.av?.audio) parts.push(`video=${snap.av.video?.codec ?? '-'}`, `audio=${snap.av.audio?.codec ?? '-'}`);
    if (snap.av) parts.push(`black=${snap.av.black}`, `silent=${snap.av.silent}`, `decodeErrors=${snap.av.decodeErrors}`);
    if (snap.waitingForMs !== null) parts.push(`waiting=${Math.round(snap.waitingForMs / 1000)}s`);
    this.log('INFO', 'stats', parts.join(' '));
  }

  // -------------------------------------------------------------- control

  start(raw: unknown): void {
    const cfg = validateConfig(raw);
    const expected: ChannelKind = cfg.mode === 'multicast' ? 'udp' : cfg.mode === 'hls' ? 'hls' : 'srt';
    if (this.kind !== expected) {
      throw new Error(
        this.kind === 'udp' ? 'UDP channels only receive multicast' : this.kind === 'hls' ? 'HLS channels take an http(s) playlist address' : 'SRT channels use listener or caller mode',
      );
    }
    this.hist.reset();
    this.reportedError = null;
    this.lastStatsLog = 0;
    this.config = { ...cfg, passphrase: undefined, streamId: undefined };
    this.session.start(cfg);
    this.log('INFO', 'control', cfg.mode === 'hls' ? `started: hls ${cfg.url?.split('?')[0]}${cfg.lightAnalysis === false ? ' full decode' : ''}` : `started: ${cfg.mode} ${cfg.host}:${cfg.port}${cfg.iface ? ` iface=${cfg.iface}` : ''}${cfg.mode === 'multicast' ? '' : ` latency=${cfg.latencyMs}ms`}${cfg.transcodePreview ? ' re-encoded preview' : ''}`);
    this.host.persist();
  }

  stop(): void {
    if (!this.session.running) return;
    this.engine.clearAll(Date.now());
    this.session.stop();
    this.hist.reset();
    this.log('INFO', 'control', 'stopped');
    this.host.broadcast('snapshot', { ch: this.id, snapshot: this.session.snapshot() });
  }

  rename(name: string): void {
    if (name === this.name) return;
    this.log('INFO', 'control', `renamed "${this.name}" → "${name}"`);
    this.name = name;
  }

  setThresholds(t: AlertThresholds): void {
    this.thresholds = t;
  }

  /** Active alerts first would hide history, so this is just the engine's newest-first history. */
  alerts(): Alert[] {
    return this.engine.history.slice(0, 200).map((a) => ({ ...a, channelId: this.id, channelName: this.name }));
  }

  activeCount(): number {
    return this.engine.activeAlerts().length;
  }

  status(): ChannelStatus {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      config: this.config,
      thresholds: this.thresholds,
      snapshot: this.session.snapshot(),
      alerts: this.alerts(),
    };
  }

  dispose(): void {
    this.session.stop();
  }
}
