import type { Alert } from './types';

/** One stored chart sample (a subset of what the live chart keeps in memory). */
export interface StoredSample {
  ch: number;
  t: number;
  kbps: number;
  rttMs: number | null;
  bufferMs: number | null;
}

interface StoredAlert extends Alert {
  /** Key: channel, raise time and id, so a server restart that reuses ids never overwrites an older alert. */
  k: string;
  ch: number;
}

const DB_NAME = 'playprobe-history';
const SAMPLE_EVERY_MS = 5000;
const FLUSH_MS = 4000;
/** Samples and alerts older than this are deleted when the page opens. */
const KEEP_MS = 7 * 24 * 3600 * 1000;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const samples = db.createObjectStore('samples', { keyPath: ['ch', 't'] });
        samples.createIndex('t', 't');
        const alerts = db.createObjectStore('alerts', { keyPath: 'k' });
        alerts.createIndex('ch_at', ['ch', 'at']);
        alerts.createIndex('at', 'at');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

const done = (tx: IDBTransaction) => new Promise<void>((res) => {
  tx.oncomplete = () => res();
  tx.onerror = () => res();
  tx.onabort = () => res();
});

const request = <T>(r: IDBRequest<T>) => new Promise<T | null>((res) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => res(null);
});

/**
 * Keeps channel history in this browser (IndexedDB) so the chart can look back past the live window and past a
 * page reload. It only records while Pulse is open. Failures (private mode, storage off) are silent: the
 * live chart keeps working from memory.
 */
class HistoryStore {
  private samples: StoredSample[] = [];
  private alerts = new Map<string, StoredAlert>();
  private lastSample = new Map<number, number>();
  /** What was last queued per alert, so repeated status updates do not rewrite the same rows. */
  private seen = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.prune();
  }

  private async prune() {
    const db = await open();
    if (!db) return;
    const cutoff = Date.now() - KEEP_MS;
    const tx = db.transaction(['samples', 'alerts'], 'readwrite');
    tx.objectStore('samples').index('t').openCursor(IDBKeyRange.upperBound(cutoff)).onsuccess = function () {
      const cur = this.result;
      if (cur) {
        cur.delete();
        cur.continue();
      }
    };
    tx.objectStore('alerts').index('at').openCursor(IDBKeyRange.upperBound(cutoff)).onsuccess = function () {
      const cur = this.result;
      if (cur) {
        cur.delete();
        cur.continue();
      }
    };
    await done(tx);
  }

  recordSample(ch: number, t: number, kbps: number, rttMs: number | null, bufferMs: number | null) {
    if (t - (this.lastSample.get(ch) ?? 0) < SAMPLE_EVERY_MS) return;
    this.lastSample.set(ch, t);
    this.samples.push({ ch, t, kbps, rttMs, bufferMs });
    this.schedule();
  }

  recordAlert(ch: number, a: Alert) {
    const k = `${ch}:${a.at}:${a.id}`;
    const sig = `${a.state}:${a.clearedAt ?? ''}`;
    if (this.seen.get(k) === sig) return;
    this.seen.set(k, sig);
    this.alerts.set(k, { ...a, k, ch });
    this.schedule();
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
  }

  async flush() {
    const samples = this.samples;
    const alerts = [...this.alerts.values()];
    this.samples = [];
    this.alerts.clear();
    if (!samples.length && !alerts.length) return;
    const db = await open();
    if (!db) return;
    try {
      const tx = db.transaction(['samples', 'alerts'], 'readwrite');
      for (const s of samples) tx.objectStore('samples').put(s);
      for (const a of alerts) tx.objectStore('alerts').put(a);
      await done(tx);
    } catch {
      /* storage full or unavailable */
    }
  }

  async samplesBetween(ch: number, from: number, to: number): Promise<StoredSample[]> {
    const db = await open();
    if (!db) return [];
    try {
      const tx = db.transaction('samples');
      return (await request(tx.objectStore('samples').getAll(IDBKeyRange.bound([ch, from], [ch, to])))) ?? [];
    } catch {
      return [];
    }
  }

  async alertsBetween(ch: number, from: number, to: number): Promise<Alert[]> {
    const db = await open();
    if (!db) return [];
    try {
      const tx = db.transaction('alerts');
      const rows = (await request(tx.objectStore('alerts').index('ch_at').getAll(IDBKeyRange.bound([ch, from], [ch, to])))) ?? [];
      return rows as Alert[];
    } catch {
      return [];
    }
  }

  /** Oldest time recorded for a channel, or null. */
  async oldest(ch: number): Promise<number | null> {
    const db = await open();
    if (!db) return null;
    try {
      const tx = db.transaction('samples');
      const cur = await request(tx.objectStore('samples').openCursor(IDBKeyRange.bound([ch, 0], [ch, Infinity])));
      return cur ? (cur.value as StoredSample).t : null;
    } catch {
      return null;
    }
  }
}

export const historyStore = new HistoryStore();
