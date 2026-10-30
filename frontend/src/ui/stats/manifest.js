import { h } from '../dom';
import { clock, formatBytes, shortUri } from '../format';
const HIGHLIGHT = /SCTE|CUE-OUT|CUE-IN|DATERANGE|EventStream|InbandEventStream|<Event\b|<Binary|SPLICE|OATCLS/i;
/** Shows the raw manifest / playlists exactly as fetched, refreshed for live. */
export class ManifestTab {
  ctrl;
  el = h('div', { class: 'tab-pane' });
  picker = h('select', { 'aria-label': 'Captured document', onchange: () => this.renderBody(true) });
  meta = h('span', { class: 'muted small' });
  body = h('pre', { class: 'code manifest' });
  selected = null;
  lastSignature = '';
  constructor(ctrl) {
    this.ctrl = ctrl;
    this.el.append(
      h(
        'div',
        { class: 'toolbar' },
        this.picker,
        h(
          'button',
          {
            type: 'button',
            onclick: () => {
              const doc = this.selected ? this.ctrl.documents.get(this.selected) : undefined;
              if (doc) navigator.clipboard?.writeText(doc.text).catch(() => undefined);
            },
          },
          'Copy',
        ),
      ),
      this.meta,
      this.body,
    );
  }
  render() {
    const docs = [...this.ctrl.documents.values()];
    if (!docs.length) {
      this.picker.replaceChildren(h('option', null, 'Nothing captured yet'));
      this.meta.textContent = '';
      this.body.textContent = '';
      this.selected = null;
      return;
    }
    if (!this.selected || !this.ctrl.documents.has(this.selected)) this.selected = docs[0].uri;
    const signature = docs.map((d) => d.uri).join('|');
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.picker.replaceChildren(
        ...docs.map((d) => h('option', { value: d.uri, selected: d.uri === this.selected }, `${d.kind} — ${shortUri(d.uri, 50)}`)),
      );
    }
    this.renderBody(false);
  }
  renderBody(fromPicker) {
    if (fromPicker) this.selected = this.picker.value;
    const doc = this.selected ? this.ctrl.documents.get(this.selected) : undefined;
    if (!doc) return;
    this.meta.textContent = `${doc.kind} · ${formatBytes(doc.size)} · fetched ${clock(doc.at)} UTC · ${doc.uri}`;
    const key = `${doc.uri}@${doc.at.getTime()}`;
    if (this.body.dataset.key === key) return;
    this.body.dataset.key = key;
    const lines = doc.text.split('\n');
    const shown = lines.slice(0, 4000);
    this.body.replaceChildren(
      ...shown.map((line) => h('span', { class: HIGHLIGHT.test(line) ? 'line hl' : 'line' }, line || ' ')),
      lines.length > shown.length ? `\n… ${lines.length - shown.length} more lines` : '',
    );
  }
}
