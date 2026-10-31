import { ASPECTS, collides, fillEmpty, freeSpot, fromPreset, GRID, MIN_CELL, PRESETS } from '../../layouts/model';
import { loadLayouts, saveLayouts } from '../../layouts/client';
import { clear, h } from '../dom';
import { LayoutWall, place } from './view';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const aspectLabel = (id) => ASPECTS.find((a) => a.id === id)?.label ?? id;
const option = (value, text) => h('option', { value }, text);

/**
 * Layouts: save how the channels are arranged on a screen (a preset such as 3 × 3 or "1 big + 5", or cells drawn by
 * hand), then show that arrangement live, also fullscreen. Three screens: the list, the editor and the live view.
 */
export class LayoutsPanel {
  el;
  client;
  hooks;
  layouts = [];
  mode = 'list';
  /** The layout being edited (a copy: Cancel throws it away). */
  draft = null;
  canvas = null;
  cellEls = [];
  viewLayout = null;
  view = null;
  wall;
  summary = h('span', { class: 'muted small' });
  body = h('div', { class: 'lay-body' });
  loaded = false;
  renderTimer = null;
  constructor(el, client, hooks) {
    this.el = el;
    this.client = client;
    this.hooks = hooks;
    this.wall = new LayoutWall(client, {
      onPick: (id) => {
        if (document.fullscreenElement) void document.exitFullscreen();
        hooks.onPick(id);
      },
      onSummary: (s) => {
        this.summary.textContent = `${s.live} playing · ${s.alerts} alert${s.alerts === 1 ? '' : 's'}`;
      },
    });
    el.append(h('h3', { class: 'lay-title' }, 'Layouts'), this.body);
    for (const name of ['status', 'channels', 'alert']) client.on(name, () => this.scheduleRender());
    this.renderList();
  }
  get isOpen() {
    return !this.el.hidden;
  }
  toggle(open) {
    this.el.hidden = open === undefined ? !this.el.hidden : !open;
    if (this.el.hidden) {
      if (document.fullscreenElement && this.view?.contains(document.fullscreenElement)) void document.exitFullscreen();
      return;
    }
    if (!this.loaded) void this.load();
    if (this.mode === 'view') this.wall.render();
  }
  async load() {
    try {
      this.layouts = await loadLayouts();
      this.loaded = true;
    } catch (err) {
      this.hooks.toast(`Could not load the layouts: ${err instanceof Error ? err.message : err}`);
    }
    if (this.mode === 'list') this.renderList();
  }
  async persist(next) {
    this.layouts = await saveLayouts(next);
  }
  scheduleRender() {
    if (this.mode !== 'view' || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.wall.render();
    }, 300);
  }
  channelIds() {
    return this.client.channels.map((c) => c.id);
  }

  // ---------------------------------------------------------------- list

  renderList() {
    this.mode = 'list';
    this.wall.layout = null;
    const rows = this.layouts.map((l) =>
      h(
        'tr',
        null,
        h('td', null, h('button', { type: 'button', class: 'link', onclick: () => this.show(l) }, l.name)),
        h('td', null, aspectLabel(l.aspect)),
        h('td', null, String(l.cells.length)),
        h(
          'td',
          { class: 'lay-actions' },
          h('button', { type: 'button', class: 'primary', onclick: () => this.show(l) }, 'Show'),
          h('button', { type: 'button', onclick: () => this.edit(l) }, 'Edit'),
          h('button', { type: 'button', onclick: () => void this.duplicate(l) }, 'Duplicate'),
          h('button', { type: 'button', class: 'danger', onclick: () => void this.remove(l) }, 'Delete'),
        ),
      ),
    );
    clear(
      this.body,
      h(
        'div',
        { class: 'srt-actions' },
        h('button', { type: 'button', class: 'primary', onclick: () => this.create() }, '＋ New layout'),
        h(
          'span',
          { class: 'muted small' },
          'A layout is a saved arrangement of your channels on one screen. Pick a preset or draw the cells yourself.',
        ),
      ),
      rows.length
        ? h(
            'table',
            { class: 'lay-table' },
            h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'View'), h('th', null, 'Cells'), h('th'))),
            h('tbody', null, rows),
          )
        : h('p', { class: 'muted' }, this.loaded ? 'No layouts yet. Press "New layout" to make one.' : 'Loading…'),
    );
  }
  async duplicate(l) {
    const id = Math.max(0, ...this.layouts.map((x) => x.id)) + 1;
    try {
      await this.persist([...this.layouts, { ...structuredClone(l), id, name: `${l.name} (copy)`.slice(0, 60) }]);
    } catch (err) {
      this.hooks.toast(`Could not duplicate: ${err instanceof Error ? err.message : err}`);
    }
    this.renderList();
  }
  async remove(l) {
    if (!confirm(`Delete the layout "${l.name}"?`)) return;
    try {
      await this.persist(this.layouts.filter((x) => x.id !== l.id));
    } catch (err) {
      this.hooks.toast(`Could not delete: ${err instanceof Error ? err.message : err}`);
    }
    this.renderList();
  }

  // ---------------------------------------------------------------- editor

  create() {
    const preset = PRESETS.find((p) => p.id === '3x3');
    const cells = fromPreset(preset, [], this.channelIds());
    this.openEditor({ id: Math.max(0, ...this.layouts.map((x) => x.id)) + 1, name: '', aspect: '16x9', cells }, true);
  }
  edit(l) {
    this.openEditor(structuredClone(l), false);
  }
  openEditor(draft, isNew) {
    this.mode = 'edit';
    this.wall.layout = null;
    this.draft = draft;
    this.isNew = isNew;
    const nameInput = h('input', {
      type: 'text',
      maxLength: 60,
      autocomplete: 'off',
      spellcheck: false,
      placeholder: 'Layout name, e.g. Sports wall',
      'aria-label': 'Layout name',
      value: draft.name,
    });
    nameInput.addEventListener('input', () => (this.draft.name = nameInput.value));
    const aspectSel = h(
      'select',
      { 'aria-label': 'Screen shape' },
      ASPECTS.map((a) => option(a.id, a.label)),
    );
    aspectSel.value = draft.aspect;
    aspectSel.addEventListener('change', () => {
      this.draft.aspect = aspectSel.value;
      this.applyAspect();
    });
    this.canvas = h('div', { class: 'lay-canvas', role: 'application', 'aria-label': 'Layout editor' });
    this.applyAspect();
    const presets = h(
      'div',
      { class: 'lay-presets', role: 'list', 'aria-label': 'Preset layouts' },
      PRESETS.map((p) =>
        h(
          'button',
          { type: 'button', class: 'lay-preset', role: 'listitem', title: p.label, onclick: () => this.usePreset(p) },
          h(
            'span',
            { class: 'lay-thumb' },
            p.cells.map((c) => {
              const t = h('i');
              place(t, c);
              return t;
            }),
          ),
          h('small', null, p.label),
        ),
      ),
    );
    this.saveError = h('div', { class: 'small lay-error' });
    clear(
      this.body,
      h(
        'div',
        { class: 'srt-actions lay-toolbar' },
        h('label', { class: 'lay-field' }, 'Name ', nameInput),
        h('label', { class: 'lay-field' }, 'View ', aspectSel),
        h('button', { type: 'button', onclick: () => this.addCell() }, '＋ Add cell'),
        h(
          'button',
          {
            type: 'button',
            title: 'Give every empty cell a channel that is not on the screen yet',
            onclick: () => {
              this.draft.cells = fillEmpty(this.draft.cells, this.channelIds());
              this.renderCells();
            },
          },
          'Fill with channels',
        ),
        h(
          'button',
          {
            type: 'button',
            onclick: () => {
              this.draft.cells = [];
              this.renderCells();
            },
          },
          'Clear',
        ),
        h('span', { class: 'lay-gap' }),
        h('button', { type: 'button', class: 'primary', onclick: () => void this.save() }, 'Save'),
        h('button', { type: 'button', onclick: () => this.renderList() }, 'Cancel'),
      ),
      this.saveError,
      h(
        'p',
        { class: 'muted small' },
        'Pick a preset on the left, or drag a cell to move it and drag its bottom-right corner to resize it. Choose the channel inside each cell.',
      ),
      h('div', { class: 'lay-editor' }, presets, this.canvas),
    );
    this.renderCells();
    nameInput.focus();
  }
  applyAspect() {
    const ratio = ASPECTS.find((a) => a.id === this.draft.aspect)?.ratio ?? 16 / 9;
    this.canvas.style.setProperty('--ar', String(ratio));
  }
  usePreset(preset) {
    this.draft.cells = fromPreset(preset, this.draft.cells, this.channelIds());
    this.renderCells();
  }
  addCell() {
    const spot = freeSpot(this.draft.cells);
    if (!spot) {
      this.hooks.toast('There is no room left on the screen: make a cell smaller or remove one.');
      return;
    }
    const [next] = fillEmpty([{ ...spot, channel: null }], this.channelIds().filter((id) => !this.draft.cells.some((c) => c.channel === id)));
    this.draft.cells.push(next);
    this.renderCells();
  }
  renderCells() {
    clear(this.canvas);
    this.cellEls = this.draft.cells.map((cell, i) => this.makeCell(cell, i));
    this.canvas.append(...this.cellEls);
  }
  makeCell(cell, i) {
    const sel = h('select', { class: 'lay-pick', 'aria-label': `Channel of cell ${i + 1}` }, [
      option('', '— no channel —'),
      ...this.client.channels.map((c, n) => option(String(c.id), `${n + 1}. ${c.name}`)),
    ]);
    sel.value = cell.channel === null ? '' : String(cell.channel);
    sel.addEventListener('change', () => {
      cell.channel = sel.value === '' ? null : Number(sel.value);
    });
    // Moving and resizing must not start from the channel list.
    sel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const del = h('button', { type: 'button', class: 'lay-del', title: 'Remove this cell', 'aria-label': `Remove cell ${i + 1}` }, '×');
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', () => {
      this.draft.cells.splice(i, 1);
      this.renderCells();
    });
    const handle = h('span', { class: 'lay-handle', title: 'Drag to resize' });
    const el = h('div', { class: 'lay-cell' }, h('b', { class: 'lay-no' }, String(i + 1)), del, sel, handle);
    place(el, cell);
    el.addEventListener('pointerdown', (e) => this.drag(e, el, cell, i, e.target === handle ? 'resize' : 'move'));
    return el;
  }
  /** Moves or resizes a cell with the mouse (or a finger), snapping to the grid and never onto another cell. */
  drag(e, el, cell, index, mode) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const unitX = rect.width / GRID;
    const unitY = rect.height / GRID;
    const start = { x: e.clientX, y: e.clientY, cell: { ...cell } };
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const move = (ev) => {
      const dx = Math.round((ev.clientX - start.x) / unitX);
      const dy = Math.round((ev.clientY - start.y) / unitY);
      const s = start.cell;
      const next =
        mode === 'move'
          ? { ...s, x: clamp(s.x + dx, 0, GRID - s.w), y: clamp(s.y + dy, 0, GRID - s.h) }
          : { ...s, w: clamp(s.w + dx, MIN_CELL, GRID - s.x), h: clamp(s.h + dy, MIN_CELL, GRID - s.y) };
      if (collides(this.draft.cells, next, index)) return;
      Object.assign(cell, next);
      place(el, cell);
    };
    const done = () => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', done);
      el.removeEventListener('pointercancel', done);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', done);
    el.addEventListener('pointercancel', done);
  }
  async save() {
    const d = this.draft;
    d.name = d.name.trim();
    if (!d.name) return void (this.saveError.textContent = 'Give the layout a name.');
    if (!d.cells.length) return void (this.saveError.textContent = 'Add at least one cell.');
    if (this.layouts.some((l) => l.id !== d.id && l.name.toLowerCase() === d.name.toLowerCase())) {
      return void (this.saveError.textContent = 'Another layout already has this name.');
    }
    try {
      const exists = this.layouts.some((l) => l.id === d.id);
      await this.persist(exists ? this.layouts.map((l) => (l.id === d.id ? d : l)) : [...this.layouts, d]);
    } catch (err) {
      this.saveError.textContent = `Could not save: ${err instanceof Error ? err.message : err}`;
      return;
    }
    this.hooks.toast(`Layout "${d.name}" saved`);
    this.show(this.layouts.find((l) => l.id === d.id) ?? d);
  }

  // ---------------------------------------------------------------- live view

  show(layout) {
    this.mode = 'view';
    this.viewLayout = layout;
    this.view = h('div', { class: 'lay-view' }, this.wall.el);
    clear(
      this.body,
      h(
        'div',
        { class: 'srt-actions' },
        h('strong', { class: 'lay-name' }, layout.name),
        this.summary,
        h('span', { class: 'lay-gap' }),
        h('button', { type: 'button', class: 'primary', onclick: () => void this.view.requestFullscreen?.() }, 'Fullscreen'),
        h('button', { type: 'button', onclick: () => this.edit(layout) }, 'Edit'),
        h('button', { type: 'button', onclick: () => this.renderList() }, 'Back to layouts'),
      ),
      this.view,
    );
    this.wall.setLayout(layout);
  }
}
