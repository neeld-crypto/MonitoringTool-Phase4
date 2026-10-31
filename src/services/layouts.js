import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Cells sit on a GRID × GRID grid, so halves, thirds, quarters and sixths of the screen all fit exactly. */
export const LAYOUT_GRID = 24;
export const ASPECTS = ['16x9', '4x3', '21x9', '1x1'];
const MAX_LAYOUTS = 64;
const MAX_CELLS = 64;
const MAX_NAME = 60;

const int = (v) => Number.isInteger(v);

/** Validates untrusted JSON from the browser into a list of layouts. Throws with a user-facing message. */
export function validateLayouts(raw) {
  if (!Array.isArray(raw)) throw new Error('layouts must be a list');
  if (raw.length > MAX_LAYOUTS) throw new Error(`At most ${MAX_LAYOUTS} layouts can be saved`);
  const ids = new Set();
  return raw.map((l, n) => {
    const where = `layout ${n + 1}`;
    if (!int(l?.id) || l.id < 1 || ids.has(l.id)) throw new Error(`${where}: bad id`);
    ids.add(l.id);
    const name = typeof l.name === 'string' ? l.name.trim().slice(0, MAX_NAME) : '';
    if (!name) throw new Error(`${where}: a name is required`);
    if (!ASPECTS.includes(l.aspect)) throw new Error(`${where}: aspect must be one of ${ASPECTS.join(', ')}`);
    if (!Array.isArray(l.cells) || l.cells.length > MAX_CELLS) throw new Error(`${where}: at most ${MAX_CELLS} cells`);
    const cells = l.cells.map((c, i) => {
      const { x, y, w, h } = c ?? {};
      if (![x, y, w, h].every(int) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > LAYOUT_GRID || y + h > LAYOUT_GRID) {
        throw new Error(`${where}: cell ${i + 1} is outside the screen`);
      }
      const channel = c.channel === null || c.channel === undefined ? null : c.channel;
      if (channel !== null && (!int(channel) || channel < 1)) throw new Error(`${where}: cell ${i + 1} has a bad channel`);
      return { x, y, w, h, channel };
    });
    return { id: l.id, name, aspect: l.aspect, cells };
  });
}

/** The saved layouts, or an empty list when there are none yet (or the file is unreadable). */
export function loadLayouts(path) {
  try {
    if (!existsSync(path)) return [];
    return validateLayouts(JSON.parse(readFileSync(path, 'utf8')).layouts);
  } catch {
    return [];
  }
}

/** Replaces the saved layouts; the file is swapped in whole so a crash never leaves half of it. */
export function saveLayouts(path, raw) {
  const layouts = validateLayouts(raw);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ layouts }, null, 2));
  renameSync(tmp, path);
  return layouts;
}
