import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let home;
let server;
let base;
let disposeMonitor;
const SEG = '20261103_100000.ts';

const call = (method, path, body) =>
  fetch(`${base}/__srt${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(async () => {
  // The app keeps its files next to itself: point it at a throw-away folder before anything is loaded.
  home = mkdtempSync(join(tmpdir(), 'pulse-api-'));
  process.env.PLAYPROBE_HOME = home;
  const { createApp } = await import('../src/app.js');
  ({ disposeMonitor } = await import('../src/services/srt/index.js'));
  const { createAuth } = await import('../src/services/auth.js');
  const app = createApp({ onQuit: () => undefined, auth: createAuth({ enabled: false, user: 'a', password: 'b' }) });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(join(home, 'recordings', 'ch1'), { recursive: true });
  writeFileSync(join(home, 'recordings', 'ch1', SEG), Buffer.alloc(3000, 7));
  writeFileSync(join(home, 'recordings', 'ch1', 'notes.txt'), 'not a segment');
});
afterAll(() => {
  disposeMonitor?.();
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

describe('recordings API', () => {
  it('lists the segments of a channel (and only segments)', async () => {
    const res = await call('GET', '/ch/1/recordings');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files.map((f) => f.name)).toEqual([SEG]);
    expect(body.files[0]).toMatchObject({ size: 3000 });
    expect(body).toMatchObject({ segmentSec: 600, keepHours: 24 });
    expect(typeof body.channelName).toBe('string');
  });

  it('downloads a segment as an attachment named after the channel', async () => {
    const res = await call('GET', `/ch/1/recordings/${SEG}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename=.*_20261103_100000\.ts/);
    expect((await res.arrayBuffer()).byteLength).toBe(3000);
  });

  it('refuses names that are not segments, including path tricks', async () => {
    for (const name of ['notes.txt', '..%2F..%2Fpackage.json', '%2e%2e%2fsecret.ts', 'a.ts', `${SEG}x`]) {
      expect((await call('GET', `/ch/1/recordings/${name}`)).status, name).toBe(404);
      expect((await call('DELETE', `/ch/1/recordings/${name}`)).status, name).toBe(400);
    }
    expect(existsSync(join(home, 'recordings', 'ch1', 'notes.txt'))).toBe(true);
  });

  it('answers 404 for a bad channel number and 400 for a channel that does not exist', async () => {
    expect((await call('GET', '/ch/abc/recordings')).status).toBe(404);
    expect((await call('GET', '/ch/999/recordings')).status).toBe(400);
    expect((await call('GET', `/ch/999/recordings/${SEG}`)).status).toBe(400);
  });

  it('will not start recording a channel that is not running, and rejects a bad segment length', async () => {
    const idle = await call('POST', '/ch/1/record', { on: true });
    expect(idle.status).toBe(400);
    expect((await idle.json()).error).toMatch(/Start the channel first/);
    const bad = await call('POST', '/ch/1/record', { on: true, segmentMin: 7 });
    expect(bad.status).toBe(400);
    // Stopping something that is not recording is harmless.
    expect((await call('POST', '/ch/1/record', { on: false })).status).toBe(200);
  });

  it('refuses to record an HLS channel', async () => {
    const added = await call('POST', '/channels', { kind: 'hls', name: 'Playlist' });
    expect(added.status).toBe(200);
    const id = (await added.json()).channels.at(-1).id;
    expect((await call('POST', `/ch/${id}/record`, { on: true })).status).toBe(400);
  });

  it('deletes a segment and returns the new list', async () => {
    const res = await call('DELETE', `/ch/1/recordings/${SEG}`);
    expect(res.status).toBe(200);
    expect((await res.json()).files).toEqual([]);
    expect((await call('GET', `/ch/1/recordings/${SEG}`)).status).toBe(404);
  });
});
