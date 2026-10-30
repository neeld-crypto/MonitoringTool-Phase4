/**
 * Audio measurement DSP shared by the AudioWorklet (real time) and the unit
 * tests (synthetic signals). No DOM or Web Audio types here.
 *
 * References: ITU-R BS.1770-4 (K-weighting, gating, true peak),
 * EBU R128 / Tech 3341 / Tech 3342 (momentary, short-term, LRA).
 */
/**
 * BS.1770 K-weighting as two biquads (high-shelf "head" filter + RLB
 * high-pass), with coefficients derived for any sample rate (the 48 kHz
 * values match the table in BS.1770-4).
 */
export function kWeighting(sampleRate) {
  // Stage 1: high shelf.
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: RLB high-pass.
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const highpass = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  return [shelf, highpass];
}
/** Direct form I biquad. */
export class Biquad {
  c;
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;
  constructor(c) {
    this.c = c;
  }
  process(x) {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}
/**
 * 4× oversampling interpolator for true-peak estimation (BS.1770-4 Annex 2
 * approach: 4 phases × 12 taps). Uses a Hann-windowed sinc low-pass, which
 * stays within a few tenths of a dB of the reference filter.
 */
const TP_TAPS = 12;
const TP_PHASES = 4;
const TP_FILTER = (() => {
  const n = TP_TAPS * TP_PHASES;
  const h = new Float64Array(n);
  const mid = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const t = (i - mid) / TP_PHASES;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    h[i] = sinc * w;
  }
  // Split into polyphase components, each normalised to unity DC gain.
  return Array.from({ length: TP_PHASES }, (_, p) => {
    const phase = new Float64Array(TP_TAPS);
    let sum = 0;
    for (let k = 0; k < TP_TAPS; k++) {
      phase[k] = h[k * TP_PHASES + p];
      sum += phase[k];
    }
    for (let k = 0; k < TP_TAPS; k++) phase[k] /= sum;
    return phase;
  });
})();
export class TruePeak {
  hist = new Float64Array(TP_TAPS);
  pos = 0;
  /** Feeds one sample; returns the max |value| over the 4 interpolated points. */
  process(x) {
    this.hist[this.pos] = x;
    this.pos = (this.pos + 1) % TP_TAPS;
    let max = 0;
    for (let p = 0; p < TP_PHASES; p++) {
      const f = TP_FILTER[p];
      let acc = 0;
      for (let k = 0; k < TP_TAPS; k++) {
        acc += f[k] * this.hist[(this.pos + k) % TP_TAPS];
      }
      const a = Math.abs(acc);
      if (a > max) max = a;
    }
    return max;
  }
}
/**
 * Consumes audio in arbitrary-sized chunks (Web Audio delivers 128 frames)
 * and emits one SubBlock per 100 ms. Reconfigures itself when the channel
 * count changes (e.g. switching from a stereo to a 5.1 track).
 */
export class MeterCore {
  sampleRate;
  channels = 0;
  filters = [];
  tp = [];
  n = 0;
  acc;
  blockSize;
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.blockSize = Math.round(sampleRate / 10);
  }
  configure(channels) {
    this.channels = channels;
    const [s1, s2] = kWeighting(this.sampleRate);
    this.filters = Array.from({ length: channels }, () => [new Biquad(s1), new Biquad(s2)]);
    this.tp = Array.from({ length: channels }, () => new TruePeak());
    this.resetAcc();
  }
  resetAcc() {
    const z = () => new Array(this.channels).fill(0);
    this.n = 0;
    this.acc = { peak: z(), tp: z(), k: z(), sq: z(), lr: 0, ll: 0, rr: 0 };
  }
  /** `input[c][i]` = sample i of channel c. Returns finished sub-blocks. */
  process(input) {
    const out = [];
    const channels = input.length;
    if (channels === 0) return out;
    if (channels !== this.channels) this.configure(channels);
    const frames = input[0].length;
    const a = this.acc;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const x = input[c][i];
        const ax = Math.abs(x);
        if (ax > a.peak[c]) a.peak[c] = ax;
        const t = this.tp[c].process(x);
        if (t > a.tp[c]) a.tp[c] = t;
        const [f1, f2] = this.filters[c];
        const k = f2.process(f1.process(x));
        a.k[c] += k * k;
        a.sq[c] += x * x;
      }
      if (channels >= 2) {
        const l = input[0][i];
        const r = input[1][i];
        a.lr += l * r;
        a.ll += l * l;
        a.rr += r * r;
      }
      if (++this.n === this.blockSize) {
        out.push({
          channels,
          samplePeak: [...a.peak],
          truePeak: [...a.tp],
          kMeanSquare: a.k.map((v) => v / this.n),
          rms: a.sq.map((v) => Math.sqrt(v / this.n)),
          corr: { lr: a.lr, ll: a.ll, rr: a.rr },
        });
        this.resetAcc();
      }
    }
    return out;
  }
}
export const toDb = (linear) => (linear > 0 ? 20 * Math.log10(linear) : -Infinity);
