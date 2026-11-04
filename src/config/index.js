import { existsSync, readdirSync } from 'node:fs';
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
 *   PULSE_USER, PULSE_PASSWORD   the sign-in (default skandha / skandha@123); PULSE_AUTH=off turns the sign-in off
 *   PULSE_SESSION_HOURS          how long a sign-in lasts (default 12)
 *   PULSE_RECORD_SEGMENT_MIN     length of one recorded segment (default 10); PULSE_RECORD_KEEP_HOURS how long segments are kept (default 24)
 *   FFMPEG_PATH, SRT_LIVE_TRANSMIT_PATH, SRT_WEBHOOK_URL, SRT_WEBHOOK_KIND
 */
const embedded = sea.isSea();
// import.meta.url is not available in the bundled executable, where the exe's own folder is used.
const appDir = process.env.PLAYPROBE_HOME
  ? resolve(process.env.PLAYPROBE_HOME)
  : embedded
    ? dirname(process.execPath)
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Settings and secrets can live in a .env file next to the app; real environment variables win over it.
try {
  process.loadEnvFile(join(appDir, '.env'));
} catch {
  /* no .env file */
}

// A packaged bundle has dist/ next to the server; a checkout has the frontend build in frontend/dist.
const dist = !process.env.PLAYPROBE_HOME && existsSync(join(appDir, 'frontend', 'dist')) ? join(appDir, 'frontend', 'dist') : join(appDir, 'dist');

// Bundled tools (tools/ffmpeg.exe, tools/srt-live-transmit.exe) are used unless the user set their own.
const exe = process.platform === 'win32' ? '.exe' : '';
const tools = join(appDir, 'tools');
if (!process.env.FFMPEG_PATH && existsSync(join(tools, `ffmpeg${exe}`))) process.env.FFMPEG_PATH = join(tools, `ffmpeg${exe}`);
// winget puts ffmpeg under the user's profile and on PATH only for terminals opened afterwards: look there if PATH has none.
if (!process.env.FFMPEG_PATH && process.platform === 'win32' && process.env.LOCALAPPDATA) {
  const onPath = (process.env.PATH ?? '').split(';').some((d) => d && existsSync(join(d, 'ffmpeg.exe')));
  if (!onPath) {
    const winget = join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet');
    const candidates = [join(winget, 'Links', 'ffmpeg.exe')];
    try {
      for (const pkg of readdirSync(join(winget, 'Packages'))) {
        if (!/ffmpeg/i.test(pkg)) continue;
        candidates.push(join(winget, 'Packages', pkg, 'bin', 'ffmpeg.exe'));
        for (const build of readdirSync(join(winget, 'Packages', pkg))) candidates.push(join(winget, 'Packages', pkg, build, 'bin', 'ffmpeg.exe'));
      }
    } catch {
      /* no winget packages */
    }
    const found = candidates.find((c) => existsSync(c));
    if (found) process.env.FFMPEG_PATH = found;
  }
}
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
  layoutsPath: join(appDir, '.playprobe', 'layouts.json'),
  logDir: join(appDir, 'logs'),
  recordingsDir: join(appDir, 'recordings'),
  recordSegmentSec: (Number(process.env.PULSE_RECORD_SEGMENT_MIN) > 0 ? Number(process.env.PULSE_RECORD_SEGMENT_MIN) : 10) * 60,
  recordKeepHours: Number(process.env.PULSE_RECORD_KEEP_HOURS) > 0 ? Number(process.env.PULSE_RECORD_KEEP_HOURS) : 24,
  noBrowser: process.env.PLAYPROBE_NO_BROWSER === '1',
  auth: {
    enabled: (process.env.PULSE_AUTH ?? '').toLowerCase() !== 'off',
    user: process.env.PULSE_USER || 'Skandha',
    password: process.env.PULSE_PASSWORD || 'Skandha@123',
    storePath: join(appDir, '.playprobe', 'sessions.json'),
    sessionMs: (Number(process.env.PULSE_SESSION_HOURS) > 0 ? Number(process.env.PULSE_SESSION_HOURS) : 12) * 3600_000,
  },
};
