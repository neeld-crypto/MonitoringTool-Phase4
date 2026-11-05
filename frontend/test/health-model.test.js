import { describe, expect, it } from 'vitest';
import { ruleHelp, ruleLabel } from '../src/srt/rule-labels';
import { healthModel } from '../src/ui/stats/health';

const snap = (over = {}) => ({
  tsSource: 'wire',
  ts: { syncLosses: 0, ccErrors: 3, teiErrors: 0, psiCrcErrors: 0 },
  link: { lost: 12, dropped: 0, retransmitted: 4 },
  av: { blackFrames: 0, silenceEvents: 1, decodeErrors: 0 },
  ...over,
});
const alert = (rule, state = 'raised', at = 1000) => ({ rule, state, at, message: `${rule} happened`, severity: 'warning' });
const rows = (m) => Object.fromEntries(m.groups.flatMap((g) => g.rows).map((r) => [r.rule, r]));

describe('stream health checklist', () => {
  it('is all green with no alerts', () => {
    const m = healthModel(snap(), []);
    expect(m.raised).toEqual([]);
    expect(m.groups.flatMap((g) => g.rows).every((r) => r.live === null)).toBe(true);
  });

  it('marks a row red while its alert is raised, and remembers the last time after it recovers', () => {
    const m = healthModel(snap(), [alert('ts_cc', 'raised', 5000), alert('video_black', 'cleared', 3000)]);
    const r = rows(m);
    expect(r.ts_cc.live).toMatchObject({ state: 'raised' });
    expect(r.ts_cc.count).toBe(3);
    expect(r.video_black.live).toBeNull();
    expect(r.video_black.last.at).toBe(3000);
    expect(m.problems).toEqual([ruleLabel('ts_cc')]);
  });

  it('ignores one-off events (connect / SCTE-35) and other channels\' rules', () => {
    const m = healthModel(snap(), [alert('scte', 'event'), alert('connected', 'event')]);
    expect(m.raised).toEqual([]);
  });

  it('hides the wire-level checks in basic mode, where they would be false reassurance', () => {
    const wire = Object.keys(rows(healthModel(snap(), [])));
    const basic = Object.keys(rows(healthModel(snap({ tsSource: 'remuxed' }), [])));
    for (const rule of ['ts_sync', 'ts_cc', 'ts_tei', 'ts_crc', 'ts_pcr']) {
      expect(wire).toContain(rule);
      expect(basic).not.toContain(rule);
    }
    expect(basic).toContain('video_black');
  });

  it('has no network group without link statistics', () => {
    const titles = healthModel(snap({ link: null }), []).groups.map((g) => g.title);
    expect(titles).not.toContain('Network');
  });

  it('gives every row a label and a "what to check" hint', () => {
    for (const row of Object.values(rows(healthModel(snap(), [])))) {
      expect(ruleLabel(row.rule)).not.toMatch(/_/);
      expect(ruleHelp(row.rule).length).toBeGreaterThan(10);
    }
  });
});
