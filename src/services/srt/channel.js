import { join } from 'node:path';
import { cueDirection, cueDuration, parseScte35, summarizeScte35 } from '../../parser/scte35.js';
import { kindLabel } from '../../constants/srt.js';
import { AlertEngine, EvalHistory, evaluate } from './alerts.js';
import { SrtSession, validateConfig } from './session.js';
/** Condensed one-line state, written to the log every STATS_LOG_MS. */
const STATS_LOG_MS = 30_000;
/** Identical process messages are logged once per this many ms. */
const REPEAT_MS = 10_000;
/** One monitored SRT feed: its session, rules, alert engine and name. */
export class SrtChannel {
  id;
  host;
  session;
  kind;
  name;
  thresholds;
  /** Last connection settings used (without secrets), to pre-fill the form and for "Start all". */
  config;
  engine;
  hist = new EvalHistory();
  reportedError = null;
  lastErrorAt = 0;
  lastStatsLog = 0;
  lastState = '';
  repeats = new Map();
  constructor(id, init, host, opts) {
    this.id = id;
    this.host = host;
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
      const a = { ...alert, channelId: this.id, channelName: this.name };
      this.host.broadcast('alert', a);
      const label = a.state === 'cleared' ? 'RECOVERED' : a.severity.toUpperCase();
      this.log(
        a.severity === 'critical' ? 'ERROR' : a.severity === 'warning' ? 'WARN' : 'INFO',
        'alert',
        `${label} ${a.rule} — ${a.message}`,
        true,
      );
      if (notify) this.host.notify(a);
    });
    this.wire();
  }
  get proto() {
    return kindLabel(this.kind);
  }
  log(level, category, text, alert = false) {
    this.host.log(this.id, this.name, level, category, text, alert, this.kind);
  }
  wire() {
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
        snap.connections > 1
          ? `${this.proto} stream reconnected`
          : `${this.proto} stream connected${c ? ` (${c.mode} ${c.host}:${c.port})` : ''}`,
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
      let direction = 'other';
      let duration;
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
  raiseScte(direction, summary, crcValid, receivedAt, duration, pid) {
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
  processLine(line) {
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
  reportError(snap) {
    if (snap.state === 'connected' || snap.state === 'stalled' || !snap.lastError) return;
    if (snap.lastError === this.reportedError && snap.now - this.lastErrorAt < 60_000) return;
    this.reportedError = snap.lastError;
    this.lastErrorAt = snap.now;
    this.engine.event('srt_error', 'critical', `${this.proto} connection problem: ${snap.lastError}`, snap.now);
  }
  logStats(snap) {
    if (snap.now - this.lastStatsLog < STATS_LOG_MS) return;
    this.lastStatsLog = snap.now;
    if (snap.state === 'idle') return;
    const parts = [`state=${snap.state}`];
    if (snap.ts) parts.push(`bitrate=${Math.round(snap.ts.bitrateKbps)}kbps`, `cc=${snap.ts.ccErrors}`);
    if (snap.link) {
      parts.push(
        `rtt=${snap.link.rttMs ?? '-'}ms`,
        `lost=${snap.link.lost}`,
        `dropped=${snap.link.dropped}`,
        `retrans=${snap.link.retransmitted}`,
      );
    }
    if (snap.av?.video || snap.av?.audio) parts.push(`video=${snap.av.video?.codec ?? '-'}`, `audio=${snap.av.audio?.codec ?? '-'}`);
    if (snap.av) parts.push(`black=${snap.av.black}`, `silent=${snap.av.silent}`, `decodeErrors=${snap.av.decodeErrors}`);
    if (snap.waitingForMs !== null) parts.push(`waiting=${Math.round(snap.waitingForMs / 1000)}s`);
    this.log('INFO', 'stats', parts.join(' '));
  }
  // -------------------------------------------------------------- control
  start(raw) {
    const cfg = validateConfig(raw);
    const expected = cfg.mode === 'multicast' ? 'udp' : cfg.mode === 'hls' ? 'hls' : 'srt';
    if (this.kind !== expected) {
      throw new Error(
        this.kind === 'udp'
          ? 'UDP channels only receive multicast'
          : this.kind === 'hls'
            ? 'HLS channels take an http(s) playlist address'
            : 'SRT channels use listener or caller mode',
      );
    }
    this.hist.reset();
    this.reportedError = null;
    this.lastStatsLog = 0;
    this.config = { ...cfg, passphrase: undefined, streamId: undefined };
    this.session.start(cfg);
    this.log(
      'INFO',
      'control',
      cfg.mode === 'hls'
        ? `started: hls ${cfg.url?.split('?')[0]}${cfg.lightAnalysis === false ? ' full decode' : ''}`
        : `started: ${cfg.mode} ${cfg.host}:${cfg.port}${cfg.iface ? ` iface=${cfg.iface}` : ''}${cfg.mode === 'multicast' ? '' : ` latency=${cfg.latencyMs}ms`}${cfg.transcodePreview ? ' re-encoded preview' : ''}`,
    );
    this.host.persist();
  }
  stop() {
    if (!this.session.running) return;
    this.engine.clearAll(Date.now());
    this.session.stop();
    this.hist.reset();
    this.log('INFO', 'control', 'stopped');
    this.host.broadcast('snapshot', { ch: this.id, snapshot: this.session.snapshot() });
  }
  rename(name) {
    if (name === this.name) return;
    this.log('INFO', 'control', `renamed "${this.name}" → "${name}"`);
    this.name = name;
  }
  setThresholds(t) {
    this.thresholds = t;
  }
  /** Active alerts first would hide history, so this is just the engine's newest-first history. */
  alerts() {
    return this.engine.history.slice(0, 200).map((a) => ({ ...a, channelId: this.id, channelName: this.name }));
  }
  activeCount() {
    return this.engine.activeAlerts().length;
  }
  status() {
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
  dispose() {
    this.session.stop();
  }
}
