import { historyStore } from './history-store';
import { defaultChannelName } from './types';
const MAX_LOG = 300;
const MAX_ALERTS = 500;
/** Three minutes at one sample per second. */
const MAX_HISTORY = 180;
const SELECTED_KEY = 'sap.srt.selected.v1';
async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/__srt/${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      'Cannot reach the Pulse server. Make sure it is still running (npm run dev, or PlayProbe.exe) and that this page was opened from it.',
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}
/**
 * Talks to the SRT monitoring API of the dev / preview server. Mirrors the
 * PlayerController style: `on(name, fn)` for the events the UI listens to.
 *
 * It tracks all channels; the plain getters (`snapshot`, `alerts`, `history`…) describe the
 * *selected* channel, which is what the SRT and Alerts tabs show. Events:
 *   status    structure changed (first load, rename, start / stop, reconnect)
 *   snapshot  the selected channel's numbers changed
 *   channels  anything changed on any channel (the wall listens to this)
 *   alert     an alert on any channel (detail: Alert)
 *   cpu       the machine CPU figure changed
 *   notice    the server has something to tell the user (detail: { text }), e.g. why a start was skipped
 *   scte, log, notify, settings, select, preview
 */
export class SrtClient {
  /** False on static hosting (no SRT back end). */
  available = false;
  ffmpeg = false;
  srtLiveTransmit = false;
  connected = false;
  channels = [];
  notify = null;
  logDir = '';
  cpu = null;
  selectedId = 1;
  handlers = new Map();
  source = null;
  constructor() {
    try {
      const saved = Number(localStorage.getItem(SELECTED_KEY));
      if (Number.isInteger(saved) && saved >= 1) this.selectedId = saved;
    } catch {
      /* storage unavailable */
    }
  }
  on(name, fn) {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
  emit(name, detail) {
    for (const fn of this.handlers.get(name) ?? []) fn(detail);
  }
  // ------------------------------------------- selected channel (what the tabs show)
  get current() {
    return this.channels.find((c) => c.id === this.selectedId) ?? this.channels[0] ?? null;
  }
  get snapshot() {
    return this.current?.snapshot ?? null;
  }
  get alerts() {
    return this.current?.alerts ?? [];
  }
  get logs() {
    return this.current?.logs ?? [];
  }
  get scte() {
    return this.current?.scte ?? [];
  }
  get history() {
    return this.current?.history ?? [];
  }
  get settings() {
    const c = this.current;
    return c && this.notify ? { thresholds: c.thresholds, notify: this.notify } : null;
  }
  get activeAlerts() {
    return this.alerts.filter((a) => a.state === 'raised');
  }
  get running() {
    return this.isRunning(this.current);
  }
  isRunning(c) {
    const s = c?.snapshot.state;
    return s !== undefined && s !== 'idle';
  }
  activeCount(c) {
    return c.alerts.filter((a) => a.state === 'raised').length;
  }
  /** Active alerts on every channel (the header button). */
  get totalActive() {
    return this.channels.reduce((n, c) => n + this.activeCount(c), 0);
  }
  get anyRunning() {
    return this.channels.some((c) => this.isRunning(c));
  }
  channelName(id) {
    return this.channels.find((c) => c.id === id)?.name ?? defaultChannelName(id);
  }
  /** The wall picture of a channel. The timestamp makes the browser fetch each new frame instead of its cached copy. */
  thumbUrl(c) {
    return c.snapshot.thumbAt ? `/__srt/thumb/${c.id}.jpg?t=${c.snapshot.thumbAt}` : null;
  }
  // ---------------------------------------------------------------- connection
  /** Detects the back end and subscribes to its events. Safe to call on any host. */
  async init() {
    try {
      const status = await request('GET', 'status');
      if (!status.available) return;
      this.available = true;
      this.applyStatus(status);
      this.connect();
      void this.watch(this.selectedId);
    } catch {
      this.available = false;
    }
    this.emit('status');
  }
  applyStatus(s) {
    this.ffmpeg = s.ffmpeg;
    this.srtLiveTransmit = s.srtLiveTransmit;
    this.notify = s.notify;
    this.logDir = s.logDir;
    this.cpu = s.cpu;
    this.channels = s.channels.map((c) => {
      const old = this.channels.find((o) => o.id === c.id);
      return { ...c, logs: old?.logs ?? [], scte: old?.scte ?? [], history: old?.history ?? [], lastPreview: old?.lastPreview ?? null };
    });
    if (!this.channels.some((c) => c.id === this.selectedId)) this.selectedId = this.channels[0]?.id ?? 1;
    for (const c of this.channels) {
      this.trackPreview(c);
      for (const a of c.alerts) historyStore.recordAlert(c.id, a);
    }
  }
  channel(id) {
    return this.channels.find((c) => c.id === id);
  }
  connect() {
    this.source?.close();
    const es = new EventSource('/__srt/events');
    this.source = es;
    es.onopen = () => {
      this.connected = true;
      this.emit('status');
    };
    es.onerror = () => {
      this.connected = false;
      this.emit('status');
    };
    const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
    on('status', (s) => {
      this.applyStatus(s);
      this.emit('status');
      this.emit('channels');
    });
    on('snapshot', ({ ch, snapshot: s }) => {
      const c = this.channel(ch);
      if (!c) return;
      c.snapshot = s;
      // The first seconds after connecting are ffmpeg's probe burst, not the stream's real rate.
      const settled = s.connectedAt !== null && s.now - s.connectedAt > 4000;
      if (settled && (s.state === 'connected' || s.state === 'stalled')) {
        c.history.push({ t: s.now, kbps: s.ts?.bitrateKbps ?? 0, rttMs: s.link?.rttMs ?? null, bufferMs: s.link?.recvBufferMs ?? null });
        if (c.history.length > MAX_HISTORY) c.history.shift();
        historyStore.recordSample(ch, s.now, s.ts?.bitrateKbps ?? 0, s.link?.rttMs ?? null, s.link?.recvBufferMs ?? null);
      }
      this.trackPreview(c);
      if (ch === this.selectedId) this.emit('snapshot');
      this.emit('channels');
    });
    on('alert', (a) => {
      const c = this.channel(a.channelId ?? 0);
      if (!c) return;
      const i = c.alerts.findIndex((x) => x.id === a.id);
      if (i >= 0) c.alerts[i] = a;
      else c.alerts.unshift(a);
      if (c.alerts.length > MAX_ALERTS) c.alerts.length = MAX_ALERTS;
      historyStore.recordAlert(c.id, a);
      this.emit('alert', a);
      this.emit('channels');
    });
    on('scte', (m) => {
      const c = this.channel(m.ch);
      if (!c) return;
      c.scte.unshift(m);
      if (c.scte.length > 200) c.scte.length = 200;
      if (m.ch === this.selectedId) this.emit('scte', m);
    });
    on('log', (l) => {
      const c = this.channel(l.ch);
      if (!c) return;
      c.logs.unshift({ at: l.at, line: l.line });
      if (c.logs.length > MAX_LOG) c.logs.length = MAX_LOG;
      if (l.ch === this.selectedId) this.emit('log');
    });
    on('notify', (n) => this.emit('notify', n));
    on('cpu', (c) => {
      this.cpu = c;
      this.emit('cpu');
    });
    on('notice', (n) => this.emit('notice', n));
    on('channel', (d) => {
      const c = this.channel(d.ch);
      if (!c) return;
      c.name = d.name;
      c.thresholds = d.thresholds;
      this.emit('settings');
      this.emit('channels');
    });
  }
  /** Fires `preview` (url) when the selected channel's preview playlist becomes available. */
  trackPreview(c) {
    const url = c.snapshot.previewUrl;
    if (url && url !== c.lastPreview && c.id === this.selectedId) this.emit('preview', url);
    c.lastPreview = url;
  }
  /** Make a tile the one the tabs and the player follow. */
  select(id) {
    const c = this.channel(id);
    if (!c) return;
    this.selectedId = id;
    try {
      localStorage.setItem(SELECTED_KEY, String(id));
    } catch {
      /* storage unavailable */
    }
    void this.watch(id);
    this.emit('select', id);
    this.emit('status');
    this.emit('snapshot');
    this.emit('settings');
    this.emit('channels');
    if (c.snapshot.previewUrl) this.emit('preview', c.snapshot.previewUrl);
  }
  // -------------------------------------------------------------------- actions
  async run(status) {
    const s = await status;
    this.applyStatus(s);
    this.emit('status');
    this.emit('channels');
    return s;
  }
  async start(id, config) {
    const c = this.channel(id);
    if (c) {
      c.scte = [];
      c.logs = [];
      c.history = [];
    }
    await this.run(request('POST', `ch/${id}/start`, config));
  }
  /** Ask the server to prepare a browser preview for this channel (and drop the previous one). */
  async watch(id) {
    try {
      await request('POST', `ch/${id}/watch`);
    } catch {
      /* the next status update shows the connection problem */
    }
  }
  async stop(id) {
    await this.run(request('POST', `ch/${id}/stop`));
  }
  /**
   * Queues every stopped channel that has saved connection settings and returns how many. The server starts them one by
   * one and stops at its CPU limit; what it could not start arrives as a `notice` event.
   */
  async startAll() {
    const s = await this.run(request('POST', 'start-all'));
    return s.queued ?? 0;
  }
  /** Adds an empty channel and returns its id (the highest id after the call). */
  async addChannel(kind, name) {
    const s = await this.run(request('POST', 'channels', { kind, name }));
    return Math.max(...s.channels.map((c) => c.id));
  }
  /** Stops and removes a channel. If it was the selected one, the first remaining channel is selected. */
  async removeChannel(id) {
    const wasSelected = this.selectedId === id;
    await this.run(request('DELETE', `ch/${id}`));
    if (wasSelected && this.channels[0]) this.select(this.channels[0].id);
  }
  /** Creates one channel per address; with `start` the server also launches them (within the CPU limit). */
  async bulkAdd(items, start) {
    const s = await this.run(request('POST', 'bulk', { items, start }));
    const r = s;
    return { added: r.added, failed: r.failed };
  }
  async setMaxCpu(maxCpuPct) {
    await this.run(request('PUT', 'limits', { maxCpuPct }));
    this.emit('cpu');
  }
  async stopAll() {
    await this.run(request('POST', 'stop-all'));
  }
  /** Name and / or rules of one channel. */
  async saveChannel(id, patch) {
    await this.run(request('PUT', `ch/${id}`, patch));
    this.emit('settings');
  }
  async copyRules(id) {
    await this.run(request('POST', `ch/${id}/copy-rules`));
    this.emit('settings');
  }
  async saveNotify(next) {
    this.notify = await request('PUT', 'notify', next);
    this.emit('settings');
  }
  async testNotify(ch) {
    return (await request('POST', 'notify-test', { ch })).results;
  }
}
