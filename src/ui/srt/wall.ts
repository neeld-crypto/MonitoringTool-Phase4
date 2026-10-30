import type { ChannelState, ScteFeedItem, SrtClient } from '../../srt/client';
import { ruleLabel } from '../../srt/rule-labels';
import { kindLabel, type Severity } from '../../srt/types';
import { h } from '../dom';

export type WallFilter = 'all' | 'running' | 'problems' | 'stopped' | 'srt' | 'udp' | 'hls';
/** `auto` fits as many as the width allows; `NxN` is a fixed grid of that many columns (and, in fullscreen, rows). */
export type WallSize = 'auto' | '2x2' | '3x3' | '4x4' | '5x5' | '6x6' | '8x8';
export const WALL_SIZES: WallSize[] = ['auto', '2x2', '3x3', '4x4', '5x5', '6x6', '8x8'];
const gridCols = (size: WallSize) => (size === 'auto' ? 0 : Number(size.split('x')[0]));

/** Minimum tile width in pixels when the grid is automatic. */
const AUTO_MIN_PX = 250;
/** The level meter shows this range; quieter than the floor reads as empty. */
const METER_FLOOR_DB = -60;
/** Re-render at most this often, however many channels report. */
const RENDER_MS = 300;

type Health = 'ok' | 'warn' | 'crit' | 'wait' | 'idle';

interface Tile {
  id: number;
  el: HTMLButtonElement;
  img: HTMLImageElement;
  num: HTMLElement;
  kind: HTMLElement;
  scte: HTMLElement;
  overlay: HTMLElement;
  bars: HTMLElement[];
  alerts: HTMLElement;
  name: HTMLElement;
  info: HTMLElement;
  /** What the DOM currently shows, so unchanged values are not written again. */
  shown: { health: string; overlay: string; name: string; info: string; alerts: string; bars: string; selected: boolean; thumb: string | null; stale: boolean; scte: string };
  loading: boolean;
  visible: boolean;
}

/** The alert rules a tile names: black video and audio silence (ad breaks have their own badge). */
const TILE_ALERT_RULES = new Set(['video_black', 'audio_silence']);

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

const dbToPct = (db: number) => Math.max(0, Math.min(100, ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100));

function resolution(c: ChannelState): string {
  const v = c.snapshot.av?.video;
  if (!v?.height) return '';
  return v.height >= 720 ? `${v.height}p` : `${v.width ?? '?'}×${v.height}`;
}

const rate = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`);

/** Worst active alert on the channel, or null. */
function worstAlert(c: ChannelState): Severity | null {
  let worst: Severity | null = null;
  for (const a of c.alerts) {
    if (a.state !== 'raised') continue;
    if (worst === null || SEVERITY_RANK[a.severity] > SEVERITY_RANK[worst]) worst = a.severity;
  }
  return worst;
}

function health(c: ChannelState): Health {
  const s = c.snapshot.state;
  if (s === 'idle') return 'idle';
  if (s === 'error') return 'crit';
  const worst = worstAlert(c);
  if (worst === 'critical' || s === 'stalled') return 'crit';
  if (worst === 'warning') return 'warn';
  if (s === 'connected') return 'ok';
  return 'wait';
}

const clock = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** How long the "IN" and one-off cue badges stay on a tile, and how long an unfinished break is kept when no duration is known. */
const SCTE_IN_SHOW_SEC = 20;
const SCTE_OTHER_SHOW_SEC = 10;
const SCTE_OUT_OVERDUE_SEC = 10;
const SCTE_OUT_NO_DURATION_SEC = 600;

interface ScteBadge {
  kind: 'out' | 'in' | 'other';
  text: string;
  title: string;
}

/**
 * What the SCTE-35 markers of one channel mean right now: a running ad break (OUT, counting down when the
 * marker says how long it lasts), a recent return to programme (IN), or another recent cue. splice_null
 * keep-alives and old markers show nothing. Times use the server's clock, as the markers' receive times do.
 */
export function scteBadge(c: ChannelState): ScteBadge | null {
  const now = c.snapshot.now;
  // Newest first. OUT / IN decide whether a break is running; other cues (and splice_null keep-alives, which
  // are ignored) only show when nothing else does.
  const m = c.scte.find((x) => x.direction !== 'other');
  const other = c.scte.find((x) => x.direction === 'other' && !/splice_null/i.test(x.summary));
  const badge = m ? fromMarker(m, now) : null;
  if (badge || !other) return badge;
  return (now - other.receivedAt) / 1000 <= SCTE_OTHER_SHOW_SEC ? { kind: 'other', text: 'SCTE', title: other.summary } : null;
}

function fromMarker(m: ScteFeedItem, now: number): ScteBadge | null {
  const age = (now - m.receivedAt) / 1000;
  if (m.direction === 'out') {
    if (m.duration !== undefined) {
      const left = m.duration - age;
      if (left < -SCTE_OUT_OVERDUE_SEC) return null;
      return { kind: 'out', text: left > 0 ? `AD BREAK ${clock(left)}` : 'AD BREAK ending', title: `${m.summary}\nBreak of ${m.duration.toFixed(1)} s, started ${clock(age)} ago` };
    }
    if (age > SCTE_OUT_NO_DURATION_SEC) return null;
    return { kind: 'out', text: `AD BREAK +${clock(age)}`, title: `${m.summary}\nStarted ${clock(age)} ago (the marker gives no duration)` };
  }
  if (m.direction === 'in') return age <= SCTE_IN_SHOW_SEC ? { kind: 'in', text: 'SCTE IN', title: m.summary } : null;
  return null;
}

/** The words over a tile that has no live picture. Empty when the picture says it all. */
function overlayText(c: ChannelState, hasPicture: boolean): string {
  const s = c.snapshot;
  switch (s.state) {
    case 'idle':
      return c.config ? 'STOPPED' : 'NOT CONFIGURED';
    case 'starting':
    case 'waiting': {
      const sec = s.waitingForMs !== null ? ` ${Math.round(s.waitingForMs / 1000)}s` : '';
      return `${c.config?.mode === 'listener' ? 'LISTENING' : c.config?.mode === 'hls' ? 'LOADING' : 'CONNECTING'}${sec}`;
    }
    case 'reconnecting':
      return 'RECONNECTING';
    case 'stalled':
      return c.config?.mode === 'hls' ? 'STALE PLAYLIST' : 'NO SIGNAL';
    case 'error':
      return 'ERROR';
    default:
      return hasPicture ? '' : 'WAITING FOR PICTURE';
  }
}

/**
 * Multiviewer: one tile per channel, as many as there are, each showing a live picture, the channel's name,
 * state colour and audio level. A tile is a button: choosing it makes the player and the analysis tabs follow it.
 */
export class SrtWall {
  readonly el = h('div', { class: 'mv-wall', role: 'list', 'aria-label': 'SRT, UDP and HLS channels' });
  private tiles = new Map<number, Tile>();
  private filter: WallFilter = 'all';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRender = 0;
  private io: IntersectionObserver | null = null;
  private lastFit = '';

  constructor(
    private readonly client: SrtClient,
    private readonly hooks: { onPick(id: number): void; onSummary(s: { total: number; live: number; alerts: number; shown: number }): void },
  ) {
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const tile = [...this.tiles.values()].find((t) => t.el === e.target);
            if (tile) tile.visible = e.isIntersecting;
          }
          this.schedule();
        },
        { rootMargin: '120px' },
      );
    }
    document.addEventListener('fullscreenchange', () => this.fit());
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.fit()).observe(this.el);
    this.setSize('auto');
  }

  setSize(size: WallSize): void {
    const n = gridCols(size);
    this.cols = n;
    this.el.style.setProperty('--mv-min', `${AUTO_MIN_PX}px`);
    if (n) this.el.style.setProperty('--mv-n', String(n));
    this.el.dataset.grid = n ? 'fixed' : 'auto';
    // Drives the CSS that drops detail from small tiles.
    this.el.dataset.size = n >= 5 ? 's' : n === 2 ? 'xl' : 'm';
    this.lastFit = '';
    this.fit();
  }

  setFilter(filter: WallFilter): void {
    this.filter = filter;
    this.render();
  }

  private cols = 0;

  get fullscreen(): boolean {
    return document.fullscreenElement === this.el;
  }

  async toggleFullscreen(): Promise<void> {
    if (this.fullscreen) await document.exitFullscreen();
    else await this.el.requestFullscreen?.();
  }

  /** Coalesces the bursts of updates (every channel reports every second) into one pass. */
  schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, RENDER_MS - (Date.now() - this.lastRender));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.render();
    }, wait);
  }

  render(): void {
    this.lastRender = Date.now();
    // The panel can be closed: nothing to draw, and the next open renders at once.
    if (this.el.closest('[hidden]')) return;
    const channels = this.client.channels;
    const ids = new Set(channels.map((c) => c.id));

    for (const [id, tile] of this.tiles) {
      if (ids.has(id)) continue;
      this.io?.unobserve(tile.el);
      tile.el.remove();
      this.tiles.delete(id);
    }
    let live = 0;
    let alerts = 0;
    let shown = 0;
    channels.forEach((c, index) => {
      let tile = this.tiles.get(c.id);
      if (!tile) {
        tile = this.makeTile(c.id);
        this.tiles.set(c.id, tile);
        this.io?.observe(tile.el);
      }
      // Keep DOM order equal to channel order without touching tiles that are already in place.
      if (this.el.children[index] !== tile.el) this.el.insertBefore(tile.el, this.el.children[index] ?? null);
      const n = this.update(tile, c, index + 1);
      if (c.snapshot.state === 'connected') live++;
      alerts += this.client.activeCount(c);
      if (n) shown++;
    });
    this.el.dataset.hud = `${live} playing · ${shown} shown · ${alerts} alert${alerts === 1 ? '' : 's'}`;
    this.hooks.onSummary({ total: channels.length, live, alerts, shown });
    this.fit();
  }

  private makeTile(id: number): Tile {
    const img = h('img', { class: 'mv-img', alt: '', decoding: 'async', draggable: false });
    const num = h('span', { class: 'mv-num' });
    const kind = h('span', { class: 'mv-kind' });
    const scte = h('span', { class: 'mv-scte', hidden: true });
    const overlay = h('div', { class: 'mv-overlay' });
    const bars = [h('i'), h('i')];
    const alerts = h('span', { class: 'mv-alerts' });
    const name = h('strong', { class: 'mv-name' });
    const info = h('span', { class: 'mv-info' });
    const el = h(
      'button',
      { type: 'button', class: 'mv-tile', role: 'listitem', 'data-id': String(id), onclick: () => this.hooks.onPick(id) },
      h('div', { class: 'mv-screen' }, img, overlay, num, kind, alerts, scte, h('div', { class: 'mv-meter' }, ...bars)),
      h('div', { class: 'mv-label' }, name, info),
    );
    return {
      id,
      el,
      img,
      num,
      kind,
      scte,
      overlay,
      bars,
      alerts,
      name,
      info,
      shown: { health: '', overlay: '\0', name: '\0', info: '\0', alerts: '', bars: '', selected: false, thumb: null, stale: false, scte: '' },
      loading: false,
      visible: true,
    };
  }

  /** Brings one tile up to date. Returns whether it passes the filter. */
  private update(t: Tile, c: ChannelState, position: number): boolean {
    const s = c.snapshot;
    const hl = health(c);
    const active = this.client.activeCount(c);
    const running = this.client.isRunning(c);
    const pass =
      this.filter === 'all' ||
      (this.filter === 'running' && running) ||
      (this.filter === 'stopped' && !running) ||
      this.filter === c.kind ||
      (this.filter === 'problems' && (hl === 'crit' || hl === 'warn' || active > 0));
    t.el.hidden = !pass;
    if (!pass) return false;

    const selected = c.id === this.client.selectedId;
    if (t.shown.selected !== selected) {
      t.el.classList.toggle('selected', selected);
      t.el.setAttribute('aria-pressed', String(selected));
      t.shown.selected = selected;
    }
    if (t.shown.health !== hl) {
      t.el.dataset.health = hl;
      t.shown.health = hl;
    }
    t.num.textContent = String(position);
    t.kind.textContent = c.kind === 'srt' ? '' : kindLabel(c.kind);

    if (t.shown.name !== c.name) {
      t.name.textContent = c.name;
      t.el.title = c.name;
      t.shown.name = c.name;
    }
    const live = s.state === 'connected' || s.state === 'stalled';
    // Only ad breaks are shown from SCTE-35 (not IN cues or other markers); problems are shown by name below.
    const found = live ? scteBadge(c) : null;
    const cue = found?.kind === 'out' ? found : null;
    const cueKey = cue ? `${cue.kind}|${cue.text}` : '';
    if (t.shown.scte !== cueKey) {
      t.scte.hidden = !cue;
      t.scte.textContent = cue?.text ?? '';
      t.scte.dataset.kind = cue?.kind ?? '';
      t.scte.title = cue?.title ?? '';
      t.shown.scte = cueKey;
    }
    const info = live ? [resolution(c), s.ts ? rate(s.ts.bitrateKbps) : s.hls?.kbps ? rate(s.hls.kbps) : ''].filter(Boolean).join(' · ') : c.config ? this.describe(c) : 'click to set up';
    if (t.shown.info !== info) {
      t.info.textContent = info;
      t.shown.info = info;
    }
    // Tiles name only picture / sound problems; link and transport alerts (packet loss, RTT …) stay in the Alerts tab and the chart.
    const raised = c.alerts.filter((a) => a.state === 'raised' && TILE_ALERT_RULES.has(a.rule)).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
    const names = [...new Set(raised.map((a) => ruleLabel(a.rule)))];
    const alertKey = names.join('|');
    if (t.shown.alerts !== alertKey) {
      t.alerts.textContent = names.length ? `${names[0].toUpperCase()}${names.length > 1 ? ` +${names.length - 1}` : ''}` : '';
      t.alerts.title = names.join('\n');
      t.alerts.hidden = !names.length;
      t.alerts.dataset.severity = raised[0]?.severity ?? '';
      t.shown.alerts = alertKey;
    }

    // Picture: a new frame is only fetched for tiles that can be seen, and swapped in once it has loaded (no flicker).
    const url = this.client.thumbUrl(c);
    const hasPicture = url !== null;
    if (url && url !== t.shown.thumb && t.visible && !t.loading) {
      t.loading = true;
      const probe = new Image();
      probe.onload = () => {
        t.loading = false;
        t.img.src = url;
        t.shown.thumb = url;
        t.img.classList.add('has-picture');
      };
      probe.onerror = () => {
        t.loading = false;
      };
      probe.src = url;
    }
    if (!url && t.shown.thumb) {
      t.img.removeAttribute('src');
      t.img.classList.remove('has-picture');
      t.shown.thumb = null;
    }
    const stale = hl === 'crit' && s.state === 'stalled';
    if (t.shown.stale !== stale) {
      t.el.classList.toggle('stale', stale);
      t.shown.stale = stale;
    }

    const text = overlayText(c, hasPicture);
    if (t.shown.overlay !== text) {
      t.overlay.textContent = text;
      t.overlay.hidden = !text;
      t.shown.overlay = text;
    }

    // Level meters: two bars, left and right (a mono feed shows the same level twice).
    const db = live ? s.av?.audioDb ?? null : null;
    const levels = db && db.length ? [db[0], db[1] ?? db[0]] : null;
    const key = levels ? levels.map((v) => Math.round(dbToPct(v))).join(',') : '';
    if (t.shown.bars !== key) {
      t.bars.forEach((bar, i) => bar.style.setProperty('--lvl', `${levels ? dbToPct(levels[i]) : 0}%`));
      t.el.classList.toggle('no-audio', !levels);
      t.shown.bars = key;
    }
    return true;
  }

  private describe(c: ChannelState): string {
    const cfg = c.config;
    if (!cfg) return '';
    if (cfg.mode === 'hls') return cfg.url ? `${cfg.host}${new URL(cfg.url).pathname.replace(/^.*[/]([^/]+)$/, ' / $1')}` : cfg.host;
    if (cfg.mode === 'listener') return `listening :${cfg.port}`;
    if (cfg.mode === 'multicast') return `${cfg.host}:${cfg.port}`;
    return `${cfg.host}:${cfg.port}`;
  }

  /**
   * Fullscreen has no scrolling and no empty space. The chosen grid (or, on auto, the column count whose cells are
   * closest to 16:9 for this screen) decides the number of rows; the channels are shared out evenly over those rows,
   * and the tiles of a row with fewer channels are made wider so every row is full. Outside fullscreen the CSS grid decides.
   */
  private fit(): void {
    const tiles = [...this.el.children].filter((e): e is HTMLElement => e instanceof HTMLElement && e.classList.contains('mv-tile'));
    if (!this.fullscreen) {
      if (this.lastFit) {
        this.el.style.removeProperty('--mv-cols');
        this.el.style.removeProperty('--mv-rows');
        for (const t of tiles) t.style.removeProperty('grid-column');
        this.lastFit = '';
      }
      return;
    }
    const shown = tiles.filter((e) => !e.hidden);
    const n = shown.length || 1;
    const { clientWidth: w, clientHeight: hgt } = this.el;
    let cols = this.cols;
    if (!cols) {
      let bestDiff = Infinity;
      for (let c = 1; c <= n; c++) {
        const diff = Math.abs(Math.log(w / c / (hgt / Math.ceil(n / c)) / (16 / 9)));
        if (diff < bestDiff) {
          bestDiff = diff;
          cols = c;
        }
      }
    }
    cols = Math.max(1, Math.min(cols || 1, n));
    const rows = Math.ceil(n / cols);
    const key = `${w}x${hgt}/${cols}/${shown.map((e) => e.dataset.id ?? '').join(',')}`;
    if (key === this.lastFit) return;
    this.lastFit = key;
    const base = Math.floor(n / rows);
    const extra = n % rows;
    const counts = Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
    const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
    const span = counts.reduce((acc, k) => (acc * k) / gcd(acc, k), 1);
    this.el.style.setProperty('--mv-cols', String(span));
    this.el.style.setProperty('--mv-rows', String(rows));
    let at = 0;
    for (const k of counts) for (let i = 0; i < k; i++) shown[at++].style.gridColumn = `span ${span / k}`;
  }
}
