import { describe, expect, it } from 'vitest';
import { collides, fillEmpty, freeSpot, fromPreset, GRID, PRESETS } from '../src/layouts/model';

describe('layout presets', () => {
  it('stay inside the screen and never overlap', () => {
    for (const p of PRESETS) {
      p.cells.forEach((c, i) => {
        expect(c.x >= 0 && c.y >= 0 && c.x + c.w <= GRID && c.y + c.h <= GRID, `${p.id} cell ${i}`).toBe(true);
        expect(collides(p.cells, c, i), `${p.id} cell ${i} overlaps`).toBe(false);
      });
    }
  });

  it('give 9 cells for 3 × 3 and 6 for "1 big + 5"', () => {
    expect(PRESETS.find((p) => p.id === '3x3').cells).toHaveLength(9);
    expect(PRESETS.find((p) => p.id === 'f5').cells).toHaveLength(6);
  });
});

describe('placing cells', () => {
  it('finds the first free spot and says when the screen is full', () => {
    const full = [{ x: 0, y: 0, w: GRID, h: GRID }];
    expect(freeSpot(full)).toBeNull();
    expect(freeSpot([{ x: 0, y: 0, w: 12, h: GRID }])).toEqual({ x: 12, y: 0, w: 8, h: 8 });
  });

  it('shrinks a new cell to fit a small gap', () => {
    const cells = [{ x: 0, y: 0, w: GRID, h: GRID - 3 }];
    expect(freeSpot(cells)).toEqual({ x: 0, y: GRID - 3, w: 3, h: 3 });
  });

  it('fills empty cells with unused channels and keeps chosen ones', () => {
    const cells = [
      { x: 0, y: 0, w: 12, h: 12, channel: 2 },
      { x: 12, y: 0, w: 12, h: 12, channel: null },
      { x: 0, y: 12, w: 12, h: 12, channel: null },
    ];
    expect(fillEmpty(cells, [1, 2, 3]).map((c) => c.channel)).toEqual([2, 1, 3]);
    expect(fillEmpty(cells, [2]).map((c) => c.channel)).toEqual([2, null, null]);
  });

  it('keeps a cell\'s channel when another preset is chosen', () => {
    const previous = [{ channel: 5 }, { channel: null }];
    const cells = fromPreset(PRESETS.find((p) => p.id === '2x2'), previous, [5, 6, 7]);
    expect(cells.map((c) => c.channel)).toEqual([5, 6, 7, null]);
  });
});
