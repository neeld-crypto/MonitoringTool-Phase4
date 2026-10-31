import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DailyLog, dayFolder } from '../src/services/srt/daily-log.js';
import { CpuSampler, cpuBlock } from '../src/services/srt/load.js';
import { parseStoredChannels, sanitizeConfig, sanitizeName } from '../src/services/srt/monitor.js';
import { Notifier, describeAlert, webhookBody } from '../src/services/srt/notifiers.js';
import { DEFAULT_NOTIFY } from '../src/constants/srt.js';
const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'playprobe-log-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const alert = (over = {}) => ({
  id: 1,
  rule: 'video_black',
  key: 'black_video',
  severity: 'critical',
  state: 'raised',
  message: 'Black video for 3 s',
  at: Date.parse('2026-10-22T10:00:00Z'),
  ...over,
});
describe('DailyLog', () => {
  it('writes into one folder per local date and starts the next folder after midnight', () => {
    const root = tmp();
    let now = new Date(2026, 9, 22, 23, 59, 58);
    const log = new DailyLog(root, () => now);
    log.write(1, 'Studio feed', 'INFO', 'state', 'idle → connected');
    now = new Date(2026, 9, 23, 0, 0, 1);
    log.write(1, 'Studio feed', 'ERROR', 'alert', 'CRITICAL black_video — Black video', true);
    expect(readdirSync(root).sort()).toEqual(['2026-10-22', '2026-10-23']);
    expect(readFileSync(join(root, '2026-10-22', 'Studio feed.log'), 'utf8')).toContain('idle → connected');
    const next = readFileSync(join(root, '2026-10-23', 'Studio feed.log'), 'utf8');
    expect(next).toContain('[Studio feed]');
    expect(next).not.toContain('idle → connected');
    expect(readFileSync(join(root, '2026-10-23', 'all-channels.log'), 'utf8')).toContain('black_video');
    expect(readdirSync(join(root, '2026-10-22'))).not.toContain('all-channels.log');
  });
  it('puts the alerts of every channel and the server lines in all-channels.log, and everything else only in the channel file', () => {
    const root = tmp();
    const log = new DailyLog(root, () => new Date(2026, 0, 5, 8, 0, 0));
    log.write(0, '', 'INFO', 'server', 'ready');
    log.write(2, 'Backup', 'WARN', 'process', 'line one\nline two');
    log.write(2, 'Backup', 'ERROR', 'alert', 'CRITICAL black_video', true);
    log.write(3, 'News', 'ERROR', 'alert', 'WARNING audio_silence', true);
    const dir = join(root, '2026-01-05');
    expect(readdirSync(dir).sort()).toEqual(['Backup.log', 'News.log', 'all-channels.log']);
    const all = readFileSync(join(dir, 'all-channels.log'), 'utf8').trim().split('\n');
    expect(all).toHaveLength(3);
    expect(all[0]).toContain('[server]');
    expect(all[1]).toContain('[Backup]');
    expect(all[2]).toContain('[News]');
    expect(all.join('\n')).not.toContain('line one');
    const backup = readFileSync(join(dir, 'Backup.log'), 'utf8');
    expect(backup).toContain('line one ⏎ line two');
    expect(backup).toContain('black_video');
  });
  it('formats the folder name as YYYY-MM-DD', () => {
    expect(dayFolder(new Date(2026, 8, 3))).toBe('2026-09-03');
  });
});
describe('log files are named after the channel', () => {
  it('uses the name from the app, and keeps appending to the same file when the channel is stopped and started again', () => {
    const root = tmp();
    const log = new DailyLog(root, () => new Date(2026, 0, 5, 8, 0, 0));
    log.write(12, 'Sports East', 'INFO', 'control', 'started');
    log.write(12, 'Sports East', 'INFO', 'control', 'stopped');
    log.write(12, 'Sports East', 'INFO', 'control', 'started');
    expect(readdirSync(join(root, '2026-01-05'))).toEqual(['Sports East.log']);
    expect(readFileSync(join(root, '2026-01-05', 'Sports East.log'), 'utf8').trim().split('\n')).toHaveLength(3);
  });
  it('keeps the same file after a restart of the monitor', () => {
    const root = tmp();
    const first = new DailyLog(root, () => new Date(2026, 0, 5, 8, 0, 0));
    first.write(4, 'Multicast A', 'INFO', 'state', 'one', false, 'udp');
    const second = new DailyLog(root, () => new Date(2026, 0, 5, 9, 0, 0));
    second.reserve(4, 'Multicast A', 'udp');
    second.write(4, 'Multicast A', 'INFO', 'state', 'two', false, 'udp');
    expect(readdirSync(join(root, '2026-01-05'))).toEqual(['Multicast A.log']);
    expect(readFileSync(join(root, '2026-01-05', 'Multicast A.log'), 'utf8')).toMatch(/one[\s\S]*two/);
  });
  it('starts a new file when the channel is renamed, and falls back to kind-id for an empty name', () => {
    const root = tmp();
    const log = new DailyLog(root, () => new Date(2026, 0, 5, 8, 0, 0));
    log.write(1, 'Old name', 'INFO', 'control', 'a');
    log.write(1, 'New name', 'INFO', 'control', 'b');
    log.write(13, '', 'INFO', 'state', 'c', false, 'udp');
    expect(readdirSync(join(root, '2026-01-05')).sort()).toEqual(['New name.log', 'Old name.log', 'udp-13.log']);
  });
  it('keeps two channels with the same name in separate files and makes unsafe names safe', () => {
    const root = tmp();
    const log = new DailyLog(root, () => new Date(2026, 0, 5, 8, 0, 0));
    log.write(1, 'Studio', 'INFO', 'state', 'x');
    log.write(2, 'studio', 'INFO', 'state', 'y');
    log.write(3, 'A/B: "live"?', 'INFO', 'state', 'z');
    log.write(4, 'CON', 'INFO', 'state', 'w');
    expect(readdirSync(join(root, '2026-01-05')).sort()).toEqual(['A_B_ _live__.log', 'CON_.log', 'Studio.log', 'studio (2).log']);
  });
});
describe('channel list in the settings file', () => {
  it('keeps the old fixed layout: six SRT entries then one UDP entry, ids by position', () => {
    const old = [...Array.from({ length: 6 }, (_, i) => ({ name: `S${i + 1}`, config: null })), { name: 'UDP 1', config: null }];
    const parsed = parseStoredChannels(old);
    expect(parsed.map((c) => [c.id, c.kind, c.name])).toEqual([
      [1, 'srt', 'S1'],
      [2, 'srt', 'S2'],
      [3, 'srt', 'S3'],
      [4, 'srt', 'S4'],
      [5, 'srt', 'S5'],
      [6, 'srt', 'S6'],
      [7, 'udp', 'UDP 1'],
    ]);
  });
  it('reads ids and kinds from the new layout, repairs duplicate ids and bad entries, and orders by id', () => {
    const parsed = parseStoredChannels([
      { id: 20, kind: 'udp', name: 'Mcast', config: { mode: 'multicast', host: '239.1.1.1', port: 5000 } },
      { id: 3, kind: 'srt', name: '  News  ', config: { mode: 'caller', host: 'h', port: 7003, latencyMs: 80 } },
      { id: 3, kind: 'srt', name: '', config: { mode: 'nonsense', port: 1 } },
      'garbage',
    ]);
    // The duplicate id 3 moves to 4; the unreadable entry then moves to 5 (it was in position 4).
    expect(parsed.map((c) => c.id)).toEqual([3, 4, 5, 20]);
    expect(parsed.find((c) => c.id === 3)).toMatchObject({
      name: 'News',
      kind: 'srt',
      config: { mode: 'caller', host: 'h', port: 7003, latencyMs: 80 },
    });
    expect(parsed.find((c) => c.id === 4)).toMatchObject({ name: 'SRT 4', config: null });
    expect(parsed.find((c) => c.id === 20)?.kind).toBe('udp');
  });
  it('is empty for a missing or invalid list so a first run can create its own channel', () => {
    expect(parseStoredChannels(undefined)).toEqual([]);
    expect(parseStoredChannels({})).toEqual([]);
  });
  it('never stores secrets from the file or accepts unusable ports', () => {
    expect(sanitizeConfig({ mode: 'caller', host: 'h', port: 1, passphrase: 'secret-secret', streamId: 'x' })).not.toHaveProperty(
      'passphrase',
    );
    expect(sanitizeConfig({ mode: 'caller', host: 'h', port: 70000 })).toBeNull();
    expect(sanitizeConfig(null)).toBeNull();
  });
});
describe('CPU limit', () => {
  it('refuses a start at or above the limit and names both numbers', () => {
    expect(cpuBlock(69.9, 70)).toBeNull();
    expect(cpuBlock(70, 70)).toMatch(/CPU is at 70%.*limit 70%/);
    expect(cpuBlock(93.4, 70)).toMatch(/at 93%/);
  });
  it('averages the last few samples so one spike does not block, and exposes the newest', () => {
    let idle = 0;
    let total = 0;
    const busy = (pct) => () => {
      total += 1000;
      idle += 1000 * (1 - pct / 100);
      return { idle, total };
    };
    let next = busy(0);
    const s = new CpuSampler(() => next());
    s.sample(); // first reading only sets the baseline
    expect(s.pct).toBe(0);
    for (const p of [20, 20, 20]) {
      next = busy(p);
      s.sample();
    }
    expect(s.pct).toBeCloseTo(20, 5);
    next = busy(80);
    s.sample();
    expect(s.latest).toBeCloseTo(80, 5);
    expect(s.pct).toBeCloseTo(40, 5);
    for (let i = 0; i < 3; i++) s.sample();
    expect(s.pct).toBeCloseTo(80, 5);
  });
});
describe('channel names', () => {
  it('trims, collapses whitespace, strips control characters and caps the length', () => {
    expect(sanitizeName('  Studio \n  A  ', 'SRT 1')).toBe('Studio A');
    expect(sanitizeName('x'.repeat(100), 'SRT 1')).toHaveLength(40);
    expect(sanitizeName('   ', 'SRT 3')).toBe('SRT 3');
    expect(sanitizeName(42, 'SRT 4')).toBe('SRT 4');
  });
});
describe('notifications name the channel', () => {
  it('puts the channel name in the title and body of every format', () => {
    const a = alert({ channelId: 3, channelName: 'Sports East' });
    expect(describeAlert(a).title).toContain('Sports East');
    expect(describeAlert(a).text).toContain('Sports East');
    expect(JSON.stringify(webhookBody('slack', a))).toContain('Sports East');
    expect(JSON.stringify(webhookBody('teams', a))).toContain('Sports East');
    expect(JSON.stringify(webhookBody('generic', a))).toContain('Sports East');
  });
  it('applies the cooldown per channel, not across channels', async () => {
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      sent.push(String(init?.body));
      return new Response('ok');
    };
    try {
      const settings = { ...DEFAULT_NOTIFY, webhook: { enabled: true, kind: 'generic', url: 'http://127.0.0.1/hook' }, cooldownSec: 600 };
      const n = new Notifier(() => settings);
      await n.notify(alert({ channelId: 1, channelName: 'A' }));
      await n.notify(alert({ channelId: 1, channelName: 'A' }));
      await n.notify(alert({ channelId: 2, channelName: 'B' }));
      expect(sent).toHaveLength(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
