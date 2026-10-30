import { historyStore } from '../../srt/history-store';
import { ruleLabel } from '../../srt/rule-labels';
import { h } from '../dom';
const WINDOWS = [
  ['1 min', 60e3],
  ['3 min', 180e3],
  ['15 min', 900e3],
  ['1 hour', 3600e3],
  ['6 hours', 6 * 3600e3],
  ['24 hours', 24 * 3600e3],
  ['7 days', 7 * 24 * 3600e3],
];
/** The live in-memory history covers this much, so shorter live windows need no stored data. */
const MEMORY_MS = 170e3;
/** Samples further apart than this are drawn as a gap (Pulse was closed or the channel stopped). */
const GAP_MS = 30e3;
const SEVERITY_COLOR = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };
const RECOVERED = '#22c55e';
const EVENT = '#a855f7';
const pad2 = (n) => String(n).padStart(2, '0');
const clock = (t) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const stamp = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock(t)}`;
};
const localInput = (t) => stamp(t).replace(' ', 'T');
const rate = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} Mbps` : `${Math.round(v)} kbps`);
/**
 * Bitrate and RTT over time with the channel's alerts drawn on it (raised, recovered, one-off events). It shows
 * the live edge by default; drag to go back in time, pick a window length, or jump to a date and time. Older data
 * comes from the browser's stored history (see history-store).
 */
export class SrtChartView {
  el = h('div', { class: 'srt-chart' });
  canvas = h('canvas', { class: 'chart', height: 230 });
  tip = h('div', { class: 'srt-chart-tip', hidden: true });
  status = h('span', { class: 'muted small srt-chart-status' });
  windowSel = h(
    'select',
    { 'aria-label': 'Time window' },
    WINDOWS.map(([l, ms]) => h('option', { value: String(ms) }, l)),
  );
  goto = h('input', { type: 'datetime-local', step: 1, 'aria-label': 'Go to date and time' });
  liveBtn = h('button', { type: 'button', class: 'primary', onclick: () => this.goLive() }, '● Live');
  legend = h('div', { class: 'srt-chart-legend', role: 'group', 'aria-label': 'Chart legend: click one to show only that' });
  /** When set, only this legend item is shown (`s:bitrate`, `s:rtt`, `r:<rule>`, `rec`, `ev`). */
  only = null;
  legendKey = '';
  ch = -1;
  mem = [];
  memAlerts = [];
  windowMs = 180e3;
  /** End of the visible window; null follows the live edge. */
  endT = null;
  cache = null;
  fetching = 0;
  markers = [];
  view = { from: 0, to: 0, points: [], padL: 8, plotW: 1 };
  constructor() {
    this.windowSel.value = String(this.windowMs);
    this.windowSel.addEventListener('change', () => {
      this.windowMs = Number(this.windowSel.value);
      this.redraw();
    });
    this.goto.addEventListener('change', () => {
      const t = new Date(this.goto.value).getTime();
      if (Number.isNaN(t)) return;
      // Centre the window on the chosen moment.
      this.setEnd(t + this.windowMs / 2);
    });
    const step = (dir) => () => this.setEnd((this.endT ?? Date.now()) + dir * this.windowMs * 0.5);
    this.el.append(
      h(
        'div',
        { class: 'srt-chart-bar' },
        h('button', { type: 'button', title: 'Back in time', 'aria-label': 'Back in time', onclick: step(-1) }, '◀'),
        h('button', { type: 'button', title: 'Forward in time', 'aria-label': 'Forward in time', onclick: step(1) }, '▶'),
        this.windowSel,
        h('label', { class: 'srt-chart-goto' }, 'Go to ', this.goto),
        this.liveBtn,
        this.status,
      ),
      this.legend,
      h('div', { class: 'chart-wrap srt-chart-wrap' }, this.canvas, this.tip),
    );
    this.installPointer();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.redraw()).observe(this.canvas);
  }
  /** Called with the selected channel's live data on every update. */
  update(ch, history, alerts) {
    if (ch !== this.ch) {
      this.ch = ch;
      this.endT = null;
      this.cache = null;
    }
    this.mem = history;
    this.memAlerts = alerts;
    this.redraw();
  }
  goLive() {
    this.endT = null;
    this.redraw();
  }
  setEnd(t) {
    this.endT = t >= Date.now() - 1000 ? null : t;
    this.redraw();
  }
  range() {
    const to = this.endT ?? Date.now();
    return [to - this.windowMs, to];
  }
  /** Loads stored history for the window (and one window either side, so dragging stays smooth). */
  ensureData(from, to) {
    if (this.ch < 0) return;
    const live = this.endT === null;
    if (live && this.windowMs <= MEMORY_MS) return;
    const c = this.cache;
    const covered = c && c.ch === this.ch && c.from <= from && (c.to >= to || (live && Date.now() - c.at < 10e3));
    if (covered) return;
    const token = ++this.fetching;
    const ch = this.ch;
    const lo = from - this.windowMs;
    const hi = Math.min(Date.now(), to + this.windowMs);
    void Promise.all([historyStore.samplesBetween(ch, lo, hi), historyStore.alertsBetween(ch, lo, hi)]).then(([samples, alerts]) => {
      if (token !== this.fetching) return;
      this.cache = {
        ch,
        from: lo,
        to: hi,
        at: Date.now(),
        points: samples.map(({ t, kbps, rttMs, bufferMs }) => ({ t, kbps, rttMs, bufferMs })),
        alerts,
      };
      this.redraw(false);
    });
  }
  redraw(fetch = true) {
    const [from, to] = this.range();
    if (fetch) this.ensureData(from, to);
    const live = this.endT === null;
    this.liveBtn.disabled = live;
    this.status.textContent = live ? 'Live' : `Viewing ${stamp(from)} → ${stamp(to)} (not live)`;
    if (document.activeElement !== this.goto) this.goto.value = localInput(from + this.windowMs / 2);
    this.draw(from, to);
  }
  merged(from, to) {
    const byT = new Map();
    const c = this.cache && this.cache.ch === this.ch ? this.cache : null;
    for (const p of c?.points ?? []) byT.set(p.t, p);
    for (const p of this.mem) byT.set(p.t, p);
    const points = [...byT.values()].filter((p) => p.t >= from - GAP_MS && p.t <= to + GAP_MS).sort((a, b) => a.t - b.t);
    const byAlert = new Map();
    for (const a of c?.alerts ?? []) byAlert.set(`${a.at}:${a.id}`, a);
    for (const a of this.memAlerts) byAlert.set(`${a.at}:${a.id}`, a);
    return { points, alerts: [...byAlert.values()] };
  }
  shows(key) {
    return this.only === null || this.only === key;
  }
  toggleOnly(key) {
    this.only = this.only === key ? null : key;
    this.legendKey = '';
    this.redraw(false);
  }
  /** Legend items double as filters. Rebuilt only when their content changes, so clicks are never lost mid-update. */
  renderLegend(items) {
    const sig = `${this.only}|${items.map((i) => `${i.key}:${i.count ?? ''}:${i.value ?? ''}`).join(',')}`;
    if (sig === this.legendKey) return;
    this.legendKey = sig;
    this.legend.replaceChildren(
      ...items.map((i) =>
        h(
          'button',
          {
            type: 'button',
            class: `legend-item${this.only === i.key ? ' solo' : ''}${this.only !== null && this.only !== i.key ? ' dim' : ''}`,
            'aria-pressed': String(this.only === i.key),
            title: this.only === i.key ? 'Click to show everything again' : `Click to show only ${i.label}`,
            onclick: () => this.toggleOnly(i.key),
          },
          h('i', { class: `legend-mark ${i.shape}`, style: `background:${i.color}` }),
          i.label,
          i.count !== undefined ? h('small', null, ` ×${i.count}`) : '',
          i.value ? h('small', { class: 'legend-value' }, ` ${i.value}`) : '',
        ),
      ),
      this.only ? h('button', { type: 'button', class: 'legend-reset', onclick: () => this.toggleOnly(this.only) }, 'Show all') : '',
    );
  }
  draw(from, to) {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, hgt);
    const { points, alerts: allAlerts } = this.merged(from, to);
    // Keep-alives (splice_null) are not worth a marker.
    const alerts = allAlerts.filter((a) => !(a.rule === 'scte' && /splice_null/i.test(a.message)));
    const hasRtt = points.some((p) => p.rttMs !== null);
    const visible = points.filter((p) => p.t >= from && p.t <= to);
    const maxKbps = Math.max(100, ...visible.map((p) => p.kbps)) * 1.1;
    const maxRtt = Math.max(20, ...visible.map((p) => p.rttMs ?? 0)) * 1.1;
    const pad = { l: 48, r: hasRtt ? 44 : 12, t: 18, b: 22 };
    const plotW = w - pad.l - pad.r;
    const plotH = hgt - pad.t - pad.b;
    const css = getComputedStyle(canvas);
    const grid = css.getPropertyValue('--chart-grid').trim() || 'rgba(148,163,184,0.15)';
    const labelColor = css.getPropertyValue('--chart-text').trim() || '#cbd5e1';
    const panel = css.getPropertyValue('--panel-2').trim() || '#0f172a';
    const span = to - from;
    const x = (t) => pad.l + (plotW * (t - from)) / span;
    const yOf = (v, max) => pad.t + plotH - (plotH * v) / max;
    this.view = { from, to, points, padL: pad.l, plotW };
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    // Grid with axis values: bitrate on the left, RTT on the right.
    const linesFaded = this.only !== null && !this.only.startsWith('s:');
    const bitrateAxis = this.shows('s:bitrate') || linesFaded;
    const rttAxis = hasRtt && (this.shows('s:rtt') || linesFaded);
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (plotH * i) / 4;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillStyle = labelColor;
      if (bitrateAxis) {
        ctx.textAlign = 'right';
        ctx.fillText(
          rate((maxKbps * (4 - i)) / 4)
            .replace(' kbps', 'k')
            .replace(' Mbps', 'M'),
          pad.l - 6,
          y + 4,
        );
      }
      if (rttAxis) {
        ctx.textAlign = 'left';
        ctx.fillText(`${Math.round((maxRtt * (4 - i)) / 4)}ms`, w - pad.r + 6, y + 4);
      }
    }
    // Time axis.
    const multiDay = new Date(from).toDateString() !== new Date(to).toDateString();
    ctx.fillStyle = labelColor;
    for (let i = 0; i <= 4; i++) {
      const t = from + (span * i) / 4;
      const d = new Date(t);
      const text =
        span <= 15 * 60e3
          ? clock(t)
          : multiDay
            ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
            : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      ctx.fillText(text, pad.l + (plotW * i) / 4, hgt - 6);
    }
    ctx.textAlign = 'left';
    // Lines: faded when the legend filter is on an alert type, so the markers keep their context.
    const series = [
      { key: 's:bitrate', color: '#ec4899', max: maxKbps, value: (p) => p.kbps, area: true },
      ...(hasRtt ? [{ key: 's:rtt', color: '#3b82f6', max: maxRtt, value: (p) => p.rttMs, area: false }] : []),
    ];
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, 0, plotW, hgt);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of series) {
      if (!this.shows(s.key) && !linesFaded) continue;
      ctx.globalAlpha = linesFaded ? 0.28 : 1;
      const runs = [];
      let prev = null;
      for (const p of points) {
        const v = s.value(p);
        if (v === null) continue;
        const pt = [x(p.t), yOf(v, s.max)];
        if (prev === null || p.t - prev > GAP_MS) runs.push([pt]);
        else runs[runs.length - 1].push(pt);
        prev = p.t;
      }
      if (s.area) {
        const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
        g.addColorStop(0, `${s.color}55`);
        g.addColorStop(1, `${s.color}00`);
        ctx.fillStyle = g;
        for (const run of runs) {
          if (run.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(run[0][0], pad.t + plotH);
          for (const [px, py] of run) ctx.lineTo(px, py);
          ctx.lineTo(run[run.length - 1][0], pad.t + plotH);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const run of runs) {
        run.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        if (run.length === 1) ctx.lineTo(run[0][0] + 0.1, run[0][1]);
      }
      ctx.stroke();
    }
    ctx.restore();
    // Alert bands and markers.
    const now = Date.now();
    this.markers = [];
    const sevOf = (a) => (a.state === 'event' ? EVENT : SEVERITY_COLOR[a.severity]);
    const raisedOn = (a) => (a.state === 'event' ? this.shows('ev') : this.shows(`r:${a.rule}`));
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, 0, plotW, hgt);
    ctx.clip();
    for (const a of alerts) {
      if (a.state === 'event' || !raisedOn(a)) continue;
      const end = a.clearedAt ?? (a.state === 'raised' ? now : a.at);
      if (end < from || a.at > to) continue;
      ctx.fillStyle = `${sevOf(a)}1a`;
      const x0 = Math.max(pad.l, x(a.at));
      const x1 = Math.min(w - pad.r, x(end));
      ctx.fillRect(x0, pad.t, Math.max(2, x1 - x0), plotH);
    }
    const mark = (t, color, text, dashed) => {
      if (t < from || t > to) return;
      const mx = x(t);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.setLineDash(dashed ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(mx, pad.t);
      ctx.lineTo(mx, pad.t + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.strokeStyle = panel;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mx, pad.t, 4.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
      this.markers.push({ x: mx, color, text });
    };
    for (const a of alerts) {
      const label = a.state === 'event' ? 'Event' : ruleLabel(a.rule);
      if (raisedOn(a)) mark(a.at, sevOf(a), `${clock(a.at)} ${label}\n${a.message}`, false);
      if (a.clearedAt && a.state !== 'event' && this.shows('rec'))
        mark(a.clearedAt, RECOVERED, `${clock(a.clearedAt)} Recovered: ${label}\n${a.message}`, true);
    }
    ctx.restore();
    if (!visible.length) {
      ctx.fillStyle = labelColor;
      ctx.textAlign = 'center';
      ctx.fillText(this.endT === null ? 'Waiting for data…' : 'No data recorded for this time', w / 2, pad.t + plotH / 2);
      ctx.textAlign = 'left';
    }
    // Legend (HTML, clickable): series with their latest value, then each alert type seen in this window.
    const last = visible.length ? visible[visible.length - 1] : null;
    const items = [
      { key: 's:bitrate', label: 'Bitrate', color: '#ec4899', shape: 'line', value: last ? rate(last.kbps) : '' },
      ...(hasRtt
        ? [{ key: 's:rtt', label: 'RTT', color: '#3b82f6', shape: 'line', value: last?.rttMs != null ? `${last.rttMs.toFixed(0)} ms` : '' }]
        : []),
    ];
    const rules = new Map();
    let recovered = 0;
    let events = 0;
    for (const a of alerts) {
      if (a.at > to || (a.clearedAt ?? a.at) < from) continue;
      if (a.state === 'event') {
        events++;
        continue;
      }
      if (a.at >= from) {
        const r = rules.get(a.rule) ?? { count: 0, sev: a.severity };
        r.count++;
        if (a.severity === 'critical') r.sev = 'critical';
        rules.set(a.rule, r);
      }
      if (a.clearedAt && a.clearedAt >= from && a.clearedAt <= to) recovered++;
    }
    for (const [rule, r] of [...rules].sort((a, b) => b[1].count - a[1].count))
      items.push({ key: `r:${rule}`, label: ruleLabel(rule), color: SEVERITY_COLOR[r.sev], shape: 'dot', count: r.count });
    if (recovered) items.push({ key: 'rec', label: 'Recovered', color: RECOVERED, shape: 'dot', count: recovered });
    if (events) items.push({ key: 'ev', label: 'Events', color: EVENT, shape: 'dot', count: events });
    this.renderLegend(items);
  }
  installPointer() {
    const c = this.canvas;
    let drag = null;
    c.style.touchAction = 'pan-y';
    c.style.cursor = 'grab';
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, end: this.range()[1] };
      c.setPointerCapture(e.pointerId);
      c.style.cursor = 'grabbing';
      this.tip.hidden = true;
    });
    c.addEventListener('pointermove', (e) => {
      if (drag) {
        const dt = ((e.clientX - drag.x) / this.view.plotW) * this.windowMs;
        const end = drag.end - dt;
        this.endT = end >= Date.now() - 1000 ? null : end;
        this.redraw();
        return;
      }
      this.hover(e);
    });
    const end = () => {
      drag = null;
      c.style.cursor = 'grab';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (!drag) this.tip.hidden = true;
    });
    // Ctrl + wheel zooms the window; a plain wheel still scrolls the page.
    c.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const i = WINDOWS.findIndex(([, ms]) => ms === this.windowMs);
        const next = WINDOWS[Math.max(0, Math.min(WINDOWS.length - 1, i + (e.deltaY > 0 ? 1 : -1)))];
        this.windowMs = next[1];
        this.windowSel.value = String(next[1]);
        this.redraw();
      },
      { passive: false },
    );
  }
  hover(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const near = this.markers.filter((m) => Math.abs(m.x - mx) <= 7).sort((a, b) => Math.abs(a.x - mx) - Math.abs(b.x - mx));
    let text = near
      .slice(0, 3)
      .map((m) => m.text)
      .join('\n');
    if (!text) {
      const { from, to, padL, plotW, points } = this.view;
      const t = from + ((mx - padL) / plotW) * (to - from);
      let best = null;
      for (const p of points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      if (best && Math.abs(best.t - t) <= Math.max(GAP_MS, (to - from) / 40) && mx >= padL && mx <= padL + plotW) {
        text = `${clock(best.t)}\nBitrate ${rate(best.kbps)}${best.rttMs !== null ? `\nRTT ${best.rttMs.toFixed(0)} ms` : ''}`;
      }
    }
    if (!text) {
      this.tip.hidden = true;
      return;
    }
    this.tip.textContent = text;
    this.tip.hidden = false;
    const left = Math.min(mx + 12, rect.width - this.tip.offsetWidth - 4);
    this.tip.style.left = `${Math.max(4, left)}px`;
    this.tip.style.top = '26px';
  }
}
