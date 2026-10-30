/**
 * Turns ffmpeg's stderr into audio/video health. The ffmpeg command runs the
 * `blackframe` and `silencedetect` filters and logs at info level:
 *
 *   [Parsed_blackframe_0 @ 0x..] frame:12 pblack:99 pts:480 t:0.48 type:P last_keyframe:0
 *   [silencedetect @ 0x..] silence_start: 12.3
 *   [silencedetect @ 0x..] silence_end: 15 | silence_duration: 2.7
 *
 * It also reads the "Stream #0:0[0x100]: Video: h264 ..." lines of the input, and the
 * `ametadata` lines that carry the audio peak of the last half second for the wall's meters:
 *
 *   lavfi.astats.1.Peak_level=-17.7
 *   lavfi.astats.2.Peak_level=-inf
 */
/** blackframe prints one line per black frame; a gap longer than this ends the black period. */
const BLACK_GAP_MS = 1500;
const MAX_STREAM_LINES = 24;
const AUDIO_LEVEL = /^lavfi\.astats\.(\d+)\.Peak_level=(-?[\d.]+|-?inf|nan)\s*$/i;
const MAX_METER_CHANNELS = 8;
/** Level shown for digital silence, and the floor of the meter. */
export const METER_FLOOR_DB = -90;
/** The meters go blank when no level line has arrived for this long. */
const AUDIO_LEVEL_TTL_MS = 3000;
/** silencedetect `d=` value: shortest silence it reports. */
export const SILENCE_MIN_SEC = 1;
/** silencedetect `n=` value in dB. */
export const SILENCE_NOISE_DB = -50;
/** Decoder / demuxer complaints that mean damaged or missing data. */
const DECODE_ERROR =
  /error while decoding|corrupt|non[- ]monotonic|pes packet size mismatch|missing picture|concealing|invalid data found|invalid nal|co located poc|reference picture missing|number of reference frames|decode_slice_header|invalid mb type|cabac decode failed|dts.*(?:invalid|out of order)|packet too (?:large|small)/i;
export const SRT_ERROR_PATTERNS = [
  /connection setup failure/i,
  /wrong passphrase|bad secret|unmatched (?:pbkeylen|passphrase)|rejected/i,
  /connection timed out|timeout/i,
  /no route to host|connection refused|address already in use|bind(?:ing)? (?:failed|error)/i,
  /failed to (?:open|connect)|could not (?:open|connect)/i,
];
/** Strips libsrt / ffmpeg log prefixes and explains the common failures in plain words. */
export function friendlyError(line) {
  const raw = line
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/^\d{2}:\d{2}:\d{2}\.\d+\/!?[A-Z]:[\w.]+:\s*/, '')
    .trim();
  let hint = '';
  if (/UNSECURE|BADSECRET|wrong passphrase|bad secret|unmatched passphrase/i.test(raw)) {
    hint = 'Passphrase mismatch: the encoder and this monitor must use the same passphrase (or both none). ';
  } else if (/unable to create\/configure SRT socket|cannot assign requested address|invalid argument/i.test(raw)) {
    hint =
      'Cannot listen on that address: the bind address must belong to this computer (leave it blank for all interfaces). To pull from a remote SRT source, use Caller mode instead. ';
  } else if (/address already in use|bind(?:ing)? (?:failed|error)/i.test(raw)) {
    hint = 'The port is already in use by another program. ';
  } else if (/ROGUE|streamid|stream id/i.test(raw)) {
    hint = 'The stream ID was rejected. ';
  } else if (/connection timed out|timeout/i.test(raw)) {
    hint = 'No answer from the remote side (check host, port and firewall). ';
  } else if (/connection refused|no route to host/i.test(raw)) {
    hint = 'The remote host refused or cannot be reached. ';
  }
  return `${hint}${hint ? `(${raw})` : raw}`.slice(0, 300);
}
/** Longest gap between black frames that still counts as one black period (keyframes-only mode). */
const MAX_KEYFRAME_GAP_MS = 12_000;
const MIN_KEYFRAME_GAP_MS = 6000;
export class AvDetector {
  now;
  inInput = true;
  streams = [];
  video;
  audio;
  keyframesOnly;
  /** Smoothed spacing between black frames, to size the gap to the stream's GOP length. */
  blackSpacing = 0;
  lastBlackAt = null;
  blackSince = null;
  blackFrames = 0;
  silenceSince = null;
  silenceEvents = 0;
  decodeErrors = 0;
  levels = [];
  levelsAt = 0;
  /** Last line that looked like an SRT / connection error. */
  lastError = null;
  constructor(opts = {}) {
    this.now = opts.now ?? Date.now;
    this.keyframesOnly = opts.keyframesOnly === true;
  }
  /** How long after the last black frame the picture still counts as black. */
  get blackGap() {
    if (!this.keyframesOnly) return BLACK_GAP_MS;
    return Math.min(MAX_KEYFRAME_GAP_MS, Math.max(MIN_KEYFRAME_GAP_MS, this.blackSpacing * 2.5));
  }
  reset() {
    this.inInput = true;
    this.streams = [];
    this.video = undefined;
    this.audio = undefined;
    this.lastBlackAt = null;
    this.blackSince = null;
    this.blackSpacing = 0;
    this.silenceSince = null;
    this.levels = [];
    this.levelsAt = 0;
  }
  /** Feed one stderr line. */
  feed(line) {
    const now = this.now();
    const level = AUDIO_LEVEL.exec(line);
    if (level) {
      const ch = Number(level[1]) - 1;
      if (ch >= 0 && ch < MAX_METER_CHANNELS) {
        const db = Number(level[2]);
        this.levels[ch] = Number.isFinite(db) ? Math.max(METER_FLOOR_DB, db) : METER_FLOOR_DB;
        this.levelsAt = now;
      }
      return;
    }
    if (/^Output #\d/.test(line)) this.inInput = false;
    if (this.inInput) this.stream(line);
    if (/blackframe/.test(line) && /pblack:\s*\d+/.test(line)) {
      this.blackFrames++;
      if (this.lastBlackAt !== null && now - this.lastBlackAt <= this.blackGap) {
        this.blackSpacing = this.blackSpacing ? this.blackSpacing * 0.7 + (now - this.lastBlackAt) * 0.3 : now - this.lastBlackAt;
      }
      if (this.lastBlackAt === null || now - this.lastBlackAt > this.blackGap) this.blackSince = now;
      this.lastBlackAt = now;
      return;
    }
    if (/silencedetect/.test(line)) {
      if (/silence_start/.test(line)) {
        if (this.silenceSince === null) this.silenceEvents++;
        // The filter only reports a silence once it has lasted SILENCE_MIN_SEC.
        this.silenceSince = now - SILENCE_MIN_SEC * 1000;
      } else if (/silence_end/.test(line)) this.silenceSince = null;
      return;
    }
    if (DECODE_ERROR.test(line)) {
      this.decodeErrors++;
      return;
    }
    if (SRT_ERROR_PATTERNS.some((p) => p.test(line)) && !/silence|black/i.test(line)) {
      this.lastError = friendlyError(line);
    }
  }
  stream(line) {
    const m = /^\s*Stream #\d+:\d+(?:\[(0x[0-9a-fA-F]+)\])?[^:]*: (Video|Audio|Data|Subtitle): (.*)$/.exec(line);
    if (!m || this.streams.length >= MAX_STREAM_LINES) return;
    const [, pid, kind, rest] = m;
    this.streams.push(`${pid ? `${pid} ` : ''}${kind}: ${rest}`.trim());
    const codec = rest.split(/[ ,(]/)[0];
    if (kind === 'Video' && !this.video) {
      const size = /(\d{2,5})x(\d{2,5})/.exec(rest);
      const fps = /([\d.]+) fps/.exec(rest);
      this.video = {
        codec,
        width: size ? Number(size[1]) : undefined,
        height: size ? Number(size[2]) : undefined,
        fps: fps ? Number(fps[1]) : undefined,
        description: rest,
      };
    } else if (kind === 'Audio' && !this.audio) {
      const rate = /(\d+) Hz/.exec(rest);
      const parts = rest.split(',').map((p) => p.trim());
      this.audio = {
        codec,
        sampleRate: rate ? Number(rate[1]) : undefined,
        channels: parts.find((p) => /mono|stereo|\d\.\d|\d channels/.test(p)),
        description: rest,
      };
    }
  }
  stats() {
    const now = this.now();
    const black = this.lastBlackAt !== null && now - this.lastBlackAt <= this.blackGap;
    return {
      video: this.video,
      audio: this.audio,
      streams: this.streams,
      black,
      blackForSec: black && this.blackSince !== null ? (now - this.blackSince) / 1000 : 0,
      blackFrames: this.blackFrames,
      silent: this.silenceSince !== null,
      silentForSec: this.silenceSince !== null ? (now - this.silenceSince) / 1000 : 0,
      silenceEvents: this.silenceEvents,
      audioDb: this.levelsAt && now - this.levelsAt <= AUDIO_LEVEL_TTL_MS ? this.levels.map((v) => v ?? METER_FLOOR_DB) : null,
      decodeErrors: this.decodeErrors,
    };
  }
}
