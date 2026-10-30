import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import sea from 'node:sea';
import { fileURLToPath } from 'node:url';

/**
 * Runtime configuration, read once from the environment.
 *
 *   PORT              default 4173
 *   HOST              default 127.0.0.1 (the APIs start processes and have no login: keep it local or on a trusted network)
 *   PLAYPROBE_HOME    folder holding dist/, tools/ and the data folders (the Linux bundle's start.sh sets it)
 *   FFMPEG_PATH, SRT_LIVE_TRANSMIT_PATH, SRT_WEBHOOK_URL, SRT_WEBHOOK_KIND
 */
const embedded = sea.isSea();
// import.meta.url is not available in the bundled executable, where the exe's own folder is used.
const appDir = process.env.PLAYPROBE_HOME
  ? resolve(process.env.PLAYPROBE_HOME)
  : embedded
    ? dirname(process.execPath)
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A packaged bundle has dist/ next to the server; a checkout has the frontend build in frontend/dist.
const dist = !process.env.PLAYPROBE_HOME && existsSync(join(appDir, 'frontend', 'dist')) ? join(appDir, 'frontend', 'dist') : join(appDir, 'dist');

// Bundled tools (tools/ffmpeg.exe, tools/srt-live-transmit.exe) are used unless the user set their own.
const exe = process.platform === 'win32' ? '.exe' : '';
const tools = join(appDir, 'tools');
if (!process.env.FFMPEG_PATH && existsSync(join(tools, `ffmpeg${exe}`))) process.env.FFMPEG_PATH = join(tools, `ffmpeg${exe}`);
if (!process.env.SRT_LIVE_TRANSMIT_PATH && existsSync(join(tools, `srt-live-transmit${exe}`))) {
  process.env.SRT_LIVE_TRANSMIT_PATH = join(tools, `srt-live-transmit${exe}`);
}

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';

export const config = {
  embedded,
  appDir,
  dist,
  port,
  host,
  url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`,
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  previewDir: join(tmpdir(), 'playprobe-srt-preview'),
  settingsPath: join(appDir, '.playprobe', 'srt-settings.json'),
  logDir: join(appDir, 'logs'),
  noBrowser: process.env.PLAYPROBE_NO_BROWSER === '1',
};
