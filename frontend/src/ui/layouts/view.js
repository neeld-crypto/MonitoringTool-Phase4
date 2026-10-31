import { aspectRatio, GRID } from '../../layouts/model';
import { h } from '../dom';
import { SrtWall } from '../srt/wall';

/** Puts an element where a layout cell says, in percent of the screen. */
export function place(el, cell) {
  el.style.left = `${(cell.x / GRID) * 100}%`;
  el.style.top = `${(cell.y / GRID) * 100}%`;
  el.style.width = `${(cell.w / GRID) * 100}%`;
  el.style.height = `${(cell.h / GRID) * 100}%`;
}

/**
 * The live wall of one saved layout: the same tiles as the SRT / UDP wall (picture, name, alerts, level meter), each
 * placed in its cell. A cell with no channel shows an empty box. The stage keeps the layout's shape, also in fullscreen.
 */
export class LayoutWall extends SrtWall {
  layout = null;
  slots = [];
  constructor(client, hooks) {
    super(client, hooks);
    this.el.classList.add('lay-stage');
  }
  setLayout(layout) {
    for (const t of this.tiles.values()) this.io?.unobserve(t.el);
    this.tiles.clear();
    this.layout = layout;
    this.el.replaceChildren();
    this.el.style.setProperty('--ar', String(aspectRatio(layout.aspect)));
    // The same switch that drops detail from small tiles on the wall.
    this.el.dataset.size = layout.cells.length > 15 ? 's' : layout.cells.length > 4 ? 'm' : 'xl';
    this.slots = layout.cells.map((cell) => {
      const slot = h('div', { class: 'lay-slot' });
      place(slot, cell);
      this.el.append(slot);
      return slot;
    });
    this.render();
  }
  render() {
    this.lastRender = Date.now();
    if (!this.layout || this.el.closest('[hidden]')) return;
    const byId = new Map(this.client.channels.map((c) => [c.id, c]));
    let live = 0;
    let alerts = 0;
    this.layout.cells.forEach((cell, i) => {
      const slot = this.slots[i];
      const c = cell.channel === null ? undefined : byId.get(cell.channel);
      let tile = this.tiles.get(i);
      if (!c) {
        if (tile) {
          this.io?.unobserve(tile.el);
          this.tiles.delete(i);
        }
        const text = cell.channel === null ? 'No channel' : 'Channel removed';
        if (slot.dataset.empty !== text) {
          slot.dataset.empty = text;
          slot.replaceChildren(text);
        }
        return;
      }
      if (!tile) {
        tile = this.makeTile(c.id);
        this.tiles.set(i, tile);
        delete slot.dataset.empty;
        slot.replaceChildren(tile.el);
        this.io?.observe(tile.el);
      }
      this.update(tile, c, i + 1);
      if (c.snapshot.state === 'connected') live++;
      alerts += this.client.activeCount(c);
    });
    this.hooks.onSummary({ live, alerts });
  }
}
