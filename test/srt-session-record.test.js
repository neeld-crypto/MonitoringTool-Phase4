import { describe, expect, it } from 'vitest';
import { RECORD_SEGMENT_MINUTES, SrtSession } from '../src/services/srt/session.js';

/** A session that looks started (no processes are spawned), so recording can be switched on and off. */
const running = (over = {}, cfg = { mode: 'caller' }) => {
  const s = new SrtSession({ ffmpegPath: 'ffmpeg', recordDir: '/tmp/none', recordSegmentSec: 600, recordKeepHours: 24, ...over });
  s.stopped = false;
  s.cfg = cfg;
  return s;
};

describe('recording on a session', () => {
  it('needs a running channel', () => {
    const s = new SrtSession({ ffmpegPath: 'ffmpeg', recordDir: '/tmp/none' });
    expect(() => s.setRecording(true)).toThrow(/Start the channel first/);
    expect(s.recordOn).toBe(false);
  });

  it('is refused for HLS, and where the server has no recordings folder', () => {
    expect(() => running({}, { mode: 'hls' }).setRecording(true)).toThrow(/not available for HLS/);
    expect(() => running({ recordDir: null }).setRecording(true)).toThrow(/not set up/);
  });

  it('offers 5, 10, 15, 20, 30 and 60 minutes and nothing else', () => {
    expect(RECORD_SEGMENT_MINUTES).toEqual([5, 10, 15, 20, 30, 60]);
    for (const bad of [0, 1, 7, 25, 61, -5, Number.NaN]) {
      const s = running();
      expect(() => s.setRecording(true, bad), String(bad)).toThrow(/Segment length must be one of/);
      expect(s.recordOn).toBe(false);
    }
  });

  it('records with the chosen length and reports it in the snapshot', () => {
    for (const min of RECORD_SEGMENT_MINUTES) {
      const s = running();
      s.setRecording(true, min);
      expect(s.snapshot().recording).toMatchObject({ segmentSec: min * 60, keepHours: 24 });
      s.setRecording(false);
      expect(s.snapshot().recording).toBeNull();
    }
  });

  it('falls back to the server default length', () => {
    const s = running({ recordSegmentSec: 900 });
    s.setRecording(true);
    expect(s.snapshot().recording.segmentSec).toBe(900);
  });

  it('is switched off when the channel stops', () => {
    const s = running();
    s.setRecording(true, 5);
    s.stop();
    expect(s.recordOn).toBe(false);
    expect(s.snapshot().recording).toBeNull();
  });
});
