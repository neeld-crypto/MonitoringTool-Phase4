import { spawn } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import sea from 'node:sea';
import { fileURLToPath } from 'node:url';
import { corsProxyMiddleware } from './proxy-plugin.ts';
import { createSrtMiddleware, json, sameOrigin } from './srt/srt-plugin.ts';

/**
 * Skandha without Vite. Serves the built app and the same SRT / UDP and CORS-proxy APIs the dev
 * server has. Runs two ways:
 *
 *   npm start        from the project (serves ./dist; build first with `npm run build`)
 *   PlayProbe.exe    a single executable made by `npm run build:exe`, with the app embedded in it.
 *                    It has no console window: it opens the app in its own browser window, can be quit
 *                    from the page (or with `PlayProbe.exe --quit`), and exits by itself once the page
 *                    is closed and no channel is running.
 *
 *   PORT  (default 4173)     HOST  (default 127.0.0.1; the APIs start processes, so keep it local)
 *
 * Settings (.playprobe/) and logs (logs/) live next to the exe, or in the project root.
 */

const embedded = sea.isSea();
// import.meta.url is not available in the bundled executable, where the exe's own folder is used.
// PLAYPROBE_HOME: the folder holding dist/, tools/ and the data folders (used by the Linux bundle's start.sh).
const appDir = process.env.PLAYPROBE_HOME
  ? resolve(process.env.PLAYPROBE_HOME)
  : embedded
    ? dirname(process.execPath)
    : resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(appDir, 'dist');
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';
const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`;

/** The executable has no console, so anything that goes wrong is written to a file next to it. */
function reportFatal(message: string) {
  console.error(message);
  if (!embedded) return;
  try {
    appendFileSync(join(appDir, 'PlayProbe-error.txt'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* nowhere to write */
  }
}

const quitMode = process.argv.includes('--quit');
if (quitMode) {
  // Ask a running instance to quit (the uninstaller and the "Stop Skandha" shortcut use this).
  void fetch(`${url}__app/quit`, { method: 'POST' })
    .catch(() => undefined)
    .finally(() => process.exit(0));
}

// Bundled tools (tools/ffmpeg.exe, tools/srt-live-transmit.exe) are used unless the user set their own.
const exe = process.platform === 'win32' ? '.exe' : '';
const tools = join(appDir, 'tools');
if (!process.env.FFMPEG_PATH && existsSync(join(tools, `ffmpeg${exe}`))) process.env.FFMPEG_PATH = join(tools, `ffmpeg${exe}`);
if (!process.env.SRT_LIVE_TRANSMIT_PATH && existsSync(join(tools, `srt-live-transmit${exe}`))) {
  process.env.SRT_LIVE_TRANSMIT_PATH = join(tools, `srt-live-transmit${exe}`);
}

/** Embedded files, keyed by path relative to dist (e.g. `assets/index-abc.js`). */
const assets = new Set<string>(embedded ? (JSON.parse(Buffer.from(sea.getRawAsset('manifest.json') as ArrayBuffer).toString()) as string[]) : []);

if (!embedded && !existsSync(join(dist, 'index.html'))) {
  console.error('The app has not been built yet. Run "npm run build" first.');
  process.exit(1);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const srt = createSrtMiddleware(appDir);

const server = createServer((req, res) => {
  if (req.url === '/__app/info') return json(res, 200, { desktop: embedded });
  if (req.url === '/__app/quit' && req.method === 'POST') {
    if (!embedded || !sameOrigin(req)) return json(res, 403, { error: 'Not available' });
    json(res, 200, { ok: true });
    setTimeout(stop, 200);
    return;
  }
  const fail = (err: unknown) => {
    if (!res.headersSent) res.statusCode = 500;
    res.end(String(err));
  };
  corsProxyMiddleware(req, res, (err?: unknown) => {
    if (err) return fail(err);
    srt.middleware(req, res, (err2?: unknown) => {
      if (err2) return fail(err2);
      serveStatic(req.url ?? '/', res);
    });
  });
});

function headers(res: ServerResponse, name: string, size: number) {
  res.setHeader('content-type', MIME[extname(name)] ?? 'application/octet-stream');
  res.setHeader('content-length', size);
  // Hashed assets never change; the page itself must always be re-checked.
  res.setHeader('cache-control', name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
}

function serveStatic(reqUrl: string, res: ServerResponse) {
  let path: string;
  try {
    path = decodeURIComponent(reqUrl.split('?')[0]);
  } catch {
    res.statusCode = 400;
    return res.end('Bad request');
  }
  // Relative, forward-slash name inside dist; anything that climbs out is refused.
  const rel = normalize(path).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  if (rel.split('/').includes('..')) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }

  if (embedded) {
    const name = assets.has(rel) ? rel : 'index.html';
    const data = Buffer.from(sea.getRawAsset(name) as ArrayBuffer);
    headers(res, name, data.length);
    return res.end(data);
  }

  let file = resolve(dist, rel);
  if (file !== dist && !file.startsWith(dist + sep)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  headers(res, file.slice(dist.length + 1).replace(/\\/g, '/'), statSync(file).size);
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

/** Opens the app in its own window (Edge / Chrome app mode), or the default browser. */
function openWindow() {
  const launch = (cmd: string, args: string[]) =>
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: false }).on('error', () => undefined).unref();
  if (process.platform === 'win32') {
    const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
    const browsers = pf.flatMap((p) => [join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')]);
    const found = browsers.find((b) => existsSync(b));
    if (found) return launch(found, [`--app=${url}`, '--window-size=1500,950']);
    return launch('cmd', ['/c', 'start', '', url]);
  }
  launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

if (!quitMode) server.listen(port, host, () => {
  console.log(`Skandha is running at ${url}`);
  console.log(`ffmpeg: ${process.env.FFMPEG_PATH ?? 'from PATH'}`);
  console.log('Press Ctrl+C to stop it and every SRT / UDP channel.');
  if (embedded && process.env.PLAYPROBE_NO_BROWSER !== '1') openWindow();
  if (embedded) watchForExit();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && embedded) {
    // Already running (a second double-click): just show the existing instance.
    if (process.env.PLAYPROBE_NO_BROWSER !== '1') openWindow();
    process.exit(0);
  }
  reportFatal(err.code === 'EADDRINUSE' ? `Port ${port} is already in use by another program. Set PORT=<other>.` : String(err));
  process.exit(1);
});

/**
 * With no console to close, quit once the page has been closed and nothing is being monitored.
 * While channels run it stays alive (alerts keep going to Slack / email); use the Quit button then.
 */
function watchForExit() {
  const startedAt = Date.now();
  let idleSince: number | null = null;
  setInterval(() => {
    const { clients, running } = srt.activity();
    if (clients > 0 || running > 0 || Date.now() - startedAt < 60_000) {
      idleSince = null;
      return;
    }
    idleSince ??= Date.now();
    if (Date.now() - idleSince > 120_000) stop();
  }, 10_000).unref();
}

function stop() {
  srt.dispose();
  server.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('uncaughtException', (err) => reportFatal(`Unexpected error: ${err.stack ?? err}`));
process.on('unhandledRejection', (err) => reportFatal(`Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
