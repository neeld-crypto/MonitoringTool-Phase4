import { describe, expect, it } from 'vitest';
import { resolution } from '../src/ui/srt/wall';

const ch = (video) => ({ snapshot: { av: { video } } });

describe('wall tile video spec', () => {
  it('writes progressive as p and interlaced as i, with the frame rate', () => {
    expect(resolution(ch({ codec: 'h264', width: 1920, height: 1080, fps: 25, scan: 'progressive' }))).toBe('h264 · 1080p25');
    expect(resolution(ch({ codec: 'mpeg2video', width: 1920, height: 1080, fps: 25, scan: 'interlaced' }))).toBe('mpeg2 · 1080i25');
    expect(resolution(ch({ codec: 'hevc', width: 1280, height: 720, fps: 59.94, scan: 'progressive' }))).toBe('hevc · 720p59.94');
  });
  it('does not guess the scan type before the stream reports it', () => {
    expect(resolution(ch({ codec: 'h264', width: 1920, height: 1080, fps: 25 }))).toBe('h264 · 1080@25');
    expect(resolution(ch({ codec: 'h264', width: 640, height: 360, fps: 25 }))).toBe('h264 · 640×360@25');
    expect(resolution(ch({ codec: 'h264', width: 1920, height: 1080 }))).toBe('h264 · 1080');
  });
  it('is empty while nothing is detected', () => {
    expect(resolution({ snapshot: { av: null } })).toBe('');
  });
});
