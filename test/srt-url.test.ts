import { describe, expect, it } from 'vitest';
import { parseStreamLine, parseStreamList, parseStreamUrl } from '../src/srt/url';

describe('parseStreamUrl', () => {
  it('reads an SRT caller with latency, passphrase and stream id', () => {
    expect(parseStreamUrl('srt://203.0.113.10:7003?mode=caller&latency=200&passphrase=abcdefghij&streamid=live/1')).toEqual({
      mode: 'caller',
      host: '203.0.113.10',
      port: 7003,
      latencyMs: 200,
      passphrase: 'abcdefghij',
      streamId: 'live/1',
    });
  });
  it('treats srt://host:port without a mode as a caller, and no host as a listener', () => {
    expect(parseStreamUrl('srt://example.com:9000')).toMatchObject({ mode: 'caller', host: 'example.com', port: 9000 });
    expect(parseStreamUrl('srt://:9001')).toMatchObject({ mode: 'listener', host: '', port: 9001 });
    expect(parseStreamUrl('srt://0.0.0.0:9002?mode=listener')).toMatchObject({ mode: 'listener', host: '', port: 9002 });
  });
  it('converts ffmpeg microsecond latency to milliseconds', () => {
    expect(parseStreamUrl('srt://h:1?mode=caller&latency=120000')).toMatchObject({ latencyMs: 120 });
    expect(parseStreamUrl('srt://h:1?mode=caller&latency=120')).toMatchObject({ latencyMs: 120 });
  });
  it('reads UDP multicast, with or without the @, and the network interface', () => {
    expect(parseStreamUrl('udp://@239.1.1.1:5000')).toEqual({ mode: 'multicast', host: '239.1.1.1', port: 5000 });
    expect(parseStreamUrl('udp://239.1.1.2:5001?localaddr=10.0.0.5')).toEqual({ mode: 'multicast', host: '239.1.1.2', port: 5001, iface: '10.0.0.5' });
  });
  it('reads IPv6 hosts without the brackets', () => {
    expect(parseStreamUrl('srt://[2001:db8::1]:9000?mode=caller')).toMatchObject({ host: '2001:db8::1', port: 9000 });
  });
  it('explains what is missing instead of guessing', () => {
    expect(parseStreamUrl('srt://host')).toEqual({ error: expect.stringMatching(/port/) });
    expect(parseStreamUrl('srt://host:99999')).toEqual({ error: expect.stringMatching(/port/) });
    expect(parseStreamUrl('srt://:9000?mode=caller')).toEqual({ error: expect.stringMatching(/host/) });
    expect(parseStreamUrl('udp://:5000')).toEqual({ error: expect.stringMatching(/multicast/) });
  });
  it('returns null for anything that is not a stream address', () => {
    expect(parseStreamUrl('ftp://example.com/a.m3u8')).toBeNull();
    expect(parseStreamUrl('hello')).toBeNull();
  });
});

describe('parseStreamLine', () => {
  it('splits an optional name from the address', () => {
    expect(parseStreamLine('Sports East | srt://h:7003?mode=caller')).toMatchObject({ name: 'Sports East', config: { host: 'h', port: 7003 } });
    expect(parseStreamLine('News, 24x7 , srt://h:7004')).toMatchObject({ name: 'News, 24x7' });
    expect(parseStreamLine('srt://h:7005')).not.toHaveProperty('name');
  });
  it('skips blank lines and comments, and reports lines without an address', () => {
    expect(parseStreamLine('   ')).toBeNull();
    expect(parseStreamLine('# srt://h:1')).toBeNull();
    expect(parseStreamLine('just words')).toEqual({ error: expect.stringMatching(/address/) });
  });
});

describe('parseStreamList', () => {
  it('collects the good lines and numbers the bad ones as typed', () => {
    const r = parseStreamList('A | srt://h:1\n\n# note\nbroken line\nudp://@239.1.1.1:5000\r\nsrt://h\n');
    expect(r.items.map((i) => i.config.port)).toEqual([1, 5000]);
    expect(r.errors.map((e) => e.line)).toEqual([4, 6]);
  });
});

describe('formatStreamUrl', () => {
  it('writes a saved config back as an address that parses to the same config', async () => {
    const { formatStreamUrl, parseStreamUrl } = await import('../src/srt/url');
    for (const raw of ['srt://203.0.113.10:7003', 'srt://:9001', 'srt://0.0.0.0:9001?mode=listener', 'srt://host:9000?latency=250', 'udp://@239.1.1.1:5000?localaddr=10.0.0.5']) {
      const cfg = parseStreamUrl(raw) as Record<string, unknown>;
      expect(parseStreamUrl(formatStreamUrl({ latencyMs: 120, ...cfg }))).toMatchObject(cfg);
    }
    expect(formatStreamUrl(null)).toBe('');
    expect(formatStreamUrl({ mode: 'listener', host: '', port: 9001, passphrase: 'secretsecret' })).not.toContain('secret');
  });
});
