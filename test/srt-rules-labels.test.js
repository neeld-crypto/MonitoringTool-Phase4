import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ruleHelp, ruleLabel } from '../frontend/src/srt/rule-labels.js';

const source = (file) => readFileSync(new URL(`../src/services/srt/${file}`, import.meta.url), 'utf8');
const rulesIn = (text) => [...text.matchAll(/\brule: '([a-z_]+)'/g)].map((m) => m[1]);
// The PAT / PMT rules are built as `ts_${name}` in the evaluator.
const evaluated = [...new Set([...rulesIn(source('alerts.js')), 'ts_pat', 'ts_pmt'])];
const events = ['connected', 'disconnected', 'srt_error', 'scte'];

describe('alert rules and what the operator sees', () => {
  it('finds the rules in the evaluator (guards this test against going stale)', () => {
    expect(evaluated.length).toBeGreaterThan(15);
    expect(evaluated).toContain('video_black');
    expect(evaluated).toContain('link_loss');
  });

  it('gives every rule a readable name and a "what to check" hint', () => {
    for (const rule of evaluated) {
      expect(ruleLabel(rule), rule).not.toMatch(/_/);
      expect(ruleHelp(rule).length, `${rule} has no hint`).toBeGreaterThan(10);
    }
  });

  it('names the one-off events too', () => {
    for (const rule of events) expect(ruleLabel(rule), rule).not.toMatch(/_/);
  });
});
