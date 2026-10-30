import { parseHlsCues } from './hls-cues.js';
import { cueDirection, cueDuration, parseScte35, summarizeScte35 } from './scte35.js';
/**
 * Turns one playlist tag into a cue: the direction and length come from the SCTE-35 payload when the tag carries
 * one (DATERANGE SCTE35-OUT / -IN / -CMD, EXT-X-SCTE35, OATCLS, SPLICEPOINT), else from the tag itself (CUE-OUT /
 * CUE-IN). Null for a CUE-OUT-CONT, which is handled by the caller, and for tags that carry nothing usable.
 */
export function describeCue(cue, now) {
  let direction = 'other';
  let summary = '';
  let duration = cue.duration;
  let crcValid = true;
  switch (cue.kind) {
    case 'DATERANGE':
      direction = cue.scte35Attribute === 'SCTE35-OUT' ? 'out' : cue.scte35Attribute === 'SCTE35-IN' ? 'in' : 'other';
      summary = `DATERANGE ${cue.id ?? ''}${cue.attributes.CLASS ? ` (${cue.attributes.CLASS})` : ''}`.trim();
      break;
    case 'CUE-OUT':
      direction = 'out';
      summary = 'CUE-OUT';
      break;
    case 'CUE-IN':
      direction = 'in';
      summary = 'CUE-IN';
      break;
    case 'SCTE35':
      summary = 'EXT-X-SCTE35';
      break;
    case 'OATCLS-SCTE35':
      summary = 'EXT-OATCLS-SCTE35';
      break;
    case 'SPLICEPOINT-SCTE35':
      summary = 'EXT-X-SPLICEPOINT-SCTE35';
      break;
    default:
      return null;
  }
  if (cue.scte35) {
    try {
      const sec = parseScte35(cue.scte35);
      const d = cueDirection(sec);
      if (d !== 'other') direction = d;
      duration ??= cueDuration(sec);
      crcValid = sec.crcValid;
      summary = `${summary} · ${summarizeScte35(sec)}`;
    } catch (err) {
      summary = `${summary} · Undecodable: ${err instanceof Error ? err.message : err}`;
    }
  }
  return { direction, summary, duration, receivedAt: now, crcValid };
}
const attr = (line, name) => {
  const m = new RegExp(`(?:^|[:,])${name}=("([^"]*)"|[^,]*)`).exec(line);
  return m ? (m[2] ?? m[1]) : null;
};
/** Variants of a master playlist (empty for a media playlist), with absolute URLs. */
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const next = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!next) continue;
    const codecs = attr(lines[i], 'CODECS') ?? '';
    const resolution = attr(lines[i], 'RESOLUTION');
    let url;
    try {
      url = new URL(next, baseUrl).href;
    } catch {
      continue;
    }
    out.push({
      url,
      bandwidth: Number(attr(lines[i], 'AVERAGE-BANDWIDTH') ?? attr(lines[i], 'BANDWIDTH')) || 0,
      resolution,
      audioOnly: !resolution && codecs !== '' && !/avc|hvc|hev|vp0?9|av01|mp4v|dvh/i.test(codecs),
    });
  }
  return out;
}
/** The rendition that is cheapest to decode: the smallest picture that has video, then the lowest bitrate. */
export function pickLowest(variants) {
  const pixels = (v) => {
    const m = /^(\d+)x(\d+)$/.exec(v.resolution ?? '');
    return m ? Number(m[1]) * Number(m[2]) : Number.MAX_SAFE_INTEGER;
  };
  const video = variants.filter((v) => !v.audioOnly);
  const pool = video.length ? video : variants;
  return [...pool].sort((a, b) => pixels(a) - pixels(b) || a.bandwidth - b.bandwidth)[0] ?? null;
}
export function parseMedia(text) {
  if (!text.includes('#EXTM3U')) return null;
  const num = (tag) => {
    const m = new RegExp(`${tag}:(\\d+(?:\\.\\d+)?)`).exec(text);
    return m ? Number(m[1]) : 0;
  };
  return {
    mediaSequence: num('#EXT-X-MEDIA-SEQUENCE'),
    targetDuration: num('#EXT-X-TARGETDURATION'),
    segments: (text.match(/^#EXTINF:/gm) ?? []).length,
    ended: /#EXT-X-ENDLIST/.test(text) || /#EXT-X-PLAYLIST-TYPE:VOD/.test(text),
  };
}
const TIMEOUT_MS = 8000;
async function fetchText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': 'Pulse', accept: '*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  return res.text();
}
const message = (err) => {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return `no answer within ${TIMEOUT_MS / 1000} s`;
    const cause = err.cause;
    return cause?.code ?? cause?.message ?? err.message;
  }
  return String(err);
};
/**
 * Watches one HLS stream's playlists without downloading any media: picks the cheapest rendition to decode for the
 * wall tile, then notices when the playlist stops moving (the stream is stale) or cannot be fetched at all.
 */
export class HlsProbe {
  url;
  /** The playlist ffmpeg should read: the lowest rendition of a master playlist, or the URL itself. */
  inputUrl;
  variants = [];
  chosen = null;
  media = null;
  lastSequence = -1;
  lastSegments = -1;
  /** Wall-clock time the playlist last got a new segment (or was first read). */
  advancedAt = 0;
  lastError = null;
  failures = 0;
  lastOkAt = 0;
  seenCues = new Set();
  newCues = [];
  /** A break is known to be running (its OUT was seen), so a CUE-OUT-CONT adds nothing. */
  inBreak = false;
  constructor(url) {
    this.url = url;
    this.inputUrl = url;
  }
  /** Reads the master playlist (if it is one) and chooses the rendition to decode. Throws with a readable reason. */
  async resolve() {
    let text;
    try {
      text = await fetchText(this.url);
    } catch (err) {
      throw new Error(`Cannot load the playlist: ${message(err)}`);
    }
    if (!text.includes('#EXTM3U')) throw new Error('The address did not return an HLS playlist (#EXTM3U is missing)');
    this.variants = parseMaster(text, this.url);
    this.chosen = pickLowest(this.variants);
    this.inputUrl = this.chosen?.url ?? this.url;
    if (!this.chosen) this.take(text);
    this.advancedAt = Date.now();
    this.lastOkAt = Date.now();
  }
  take(text) {
    const m = parseMedia(text);
    if (!m) return;
    this.scanCues(text);
    this.media = m;
    // A new media sequence, or (for playlists that only append) more segments, both mean the stream moved on.
    if (m.mediaSequence !== this.lastSequence || m.segments !== this.lastSegments) this.advancedAt = Date.now();
    this.lastSequence = m.mediaSequence;
    this.lastSegments = m.segments;
  }
  /** Looks at the ad tags of the playlist, remembering the ones already reported (every poll sees the same ones again). */
  scanCues(text) {
    if (!/#EXT-X-(?:DATERANGE|CUE-|SCTE35|SPLICEPOINT)|#EXT-OATCLS/.test(text)) return;
    const now = Date.now();
    for (const cue of parseHlsCues(text, this.inputUrl).cues) {
      const key = `${cue.kind}:${cue.id ?? ''}:${cue.mediaSequence}`;
      if (this.seenCues.has(key)) continue;
      this.seenCues.add(key);
      if (cue.kind === 'CUE-OUT-CONT') {
        // Only useful when joining mid-break: the OUT that started it was never seen, so stand in for it.
        if (this.inBreak || cue.elapsed === undefined) continue;
        this.inBreak = true;
        this.newCues.push({
          direction: 'out',
          summary: `Joined mid-break (CUE-OUT-CONT, ${cue.elapsed}s elapsed)`,
          duration: cue.duration,
          receivedAt: now - cue.elapsed * 1000,
          crcValid: true,
        });
        continue;
      }
      const c = describeCue(cue, now);
      if (!c) continue;
      if (c.direction === 'out') this.inBreak = true;
      else if (c.direction === 'in') this.inBreak = false;
      this.newCues.push(c);
    }
    if (this.seenCues.size > 500) this.seenCues = new Set([...this.seenCues].slice(-250));
  }
  /** Cues found since the last call. */
  drainCues() {
    const out = this.newCues;
    this.newCues = [];
    return out;
  }
  /** Re-reads the media playlist. Never throws: failures are counted and reported through `info()`. */
  async poll() {
    try {
      this.take(await fetchText(this.inputUrl));
      this.failures = 0;
      this.lastError = null;
      this.lastOkAt = Date.now();
    } catch (err) {
      this.failures++;
      this.lastError = message(err);
    }
  }
  /** Milliseconds since the playlist last moved on; null for a finished (VOD) playlist, which never will. */
  staleMs() {
    if (this.media?.ended) return null;
    return Date.now() - this.advancedAt;
  }
  /** Three failed fetches in a row: the origin is not answering. */
  get unreachable() {
    return this.failures >= 3;
  }
  get error() {
    return this.lastError;
  }
  info() {
    return {
      variants: this.variants.length,
      resolution: this.chosen?.resolution ?? null,
      kbps: this.chosen ? Math.round(this.chosen.bandwidth / 1000) : null,
      targetDuration: this.media?.targetDuration || null,
      staleMs: this.staleMs(),
      ended: this.media?.ended ?? false,
      fetchError: this.failures ? this.lastError : null,
      lastOkMs: this.lastOkAt ? Date.now() - this.lastOkAt : null,
    };
  }
}
