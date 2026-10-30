import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { loadReport } from './load.ts';
import { SrtMonitor } from './monitor.ts';

/**
 * SRT monitoring API for the Vite dev and preview servers (local use only):
 *
 *   GET  /__srt/status          capabilities, snapshot, alert history, settings
 *   GET  /__srt/load            CPU / memory of the machine, the server and its ffmpeg processes
 *   GET  /__srt/events          server-sent events: snapshot, alert, scte, log, notify
 *   POST /__srt/channels        body: { kind: 'srt' | 'udp' | 'hls', name? }   add a channel (there is no fixed number)
 *   POST /__srt/bulk            body: { items: [{ name?, config }], start }  add many, optionally start them
 *   POST /__srt/ch/<n>/start    body: SrtConfig            (n = the channel id)
 *   POST /__srt/ch/<n>/stop
 *   PUT  /__srt/ch/<n>          body: { name, thresholds }
 *   DELETE /__srt/ch/<n>        stop and remove the channel
 *   POST /__srt/ch/<n>/copy-rules   copy this channel's rules to all channels
 *   POST /__srt/ch/<n>/watch    make this the channel with a browser preview (the others have none)
 *   POST /__srt/start-all, /__srt/stop-all   (start-all launches one by one and stops at the CPU limit)
 *   PUT  /__srt/limits          body: { maxCpuPct }   no new channel starts above this machine CPU
 *   GET  /__srt/thumb/<n>.jpg   small live picture of channel n, for the wall
 *   PUT  /__srt/notify          shared webhook / email settings
 *   POST /__srt/notify-test     body: { ch? }, sends a test alert to the enabled channels
 *   GET  /__srt/hls/ch<n>/*     HLS preview written by ffmpeg
 *
 * Everything is also written to ./logs/<YYYY-MM-DD>/.
 *
 * Browsers cannot speak SRT (it runs over UDP), so ffmpeg (and srt-live-transmit
 * when installed) terminates the SRT socket here and the page talks plain HTTP.
 */

const PREFIX = '/__srt/';
const MIME: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

export function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * These endpoints start processes and hold credentials, so refuse requests that come
 * from another website (CSRF / DNS rebinding): the Origin, if sent, must match the Host.
 */
export function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** The SRT API as a plain middleware plus a `dispose` that stops every session. */
export function createSrtMiddleware(root = process.cwd()): {
  middleware: Connect.NextHandleFunction;
  dispose: () => void;
  /** Open browser pages and running channels, for the desktop app's auto-exit. */
  activity: () => { clients: number; running: number };
} {
  let monitor: SrtMonitor | null = null;
  const previewDir = join(tmpdir(), 'playprobe-srt-preview');
  const get = () =>
    (monitor ??= new SrtMonitor({
      ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
      previewDir,
      settingsPath: join(root, '.playprobe', 'srt-settings.json'),
      logDir: join(root, 'logs'),
    }));

  async function handle(req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) {
    const url = req.url ?? '';
    if (!url.startsWith(PREFIX)) return next();
    if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-origin request refused' });
    const path = url.split('?')[0];
    const m = get();

    try {
      if (req.method === 'GET' && path === `${PREFIX}status`) return json(res, 200, m.status());
      if (req.method === 'GET' && path === `${PREFIX}events`) return m.addClient(res);
      if (req.method === 'GET' && path === `${PREFIX}load`) return json(res, 200, await loadReport());

      if (path.startsWith(PREFIX + 'hls/') && req.method === 'GET') {
        const name = decodeURIComponent(path.slice((PREFIX + 'hls/').length));
        if (!/^ch\d{1,4}\/[\w.-]+$/.test(name)) return json(res, 400, { error: 'Bad file name' });
        const file = join(previewDir, name);
        const ext = name.slice(name.lastIndexOf('.'));
        if (!MIME[ext] || !existsSync(file)) return json(res, 404, { error: 'Not found' });
        res.setHeader('content-type', MIME[ext]);
        res.setHeader('content-length', statSync(file).size);
        res.setHeader('cache-control', 'no-store');
        const stream = createReadStream(file);
        stream.on('error', () => res.destroy());
        return void stream.pipe(res);
      }

      const thumb = /^\/__srt\/thumb\/(\d{1,4})\.jpg$/.exec(path);
      if (thumb && req.method === 'GET') {
        const file = m.thumbPath(Number(thumb[1]));
        if (!existsSync(file)) return json(res, 404, { error: 'No picture yet' });
        res.setHeader('content-type', 'image/jpeg');
        res.setHeader('cache-control', 'no-store');
        // Read whole: the file is a few KB and ffmpeg swaps it in atomically, so a half-written picture is never served.
        return void res.end(readFileSync(file));
      }
      if (req.method === 'POST' && path === `${PREFIX}channels`) {
        const body = (await readJson(req)) as { kind?: unknown; name?: unknown };
        m.addChannel(body.kind === 'udp' ? 'udp' : body.kind === 'hls' ? 'hls' : 'srt', body.name);
        return json(res, 200, m.status());
      }
      if (req.method === 'POST' && path === `${PREFIX}bulk`) {
        const body = (await readJson(req)) as { items?: unknown; start?: unknown };
        const result = m.bulkAdd(body.items, body.start === true);
        return json(res, 200, { ...m.status(), ...result });
      }
      if (req.method === 'PUT' && path === `${PREFIX}limits`) {
        m.updateLimits(await readJson(req));
        return json(res, 200, m.status());
      }
      const ch = /^\/__srt\/ch\/(\d+)(?:\/([\w-]+))?$/.exec(path);
      if (ch) {
        const [, id, action] = ch;
        if (req.method === 'POST' && action === 'start') m.start(id, await readJson(req));
        else if (req.method === 'POST' && action === 'stop') m.stop(id);
        else if (req.method === 'POST' && action === 'copy-rules') m.copyRules(id);
        else if (req.method === 'POST' && action === 'watch') m.watch(id);
        else if (req.method === 'PUT' && !action) m.updateChannel(id, await readJson(req));
        else if (req.method === 'DELETE' && !action) m.removeChannel(id);
        else return json(res, 404, { error: 'Unknown SRT endpoint' });
        return json(res, 200, m.status());
      }
      if (req.method === 'POST' && path === `${PREFIX}start-all`) {
        const queued = m.startAll();
        return json(res, 200, { ...m.status(), queued });
      }
      if (req.method === 'POST' && path === `${PREFIX}stop-all`) {
        m.stopAll();
        return json(res, 200, m.status());
      }
      if (req.method === 'PUT' && path === `${PREFIX}notify`) {
        return json(res, 200, m.updateNotify(await readJson(req)));
      }
      if (req.method === 'POST' && path === `${PREFIX}notify-test`) {
        const body = (await readJson(req)) as { ch?: unknown };
        const results = await m.testNotify(body.ch);
        return json(res, 200, { results });
      }
      return json(res, 404, { error: 'Unknown SRT endpoint' });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    handle(req, res, next).catch(next);
  };
  return {
    middleware,
    dispose: () => monitor?.dispose(),
    activity: () => ({ clients: monitor?.clientCount ?? 0, running: monitor?.runningCount ?? 0 }),
  };
}

export function srtMonitorPlugin(): Plugin {
  const { middleware, dispose: shutdown } = createSrtMiddleware();
  return {
    name: 'playprobe-srt',
    configureServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once('close', shutdown);
      process.once('exit', shutdown);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once('close', shutdown);
      process.once('exit', shutdown);
    },
  };
}
