import { MAX_NAME_LENGTH, kindLabel } from '../../srt/types';
import { formatStreamUrl, parseStreamLine, parseStreamList, parseStreamUrl } from '../../srt/url';
import { badge, clear, h } from '../dom';
import { SrtWall, WALL_SIZES } from './wall';
const KIND_WITH_ARTICLE = { srt: 'an SRT', udp: 'a UDP', hls: 'an HLS' };
const KIND_ADDRESS = { srt: 'an srt://', udp: 'a udp://@group:port', hls: 'an https://….m3u8' };
const WALL_PREFS_KEY = 'sap.srt.wall.v1';
const BULK_PLACEHOLDER =
  'Sports East | srt://203.0.113.10:7003?mode=caller&latency=120\nsrt://:9001\nNews UDP | udp://@239.1.1.1:5000\nCDN feed | https://example.com/live/master.m3u8\n# lines starting with # are ignored';
const field = (text, control, hint) =>
  h('label', { class: 'drm-field' }, h('span', null, text, hint ? h('small', null, ` ${hint}`) : ''), control);
const stateKind = (state) =>
  state === 'connected' ? 'ok' : state === 'idle' ? '' : state === 'stalled' || state === 'reconnecting' ? 'warn' : 'accent';
const option = (value, text) => h('option', { value }, text);
function loadWallPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(WALL_PREFS_KEY) ?? '{}');
    return {
      size: p.size && WALL_SIZES.includes(p.size) ? p.size : 'auto',
      filter: p.filter && ['all', 'running', 'problems', 'stopped', 'srt', 'udp', 'hls'].includes(p.filter) ? p.filter : 'all',
    };
  } catch {
    return { size: 'auto', filter: 'all' };
  }
}
/**
 * SRT / UDP monitoring panel: a toolbar, the CPU budget, the multiviewer wall (one live tile per channel, as
 * many as the CPU allows) and the connection form of the selected tile. Choosing a tile makes the stats tabs
 * and the player follow it.
 */
export class SrtPanel {
  el;
  client;
  hooks;
  wall;
  refreshTimer = null;
  address = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, 'aria-label': 'Channel address' });
  title = h('legend');
  nameInput = h('input', {
    type: 'text',
    maxLength: MAX_NAME_LENGTH,
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Channel name',
  });
  transcode = h('input', { type: 'checkbox' });
  light = h('input', { type: 'checkbox' });
  startBtn = h('button', { type: 'button', class: 'primary', onclick: () => void this.start() }, 'Start');
  stopBtn = h('button', { type: 'button', onclick: () => void this.stop() }, 'Stop');
  deleteBtn = h('button', { type: 'button', class: 'danger', onclick: () => void this.remove() }, 'Delete channel');
  startAllBtn = h('button', { type: 'button', onclick: () => void this.startAll() }, 'Start all');
  stopAllBtn = h('button', { type: 'button', onclick: () => void this.stopAll() }, 'Stop all');
  quitBtn = h('button', { type: 'button', hidden: true, onclick: () => void this.quit() }, 'Quit Pulse');
  urlHint = h('small', { class: 'muted' });
  status = h('div', { class: 'srt-status' });
  notice = h('div', { class: 'srt-notice' });
  logInfo = h('small', { class: 'muted' });
  loadInfo = h('div', { class: 'srt-load muted small' });
  summary = h('span', { class: 'mv-summary muted small' });
  sizeSel = h('select', { 'aria-label': 'Tile size' }, [
    option('auto', 'Auto grid'),
    option('2x2', '2 × 2 grid'),
    option('3x3', '3 × 3 grid'),
    option('4x4', '4 × 4 grid'),
    option('5x5', '5 × 5 grid'),
    option('6x6', '6 × 6 grid'),
    option('8x8', '8 × 8 grid'),
  ]);
  filterSel = h('select', { 'aria-label': 'Show channels' }, [
    option('all', 'Show all'),
    option('running', 'Running only'),
    option('problems', 'Problems only'),
    option('stopped', 'Stopped only'),
    option('srt', 'SRT only'),
    option('udp', 'UDP only'),
    option('hls', 'HLS only'),
  ]);
  cpuRing = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  cpuArc;
  cpuTick;
  cpuPct = h('strong', { class: 'mv-ring-pct' }, '0%');
  cpuText = h('span', { class: 'mv-cpu-text' });
  cpuNote = h('small', { class: 'muted' });
  cpuLimit = h('input', { type: 'number', min: 10, max: 100, step: 5, 'aria-label': 'CPU limit in percent' });
  cpuBox = h('div', { class: 'mv-cpu' });
  bulkText = h('textarea', {
    rows: 6,
    spellcheck: false,
    'aria-label': 'Addresses to add',
    placeholder: BULK_PLACEHOLDER,
  });
  bulkStart = h('input', { type: 'checkbox', checked: true });
  bulkResult = h('div', { class: 'small' });
  bulk;
  manual = h('fieldset', { class: 'drm-box', hidden: true });
  addMode = 'none';
  /** `udp` shows only the UDP / multicast channels and adds new ones as UDP; `all` is the full wall. */
  currentView = 'all';
  manualItem = h('button', { type: 'button', role: 'menuitem', onclick: () => void this.addManual() }, 'Add SRT channel manually');
  addMenu = h('div', { class: 'add-menu', hidden: true, role: 'menu' });
  addBtn = h(
    'button',
    { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => this.toggleAddMenu() },
    '＋ Add channel ▾',
  );
  /** Which channel the form currently shows, so live updates never overwrite typing. */
  filledFor = 0;
  constructor(el, client, hooks) {
    this.el = el;
    this.client = client;
    this.hooks = hooks;
    this.wall = new SrtWall(client, {
      onPick: (id) => this.pick(id),
      onSummary: (s) => {
        this.summary.textContent = `${s.total} channel${s.total === 1 ? '' : 's'} · ${s.live} live · ${s.alerts} alert${s.alerts === 1 ? '' : 's'}${s.shown !== s.total ? ` · showing ${s.shown}` : ''}`;
      },
    });
    const prefs = loadWallPrefs();
    this.sizeSel.value = prefs.size;
    this.filterSel.value = prefs.filter;
    this.wall.setSize(prefs.size);
    this.wall.setFilter(prefs.filter);
    this.currentView = prefs.filter === 'udp' ? 'udp' : 'all';
    this.sizeSel.addEventListener('change', () => {
      this.wall.setSize(this.sizeSel.value);
      this.savePrefs();
    });
    this.filterSel.addEventListener('change', () => {
      this.wall.setFilter(this.filterSel.value);
      this.savePrefs();
    });
    this.cpuRing.setAttribute('viewBox', '0 0 100 100');
    this.cpuRing.setAttribute('class', 'mv-ring');
    this.cpuRing.innerHTML =
      '<defs><linearGradient id="mv-ring-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--ring-a)"/><stop offset="1" stop-color="var(--ring-b)"/></linearGradient></defs>' +
      '<circle class="mv-ring-track" cx="50" cy="50" r="42" pathLength="100"/>' +
      '<circle class="mv-ring-arc" cx="50" cy="50" r="42" pathLength="100" stroke-dasharray="0 100"/>' +
      '<line class="mv-ring-tick" x1="84" y1="50" x2="98" y2="50"/>';
    this.cpuArc = this.cpuRing.querySelector('.mv-ring-arc');
    this.cpuTick = this.cpuRing.querySelector('.mv-ring-tick');
    this.cpuBox.setAttribute('role', 'meter');
    this.cpuBox.setAttribute('aria-label', 'Computer CPU use');
    this.cpuBox.append(
      h('div', { class: 'mv-ring-wrap' }, this.cpuRing, this.cpuPct),
      h(
        'div',
        { class: 'mv-ring-info' },
        h('span', { class: 'mv-cpu-label' }, 'Computer CPU'),
        this.cpuText,
        h('label', { class: 'mv-cpu-limit' }, 'No new channel above ', this.cpuLimit, '%'),
        this.cpuNote,
        this.loadInfo,
      ),
    );
    this.cpuLimit.addEventListener('change', () => void this.saveLimit());
    this.bulk = h(
      'div',
      { class: 'mv-bulk', hidden: true },
      h(
        'p',
        { class: 'muted small' },
        'One per line: an srt://, udp:// or https:// HLS playlist (.m3u8) address, optionally with a name in front (followed by | or a comma). ',
        'srt://host:port is a caller; srt://:port (no host) or mode=listener waits for an encoder.',
      ),
      this.bulkText,
      h(
        'div',
        { class: 'srt-actions' },
        h('label', { class: 'srt-check' }, this.bulkStart, ' Start them now, one by one (stops at the CPU limit)'),
        h('button', { type: 'button', class: 'primary', onclick: () => void this.addBulk() }, 'Add channels'),
      ),
      this.bulkResult,
    );
    el.append(
      this.notice,
      h(
        'div',
        { class: 'srt-actions mv-toolbar' },
        this.addBtn,
        this.startAllBtn,
        this.stopAllBtn,
        this.sizeSel,
        this.filterSel,
        h('button', { type: 'button', onclick: () => void this.wall.toggleFullscreen() }, 'Fullscreen wall'),
        this.quitBtn,
        this.summary,
      ),
      this.cpuBox,
      this.addMenu,
      this.bulk,
      this.manual,
      this.wall.el,
    );
    this.manual.append(
      this.title,
      h(
        'div',
        { class: 'drm-grid' },
        field('Name', this.nameInput, '(shown in every alert and notification)'),
        field('Address', this.address, '(srt://…, udp://@… or an https://….m3u8 playlist: the same format as above)'),
      ),
      this.urlHint,
      h(
        'label',
        { class: 'srt-check' },
        this.light,
        ' Light analysis ',
        h(
          'small',
          null,
          '(check keyframes only for black video: far less CPU. Turn off to decode every frame and catch damaged P/B frames)',
        ),
      ),
      h('div', { class: 'srt-actions' }, this.startBtn, this.stopBtn, this.deleteBtn, this.status),
    );
    this.addMenu.append(
      h('button', { type: 'button', role: 'menuitem', onclick: () => this.setAddMode('url') }, 'Add by URL list'),
      this.manualItem,
    );
    this.address.addEventListener('input', () => this.renderMode());
    this.address.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.startBtn.disabled) void this.start();
    });
    this.nameInput.addEventListener('change', () => void this.rename());
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.nameInput.blur();
    });
    client.on('status', () => this.sync());
    client.on('select', () => this.sync());
    client.on('channels', () => this.scheduleRefresh());
    client.on('settings', () => this.scheduleRefresh());
    client.on('cpu', () => this.renderCpu());
    client.on('notice', (n) => this.hooks.toast(n.text));
    this.sync();
    this.pollLoad();
    // Only the desktop app (PlayProbe.exe) has a process to quit.
    fetch('/__app/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        this.quitBtn.hidden = !info?.desktop;
      })
      .catch(() => undefined);
  }
  savePrefs() {
    try {
      localStorage.setItem(WALL_PREFS_KEY, JSON.stringify({ size: this.sizeSel.value, filter: this.filterSel.value }));
    } catch {
      /* storage unavailable */
    }
  }
  /**
   * For an `srt://host:port?mode=…` or `udp://@239.1.1.1:5000` address typed into the player box:
   * browsers cannot play those, so give it a channel (a new one if none is free) and fill its form.
   */
  async prefillFromUrl(raw) {
    const parsed = parseStreamLine(raw);
    if (!parsed) return null;
    if ('error' in parsed) return parsed.error;
    const cfg = parsed.config;
    const kind = cfg.mode === 'multicast' ? 'udp' : cfg.mode === 'hls' ? 'hls' : 'srt';
    const free = this.client.channels.find((c) => c.kind === kind && !c.config && !this.client.isRunning(c));
    let ch = free;
    try {
      if (!ch) {
        const id = await this.client.addChannel(kind, parsed.name);
        ch = this.client.channels.find((c) => c.id === id);
      }
    } catch (err) {
      return `Could not add a channel: ${err instanceof Error ? err.message : err}`;
    }
    if (!ch) return null;
    this.client.select(ch.id);
    this.hooks.onSelect(ch.id);
    this.toggle(true);
    this.addMode = 'none';
    this.setAddMode('manual');
    this.address.value = formatStreamUrl(cfg);
    this.renderMode();
    return `${ch.name}: filled in ${raw.trim().split('?')[0]}. Press Start.`;
  }
  /** Machine and process load, refreshed every few seconds while the panel is open. */
  pollLoad() {
    const tick = async () => {
      if (this.el.hidden || !this.client.available) return;
      try {
        const r = await (await fetch('/__srt/load')).json();
        const gb = (mb) => (mb / 1024).toFixed(1);
        const parts = [
          `Machine: CPU ${r.cpuPct.toFixed(0)}% of ${r.cores} cores${r.loadavg ? ` (load ${r.loadavg[0]})` : ''} · RAM ${gb(r.memUsedMB)} / ${gb(r.memTotalMB)} GB`,
          `Pulse server: ${r.server.cpuCores.toFixed(0)}% of one core · ${r.server.memMB} MB`,
          ...(r.children ?? []).map((c) => `${c.name} ×${c.count}: ${c.cpuCores.toFixed(0)}% of one core · ${c.memMB} MB`),
        ];
        this.loadInfo.textContent = parts.join('   |   ');
      } catch {
        this.loadInfo.textContent = '';
      }
    };
    void tick();
    setInterval(() => void tick(), 3000);
  }
  async quit() {
    const running = this.client.channels.filter((c) => this.client.isRunning(c)).length;
    if (
      !confirm(
        running
          ? `Quit Pulse? This stops ${running} running channel${running === 1 ? '' : 's'} and alerts will no longer be sent.`
          : 'Quit Pulse?',
      )
    )
      return;
    await fetch('/__app/quit', { method: 'POST' }).catch(() => undefined);
    document.body.innerHTML = '<p style="font:16px system-ui;padding:32px">Pulse has quit. You can close this window.</p>';
    window.close();
  }
  get view() {
    return this.currentView;
  }
  get isOpen() {
    return !this.el.hidden;
  }
  /** Opens the wall as the all-channels view, or as the UDP view (only UDP channels, new ones are UDP). */
  showView(view) {
    this.currentView = view;
    const filter = view === 'udp' ? 'udp' : 'all';
    this.filterSel.value = filter;
    this.wall.setFilter(filter);
    this.savePrefs();
    this.manualItem.textContent = view === 'udp' ? 'Add UDP channel manually' : 'Add SRT channel manually';
    this.bulkText.placeholder =
      view === 'udp'
        ? 'Studio A | udp://@239.1.1.1:5000\nudp://@239.1.1.2:5000?localaddr=10.0.0.5\n# lines starting with # are ignored'
        : BULK_PLACEHOLDER;
    this.setAddMode('none');
    this.toggle(true);
  }
  /** A new, empty channel of the current view's kind (or a free one), selected and ready to fill in. */
  async addManual() {
    const kind = this.currentView === 'udp' ? 'udp' : 'srt';
    let ch = this.client.channels.find((c) => c.kind === kind && !c.config && !this.client.isRunning(c));
    try {
      if (!ch) {
        const id = await this.client.addChannel(kind);
        ch = this.client.channels.find((c) => c.id === id);
      }
    } catch (err) {
      this.hooks.toast(`Could not add a channel: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (!ch) return;
    this.client.select(ch.id);
    this.filledFor = 0;
    this.addMode = 'none';
    this.setAddMode('manual');
    this.sync();
    this.nameInput.focus();
  }
  toggle(open) {
    this.el.hidden = open === undefined ? !this.el.hidden : !open;
    if (!this.el.hidden) this.refresh();
  }
  toggleAddMenu(open = this.addMenu.hidden) {
    this.addMenu.hidden = !open;
    this.addBtn.setAttribute('aria-expanded', String(open));
  }
  /** Only one way of adding a channel is shown at a time; choosing the open one again closes it. */
  setAddMode(mode) {
    this.addMode = this.addMode === mode ? 'none' : mode;
    this.bulk.hidden = this.addMode !== 'url';
    this.manual.hidden = this.addMode !== 'manual';
    this.toggleAddMenu(false);
  }
  pick(id) {
    // Fullscreen would cover the player and the analysis tabs the click is meant to open.
    if (document.fullscreenElement) void document.exitFullscreen();
    this.client.select(id);
    this.addMode = 'none';
    this.setAddMode('manual');
    this.hooks.onSelect(id);
    this.hooks.reveal();
  }
  /** Tiles and the form's status line, at most a few times a second however many channels report. */
  scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 300);
  }
  refresh() {
    if (this.el.hidden) return;
    this.wall.render();
    this.renderStatus();
    this.renderCpu();
  }
  /** Re-fill the form when the selected channel changed, then refresh everything. */
  sync() {
    const cur = this.client.current;
    if (cur && this.filledFor !== cur.id) this.fill(cur);
    this.refresh();
  }
  fill(ch) {
    this.filledFor = ch.id;
    this.nameInput.value = ch.name;
    this.address.value = formatStreamUrl(ch.config);
    this.transcode.checked = ch.config?.transcodePreview ?? false;
    this.light.checked = ch.config?.lightAnalysis !== false;
    this.renderMode();
  }
  renderMode() {
    const kind = this.client.current?.kind ?? 'srt';
    const udp = kind === 'udp';
    this.address.placeholder = udp
      ? 'udp://@239.1.1.1:5000'
      : kind === 'hls'
        ? 'https://example.com/live/master.m3u8'
        : 'srt://host:port?mode=caller   or   srt://:9000 to wait for an encoder';
    const parsed = this.address.value.trim() ? parseStreamUrl(this.address.value) : null;
    if (!parsed) {
      this.urlHint.textContent =
        kind === 'hls'
          ? 'The address of the HLS playlist (master or media .m3u8). The wall decodes its lowest rendition; clicking the tile plays the stream in the player with the full analysis.'
          : udp
            ? 'Joins a multicast group and analyses the MPEG-TS datagrams, e.g. udp://@239.1.1.1:5000 (add ?localaddr=<network card IP> to pick a card). Loss shows up as continuity errors.'
            : 'srt://host:port connects out as a caller. srt://:port (no host) waits for an encoder: point it at this computer on that port (each listener needs its own port). Optional: latency=, passphrase=, streamid=.';
    } else if ('error' in parsed) {
      this.urlHint.textContent = parsed.error;
    } else if (parsed.mode === 'hls') {
      this.urlHint.textContent = `Watches ${parsed.host}: the playlist is checked every few seconds and one picture a second is decoded.`;
    } else if (parsed.mode === 'multicast') {
      this.urlHint.textContent = `Joins multicast group ${parsed.host}:${parsed.port}${parsed.iface ? ` on network card ${parsed.iface}` : ''}.`;
    } else if (parsed.mode === 'listener') {
      this.urlHint.textContent = `Listening on port ${parsed.port}: point the encoder at srt://${location.hostname || 'localhost'}:${parsed.port} in caller mode.`;
    } else {
      this.urlHint.textContent = `Connects out to ${parsed.host}:${parsed.port} as caller.`;
    }
  }
  /** The address box as a connection config, or the reason it cannot be used. */
  config() {
    const text = this.address.value.trim();
    const parsed = text ? parseStreamUrl(text) : null;
    if (!parsed) return { error: 'Enter an address first, for example srt://203.0.113.10:9000?mode=caller or srt://:9000' };
    if ('error' in parsed) return parsed;
    const kind = this.client.current?.kind ?? 'srt';
    const want = parsed.mode === 'multicast' ? 'udp' : parsed.mode === 'hls' ? 'hls' : 'srt';
    if (kind !== want)
      return {
        error: `This is ${KIND_WITH_ARTICLE[kind]} channel: use ${KIND_ADDRESS[kind]} address. Add other kinds in the Add channels box.`,
      };
    return { ...parsed, transcodePreview: this.transcode.checked, lightAnalysis: this.light.checked };
  }
  async rename() {
    const cur = this.client.current;
    if (!cur) return;
    try {
      await this.client.saveChannel(cur.id, { name: this.nameInput.value });
      this.nameInput.value = this.client.current?.name ?? this.nameInput.value;
    } catch (err) {
      this.hooks.toast(`Could not rename: ${err instanceof Error ? err.message : err}`);
    }
  }
  async addBulk() {
    const { items, errors } = parseStreamList(this.bulkText.value);
    const problems = errors.map((e) => `line ${e.line}: ${e.error}`);
    if (!items.length) {
      this.bulkResult.textContent = problems.length
        ? `Nothing added. ${problems.join('; ')}`
        : 'Nothing to add: type or paste one address per line.';
      return;
    }
    try {
      const start = this.bulkStart.checked;
      const r = await this.client.bulkAdd(
        items.map((i) => ({ name: i.name, config: i.config })),
        start,
      );
      problems.push(...r.failed.map((f) => `${items[f.index]?.name ?? `item ${f.index + 1}`}: ${f.error}`));
      this.bulkResult.textContent = `Added ${r.added} channel${r.added === 1 ? '' : 's'}${start && r.added ? '; starting them one by one (it stops at the CPU limit)' : ''}.${problems.length ? ` Problems: ${problems.join('; ')}` : ''}`;
      if (!problems.length) {
        this.bulkText.value = '';
        this.setAddMode('none');
        this.hooks.toast(`Added ${r.added} channel${r.added === 1 ? '' : 's'}${start ? ': starting them one by one' : ''}`);
      }
    } catch (err) {
      this.bulkResult.textContent = `Could not add: ${err instanceof Error ? err.message : err}`;
    }
  }
  async remove() {
    const cur = this.client.current;
    if (!cur) return;
    const running = this.client.isRunning(cur);
    if (
      !confirm(
        `Delete channel "${cur.name}"?${running ? ' It is running and will be stopped.' : ''} Its settings and alert rules are removed.`,
      )
    )
      return;
    try {
      await this.client.removeChannel(cur.id);
      this.filledFor = 0;
      this.sync();
    } catch (err) {
      this.hooks.toast(`Could not delete: ${err instanceof Error ? err.message : err}`);
    }
  }
  async saveLimit() {
    const n = Number(this.cpuLimit.value);
    if (!Number.isFinite(n)) return;
    try {
      await this.client.setMaxCpu(Math.min(100, Math.max(10, Math.round(n))));
    } catch (err) {
      this.hooks.toast(`Could not save the CPU limit: ${err instanceof Error ? err.message : err}`);
    }
  }
  async start() {
    const cur = this.client.current;
    if (!cur) return;
    const cfg = this.config();
    if ('error' in cfg) {
      this.hooks.toast(cfg.error);
      this.address.focus();
      return;
    }
    this.startBtn.disabled = true;
    try {
      // Save the name too, so a rename typed just before pressing Start is not lost.
      if (this.nameInput.value.trim() !== cur.name) await this.client.saveChannel(cur.id, { name: this.nameInput.value });
      await this.client.start(cur.id, cfg);
      this.hooks.toast(
        cfg.mode === 'hls'
          ? `${cur.name}: watching ${cfg.host}…`
          : cfg.mode === 'listener'
            ? `${cur.name}: listening for SRT on port ${cfg.port}…`
            : `${cur.name}: connecting to ${cfg.host}:${cfg.port}…`,
      );
    } catch (err) {
      this.hooks.toast(`Could not start ${cur.name}: ${err instanceof Error ? err.message : err}`);
    }
    this.renderStatus();
  }
  async stop() {
    const cur = this.client.current;
    if (!cur) return;
    try {
      await this.client.stop(cur.id);
    } catch (err) {
      this.hooks.toast(`Could not stop: ${err instanceof Error ? err.message : err}`);
    }
  }
  async startAll() {
    try {
      const queued = await this.client.startAll();
      this.hooks.toast(
        queued
          ? `Starting ${queued} channel${queued === 1 ? '' : 's'} one by one (it stops at the CPU limit)…`
          : 'Nothing to start: no stopped channel has saved connection settings.',
      );
    } catch (err) {
      this.hooks.toast(`Could not start: ${err instanceof Error ? err.message : err}`);
    }
  }
  async stopAll() {
    try {
      await this.client.stopAll();
    } catch (err) {
      this.hooks.toast(`Could not stop: ${err instanceof Error ? err.message : err}`);
    }
  }
  renderCpu() {
    const cpu = this.client.cpu;
    this.cpuBox.hidden = !cpu;
    if (!cpu) return;
    const over = cpu.pct >= cpu.limit;
    this.cpuBox.dataset.level = over ? 'over' : cpu.pct >= cpu.limit * 0.85 ? 'near' : 'ok';
    const pct = Math.max(0, Math.min(100, cpu.pct));
    this.cpuArc.setAttribute('stroke-dasharray', `${pct} 100`);
    this.cpuTick.setAttribute('transform', `rotate(${(cpu.limit / 100) * 360} 50 50)`);
    this.cpuPct.textContent = `${cpu.pct.toFixed(0)}%`;
    this.cpuBox.setAttribute('aria-valuenow', cpu.pct.toFixed(0));
    this.cpuText.textContent = `${cpu.pct.toFixed(0)}% of ${cpu.cores} cores`;
    this.cpuNote.textContent = over
      ? 'Limit reached: new channels will not start until the CPU drops.'
      : `${Math.max(0, cpu.limit - cpu.pct).toFixed(0)}% headroom`;
    if (document.activeElement !== this.cpuLimit) this.cpuLimit.value = String(cpu.limit);
  }
  renderStatus() {
    const c = this.client;
    const cur = c.current;
    const running = c.running;
    const disabled = !c.available || !c.ffmpeg;
    this.title.textContent = cur ? `${kindLabel(cur.kind)} channel: ${cur.name}` : 'Channel';
    this.startBtn.disabled = disabled || running || !cur;
    this.stopBtn.disabled = !running;
    this.deleteBtn.disabled = !cur;
    this.startAllBtn.disabled = disabled || c.channels.every((x) => !x.config || c.isRunning(x));
    this.stopAllBtn.disabled = !c.anyRunning;
    for (const el of [this.address, this.transcode, this.light]) el.disabled = running;
    this.logInfo.textContent = c.logDir ? `Logs: ${c.logDir}` : '';
    const notes = [];
    if (!c.available) {
      notes.push(
        'SRT / UDP / HLS monitoring needs the local Pulse server (npm run dev or npm run preview). It is not available on static hosting, because browsers cannot open SRT connections.',
      );
    } else if (!c.ffmpeg) {
      notes.push('ffmpeg was not found. Install ffmpeg (with SRT support) or set FFMPEG_PATH, then restart the server.');
    } else if (!c.connected) {
      notes.push(
        'Lost the connection to the Pulse server (it may have been closed). Start it again (npm run dev, or PlayProbe.exe) and reload this page; running channels stop when the server stops.',
      );
    } else if (!c.srtLiveTransmit && cur?.kind === 'srt') {
      notes.push(
        h('strong', null, 'Basic mode: '),
        "srt-live-transmit was not found, so SRT link statistics (RTT, loss, retransmits) are unavailable and MPEG-TS checks run on ffmpeg's re-multiplexed copy. Install the SRT tools (or set SRT_LIVE_TRANSMIT_PATH) for wire-level analysis.",
      );
    }
    this.notice.hidden = notes.length === 0;
    this.notice.className = `srt-notice ${disabled ? 'error' : 'warn'}`;
    clear(this.notice, notes);
    const s = cur?.snapshot;
    const state = s?.state ?? 'idle';
    clear(
      this.status,
      badge(state, stateKind(state)),
      s?.ingest ? h('span', { class: 'muted small' }, ` via ${s.ingest}`) : '',
      s?.lastError && state !== 'connected' ? h('span', { class: 'error small' }, ` ${s.lastError}`) : '',
    );
  }
}
