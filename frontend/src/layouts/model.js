/** Cells sit on a GRID × GRID grid (the same number the server checks), so halves, thirds, quarters and sixths fit exactly. */
export const GRID = 24;
/** The smallest a cell can be dragged to, in grid units. */
export const MIN_CELL = 2;
export const ASPECTS = [
  { id: '16x9', label: '16 × 9', ratio: 16 / 9 },
  { id: '4x3', label: '4 × 3', ratio: 4 / 3 },
  { id: '21x9', label: '21 × 9', ratio: 21 / 9 },
  { id: '1x1', label: '1 × 1', ratio: 1 },
];
export const aspectRatio = (id) => ASPECTS.find((a) => a.id === id)?.ratio ?? 16 / 9;

const even = (cols, rows) => {
  const w = GRID / cols;
  const h = GRID / rows;
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ x: c * w, y: r * h, w, h });
  return cells;
};
/** One big picture with small ones along the right and bottom edges. */
const featured = (big, small) => {
  const cells = [{ x: 0, y: 0, w: big, h: big }];
  for (let y = 0; y < GRID; y += small) if (y < big) cells.push({ x: big, y, w: small, h: small });
  for (let y = big; y < GRID; y += small) for (let x = 0; x < GRID; x += small) cells.push({ x, y, w: small, h: small });
  return cells;
};
const rows = (...spec) => {
  const cells = [];
  const h = GRID / spec.length;
  spec.forEach((n, r) => {
    for (let c = 0; c < n; c++) cells.push({ x: (c * GRID) / n, y: r * h, w: GRID / n, h });
  });
  return cells;
};

/** Ready-made layouts shown beside the editor. */
export const PRESETS = [
  { id: '1', label: '1 full screen', cells: even(1, 1) },
  { id: '2x1', label: '2 side by side', cells: even(2, 1) },
  { id: '2x2', label: '2 × 2', cells: even(2, 2) },
  { id: '3x2', label: '3 × 2', cells: even(3, 2) },
  { id: '3x3', label: '3 × 3', cells: even(3, 3) },
  { id: '4x3', label: '4 × 3', cells: even(4, 3) },
  { id: '4x4', label: '4 × 4', cells: even(4, 4) },
  { id: '6x4', label: '6 × 4', cells: even(6, 4) },
  { id: '8x6', label: '8 × 6', cells: even(8, 6) },
  { id: 'f5', label: '1 big + 5', cells: featured(16, 8) },
  { id: 'f7', label: '1 big + 7', cells: featured(18, 6) },
  { id: 'r2-4', label: '2 big, 4 below', cells: rows(2, 4) },
  { id: 'r2-3', label: '2 big, 3 below', cells: rows(2, 3) },
  { id: 'r1-4', label: '1 wide, 4 below', cells: rows(1, 4) },
  { id: 'r2-4-4', label: '2, 4 and 4', cells: rows(2, 4, 4) },
];

export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Whether `cell` would sit on top of another cell (the one at `except` is ignored: it is the one being moved). */
export const collides = (cells, cell, except = -1) => cells.some((c, i) => i !== except && overlaps(c, cell));

/** The first free place for a cell of about w × h (it shrinks until it fits), or null when the screen is full. */
export function freeSpot(cells, w = 8, h = 8) {
  for (let size = Math.max(w, h); size >= MIN_CELL; size--) {
    const cw = Math.min(w, size);
    const ch = Math.min(h, size);
    for (let y = 0; y + ch <= GRID; y++) {
      for (let x = 0; x + cw <= GRID; x++) {
        const cell = { x, y, w: cw, h: ch };
        if (!collides(cells, cell)) return cell;
      }
    }
  }
  return null;
}

/** Cells for a preset, keeping the channels the old cell at the same position had and giving unused channels to empty ones. */
export function fromPreset(preset, previous, channelIds) {
  const cells = preset.cells.map((c, i) => ({ ...c, channel: previous[i]?.channel ?? null }));
  return fillEmpty(cells, channelIds);
}
/** Gives each empty cell the next channel that is not on the screen yet. */
export function fillEmpty(cells, channelIds) {
  const used = new Set(cells.map((c) => c.channel).filter((c) => c !== null));
  const spare = channelIds.filter((id) => !used.has(id));
  return cells.map((c) => (c.channel === null && spare.length ? { ...c, channel: spare.shift() } : c));
}

/**
 * Makes the cell at `index` the rectangle `next` and trims every cell it now covers (on the side that keeps the most of it), so one
 * channel can be pulled bigger without moving the others by hand. Returns the new list of rectangles, or null when a neighbour
 * would become smaller than MIN_CELL (then the cell cannot grow that far).
 */
export function resizeInto(cells, index, next) {
  const out = cells.map((c, i) => (i === index ? { ...c, ...next } : { ...c }));
  for (let i = 0; i < out.length; i++) {
    const o = out[i];
    if (i === index || !overlaps(o, next)) continue;
    const keep = [
      { x: next.x + next.w, y: o.y, w: o.x + o.w - (next.x + next.w), h: o.h },
      { x: o.x, y: o.y, w: next.x - o.x, h: o.h },
      { x: o.x, y: next.y + next.h, w: o.w, h: o.y + o.h - (next.y + next.h) },
      { x: o.x, y: o.y, w: o.w, h: next.y - o.y },
    ].filter((c) => c.w >= MIN_CELL && c.h >= MIN_CELL);
    if (!keep.length) return null;
    keep.sort((a, b) => b.w * b.h - a.w * a.h);
    Object.assign(o, keep[0]);
  }
  return out;
}
