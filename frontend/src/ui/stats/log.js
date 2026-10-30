import { h } from '../dom';
import { clock } from '../format';
export class LogTab {
  ctrl;
  el = h('div', { class: 'tab-pane' });
  body = h('ol', { class: 'log' });
  constructor(ctrl) {
    this.ctrl = ctrl;
    this.el.append(this.body);
  }
  render() {
    this.body.replaceChildren(
      ...[...this.ctrl.log]
        .reverse()
        .map((e) => h('li', { class: e.level }, h('span', { class: 'mono muted' }, clock(e.at)), ' ', e.message)),
    );
  }
}
