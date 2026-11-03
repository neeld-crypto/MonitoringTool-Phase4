import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEGMENT_FILE, buildRecordArgs, listSegments, pruneSegments, segmentStart } from '../src/services/srt/recorder.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pulse-rec-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const touch = (name, ageMs, bytes = 10) => {
  const file = join(dir, name);
  writeFileSync(file, Buffer.alloc(bytes));
  const t = new Date(Date.now() - ageMs);
  utimesSync(file, t, t);
};

describe('recording segments', () => {
  it('copies the stream into timed segment files without re-encoding', () => {
    const args = buildRecordArgs('/rec/ch1', 600);
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('copy');
    expect(args[args.indexOf('-segment_time') + 1]).toBe('600');
    expect(args).toContain('-strftime');
    expect(args.at(-1)).toMatch(/%Y%m%d_%H%M%S\.ts$/);
  });

  it('only accepts its own file names (no path tricks)', () => {
    expect(SEGMENT_FILE.test('20261103_143000.ts')).toBe(true);
    for (const bad of ['../x.ts', '20261103_143000.ts/..', 'a.ts', '20261103_143000.mp4', '']) expect(SEGMENT_FILE.test(bad)).toBe(false);
  });

  it('reads the start time from the name', () => {
    expect(segmentStart('20261103_143005.ts')).toBe(new Date(2026, 10, 3, 14, 30, 5).getTime());
    expect(segmentStart('nope.ts')).toBeNull();
  });

  it('lists segments newest first and ignores other files', () => {
    touch('20261103_140000.ts', 0, 100);
    touch('20261103_141000.ts', 0, 200);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const list = listSegments(dir);
    expect(list.map((s) => s.name)).toEqual(['20261103_141000.ts', '20261103_140000.ts']);
    expect(list[0].size).toBe(200);
  });

  it('treats a missing folder as empty', () => {
    expect(listSegments(join(dir, 'nothing'))).toEqual([]);
  });

  it('deletes only segments older than the keep time', () => {
    mkdirSync(dir, { recursive: true });
    touch('20261101_100000.ts', 25 * 3600_000);
    touch('20261103_100000.ts', 1 * 3600_000);
    expect(pruneSegments(dir, 24 * 3600_000)).toBe(1);
    expect(listSegments(dir).map((s) => s.name)).toEqual(['20261103_100000.ts']);
  });
});
