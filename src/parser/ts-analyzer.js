import { crc32Mpeg2 } from './scte35.js';
/**
 * MPEG-TS analyser: a lightweight take on the ETSI TR 101 290 priority 1 and 2
 * checks, plus per-PID bitrate and SCTE-35 section extraction. Pure: all time
 * is passed in, so it can be unit-tested with synthetic packets.
 */
const PACKET = 188;
const NULL_PID = 0x1fff;
const PCR_HZ = 27_000;
/** Fixed-PID DVB / ATSC tables, so they are not listed as "Unknown". */
const WELL_KNOWN_PIDS = {
  0x00: 'PAT',
  0x01: 'CAT',
  0x10: 'NIT',
  0x11: 'SDT / BAT',
  0x12: 'EIT',
  0x14: 'TDT / TOT',
  0x1ffb: 'ATSC PSIP',
};
const STREAM_TYPES = {
  0x01: ['MPEG-1 video', 'video'],
  0x02: ['MPEG-2 video', 'video'],
  0x03: ['MPEG-1 audio', 'audio'],
  0x04: ['MPEG-2 audio', 'audio'],
  0x06: ['PES private (AC-3 / subtitles / teletext)', 'data'],
  0x0f: ['AAC (ADTS)', 'audio'],
  0x11: ['AAC (LATM)', 'audio'],
  0x15: ['Timed metadata', 'data'],
  0x1b: ['H.264 / AVC', 'video'],
  0x24: ['H.265 / HEVC', 'video'],
  0x33: ['H.266 / VVC', 'video'],
  0x81: ['AC-3', 'audio'],
  0x86: ['SCTE-35', 'scte35'],
  0x87: ['E-AC-3', 'audio'],
};
/** Reassembles PSI / private sections that may span several packets. */
class SectionAssembler {
  buf = null;
  push(payload, pusi, emit) {
    if (pusi) {
      const pointer = payload[0] ?? 0;
      if (1 + pointer > payload.length) {
        this.buf = null;
        return;
      }
      if (this.buf && pointer > 0) {
        this.append(payload.subarray(1, 1 + pointer));
        this.drain(emit);
      }
      this.buf = payload.slice(1 + pointer);
      this.drain(emit);
    } else if (this.buf) {
      this.append(payload);
      this.drain(emit);
    }
  }
  append(more) {
    const joined = new Uint8Array((this.buf?.length ?? 0) + more.length);
    if (this.buf) joined.set(this.buf);
    joined.set(more, this.buf?.length ?? 0);
    this.buf = joined;
  }
  drain(emit) {
    while (this.buf && this.buf.length >= 3) {
      if (this.buf[0] === 0xff) {
        this.buf = null; // stuffing
        return;
      }
      const length = 3 + (((this.buf[1] & 0x0f) << 8) | this.buf[2]);
      if (this.buf.length < length) {
        if (length > 4096) this.buf = null; // corrupt length, resync on the next PUSI
        return;
      }
      emit(this.buf.subarray(0, length));
      this.buf = this.buf.length > length ? this.buf.slice(length) : null;
    }
  }
}
const crcOk = (section) => {
  if (section.length < 4) return false;
  const body = section.subarray(0, section.length - 4);
  const v = new DataView(section.buffer, section.byteOffset + section.length - 4, 4).getUint32(0);
  return crc32Mpeg2(body) === v;
};
export class TsAnalyzer {
  events;
  carry = new Uint8Array(0);
  inSync = false;
  pids = new Map();
  assemblers = new Map();
  pmtPids = new Set();
  scteAssembly = new Set();
  programs = new Set();
  packets = 0;
  bytes = 0;
  nullPackets = 0;
  syncLosses = 0;
  ccErrors = 0;
  teiErrors = 0;
  psiCrcErrors = 0;
  pcrDiscontinuities = 0;
  pcrPid = null;
  lastPcr = null;
  lastPatAt = null;
  lastPmtAt = null;
  patIntervalMax = 0;
  lastNow = 0;
  /** Per-second window values, rotated by tick(). */
  winPcrInterval = 0;
  winPcrDrift = 0;
  winNull = 0;
  winPackets = 0;
  recentPcrMax = [];
  recentDrift = [];
  recentPatMax = [];
  rate = { kbps: 0, nullPercent: 0 };
  lastTickAt = null;
  firstPacketAt = null;
  constructor(events = {}) {
    this.events = events;
  }
  /** Feed raw bytes; `now` is a monotonic time in milliseconds. */
  push(chunk, now) {
    this.lastNow = now;
    this.firstPacketAt ??= now;
    let data = chunk;
    if (this.carry.length) {
      data = new Uint8Array(this.carry.length + chunk.length);
      data.set(this.carry);
      data.set(chunk, this.carry.length);
      this.carry = new Uint8Array(0);
    }
    let i = 0;
    while (i + PACKET <= data.length) {
      if (data[i] !== 0x47) {
        if (this.inSync) {
          this.inSync = false;
          this.syncLosses++;
        }
        i = this.findSync(data, i + 1);
        if (i < 0) return this.keepTail(data, data.length);
        continue;
      }
      // Need a second sync byte (when there is room) to trust this alignment.
      if (!this.inSync) {
        if (i + 2 * PACKET <= data.length && data[i + PACKET] !== 0x47) {
          i++;
          continue;
        }
        this.inSync = true;
      }
      this.packet(data, i, now);
      i += PACKET;
    }
    this.keepTail(data, i);
  }
  keepTail(data, from) {
    const start = Math.max(from, 0);
    this.carry = data.slice(start);
    // Never carry unbounded garbage.
    if (this.carry.length > PACKET * 4) this.carry = this.carry.slice(this.carry.length - PACKET);
  }
  findSync(data, from) {
    for (let i = from; i < data.length; i++) {
      if (data[i] === 0x47 && (i + PACKET >= data.length || data[i + PACKET] === 0x47)) return i;
    }
    return -1;
  }
  pidState(pid) {
    let s = this.pids.get(pid);
    if (!s) {
      s = {
        pid,
        type: WELL_KNOWN_PIDS[pid] ?? (this.pmtPids.has(pid) ? 'PMT' : 'Unknown'),
        kind: pid in WELL_KNOWN_PIDS || this.pmtPids.has(pid) ? 'psi' : 'other',
        bytes: 0,
        windowBytes: 0,
        rateKbps: 0,
        lastSeen: null,
        lastCc: 0,
        hasCc: false,
        dupSeen: false,
        ccErrors: 0,
      };
      this.pids.set(pid, s);
    }
    return s;
  }
  packet(d, o, now) {
    this.packets++;
    this.bytes += PACKET;
    this.winPackets++;
    const tei = (d[o + 1] & 0x80) !== 0;
    const pusi = (d[o + 1] & 0x40) !== 0;
    const pid = ((d[o + 1] & 0x1f) << 8) | d[o + 2];
    const afc = (d[o + 3] >> 4) & 3;
    const cc = d[o + 3] & 0x0f;
    if (pid === NULL_PID) {
      this.nullPackets++;
      this.winNull++;
      return;
    }
    if (tei) this.teiErrors++;
    const s = this.pidState(pid);
    s.bytes += PACKET;
    s.windowBytes += PACKET;
    s.lastSeen = now;
    let payloadStart = 4;
    let discontinuity = false;
    if (afc & 2) {
      const alen = d[o + 4];
      if (alen > 0 && 5 + alen <= PACKET) {
        const flags = d[o + 5];
        discontinuity = (flags & 0x80) !== 0;
        if (flags & 0x10 && alen >= 7) this.pcr(d, o + 6, pid, discontinuity, now);
      }
      payloadStart = 5 + alen;
    }
    const hasPayload = (afc & 1) !== 0 && payloadStart < PACKET;
    // Continuity counter (only meaningful for packets carrying payload).
    if (afc & 1 && !tei) {
      if (s.hasCc && !discontinuity) {
        if (cc === s.lastCc) {
          // One duplicate packet is allowed by the standard.
          if (s.dupSeen) this.cc(s);
          s.dupSeen = true;
        } else {
          s.dupSeen = false;
          if (cc !== ((s.lastCc + 1) & 0x0f)) this.cc(s);
        }
      } else {
        s.dupSeen = false;
      }
      s.lastCc = cc;
      s.hasCc = true;
    }
    if (!hasPayload || tei) return;
    const payload = d.subarray(o + payloadStart, o + PACKET);
    if (pid === 0 || this.pmtPids.has(pid)) {
      this.assembler(pid).push(payload, pusi, (sec) => this.psi(pid, sec, now));
    } else if (this.scteAssembly.has(pid)) {
      this.assembler(pid).push(payload, pusi, (sec) => {
        if (sec[0] === 0xfc) this.events.onScte?.(sec, pid);
      });
    }
  }
  cc(s) {
    s.ccErrors++;
    this.ccErrors++;
  }
  assembler(pid) {
    let a = this.assemblers.get(pid);
    if (!a) this.assemblers.set(pid, (a = new SectionAssembler()));
    return a;
  }
  pcr(d, o, pid, discontinuity, now) {
    if (this.pcrPid !== null && pid !== this.pcrPid) return;
    const base = d[o] * 2 ** 25 + d[o + 1] * 2 ** 17 + d[o + 2] * 2 ** 9 + d[o + 3] * 2 + (d[o + 4] >> 7);
    const ext = ((d[o + 4] & 1) << 8) | d[o + 5];
    const value = base * 300 + ext;
    const prev = this.lastPcr;
    this.lastPcr = { value, at: now };
    if (!prev || discontinuity) return;
    const pcrDelta = (value - prev.value) / PCR_HZ;
    if (pcrDelta < 0 || pcrDelta > 5000) {
      this.pcrDiscontinuities++;
      return;
    }
    this.winPcrInterval = Math.max(this.winPcrInterval, pcrDelta);
    this.winPcrDrift = Math.max(this.winPcrDrift, Math.abs(now - prev.at - pcrDelta));
  }
  psi(pid, section, now) {
    const table = section[0];
    if (!crcOk(section)) {
      this.psiCrcErrors++;
      return;
    }
    if (pid === 0 && table === 0x00) {
      if (this.lastPatAt !== null) this.patIntervalMax = Math.max(this.patIntervalMax, now - this.lastPatAt);
      this.lastPatAt = now;
      this.parsePat(section);
    } else if (table === 0x02 && this.pmtPids.has(pid)) {
      this.lastPmtAt = now;
      this.parsePmt(section);
    }
  }
  parsePat(s) {
    const end = s.length - 4;
    const progs = new Set();
    for (let i = 8; i + 4 <= end; i += 4) {
      const program = (s[i] << 8) | s[i + 1];
      const pid = ((s[i + 2] & 0x1f) << 8) | s[i + 3];
      if (program === 0) continue; // network PID
      progs.add(program);
      if (!this.pmtPids.has(pid)) {
        this.pmtPids.add(pid);
        const st = this.pidState(pid);
        st.type = 'PMT';
        st.kind = 'psi';
      }
    }
    this.programs = progs;
  }
  parsePmt(s) {
    const end = s.length - 4;
    this.pcrPid ??= ((s[8] & 0x1f) << 8) | s[9];
    const infoLen = ((s[10] & 0x0f) << 8) | s[11];
    let i = 12 + infoLen;
    while (i + 5 <= end) {
      const streamType = s[i];
      const pid = ((s[i + 1] & 0x1f) << 8) | s[i + 2];
      const esLen = ((s[i + 3] & 0x0f) << 8) | s[i + 4];
      const [name, kind] = STREAM_TYPES[streamType] ?? [`Stream type 0x${streamType.toString(16)}`, 'other'];
      const st = this.pidState(pid);
      st.type = name;
      st.kind = kind;
      if (kind === 'scte35') this.scteAssembly.add(pid);
      i += 5 + esLen;
    }
  }
  /** Call once per second: rotates the per-second windows and computes rates. */
  tick(now) {
    // The first window starts at the first packet (ffmpeg may probe for a while before sending anything).
    const dt = Math.max(now - (this.lastTickAt ?? this.firstPacketAt ?? now - 1000), 1);
    this.lastTickAt = now;
    let total = 0;
    for (const s of this.pids.values()) {
      s.rateKbps = (s.windowBytes * 8) / dt;
      total += s.windowBytes;
      s.windowBytes = 0;
    }
    const nullBytes = this.winNull * PACKET;
    this.rate = {
      kbps: ((total + nullBytes) * 8) / dt,
      nullPercent: this.winPackets ? (this.winNull / this.winPackets) * 100 : 0,
    };
    this.winNull = 0;
    this.winPackets = 0;
    const keep = 10;
    this.recentPcrMax.push(this.winPcrInterval);
    this.recentDrift.push(this.winPcrDrift);
    this.recentPatMax.push(this.patIntervalMax);
    for (const arr of [this.recentPcrMax, this.recentDrift, this.recentPatMax]) while (arr.length > keep) arr.shift();
    this.winPcrInterval = 0;
    this.winPcrDrift = 0;
    this.patIntervalMax = 0;
  }
  snapshot(now) {
    const since = (t) => (t === null ? null : Math.max(0, now - t));
    const msSincePcr = this.lastPcr ? now - this.lastPcr.at : null;
    const pcrMax = Math.max(0, ...this.recentPcrMax, this.winPcrInterval);
    const pids = [...this.pids.values()]
      .filter((s) => s.pid !== NULL_PID)
      .sort((a, b) => a.pid - b.pid)
      .map((s) => ({
        pid: s.pid,
        type: s.type,
        kind: s.kind,
        bitrateKbps: s.rateKbps,
        lastSeenAgoSec: s.lastSeen === null ? null : Math.max(0, (now - s.lastSeen) / 1000),
        ccErrors: s.ccErrors,
      }));
    return {
      packets: this.packets,
      bytes: this.bytes,
      bitrateKbps: this.rate.kbps,
      nullPercent: this.rate.nullPercent,
      syncLosses: this.syncLosses,
      ccErrors: this.ccErrors,
      teiErrors: this.teiErrors,
      psiCrcErrors: this.psiCrcErrors,
      pcrPid: this.pcrPid,
      pcrIntervalMaxMs: this.lastPcr ? Math.max(pcrMax, msSincePcr ?? 0) : null,
      pcrDriftMs: this.lastPcr ? Math.max(0, ...this.recentDrift, this.winPcrDrift) : null,
      pcrDiscontinuities: this.pcrDiscontinuities,
      msSincePat: since(this.lastPatAt),
      msSincePmt: since(this.lastPmtAt),
      patIntervalMaxMs: this.lastPatAt === null ? null : Math.max(0, ...this.recentPatMax, this.patIntervalMax),
      programs: this.programs.size,
      pids,
    };
  }
  /** Time of the last packet fed in (monotonic ms). */
  get lastPacketAt() {
    return this.lastNow;
  }
}
