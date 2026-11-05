import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End to end over a real SRT connection: ffmpeg plays a 720p25 test picture as an SRT listener, Pulse connects to it
 * as a caller, and the monitoring, recording and download are checked through the HTTP API.
 * Slow (about 40 s) and needs ffmpeg with SRT, so it only runs when asked:  PULSE_E2E=1 npx vitest run test/e2e-srt.test.js
 */
const srtOk = spawnSync('ffmpeg', ['-hide_banner', '-protocols'], { encoding: 'utf8' }).stdout?.split(/\s+/).includes('srt') ?? false;
const PORT = 19231;

describe.skipIf(!process.env.PULSE_E2E || !srtOk)('SRT feed end to end', () => {
  let home;
  let server;
  let base;
  let source;
  let disposeMonitor;

  const api = (method, path, body) =>
    fetch(`${base}/__srt${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  const channel = async () => (await (await api('GET', '/status')).json()).channels.find((c) => c.id === 1);
  const until = async (what, test, ms = 25_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await test();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'pulse-e2e-'));
    process.env.PLAYPROBE_HOME = home;
    const { createApp } = await import('../src/app.js');
    ({ disposeMonitor } = await import('../src/services/srt/index.js'));
    const { createAuth } = await import('../src/services/auth.js');
    const app = createApp({ onQuit: () => undefined, auth: createAuth({ enabled: false, user: 'a', password: 'b' }) });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    source = spawn(
      'ffmpeg',
      ['-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
        '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', `srt://127.0.0.1:${PORT}?mode=listener`],
      { stdio: 'ignore' },
    );
    await new Promise((r) => setTimeout(r, 1500));
  }, 30_000);

  afterAll(async () => {
    source?.kill();
    await api('POST', '/ch/1/stop').catch(() => undefined);
    disposeMonitor?.();
    server?.close();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(home, { recursive: true, force: true });
  });

  it('connects and measures the stream', async () => {
    const started = await api('POST', '/ch/1/start', { mode: 'caller', host: '127.0.0.1', port: PORT, latencyMs: 120 });
    expect(started.status).toBe(200);
    const ch = await until('the channel to connect and detect the video', async () => {
      const c = await channel();
      return c.snapshot.state === 'connected' && c.snapshot.av?.video?.height ? c : null;
    });
    const { video, audio } = ch.snapshot.av;
    expect(video).toMatchObject({ codec: 'h264', width: 1280, height: 720, fps: 25 });
    expect(['progressive', undefined]).toContain(video.scan);
    expect(audio).toMatchObject({ codec: 'aac', sampleRate: 44100 });
    expect(ch.snapshot.ts.bitrateKbps).toBeGreaterThan(50);
    expect(ch.snapshot.recording).toBeNull();
  }, 40_000);

  it('records, lists, downloads and stops', async () => {
    const on = await api('POST', '/ch/1/record', { on: true, segmentMin: 5 });
    expect(on.status).toBe(200);
    expect((await channel()).snapshot.recording).toMatchObject({ segmentSec: 300 });
    await new Promise((r) => setTimeout(r, 9000));
    expect((await api('POST', '/ch/1/record', { on: false })).status).toBe(200);
    expect((await channel()).snapshot.recording).toBeNull();
    const list = await until('the recording to appear', async () => {
      const body = await (await api('GET', '/ch/1/recordings')).json();
      return body.files.length ? body : null;
    }, 10_000);
    const [file] = list.files;
    expect(file.size).toBeGreaterThan(50_000);
    const dl = await api('GET', `/ch/1/recordings/${file.name}`);
    expect(dl.status).toBe(200);
    const bytes = new Uint8Array(await dl.arrayBuffer());
    expect(bytes.length).toBe(file.size);
    expect(bytes[0]).toBe(0x47);
    const del = await api('DELETE', `/ch/1/recordings/${file.name}`);
    expect((await del.json()).files).toEqual([]);
  }, 40_000);

  it('notices when the source goes away and raises an alert', async () => {
    source.kill();
    await until('the channel to leave "connected"', async () => (await channel()).snapshot.state !== 'connected', 30_000);
    const ch = await until('an alert about the lost feed', async () => {
      const c = await channel();
      return c.alerts.some((a) => ['no_signal', 'disconnected', 'no_connection', 'srt_error'].includes(a.rule)) ? c : null;
    }, 40_000);
    expect(ch.alerts.length).toBeGreaterThan(0);
  }, 90_000);
});
