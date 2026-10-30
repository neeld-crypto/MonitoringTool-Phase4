import { execFile } from 'node:child_process';
import { cpus, freemem, loadavg, totalmem } from 'node:os';

export interface ProcessLoad {
  name: string;
  count: number;
  /** Percent of ONE core, summed over the processes (100 = one core fully used). */
  cpuCores: number;
  memMB: number;
}

export interface LoadReport {
  platform: string;
  cores: number;
  /** Whole-machine CPU use over the last interval, 0-100. */
  cpuPct: number;
  loadavg: number[] | null;
  memUsedMB: number;
  memTotalMB: number;
  /** The Skandha server itself. */
  server: { cpuCores: number; memMB: number };
  /** ffmpeg / srt-live-transmit started by Skandha (Linux and macOS only). */
  children: ProcessLoad[] | null;
}

let lastCpu = process.cpuUsage();
let lastAt = Date.now();

const SAMPLE_MS = 2000;
/** The CPU figure used for decisions is the average of this many samples (about 6 s): ffmpeg start-up spikes must not block a start. */
const SAMPLES_KEPT = 3;

/**
 * Whole-machine CPU use, sampled on its own timer so that the figure never depends on who asks and when.
 * `os.cpus()` times are cumulative; the use between two samples is the share of non-idle time.
 */
export class CpuSampler {
  private prev: { idle: number; total: number } | null = null;
  private samples: number[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly read: () => { idle: number; total: number } = cpuTimes) {}

  /** Takes one sample now and then every few seconds. Idempotent. */
  start(onSample?: (pct: number) => void): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => {
      this.sample();
      onSample?.(this.pct);
    }, SAMPLE_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests and for `start`. */
  sample(): void {
    const t = this.read();
    const prev = this.prev;
    this.prev = t;
    if (!prev || t.total === prev.total) return;
    const pct = Math.max(0, Math.min(100, (1 - (t.idle - prev.idle) / (t.total - prev.total)) * 100));
    this.samples.push(pct);
    if (this.samples.length > SAMPLES_KEPT) this.samples.shift();
  }

  /** Average of the recent samples; 0 until the first interval has passed. */
  get pct(): number {
    if (!this.samples.length) return 0;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }

  /** The newest sample alone, which reacts faster: used while a batch of channels is being started one by one. */
  get latest(): number {
    return this.samples.at(-1) ?? 0;
  }
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

export const cpuSampler = new CpuSampler();

/**
 * Whether one more channel may start: refused at or above the limit. Returns the reason, or null when allowed.
 * With no sample yet (the first seconds after the server starts) it allows the start.
 */
export function cpuBlock(cpuPct: number, limitPct: number): string | null {
  if (cpuPct < limitPct) return null;
  return `The computer's CPU is at ${Math.round(cpuPct)}% (limit ${limitPct}%). Stop a channel or raise the CPU limit to start another.`;
}

/** `ps` lists the children of this process with their CPU share and memory. Not available on Windows. */
function childLoad(): Promise<ProcessLoad[] | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'ppid=,pcpu=,rss=,comm='], { timeout: 3000 }, (err, out) => {
      if (err) return resolve(null);
      const groups = new Map<string, ProcessLoad>();
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (!m || Number(m[1]) !== process.pid) continue;
        const name = m[4].split('/').pop() ?? m[4];
        const g = groups.get(name) ?? { name, count: 0, cpuCores: 0, memMB: 0 };
        g.count++;
        g.cpuCores += Number(m[2]);
        g.memMB += Number(m[3]) / 1024;
        groups.set(name, g);
      }
      resolve([...groups.values()].map((g) => ({ ...g, cpuCores: Math.round(g.cpuCores * 10) / 10, memMB: Math.round(g.memMB) })));
    });
  });
}

export async function loadReport(): Promise<LoadReport> {
  cpuSampler.start();
  const now = Date.now();
  const cpu = process.cpuUsage();
  const elapsedMs = Math.max(1, now - lastAt);
  const usedMicros = cpu.user + cpu.system - lastCpu.user - lastCpu.system;
  lastCpu = cpu;
  lastAt = now;
  const total = totalmem();
  return {
    platform: process.platform,
    cores: cpus().length,
    cpuPct: Math.round(cpuSampler.pct * 10) / 10,
    loadavg: process.platform === 'win32' ? null : loadavg().map((n) => Math.round(n * 100) / 100),
    memUsedMB: Math.round((total - freemem()) / 1048576),
    memTotalMB: Math.round(total / 1048576),
    server: { cpuCores: Math.round((usedMicros / 1000 / elapsedMs) * 1000) / 10, memMB: Math.round(process.memoryUsage().rss / 1048576) },
    children: await childLoad(),
  };
}
