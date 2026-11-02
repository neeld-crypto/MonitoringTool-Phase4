import { describe, expect, it } from 'vitest';
import { collides, fillEmpty, freeSpot, fromPreset, GRID, PRESETS, resizeInto } from '../src/layouts/model';

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

describe('resizing a cell over its neighbours', () => {
  const grid2x2 = () => PRESETS.find((p) => p.id === '2x2').cells.map((c) => ({ ...c, channel: null }));

  it('trims the cells it grows over', () => {
    const out = resizeInto(grid2x2(), 0, { x: 0, y: 0, w: 18, h: 12 });
    expect(out[0]).toMatchObject({ x: 0, y: 0, w: 18, h: 12 });
    expect(out[1]).toMatchObject({ x: 18, y: 0, w: 6, h: 12 });
    expect(out[2]).toMatchObject({ x: 0, y: 12, w: 12, h: 12 });
  });

  it('refuses to squash a neighbour below the minimum size', () => {
    expect(resizeInto(grid2x2(), 0, { x: 0, y: 0, w: 24, h: 12 })).toBeNull();
  });

  it('leaves the original list alone, so dragging back restores the neighbours', () => {
    const cells = grid2x2();
    resizeInto(cells, 0, { x: 0, y: 0, w: 18, h: 12 });
    expect(cells[1]).toMatchObject({ x: 12, w: 12 });
  });
});
