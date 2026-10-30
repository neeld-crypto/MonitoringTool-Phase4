import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS helper shared with the sample generator
import { encodeScte35 } from '../scripts/lib/scte35-encode.mjs';
import { crc32Mpeg2 } from '../src/scte/scte35';
import { TsAnalyzer } from '../server/srt/ts-analyzer';

/** Synthetic MPEG-TS builder for the analyser tests. */
const PKT = 188;
function packet(pid: number, cc: number, opts: { payload?: Uint8Array; pusi?: boolean; pcr?: number; afOnly?: boolean; tei?: boolean } = {}) {
  const p = new Uint8Array(PKT).fill(0xff);
  p[0] = 0x47;
  p[1] = (opts.tei ? 0x80 : 0) | (opts.pusi ? 0x40 : 0) | (pid >> 8);
  p[2] = pid & 0xff;
  let o = 4;
  const hasAf = opts.pcr !== undefined || opts.afOnly;
  const hasPayload = !opts.afOnly;
  p[3] = ((hasAf ? 2 : 0) | (hasPayload ? 1 : 0)) << 4 | (cc & 0x0f);
  if (hasAf) {
    if (opts.pcr !== undefined) {
      const base = Math.floor(opts.pcr * 90000);
      p[4] = 7;
      p[5] = 0x10;
      p[6] = Math.floor(base / 2 ** 25) & 0xff;
      p[7] = Math.floor(base / 2 ** 17) & 0xff;
      p[8] = Math.floor(base / 2 ** 9) & 0xff;
      p[9] = Math.floor(base / 2) & 0xff;
      p[10] = ((base & 1) << 7) | 0x7e;
      p[11] = 0;
      o = 12;
    } else {
      p[4] = PKT - 5;
      p[5] = 0;
      o = PKT;
    }
  }
  if (opts.payload) p.set(opts.payload.subarray(0, PKT - o), o);
  return p;
}

function section(body: number[]) {
  // section_length counts everything after the length field, including the 4-byte CRC.
  const length = body.length - 1 + 4;
  const head = [body[0], 0xb0 | ((length >> 8) & 0x0f), length & 0xff];
  const all = Uint8Array.from([...head, ...body.slice(1)]);
  const crc = crc32Mpeg2(all);
  return Uint8Array.from([...all, crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]);
}
const withPointer = (s: Uint8Array) => Uint8Array.from([0, ...s]);

const PAT = section([0x00, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe1, 0x00]); // program 1 -> PMT PID 0x100
// PMT: PCR PID 0x101; video 0x101 H.264, audio 0x102 AAC, SCTE-35 0x103
const PMT = section([
  0x02, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00,
  0x1b, 0xe1, 0x01, 0xf0, 0x00,
  0x0f, 0xe1, 0x02, 0xf0, 0x00,
  0x86, 0xe1, 0x03, 0xf0, 0x00,
]);

function psiPackets(a: { pat: number; pmt: number }) {
  return [
    packet(0, a.pat, { payload: withPointer(PAT), pusi: true }),
    packet(0x100, a.pmt, { payload: withPointer(PMT), pusi: true }),
  ];
}
const feed = (an: TsAnalyzer, packets: Uint8Array[], now: number) => {
  const all = new Uint8Array(packets.length * PKT);
  packets.forEach((p, i) => all.set(p, i * PKT));
  an.push(all, now);
};

describe('TsAnalyzer', () => {
  it('learns programs and PIDs from PAT/PMT and checks their CRC', () => {
    const an = new TsAnalyzer();
    feed(an, psiPackets({ pat: 0, pmt: 0 }), 0);
    const s = an.snapshot(10);
    expect(s.psiCrcErrors).toBe(0);
    expect(s.programs).toBe(1);
    expect(s.pcrPid).toBe(0x101);
    const byPid = Object.fromEntries(s.pids.map((p) => [p.pid, p]));
    expect(byPid[0x101]).toMatchObject({ kind: 'video', type: 'H.264 / AVC' });
    expect(byPid[0x102]).toMatchObject({ kind: 'audio', type: 'AAC (ADTS)' });
    expect(byPid[0x103]).toMatchObject({ kind: 'scte35' });
    expect(s.msSincePat).toBe(10);
  });

  it('flags a corrupted PAT', () => {
    const an = new TsAnalyzer();
    const bad = Uint8Array.from(PAT);
    bad[bad.length - 1] ^= 0xff;
    feed(an, [packet(0, 0, { payload: withPointer(bad), pusi: true })], 0);
    expect(an.snapshot(1).psiCrcErrors).toBe(1);
  });

  it('counts continuity counter errors but tolerates one duplicate', () => {
    const an = new TsAnalyzer();
    feed(an, psiPackets({ pat: 0, pmt: 0 }), 0);
    const v = (cc: number) => packet(0x101, cc, { payload: new Uint8Array([1, 2, 3]) });
    feed(an, [v(0), v(1), v(1), v(2)], 1); // one duplicate: allowed
    expect(an.ccErrors).toBe(0);
    feed(an, [v(5)], 2); // jump
    expect(an.ccErrors).toBe(1);
    feed(an, [v(6), v(6), v(6)], 3); // two duplicates in a row
    expect(an.ccErrors).toBe(2);
    expect(an.snapshot(4).pids.find((p) => p.pid === 0x101)?.ccErrors).toBe(2);
  });

  it('does not count adaptation-only packets against the continuity counter', () => {
    const an = new TsAnalyzer();
    feed(an, [packet(0x102, 3, { payload: new Uint8Array(4) }), packet(0x102, 3, { afOnly: true }), packet(0x102, 4, { payload: new Uint8Array(4) })], 0);
    expect(an.ccErrors).toBe(0);
  });

  it('counts sync loss and resynchronises', () => {
    const an = new TsAnalyzer();
    const pk = (cc: number) => packet(0x102, cc, { payload: new Uint8Array(4) });
    feed(an, [pk(0), pk(1), pk(2)], 0);
    an.push(new Uint8Array([1, 2, 3, 4, 5]), 1); // garbage between packets
    feed(an, [pk(3), pk(4), pk(5)], 2);
    expect(an.syncLosses).toBeGreaterThanOrEqual(1);
    expect(an.packets).toBe(6);
  });

  it('handles packets split across chunks', () => {
    const an = new TsAnalyzer();
    const all = new Uint8Array(PKT * 4);
    psiPackets({ pat: 0, pmt: 0 }).forEach((p, i) => all.set(p, i * PKT));
    all.set(packet(0x101, 0, { payload: new Uint8Array(4) }), PKT * 2);
    all.set(packet(0x101, 1, { payload: new Uint8Array(4) }), PKT * 3);
    an.push(all.subarray(0, 100), 0);
    an.push(all.subarray(100, 700), 0);
    an.push(all.subarray(700), 0);
    expect(an.packets).toBe(4);
    expect(an.syncLosses).toBe(0);
  });

  it('measures PCR repetition from the stream clock', () => {
    const an = new TsAnalyzer();
    feed(an, psiPackets({ pat: 0, pmt: 0 }), 0);
    feed(an, [packet(0x101, 0, { pcr: 1.0 })], 10);
    feed(an, [packet(0x101, 1, { pcr: 1.04 })], 50);
    feed(an, [packet(0x101, 2, { pcr: 1.3 })], 60); // 260 ms gap in stream time
    const s = an.snapshot(70);
    expect(s.pcrIntervalMaxMs).toBeGreaterThan(250);
    expect(s.pcrIntervalMaxMs).toBeLessThan(270);
    expect(s.pcrDriftMs).toBeGreaterThan(190); // arrival gap was only 10 ms
  });

  it('computes bitrate and null-packet share per second', () => {
    const an = new TsAnalyzer();
    const v = (cc: number) => packet(0x101, cc, { payload: new Uint8Array(4) });
    const nul = packet(0x1fff, 0, { payload: new Uint8Array(4) });
    feed(an, [v(0), v(1), v(2), nul], 0);
    an.tick(1000);
    const s = an.snapshot(1000);
    expect(s.bitrateKbps).toBeCloseTo((4 * PKT * 8) / 1000, 5);
    expect(s.nullPercent).toBe(25);
  });

  it('extracts and de-fragments SCTE-35 sections from the PMT-declared PID', () => {
    const found: { pid: number; raw: Uint8Array }[] = [];
    const an = new TsAnalyzer({ onScte: (raw, pid) => found.push({ pid, raw: Uint8Array.from(raw) }) });
    feed(an, psiPackets({ pat: 0, pmt: 0 }), 0);
    const scte: Uint8Array = encodeScte35({ command: 'splice_insert', pts: 6, insert: { eventId: 7, out: true, duration: 8 } });
    feed(an, [packet(0x103, 0, { payload: withPointer(scte), pusi: true })], 1);
    expect(found).toHaveLength(1);
    expect(found[0].pid).toBe(0x103);
    expect(Array.from(found[0].raw)).toEqual(Array.from(scte));

    // A 300-byte section spread over two packets (the analyser does not CRC-check SCTE sections).
    const long = new Uint8Array(300);
    long[0] = 0xfc;
    long[1] = 0x30 | ((297 >> 8) & 0x0f);
    long[2] = 297 & 0xff;
    long.fill(0x11, 3);
    const first = withPointer(long).subarray(0, PKT - 4);
    const rest = long.subarray(PKT - 5);
    feed(an, [packet(0x103, 1, { payload: first, pusi: true }), packet(0x103, 2, { payload: rest })], 2);
    expect(found).toHaveLength(2);
    expect(Array.from(found[1].raw)).toEqual(Array.from(long));
  });

  it('reports how long a PID has been missing', () => {
    const an = new TsAnalyzer();
    feed(an, psiPackets({ pat: 0, pmt: 0 }), 0);
    feed(an, [packet(0x102, 0, { payload: new Uint8Array(4) })], 1000);
    const p = an.snapshot(8000).pids.find((x) => x.pid === 0x102)!;
    expect(p.lastSeenAgoSec).toBeCloseTo(7, 5);
  });
});
