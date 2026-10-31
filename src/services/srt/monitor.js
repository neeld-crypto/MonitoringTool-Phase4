import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_MAX_CPU,
  DEFAULT_NOTIFY,
  DEFAULT_THRESHOLDS,
  MAX_CHANNELS,
  MAX_NAME_LENGTH,
  SECRET_MASK,
  defaultChannelName,
} from '../../constants/srt.js';
import { SrtChannel } from './channel.js';
import { DailyLog } from './daily-log.js';
import { cpuBlock, cpuSampler } from './load.js';
import { Notifier } from './notifiers.js';
import { ffmpegAvailable, findLiveTransmit, validateConfig } from './session.js';
const SEVERITIES = ['info', 'warning', 'critical'];
const num = (v, fallback, min, max) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const str = (v, fallback, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
export function sanitizeThresholds(raw, base = DEFAULT_THRESHOLDS) {
  const o = raw ?? {};
  return {
    noSignalSec: num(o.noSignalSec, base.noSignalSec, 1, 600),
    waitingSec: num(o.waitingSec, base.waitingSec, 0, 86_400),
    bitrateDropPct: num(o.bitrateDropPct, base.bitrateDropPct, 0, 95),
    minBitrateKbps: num(o.minBitrateKbps, base.minBitrateKbps, 0, 1_000_000),
    rttMs: num(o.rttMs, base.rttMs, 1, 60_000),
    lossPct: num(o.lossPct, base.lossPct, 0.01, 100),
    droppedPackets: num(o.droppedPackets, base.droppedPackets, 0, 1_000_000),
    retransPct: num(o.retransPct, base.retransPct, 0.1, 100),
    ccErrors: num(o.ccErrors, base.ccErrors, 1, 100_000),
    decodeErrors: num(o.decodeErrors, base.decodeErrors, 1, 100_000),
    psiTimeoutMs: num(o.psiTimeoutMs, base.psiTimeoutMs, 100, 60_000),
    pcrMaxMs: num(o.pcrMaxMs, base.pcrMaxMs, 10, 10_000),
    pidTimeoutSec: num(o.pidTimeoutSec, base.pidTimeoutSec, 1, 600),
    blackSec: num(o.blackSec, base.blackSec, 1, 600),
    silenceSec: num(o.silenceSec, base.silenceSec, 1, 600),
    scteEvents: typeof o.scteEvents === 'boolean' ? o.scteEvents : base.scteEvents,
  };
}
/** Channel name from untrusted input: no control characters, trimmed, at most MAX_NAME_LENGTH. */
export function sanitizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const name = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return name || fallback;
}
/** Merges browser input into stored settings. A masked secret keeps the stored value. */
export function mergeNotify(raw, stored = DEFAULT_NOTIFY) {
  const o = raw ?? {};
  const w = o.webhook ?? {};
  const e = o.email ?? {};
  const secret = (incoming, old) => (incoming === SECRET_MASK ? old : str(incoming, old));
  const min = o.minSeverity;
  return {
    minSeverity: SEVERITIES.includes(min) ? min : stored.minSeverity,
    notifyOnClear: typeof o.notifyOnClear === 'boolean' ? o.notifyOnClear : stored.notifyOnClear,
    cooldownSec: num(o.cooldownSec, stored.cooldownSec, 0, 86_400),
    webhook: {
      enabled: typeof w.enabled === 'boolean' ? w.enabled : stored.webhook.enabled,
      kind: w.kind === 'teams' || w.kind === 'generic' || w.kind === 'slack' ? w.kind : stored.webhook.kind,
      url: secret(w.url, stored.webhook.url),
    },
    email: {
      enabled: typeof e.enabled === 'boolean' ? e.enabled : stored.email.enabled,
      host: str(e.host, stored.email.host, 253),
      port: num(e.port, stored.email.port, 1, 65535),
      secure: typeof e.secure === 'boolean' ? e.secure : stored.email.secure,
      user: str(e.user, stored.email.user, 253),
      pass: secret(e.pass, stored.email.pass),
      from: str(e.from, stored.email.from, 320),
      to: str(e.to, stored.email.to, 1000),
    },
  };
}
export function redactNotify(n) {
  return {
    ...n,
    webhook: { ...n.webhook, url: n.webhook.url ? SECRET_MASK : '' },
    email: { ...n.email, pass: n.email.pass ? SECRET_MASK : '' },
  };
}
/** Settings from before channels were dynamic had exactly this many SRT entries, then one UDP entry. */
const LEGACY_SRT_CHANNELS = 6;
/** Pause between two channel launches, so each ffmpeg's start-up cost shows in the CPU figure before the next decision. */
const START_STAGGER_MS = 2500;
/** Only fields the form can set; never trust the file for secrets. */
export function sanitizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw;
  if (o.mode !== 'listener' && o.mode !== 'caller' && o.mode !== 'multicast' && o.mode !== 'hls') return null;
  const port = Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (o.mode === 'hls' && (typeof o.url !== 'string' || !/^https?:[/][/]/i.test(o.url) || o.url.length > 2048)) return null;
  return {
    mode: o.mode,
    host: typeof o.host === 'string' ? o.host.slice(0, 253) : '',
    port,
    ...(o.mode === 'hls' ? { url: o.url } : {}),
    ...(typeof o.iface === 'string' && o.iface ? { iface: o.iface.slice(0, 45) } : {}),
    latencyMs: num(o.latencyMs, 120, 20, 60_000),
    transcodePreview: o.transcodePreview === true,
    lightAnalysis: o.lightAnalysis !== false,
  };
}
/**
 * Channels from the settings file. Entries written before channels were dynamic have no `id` or `kind`:
 * they keep their position as the id (so logs and names still line up) and the entries after the sixth are UDP.
 */
export function parseStoredChannels(raw, base = DEFAULT_THRESHOLDS) {
  if (!Array.isArray(raw)) return [];
  const used = new Set();
  const out = [];
  raw.slice(0, MAX_CHANNELS).forEach((entry, i) => {
    const c = entry && typeof entry === 'object' ? entry : {};
    const kind = c.kind === 'udp' || c.kind === 'srt' || c.kind === 'hls' ? c.kind : i >= LEGACY_SRT_CHANNELS ? 'udp' : 'srt';
    let id = Number.isInteger(c.id) && c.id >= 1 ? c.id : i + 1;
    while (used.has(id)) id++;
    used.add(id);
    out.push({
      id,
      kind,
      name: sanitizeName(c.name, defaultChannelName(id, kind)),
      thresholds: sanitizeThresholds(c.thresholds, base),
      config: sanitizeConfig(c.config),
    });
  });
  return out.sort((a, b) => a.id - b.id);
}
/** Owns the channels (as many as the CPU allows), the shared notifier, persisted settings, daily logs and the SSE clients. */
export class SrtMonitor {
  opts;
  channels = [];
  log;
  notifier;
  clients = new Set();
  notify;
  maxCpu;
  nextId = 1;
  heartbeat;
  host;
  liveTransmit;
  disposed = false;
  /** Channels waiting for their turn to start (see `queueStart`). */
  queue = [];
  draining = false;
  ffmpeg;
  srtLiveTransmit;
  constructor(opts) {
    this.opts = opts;
    this.log = new DailyLog(opts.logDir);
    this.ffmpeg = ffmpegAvailable(opts.ffmpegPath);
    this.liveTransmit = findLiveTransmit();
    this.srtLiveTransmit = this.liveTransmit !== null;
    const stored = this.load();
    this.notify = stored.notify;
    this.maxCpu = stored.maxCpuPct;
    this.notifier = new Notifier(
      () => this.notify,
      (alert, results) => {
        this.broadcast('notify', { ch: alert.channelId ?? 0, alertId: alert.id, results });
        const summary = results.map((r) => `${r.channel}: ${r.ok ? 'sent' : `FAILED (${r.error})`}`).join(', ');
        this.log.write(
          alert.channelId ?? 0,
          alert.channelName ?? '',
          results.some((r) => !r.ok) ? 'ERROR' : 'INFO',
          'notify',
          `${alert.rule} → ${summary}`,
          true,
          this.channels.find((c) => c.id === alert.channelId)?.kind,
        );
      },
    );
    this.host = {
      broadcast: (event, data) => this.broadcast(event, data),
      notify: (alert) => void this.notifier.notify(alert),
      log: (...args) => this.log.write(...args),
      persist: () => this.save(),
    };
    for (const c of stored.channels) this.channels.push(this.makeChannel(c));
    // Log file names follow the channel names: claim them in id order so a restart gives every channel the same file again.
    for (const c of [...this.channels].sort((x, y) => x.id - y.id)) this.log.reserve(c.id, c.name, c.kind);
    this.nextId = Math.max(0, ...this.channels.map((c) => c.id)) + 1;
    // A first run gets one empty channel so the page has something to configure; more are added from the panel.
    if (!this.channels.length) this.addChannel('srt', undefined, false);
    this.log.write(
      0,
      '',
      'INFO',
      'server',
      `monitor ready: ffmpeg ${this.ffmpeg ? 'found' : 'MISSING'}, srt-live-transmit ${this.liveTransmit ? 'found' : 'not found (basic mode)'}, ${this.channels.length} channel(s), CPU limit ${this.maxCpu}%`,
    );
    cpuSampler.start(() => this.broadcast('cpu', this.cpuStatus()));
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.write(': keep-alive\n\n');
    }, 20_000);
    this.heartbeat.unref();
  }
  makeChannel(init) {
    return new SrtChannel(init.id, init, this.host, {
      ffmpegPath: this.opts.ffmpegPath,
      srtLiveTransmitPath: this.liveTransmit,
      previewRoot: this.opts.previewDir,
    });
  }
  // ------------------------------------------------------------- settings
  load() {
    let raw = {};
    try {
      if (existsSync(this.opts.settingsPath)) raw = JSON.parse(readFileSync(this.opts.settingsPath, 'utf8'));
    } catch {
      /* corrupt file: fall back to defaults */
    }
    // Files from the single-stream version kept one set of rules at the top level: use it for every channel.
    const channels = parseStoredChannels(raw.channels, sanitizeThresholds(raw.thresholds));
    const notify = mergeNotify(raw.notify);
    // A fixed webhook for every channel can come from the environment instead of the form.
    const envUrl = process.env.SRT_WEBHOOK_URL?.trim();
    if (envUrl && !notify.webhook.url) {
      const kind = process.env.SRT_WEBHOOK_KIND;
      notify.webhook = { enabled: true, kind: kind === 'teams' || kind === 'generic' ? kind : 'slack', url: envUrl };
    }
    return { notify, channels, maxCpuPct: Math.round(num(raw.maxCpuPct, DEFAULT_MAX_CPU, 10, 100)) };
  }
  save() {
    const data = {
      notify: this.notify,
      maxCpuPct: this.maxCpu,
      channels: this.channels.map((c) => ({ id: c.id, kind: c.kind, name: c.name, thresholds: c.thresholds, config: c.config })),
    };
    try {
      mkdirSync(dirname(this.opts.settingsPath), { recursive: true });
      writeFileSync(this.opts.settingsPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      chmodSync(this.opts.settingsPath, 0o600);
    } catch (err) {
      this.log.write(0, '', 'ERROR', 'server', `could not save settings: ${err instanceof Error ? err.message : err}`);
    }
  }
  channel(id) {
    const c = this.channels.find((x) => x.id === Number(id));
    if (!c) throw new Error('Unknown channel (it may have been removed)');
    return c;
  }
  /** Path of the wall thumbnail the channel's ffmpeg keeps rewriting. */
  thumbPath(id) {
    return join(this.opts.previewDir, 'thumb', `${id}.jpg`);
  }
  // ------------------------------------------------------- channel list
  /** Adds an empty channel (or one pre-filled with `config`) and tells every open page. */
  addChannel(kind, name, announce = true, config = null) {
    if (this.channels.length >= MAX_CHANNELS) throw new Error(`At most ${MAX_CHANNELS} channels are supported`);
    const id = this.nextId++;
    const thresholds = { ...(this.channels.at(-1)?.thresholds ?? DEFAULT_THRESHOLDS) };
    const c = this.makeChannel({ id, kind, name: sanitizeName(name, defaultChannelName(id, kind)), thresholds, config });
    this.channels.push(c);
    this.log.write(id, c.name, 'INFO', 'control', 'channel added', false, kind);
    if (announce) {
      this.save();
      this.broadcast('status', this.status());
    }
    return c;
  }
  /** Stops the channel and forgets it: its tile, settings and thumbnail go. Its past log lines stay in the daily files. */
  removeChannel(id) {
    const c = this.channel(id);
    c.stop();
    c.dispose();
    this.channels.splice(this.channels.indexOf(c), 1);
    this.queue = this.queue.filter((q) => q.id !== c.id);
    try {
      rmSync(this.thumbPath(c.id), { force: true });
      rmSync(join(this.opts.previewDir, `ch${c.id}`), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    this.log.write(c.id, c.name, 'INFO', 'control', 'channel removed', false, c.kind);
    this.save();
    this.broadcast('status', this.status());
  }
  /**
   * Creates many channels at once from parsed addresses. Items that do not validate are reported, not fatal.
   * With `startNow` they join the start queue, which stops launching when the CPU limit is reached.
   */
  bulkAdd(items, startNow) {
    if (!Array.isArray(items)) throw new Error('items must be a list');
    const failed = [];
    const toStart = [];
    let added = 0;
    items.forEach((raw, index) => {
      try {
        const item = raw ?? {};
        const cfg = validateConfig(item.config);
        const c = this.addChannel(
          cfg.mode === 'multicast' ? 'udp' : cfg.mode === 'hls' ? 'hls' : 'srt',
          item.name,
          false,
          sanitizeConfig(cfg),
        );
        added++;
        toStart.push({ id: c.id, config: item.config });
      } catch (err) {
        failed.push({ index, error: err instanceof Error ? err.message : String(err) });
      }
    });
    this.save();
    this.broadcast('status', this.status());
    if (startNow) this.queueStart(toStart);
    return { added, failed };
  }
  /** Name and rules of one channel. */
  updateChannel(id, raw) {
    const c = this.channel(id);
    const o = raw ?? {};
    if (o.name !== undefined) c.rename(sanitizeName(o.name, defaultChannelName(c.id, c.kind)));
    if (o.thresholds !== undefined) c.setThresholds(sanitizeThresholds(o.thresholds, c.thresholds));
    this.save();
    this.broadcast('channel', { ch: c.id, name: c.name, thresholds: c.thresholds });
  }
  /** Copies one channel's rules to the others. */
  copyRules(id) {
    const from = this.channel(id);
    for (const c of this.channels) if (c !== from) c.setThresholds({ ...from.thresholds });
    this.save();
    this.log.write(from.id, from.name, 'INFO', 'control', 'alert rules copied to all channels', false, from.kind);
    this.broadcast('status', this.status());
  }
  /** Shared webhook / email settings. */
  updateNotify(raw) {
    this.notify = mergeNotify(raw, this.notify);
    this.save();
    this.log.write(
      0,
      '',
      'INFO',
      'server',
      `notification settings saved (webhook ${this.notify.webhook.enabled ? 'on' : 'off'}, email ${this.notify.email.enabled ? 'on' : 'off'})`,
    );
    return redactNotify(this.notify);
  }
  /** The CPU ceiling for starting channels. */
  updateLimits(raw) {
    const o = raw ?? {};
    this.maxCpu = Math.round(num(o.maxCpuPct, this.maxCpu, 10, 100));
    this.save();
    this.log.write(0, '', 'INFO', 'server', `CPU limit set to ${this.maxCpu}%`);
    const status = this.cpuStatus();
    this.broadcast('cpu', status);
    return status;
  }
  cpuStatus() {
    return { pct: Math.round(cpuSampler.pct * 10) / 10, limit: this.maxCpu, cores: cpus().length };
  }
  async testNotify(id) {
    const c = id === undefined ? null : this.channel(id);
    const alert = {
      id: 0,
      rule: 'test',
      key: 'test',
      severity: 'warning',
      state: 'event',
      message: `This is a test notification from Pulse SRT monitoring${c ? ` for "${c.name}"` : ''}.`,
      at: Date.now(),
      ...(c ? { channelId: c.id, channelName: c.name } : {}),
    };
    return this.notifier.deliver(alert);
  }
  // -------------------------------------------------------------- control
  /** `cpuNow` is the CPU figure to judge against: the smoothed one by default, the newest sample while a queue is draining. */
  start(id, raw, cpuNow = cpuSampler.pct) {
    if (!this.ffmpeg) throw new Error(`ffmpeg was not found (looked for "${this.opts.ffmpegPath}"). Install it or set FFMPEG_PATH.`);
    const c = this.channel(id);
    const o = raw ?? {};
    if (o.mode === 'listener') {
      const clash = this.channels.find(
        (x) => x !== c && x.session.running && x.config?.mode === 'listener' && x.config.port === Number(o.port),
      );
      if (clash) throw new Error(`Port ${o.port} is already used by listener "${clash.name}". Give each listener its own port.`);
    }
    const block = cpuBlock(cpuNow, this.maxCpu);
    if (block) throw new Error(block);
    c.start(raw);
  }
  /** Queues every stopped channel that has saved connection settings. Returns how many were queued. */
  startAll() {
    return this.queueStart(this.channels.filter((c) => !c.session.running && c.config).map((c) => ({ id: c.id })));
  }
  /**
   * Starts channels one at a time, a few seconds apart, and stops launching as soon as the machine reaches
   * the CPU limit: the rest are reported, not started. Runs in the background; progress arrives as events.
   */
  queueStart(items) {
    const fresh = items.filter((i) => !this.queue.some((q) => q.id === i.id));
    this.queue.push(...fresh);
    if (!this.draining) void this.drainQueue();
    return fresh.length;
  }
  async drainQueue() {
    this.draining = true;
    let started = 0;
    const notStarted = [];
    let blocked = null;
    try {
      while (this.queue.length && !this.disposed) {
        const item = this.queue.shift();
        const c = this.channels.find((x) => x.id === item.id);
        if (!c || c.session.running) continue;
        try {
          // After the first launch use the newest sample: it is the one that includes the previous ffmpeg.
          this.start(c.id, item.config ?? c.config, started ? cpuSampler.latest : cpuSampler.pct);
          started++;
          this.broadcast('status', this.status());
          if (this.queue.length) await new Promise((r) => setTimeout(r, START_STAGGER_MS));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/CPU is at/.test(msg)) {
            blocked = msg;
            notStarted.push(c.name, ...this.queue.map((q) => this.channels.find((x) => x.id === q.id)?.name ?? ''));
            this.queue = [];
          } else {
            notStarted.push(`${c.name} (${msg})`);
          }
        }
      }
    } finally {
      this.draining = false;
    }
    if (notStarted.length || blocked) {
      const names = notStarted.filter(Boolean);
      const text = `${started} channel${started === 1 ? '' : 's'} started. Not started: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` and ${names.length - 8} more` : ''}.${blocked ? ` ${blocked}` : ''}`;
      this.log.write(0, '', 'WARN', 'server', text);
      this.broadcast('notice', { text });
    } else if (started) {
      this.broadcast('notice', { text: `${started} channel${started === 1 ? '' : 's'} started` });
    }
  }
  stop(id) {
    this.channel(id).stop();
  }
  /** The channel whose picture the browser is watching. Only that one runs a preview encoder. */
  watch(id) {
    const c = this.channel(id);
    for (const x of this.channels) x.session.setWatching(x === c);
  }
  stopAll() {
    this.queue = [];
    for (const c of this.channels) c.stop();
  }
  status() {
    return {
      available: true,
      ffmpeg: this.ffmpeg,
      srtLiveTransmit: this.srtLiveTransmit,
      channels: this.channels.map((c) => c.status()),
      notify: redactNotify(this.notify),
      logDir: this.log.todayDir(),
      cpu: this.cpuStatus(),
    };
  }
  /** Browser pages currently listening for live updates. */
  get clientCount() {
    return this.clients.size;
  }
  get runningCount() {
    return this.channels.filter((c) => c.session.running).length;
  }
  // ------------------------------------------------------------------ SSE
  addClient(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    res.write(`event: status\ndata: ${JSON.stringify(this.status())}\n\n`);
  }
  broadcast(event, data) {
    if (!this.clients.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(payload);
  }
  dispose() {
    this.disposed = true;
    this.queue = [];
    clearInterval(this.heartbeat);
    cpuSampler.stop();
    for (const c of this.channels) c.dispose();
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.log.write(0, '', 'INFO', 'server', 'monitor stopped');
  }
}
