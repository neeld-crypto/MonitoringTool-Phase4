const WINDOW_MS = 10_000;
/** Rolling counters so rules can look at "the last 10 seconds" instead of totals. */
export class EvalHistory {
  samples = [];
  record(snap, now) {
    this.samples.push({
      t: now,
      packets: snap.link?.packets ?? 0,
      lost: snap.link?.lost ?? 0,
      dropped: snap.link?.dropped ?? 0,
      retrans: snap.link?.retransmitted ?? 0,
      cc: snap.ts?.ccErrors ?? 0,
      sync: snap.ts?.syncLosses ?? 0,
      tei: snap.ts?.teiErrors ?? 0,
      crc: snap.ts?.psiCrcErrors ?? 0,
      dec: snap.av?.decodeErrors ?? 0,
      kbps: snap.ts?.bitrateKbps ?? 0,
    });
    while (this.samples.length > 60) this.samples.shift();
  }
  reset() {
    this.samples = [];
  }
  /** Increase of a cumulative counter over the last 10 s. */
  delta(key, now) {
    const win = this.samples.filter((s) => now - s.t <= WINDOW_MS);
    if (win.length < 2) return 0;
    return Math.max(0, win[win.length - 1][key] - win[0][key]);
  }
  /** Average bitrate over the older part of the history (so a drop does not drag its own baseline down). */
  baselineKbps() {
    const older = this.samples.slice(0, -4).slice(-30);
    if (older.length < 8) return null;
    return older.reduce((a, s) => a + s.kbps, 0) / older.length;
  }
}
const fmtMs = (v) => `${Math.round(v)} ms`;
const pid = (n) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;
/** Evaluates every rule against the latest snapshot. Pure. */
export function evaluate(snap, th, hist, now) {
  const out = [];
  const add = (c) => out.push(c);
  if (snap.state !== 'connected' && snap.state !== 'stalled') {
    if (th.waitingSec > 0 && snap.waitingForMs !== null && snap.waitingForMs >= th.waitingSec * 1000) {
      const listener = snap.config?.mode === 'listener';
      add({
        key: 'no_connection',
        rule: 'no_connection',
        severity: 'critical',
        message: `${snap.config?.mode === 'hls' ? 'Cannot load the HLS stream' : listener ? 'Waiting for the encoder: nothing has connected' : 'Cannot reach the SRT source'} for ${Math.round(snap.waitingForMs / 1000)} s${snap.lastError ? `. ${snap.lastError}` : ''}`,
      });
    }
    return out;
  }
  const connectedFor = snap.connectedAt ? snap.now - snap.connectedAt : 0;
  if (snap.msSinceData !== null && snap.msSinceData >= th.noSignalSec * 1000) {
    add({
      key: 'no_signal',
      rule: 'no_signal',
      severity: 'critical',
      message:
        snap.config?.mode === 'hls'
          ? `Stream stopped: the playlist has had no new segment for ${(snap.msSinceData / 1000).toFixed(0)} s`
          : `No signal: connected, but no video data for ${(snap.msSinceData / 1000).toFixed(0)} s`,
    });
  }
  const ts = snap.ts;
  if (ts) {
    const base = hist.baselineKbps();
    if (th.bitrateDropPct > 0 && base !== null && base > 200 && ts.bitrateKbps < base * (1 - th.bitrateDropPct / 100)) {
      add({
        key: 'bitrate_drop',
        rule: 'bitrate_drop',
        severity: 'warning',
        holdSec: 3,
        message: `Picture data fell to ${Math.round(ts.bitrateKbps)} kbps (normally about ${Math.round(base)} kbps). The encoder may be struggling`,
        details: { kbps: Math.round(ts.bitrateKbps), baselineKbps: Math.round(base) },
      });
    }
    if (th.minBitrateKbps > 0 && ts.bitrateKbps < th.minBitrateKbps) {
      add({
        key: 'bitrate_low',
        rule: 'bitrate_low',
        severity: 'warning',
        holdSec: 3,
        message: `Stream is only ${Math.round(ts.bitrateKbps)} kbps, below the ${th.minBitrateKbps} kbps minimum. Quality will suffer`,
      });
    }
    // Continuity, sync, PCR and PSI timing only mean something on the bytes as received. When ffmpeg
    // owns the SRT socket the analyser sees ffmpeg's own re-multiplexed output, which is always clean
    // (and bursty), so those rules stay off rather than reporting on ffmpeg instead of the sender.
    const wire = snap.tsSource === 'wire';
    const cc = wire ? hist.delta('cc', now) : 0;
    if (cc >= th.ccErrors) {
      add({
        key: 'ts_cc',
        rule: 'ts_cc',
        severity: 'warning',
        message: `${cc} lost or repeated packet(s) in the last 10 s (continuity errors). Expect picture glitches`,
        details: { errors: cc },
      });
    }
    if (wire && hist.delta('sync', now) >= 1) {
      add({ key: 'ts_sync', rule: 'ts_sync', severity: 'critical', message: 'Stream is unreadable: the receiver lost sync with the data (TS sync loss)' });
    }
    if (wire && hist.delta('tei', now) >= 1) {
      add({ key: 'ts_tei', rule: 'ts_tei', severity: 'warning', message: 'Damaged packets are arriving from the source (transport error flag set)' });
    }
    if (wire && hist.delta('crc', now) >= 1) {
      add({ key: 'ts_crc', rule: 'ts_crc', severity: 'warning', message: 'Stream table is corrupt (PAT/PMT CRC error). The player may not find the video or audio' });
    }
    for (const [name, since] of wire
      ? [
          ['PAT', ts.msSincePat],
          ['PMT', ts.msSincePmt],
        ]
      : []) {
      if ((since !== null && since > th.psiTimeoutMs) || (since === null && connectedFor > 3000 && ts.bytes > 0)) {
        add({
          key: `ts_${name.toLowerCase()}`,
          rule: `ts_${name.toLowerCase()}`,
          severity: 'critical',
          message: since === null ? `No ${name} table received: the player cannot find the programme` : `${name} table missing for ${fmtMs(since)} (limit ${fmtMs(th.psiTimeoutMs)}). Players may lose the programme`,
        });
      }
    }
    if (wire && ts.pcrIntervalMaxMs !== null && ts.pcrIntervalMaxMs > th.pcrMaxMs) {
      add({
        key: 'ts_pcr',
        rule: 'ts_pcr',
        severity: 'warning',
        message: `Timing signal (PCR) arrives too slowly: ${fmtMs(ts.pcrIntervalMaxMs)} between packets, limit ${fmtMs(th.pcrMaxMs)}. Can cause stutter`,
        details: { pcrMs: Math.round(ts.pcrIntervalMaxMs) },
      });
    }
    for (const p of ts.pids) {
      if (
        (p.kind === 'video' || p.kind === 'audio' || p.kind === 'data') &&
        p.lastSeenAgoSec !== null &&
        p.lastSeenAgoSec > th.pidTimeoutSec
      ) {
        add({
          key: `pid_missing:${p.pid}`,
          rule: 'pid_missing',
          severity: 'critical',
          message: `The ${p.kind} stream (PID ${pid(p.pid)}, ${p.type}) disappeared ${p.lastSeenAgoSec.toFixed(0)} s ago`,
          details: { pid: p.pid },
        });
      }
    }
  }
  const link = snap.link;
  if (link) {
    if (link.rttMs !== null && link.rttMs > th.rttMs) {
      add({
        key: 'link_rtt',
        rule: 'link_rtt',
        severity: 'warning',
        holdSec: 3,
        message: `Network delay is high: ${link.rttMs.toFixed(0)} ms (limit ${th.rttMs} ms)`,
        details: { rttMs: link.rttMs },
      });
    }
    const lost = hist.delta('lost', now);
    const pk = hist.delta('packets', now);
    const lossPct = lost + pk > 0 ? (lost / (lost + pk)) * 100 : 0;
    if (lost > 0 && lossPct >= th.lossPct) {
      add({
        key: 'link_loss',
        rule: 'link_loss',
        severity: 'warning',
        message: `Network is losing packets: ${lossPct.toFixed(2)}% in the last 10 s (${lost} packets). SRT is trying to recover them`,
        details: { lossPct: Number(lossPct.toFixed(2)) },
      });
    }
    const dropped = hist.delta('dropped', now);
    if (th.droppedPackets > 0 && dropped >= th.droppedPackets) {
      add({
        key: 'link_dropped',
        rule: 'link_dropped',
        severity: 'critical',
        message: `${dropped} packet(s) lost for good: SRT could not recover them in time. Picture is damaged. Raise the latency or fix the link`,
        details: { dropped },
      });
    }
    const retrans = hist.delta('retrans', now);
    const retransPct = pk > 0 ? (retrans / pk) * 100 : 0;
    if (retrans > 0 && retransPct >= th.retransPct) {
      add({
        key: 'link_retrans',
        rule: 'link_retrans',
        severity: 'warning',
        message: `Network is unstable: ${retransPct.toFixed(1)}% of packets had to be re-sent in the last 10 s`,
        details: { retransPct: Number(retransPct.toFixed(1)) },
      });
    }
  }
  const av = snap.av;
  if (av) {
    const dec = hist.delta('dec', now);
    if (dec >= th.decodeErrors) {
      add({
        key: 'decode_errors',
        rule: 'decode_errors',
        severity: 'warning',
        message: `Picture or sound is damaged: ${dec} decode error(s) in the last 10 s`,
        details: { errors: dec },
      });
    }
    if (av.black && av.blackForSec >= th.blackSec) {
      add({
        key: 'video_black',
        rule: 'video_black',
        severity: 'critical',
        message: `Black screen for ${av.blackForSec.toFixed(0)} s`,
        details: { seconds: Math.round(av.blackForSec) },
      });
    }
    if (av.silent && av.silentForSec >= th.silenceSec) {
      add({
        key: 'audio_silence',
        rule: 'audio_silence',
        severity: 'critical',
        message: `No sound for ${av.silentForSec.toFixed(0)} s`,
        details: { seconds: Math.round(av.silentForSec) },
      });
    }
  }
  return out;
}
/** Raise / clear lifecycle with hold times, plus one-shot events. */
export class AlertEngine {
  emit;
  clearSec;
  maxHistory;
  /** Newest first. */
  history = [];
  pending = new Map();
  active = new Map();
  nextId = 1;
  constructor(emit, clearSec = 3, maxHistory = 500) {
    this.emit = emit;
    this.clearSec = clearSec;
    this.maxHistory = maxHistory;
  }
  activeAlerts() {
    return [...this.active.values()].map((e) => e.alert);
  }
  apply(conditions, now) {
    const seen = new Set();
    for (const c of conditions) {
      seen.add(c.key);
      const entry = this.active.get(c.key);
      if (entry) {
        entry.absentSince = null;
        continue;
      }
      const since = this.pending.get(c.key) ?? now;
      this.pending.set(c.key, since);
      if (now - since >= (c.holdSec ?? 0) * 1000) {
        this.pending.delete(c.key);
        const alert = {
          id: this.nextId++,
          rule: c.rule,
          key: c.key,
          severity: c.severity,
          state: 'raised',
          message: c.message,
          at: now,
          details: c.details,
        };
        this.active.set(c.key, { alert, absentSince: null });
        this.push(alert);
        this.emit({ ...alert }, true);
      }
    }
    for (const key of [...this.pending.keys()]) if (!seen.has(key)) this.pending.delete(key);
    for (const [key, entry] of this.active) {
      if (seen.has(key)) continue;
      entry.absentSince ??= now;
      if (now - entry.absentSince >= this.clearSec * 1000) this.resolve(key, now, true);
    }
  }
  /** One-shot alert (SCTE-35, connect / disconnect). */
  event(rule, severity, message, now, details) {
    const alert = { id: this.nextId++, rule, key: `${rule}:${now}`, severity, state: 'event', message, at: now, details };
    this.push(alert);
    this.emit({ ...alert }, true);
    return alert;
  }
  /** Close every open alert, e.g. when the stream disconnects (the disconnect event covers it). */
  clearAll(now) {
    this.pending.clear();
    for (const key of [...this.active.keys()]) this.resolve(key, now, false);
  }
  resolve(key, now, notify) {
    const entry = this.active.get(key);
    if (!entry) return;
    this.active.delete(key);
    entry.alert.state = 'cleared';
    entry.alert.clearedAt = now;
    // Same id: clients replace the raised entry with the cleared one.
    this.emit({ ...entry.alert }, notify);
  }
  push(alert) {
    this.history.unshift(alert);
    if (this.history.length > this.maxHistory) this.history.length = this.maxHistory;
  }
}
