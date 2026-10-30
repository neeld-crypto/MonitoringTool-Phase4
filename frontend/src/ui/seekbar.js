import { h } from './dom';
import { formatTime } from './format';
/**
 * Seek bar with buffered ranges, SCTE-35 markers and ad-break spans.
 * Works for VOD (0..duration) and live (seek range window).
 */
export class SeekBar {
  ctrl;
  onMarkerClick;
  el;
  buffered = h('div', { class: 'sb-buffered' });
  played = h('div', { class: 'sb-played' });
  markers = h('div', { class: 'sb-markers' });
  thumb = h('div', { class: 'sb-thumb' });
  tooltip = h('div', { class: 'sb-tooltip' });
  dragging = false;
  markerSignature = '';
  constructor(ctrl, onMarkerClick) {
    this.ctrl = ctrl;
    this.onMarkerClick = onMarkerClick;
    this.el = h(
      'div',
      { class: 'seekbar', role: 'slider', tabIndex: 0, 'aria-label': 'Seek' },
      h('div', { class: 'sb-track' }, this.buffered, this.played, this.markers),
      this.thumb,
      this.tooltip,
    );
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.sb-marker')) return;
      this.dragging = true;
      this.el.setPointerCapture(e.pointerId);
      this.seekTo(e);
    });
    this.el.addEventListener('pointermove', (e) => {
      this.showTooltip(e);
      if (this.dragging) this.seekTo(e);
    });
    this.el.addEventListener('pointerup', () => (this.dragging = false));
    this.el.addEventListener('pointerleave', () => this.tooltip.classList.remove('visible'));
    ctrl.on('scte', () => this.renderMarkers(true));
  }
  range() {
    const p = this.ctrl.player;
    if (!this.ctrl.loadedUrl) return { start: 0, end: 0 };
    const r = p.seekRange();
    if (p.isLive()) return r;
    const d = this.ctrl.video.duration;
    return { start: 0, end: Number.isFinite(d) ? d : r.end };
  }
  timeAt(e) {
    const rect = this.el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const { start, end } = this.range();
    return start + ratio * (end - start);
  }
  seekTo(e) {
    if (!this.ctrl.loadedUrl) return;
    this.ctrl.video.currentTime = this.timeAt(e);
    this.update();
  }
  showTooltip(e) {
    if (!this.ctrl.loadedUrl) return;
    const t = this.timeAt(e);
    const { end } = this.range();
    const rect = this.el.getBoundingClientRect();
    this.tooltip.textContent = this.ctrl.player.isLive() ? formatTime(t - end) : formatTime(t);
    this.tooltip.style.left = `${Math.min(rect.width - 24, Math.max(24, e.clientX - rect.left))}px`;
    this.tooltip.classList.add('visible');
  }
  pct(t) {
    const { start, end } = this.range();
    if (end <= start) return 0;
    return Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100));
  }
  update() {
    const t = this.ctrl.video.currentTime;
    const p = this.pct(t);
    this.played.style.width = `${p}%`;
    this.thumb.style.left = `${p}%`;
    const ranges = this.ctrl.loadedUrl ? this.ctrl.player.getBufferedInfo().total : [];
    this.buffered.replaceChildren(
      ...ranges.map((r) => {
        const a = this.pct(r.start);
        return h('div', { class: 'sb-range', style: `left:${a}%;width:${this.pct(r.end) - a}%` });
      }),
    );
    this.el.setAttribute('aria-valuetext', formatTime(t));
    // Live windows move, so markers have to follow.
    if (this.ctrl.player.isLive()) this.renderMarkers(false);
  }
  renderMarkers(force) {
    const { start, end } = this.range();
    const events = this.ctrl.scte.list().filter((e) => e.startTime !== null);
    const signature = `${events.length}:${Math.round(start)}:${Math.round(end)}`;
    if (!force && signature === this.markerSignature) return;
    this.markerSignature = signature;
    const nodes = [];
    for (const e of events) {
      const st = e.startTime;
      if (st < start - 1 || st > end + 1) continue;
      if (e.direction === 'out' && e.duration) {
        const a = this.pct(st);
        nodes.push(h('div', { class: 'sb-break', style: `left:${a}%;width:${this.pct(st + e.duration) - a}%` }));
      }
      nodes.push(
        h('button', {
          type: 'button',
          class: `sb-marker ${e.direction}`,
          style: `left:${this.pct(st)}%`,
          title: `${formatTime(st)} · ${e.source}\n${e.summary}`,
          'aria-label': `SCTE marker at ${formatTime(st)}: ${e.summary}`,
          onclick: () => this.onMarkerClick(e),
        }),
      );
    }
    this.markers.replaceChildren(...nodes);
  }
}
