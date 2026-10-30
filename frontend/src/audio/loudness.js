import { toDb } from './dsp';
export const STANDARDS = {
  ebu: { name: 'EBU R128', unit: 'LUFS', target: -23, tolerance: 1, maxTruePeak: -1 },
  atsc: { name: 'ATSC A/85', unit: 'LKFS', target: -24, tolerance: 2, maxTruePeak: -2 },
};
/** Web Audio's discrete channel order for common layouts. */
export function channelLabels(count) {
  switch (count) {
    case 1:
      return ['M'];
    case 2:
      return ['L', 'R'];
    case 4:
      return ['L', 'R', 'Ls', 'Rs'];
    case 6:
      return ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'];
    case 8:
      return ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lb', 'Rb'];
    default:
      return Array.from({ length: count }, (_, i) => `Ch${i + 1}`);
  }
}
/** BS.1770 channel weights: surrounds +1.5 dB (×1.41), LFE excluded. */
export function channelWeights(count) {
  return channelLabels(count).map((l) => (l === 'LFE' ? 0 : /^(Ls|Rs|Lb|Rb)$/.test(l) ? 1.41 : 1));
}
const LOUDNESS_OFFSET = -0.691;
const loudnessOf = (energy) => (energy > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(energy) : -Infinity);
const energyOf = (loudness) => Math.pow(10, (loudness - LOUDNESS_OFFSET) / 10);
const HIST_MIN = -70;
const HIST_MAX = 10;
const HIST_STEP = 0.1;
const HIST_BINS = Math.round((HIST_MAX - HIST_MIN) / HIST_STEP);
class Histogram {
  counts = new Float64Array(HIST_BINS);
  total = 0;
  add(loudness) {
    if (!(loudness >= HIST_MIN)) return; // absolute gate (also drops -Infinity/NaN)
    const i = Math.min(HIST_BINS - 1, Math.floor((loudness - HIST_MIN) / HIST_STEP));
    this.counts[i]++;
    this.total++;
  }
  static centre(i) {
    return HIST_MIN + (i + 0.5) * HIST_STEP;
  }
  clear() {
    this.counts.fill(0);
    this.total = 0;
  }
}
const HOLD_BLOCKS = 20; // 2 s
export class LoudnessMeter {
  recent = [];
  integratedHist = new Histogram();
  lraHist = new Histogram();
  truePeakMax = 0;
  samplePeakMax = 0;
  hold = [];
  blocks = 0;
  channels = 0;
  last = null;
  reset() {
    this.recent = [];
    this.integratedHist.clear();
    this.lraHist.clear();
    this.truePeakMax = 0;
    this.samplePeakMax = 0;
    this.hold = [];
    this.blocks = 0;
    this.last = null;
  }
  get reading() {
    return this.last;
  }
  /** Weighted energy of the last `n` sub-blocks (or null if not enough yet). */
  windowEnergy(n) {
    if (this.recent.length < n) return null;
    const slice = this.recent.slice(-n);
    const w = channelWeights(this.channels);
    let e = 0;
    for (let c = 0; c < this.channels; c++) {
      let sum = 0;
      for (const b of slice) sum += b.kMeanSquare[c] ?? 0;
      e += w[c] * (sum / n);
    }
    return e;
  }
  push(block) {
    if (block.channels !== this.channels) {
      // Layout changed (track switch): restart the sliding windows only.
      this.channels = block.channels;
      this.recent = [];
      this.hold = [];
    }
    this.recent.push(block);
    if (this.recent.length > 30) this.recent.shift();
    this.blocks++;
    const mE = this.windowEnergy(4);
    const sE = this.windowEnergy(30);
    const momentary = mE === null ? -Infinity : loudnessOf(mE);
    const shortTerm = sE === null ? -Infinity : loudnessOf(sE);
    if (mE !== null) this.integratedHist.add(momentary);
    if (sE !== null) this.lraHist.add(shortTerm);
    for (let c = 0; c < block.channels; c++) {
      this.truePeakMax = Math.max(this.truePeakMax, block.truePeak[c], block.samplePeak[c]);
      this.samplePeakMax = Math.max(this.samplePeakMax, block.samplePeak[c]);
    }
    const labels = channelLabels(block.channels);
    const channels = labels.map((label, c) => {
      const peak = toDb(block.samplePeak[c]);
      const h = this.hold[c];
      if (!h || peak >= h.value || h.age >= HOLD_BLOCKS) this.hold[c] = { value: peak, age: 0 };
      else h.age++;
      return { label, peak, hold: this.hold[c].value, rms: toDb(block.rms[c]) };
    });
    let correlation = null;
    if (block.channels >= 2) {
      let lr = 0;
      let ll = 0;
      let rr = 0;
      for (const b of this.recent.slice(-4)) {
        lr += b.corr.lr;
        ll += b.corr.ll;
        rr += b.corr.rr;
      }
      correlation = ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : null;
    }
    this.last = {
      channels,
      momentary,
      shortTerm,
      integrated: gatedLoudness(this.integratedHist, -10),
      lra: loudnessRange(this.lraHist),
      truePeakMax: toDb(this.truePeakMax),
      samplePeakMax: toDb(this.samplePeakMax),
      correlation,
      duration: this.blocks / 10,
    };
    return this.last;
  }
}
/** Mean loudness of blocks above the absolute gate and `relative` LU below their mean. */
function gatedLoudness(h, relative) {
  if (h.total === 0) return -Infinity;
  let e = 0;
  for (let i = 0; i < HIST_BINS; i++) if (h.counts[i]) e += h.counts[i] * energyOf(Histogram.centre(i));
  const threshold = loudnessOf(e / h.total) + relative;
  let e2 = 0;
  let n = 0;
  for (let i = 0; i < HIST_BINS; i++) {
    if (h.counts[i] && Histogram.centre(i) >= threshold) {
      e2 += h.counts[i] * energyOf(Histogram.centre(i));
      n += h.counts[i];
    }
  }
  return n ? loudnessOf(e2 / n) : -Infinity;
}
/** EBU Tech 3342 loudness range. */
function loudnessRange(h) {
  if (h.total === 0) return 0;
  let e = 0;
  for (let i = 0; i < HIST_BINS; i++) if (h.counts[i]) e += h.counts[i] * energyOf(Histogram.centre(i));
  const threshold = loudnessOf(e / h.total) - 20;
  const start = Math.max(0, Math.ceil((threshold - HIST_MIN) / HIST_STEP - 0.5));
  let n = 0;
  for (let i = start; i < HIST_BINS; i++) n += h.counts[i];
  if (!n) return 0;
  const percentile = (p) => {
    const target = p * n;
    let acc = 0;
    for (let i = start; i < HIST_BINS; i++) {
      acc += h.counts[i];
      if (acc >= target) return Histogram.centre(i);
    }
    return Histogram.centre(HIST_BINS - 1);
  };
  return Math.max(0, percentile(0.95) - percentile(0.1));
}
