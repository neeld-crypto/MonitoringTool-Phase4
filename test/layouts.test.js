import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLayouts, saveLayouts, validateLayouts } from '../src/services/layouts.js';

const good = (over = {}) => ({
  id: 1,
  name: ' Main wall ',
  aspect: '16x9',
  cells: [
    { x: 0, y: 0, w: 12, h: 24, channel: 3 },
    { x: 12, y: 0, w: 12, h: 24, channel: null },
  ],
  ...over,
});

describe('layouts', () => {
  it('accepts a good layout and trims the name', () => {
    const [l] = validateLayouts([good()]);
    expect(l.name).toBe('Main wall');
    expect(l.cells).toHaveLength(2);
  });

  it('rejects cells outside the screen, bad aspects, duplicate ids and empty names', () => {
    expect(() => validateLayouts([good({ cells: [{ x: 20, y: 0, w: 8, h: 4, channel: null }] })])).toThrow(/outside/);
    expect(() => validateLayouts([good({ cells: [{ x: 0, y: 0, w: 0, h: 4, channel: null }] })])).toThrow(/outside/);
    expect(() => validateLayouts([good({ aspect: '5x1' })])).toThrow(/aspect/);
    expect(() => validateLayouts([good(), good()])).toThrow(/bad id/);
    expect(() => validateLayouts([good({ name: '  ' })])).toThrow(/name/);
    expect(() => validateLayouts('x')).toThrow(/list/);
  });

  it('saves and loads, and a missing file is an empty list', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pulse-layouts-')), 'sub', 'layouts.json');
    expect(loadLayouts(path)).toEqual([]);
    saveLayouts(path, [good()]);
    expect(JSON.parse(readFileSync(path, 'utf8')).layouts).toHaveLength(1);
    expect(loadLayouts(path)[0].name).toBe('Main wall');
  });
});
