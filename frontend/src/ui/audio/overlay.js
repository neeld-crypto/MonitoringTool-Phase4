import { STANDARDS } from '../../audio/loudness';
import { audioPrefs } from '../../audio/prefs';
import { h } from '../dom';
import { MeterBank } from './meters';
/** Compact per-channel meters + short-term loudness, top-right on the video. */
export class AudioOverlay {
  el;
  engine;
  ctrl;
  bank = new MeterBank({ size: 'small' });
  loudness = h('span', { class: 'ov-loudness', title: 'Short-term loudness (3 s)' });
  start = h('button', { type: 'button', class: 'ov-start' }, 'Click to start audio meters');
  message = h('span', { class: 'ov-loudness' });
  constructor(el, engine, ctrl) {
    this.el = el;
    this.engine = engine;
    this.ctrl = ctrl;
    this.start.onclick = () => void engine.start();
    el.title = 'Audio levels (a) · details in the Audio tab';
    engine.on('levels', () => this.render());
    engine.on('state', () => this.render());
    ctrl.on('tick', () => this.render());
    audioPrefs.onChange(() => this.render());
    ctrl.on('loaded', () => this.render());
    this.render();
  }
  render() {
    const visible = audioPrefs.overlay && Boolean(this.ctrl.loadedUrl) && !this.ctrl.player.isVideoOnly();
    this.el.hidden = !visible;
    if (!visible) return;
    const e = this.engine;
    if (!e.reading && e.stream.status !== 'active') {
      if (e.needsGesture) {
        this.el.replaceChildren(this.start);
        return;
      }
      if (e.state === 'unsupported' || e.state === 'error') {
        this.message.textContent = 'meters unavailable';
        this.el.replaceChildren(this.message);
        return;
      }
    }
    const r = e.reading;
    this.bank.update(r?.channels ?? null);
    const s = STANDARDS[audioPrefs.standard];
    this.loudness.textContent = r && Number.isFinite(r.shortTerm) ? `${r.shortTerm.toFixed(1)} ${s.unit}` : `— ${s.unit}`;
    if (this.el.firstChild !== this.bank.el) this.el.replaceChildren(this.bank.el, this.loudness);
  }
}
