import { describe, expect, it } from 'vitest';
import { parseMaster, parseMedia, pickLowest } from '../src/parser/hls-probe.js';
import { buildFfmpegArgs, validateConfig } from '../src/services/srt/session.js';
import { sanitizeConfig } from '../src/services/srt/monitor.js';
const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
hd/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
sd/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"
audio/index.m3u8
`;
describe('HLS playlists', () => {
  it('lists the variants with absolute URLs and picks the smallest picture, not the audio-only one', () => {
    const v = parseMaster(MASTER, 'https://cdn.example.com/live/master.m3u8');
    expect(v.map((x) => x.url)).toEqual([
      'https://cdn.example.com/live/hd/index.m3u8',
      'https://cdn.example.com/live/sd/index.m3u8',
      'https://cdn.example.com/live/audio/index.m3u8',
    ]);
    expect(v[0].bandwidth).toBe(4_500_000);
    expect(v[2].audioOnly).toBe(true);
    expect(pickLowest(v)?.resolution).toBe('640x360');
  });
  it('falls back to the lowest bitrate when no resolution is given, and to audio when that is all there is', () => {
    const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nb.m3u8\n';
    expect(pickLowest(parseMaster(text, 'http://h/x.m3u8'))?.url).toBe('http://h/b.m3u8');
    const audio = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\na.m3u8\n';
    expect(pickLowest(parseMaster(audio, 'http://h/x.m3u8'))?.url).toBe('http://h/a.m3u8');
    expect(pickLowest([])).toBeNull();
  });
  it('treats a media playlist as having no variants and reads its sequence, target duration and end', () => {
    const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:120\n#EXTINF:6.0,\na.ts\n#EXTINF:6.0,\nb.ts\n';
    expect(parseMaster(media, 'http://h/m.m3u8')).toEqual([]);
    expect(parseMedia(media)).toEqual({ mediaSequence: 120, targetDuration: 6, segments: 2, ended: false });
    expect(parseMedia(`${media}#EXT-X-ENDLIST\n`)?.ended).toBe(true);
    expect(parseMedia('<html>not a playlist</html>')).toBeNull();
  });
});
describe('HLS config', () => {
  it('validates and persists an HLS channel, and rejects other schemes', () => {
    const cfg = validateConfig({ mode: 'hls', url: ' https://h/live/a.m3u8 ' });
    expect(cfg).toMatchObject({ mode: 'hls', host: 'h', port: 443, url: 'https://h/live/a.m3u8', lightAnalysis: true });
    expect(() => validateConfig({ mode: 'hls', url: 'file:///etc/passwd' })).toThrow(/http/);
    expect(() => validateConfig({ mode: 'hls', url: 'nonsense' })).toThrow(/playlist address/);
    expect(sanitizeConfig(cfg)?.url).toBe('https://h/live/a.m3u8');
    expect(sanitizeConfig({ mode: 'hls', host: 'h', port: 443, url: 'ftp://x' })).toBeNull();
  });
  it('reads the playlist itself in ffmpeg, in real time, without the transport-stream copy', () => {
    const cfg = validateConfig({ mode: 'hls', url: 'https://h/live/master.m3u8' });
    const args = buildFfmpegArgs(cfg, { viaLiveTransmit: false, thumbPath: 'x.jpg', inputUrl: 'https://h/live/sd/index.m3u8' });
    expect(args.slice(args.indexOf('-re'), args.indexOf('-re') + 4)).toEqual(['-re', '-rw_timeout', '15000000', '-i']);
    expect(args).toContain('https://h/live/sd/index.m3u8');
    expect(args).not.toContain('pipe:1');
    expect(args).toContain('x.jpg');
  });
});
