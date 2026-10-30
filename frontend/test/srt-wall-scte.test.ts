import { describe, expect, it } from 'vitest';
import type { ChannelState, ScteFeedItem } from '../src/srt/client';
import { scteBadge } from '../src/ui/srt/wall';

const NOW = 1_000_000_000;
const item = (direction: ScteFeedItem['direction'], agoSec: number, summary: string, duration?: number): ScteFeedItem => ({
  raw: 'x', pid: 500, receivedAt: NOW - agoSec * 1000, summary, direction, duration, crcValid: true,
});
// newest first, like the client keeps them
const chan = (...scte: ScteFeedItem[]) => ({ scte, snapshot: { now: NOW } }) as unknown as ChannelState;

describe('SCTE-35 badge on a wall tile', () => {
  it('shows nothing without markers, and ignores splice_null keep-alives', () => {
    expect(scteBadge(chan())).toBeNull();
    expect(scteBadge(chan(item('other', 1, 'splice_null')))).toBeNull();
  });

  it('counts a running ad break down from its duration', () => {
    const b = scteBadge(chan(item('out', 40, 'splice_insert · OUT #67114254 · 201.8s', 201.8), item('other', 50, 'splice_null')));
    expect(b).toMatchObject({ kind: 'out', text: 'AD BREAK 2:42' });
    expect(b?.title).toContain('OUT #67114254');
  });

  it('keeps showing the break through other cues and until it is clearly over', () => {
    expect(scteBadge(chan(item('other', 1, 'time_signal'), item('out', 10, 'out', 60)))?.kind).toBe('out');
    expect(scteBadge(chan(item('out', 65, 'out', 60)))?.text).toBe('AD BREAK ending');
    expect(scteBadge(chan(item('out', 80, 'out', 60)))).toBeNull();
  });

  it('shows the elapsed time when the marker has no duration', () => {
    expect(scteBadge(chan(item('out', 75, 'out')))?.text).toBe('AD BREAK +1:15');
    expect(scteBadge(chan(item('out', 700, 'out')))).toBeNull();
  });

  it('shows IN for a short while after the break, replacing the OUT', () => {
    expect(scteBadge(chan(item('in', 5, 'IN #67114255'), item('out', 200, 'out', 201.8)))).toMatchObject({ kind: 'in', text: 'SCTE IN' });
    expect(scteBadge(chan(item('in', 30, 'IN'), item('out', 230, 'out', 201.8)))).toBeNull();
  });

  it('flashes other cues briefly when no break is involved', () => {
    expect(scteBadge(chan(item('other', 3, 'time_signal')))).toMatchObject({ kind: 'other', text: 'SCTE' });
    expect(scteBadge(chan(item('other', 30, 'time_signal')))).toBeNull();
  });
});
