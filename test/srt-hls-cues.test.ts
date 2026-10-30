import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain JS helper shared with the sample generator
import { encodeScte35, toBase64, toHex } from '../scripts/lib/scte35-encode.mjs';
import { HlsProbe } from '../server/srt/hls-probe';

const out = encodeScte35({ command: 'splice_insert', pts: 6, insert: { eventId: 1001, out: true, duration: 201.8 } });
const back = encodeScte35({ command: 'splice_insert', pts: 6, insert: { eventId: 1001, out: false } });

const playlist = (...tags: string[]) =>
  ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:10', '#EXTINF:6,', 'a.ts', ...tags, '#EXTINF:6,', 'b.ts', '#EXTINF:6,', 'c.ts', ''].join('\n');

function serve(text: () => string) {
  vi.stubGlobal('fetch', async () => new Response(text(), { status: 200 }));
}
afterEach(() => vi.unstubAllGlobals());

async function cuesOf(text: string) {
  serve(() => text);
  const p = new HlsProbe('http://h/live/media.m3u8');
  await p.resolve();
  await p.poll();
  return p.drainCues();
}

describe('ad tags in an HLS playlist', () => {
  it('reads direction and break length from the SCTE-35 in a DATERANGE', async () => {
    const cues = await cuesOf(playlist(`#EXT-X-DATERANGE:ID="splice-1",START-DATE="2026-01-01T00:00:00Z",SCTE35-OUT=${toHex(out)}`));
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ direction: 'out', crcValid: true });
    expect(cues[0].duration).toBeCloseTo(201.8, 1);
    expect(cues[0].summary).toContain('DATERANGE splice-1');
    expect(cues[0].summary).not.toContain('Undecodable');
  });

  it('reads CUE-OUT with a duration, CUE-IN, and an OATCLS base64 payload', async () => {
    const a = await cuesOf(playlist('#EXT-X-CUE-OUT:30'));
    expect(a).toMatchObject([{ direction: 'out', duration: 30, summary: 'CUE-OUT' }]);
    const b = await cuesOf(playlist('#EXT-X-CUE-IN'));
    expect(b).toMatchObject([{ direction: 'in' }]);
    const c = await cuesOf(playlist(`#EXT-OATCLS-SCTE35:${toBase64(back)}`));
    expect(c[0]).toMatchObject({ direction: 'in' });
  });

  it('reports each tag once however often the playlist is read, and new ones as they appear', async () => {
    let text = playlist('#EXT-X-CUE-OUT:30');
    serve(() => text);
    const p = new HlsProbe('http://h/live/media.m3u8');
    await p.resolve();
    await p.poll();
    expect(p.drainCues()).toHaveLength(1);
    await p.poll();
    await p.poll();
    expect(p.drainCues()).toHaveLength(0);
    text = text.replace('#EXTINF:6,\nc.ts', '#EXT-X-CUE-IN\n#EXTINF:6,\nc.ts');
    await p.poll();
    expect(p.drainCues()).toMatchObject([{ direction: 'in' }]);
  });

  it('stands in for the missing OUT when joined mid-break, once', async () => {
    const text = playlist('#EXT-X-CUE-OUT-CONT:ElapsedTime=40,Duration=90');
    serve(() => text);
    const p = new HlsProbe('http://h/live/media.m3u8');
    await p.resolve();
    await p.poll();
    const [c] = p.drainCues();
    expect(c).toMatchObject({ direction: 'out', duration: 90 });
    expect(Date.now() - c.receivedAt).toBeGreaterThanOrEqual(39_000);
  });

  it('reports nothing for a playlist without ad tags', async () => {
    expect(await cuesOf(playlist())).toEqual([]);
  });
});
