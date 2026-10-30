import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { activity, disposeMonitor } from './services/srt/index.js';
import { openWindow, reportFatal } from './utilities/desktop.js';

/**
 * Pulse server. Serves the built frontend and the monitoring / proxy APIs. Runs two ways:
 *
 *   npm start        from the project (serves frontend/dist; build it first with `npm run build`)
 *   PlayProbe.exe    a single executable made by `npm run build:exe`, with the app embedded in it.
 *                    It has no console window: it opens the app in its own browser window, can be quit
 *                    from the page (or with `PlayProbe.exe --quit`), and exits by itself once the page
 *                    is closed and no channel is running.
 *
 * Settings (.playprobe/) and logs (logs/) live next to the exe, or in the project root.
 */
export function start() {
  const { embedded, appDir, dist, port, host, url } = config;
  const fatal = (message) => reportFatal(message, { embedded, appDir });

  if (process.argv.includes('--quit')) {
    // Ask a running instance to quit (the uninstaller and the "Stop Pulse" shortcut use this).
    void fetch(`${url}__app/quit`, { method: 'POST' })
      .catch(() => undefined)
      .finally(() => process.exit(0));
    return;
  }

  if (!embedded && !existsSync(join(dist, 'index.html'))) {
    console.error('The frontend has not been built yet. Run "npm run build" first.');
    process.exit(1);
  }

  const app = createApp({ onQuit: stop });
  const server = app.listen(port, host, () => {
    console.log(`Pulse is running at ${url}`);
    console.log(`ffmpeg: ${process.env.FFMPEG_PATH ?? 'from PATH'}`);
    console.log('Press Ctrl+C to stop it and every SRT / UDP channel.');
    if (embedded && !config.noBrowser) openWindow(url);
    if (embedded) watchForExit();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && embedded) {
      // Already running (a second double-click): just show the existing instance.
      if (!config.noBrowser) openWindow(url);
      process.exit(0);
    }
    fatal(err.code === 'EADDRINUSE' ? `Port ${port} is already in use by another program. Set PORT=<other>.` : String(err));
    process.exit(1);
  });

  /**
   * With no console to close, quit once the page has been closed and nothing is being monitored.
   * While channels run it stays alive (alerts keep going to Slack / email); use the Quit button then.
   */
  function watchForExit() {
    const startedAt = Date.now();
    let idleSince = null;
    setInterval(() => {
      const { clients, running } = activity();
      if (clients > 0 || running > 0 || Date.now() - startedAt < 60_000) {
        idleSince = null;
        return;
      }
      idleSince ??= Date.now();
      if (Date.now() - idleSince > 120_000) stop();
    }, 10_000).unref();
  }

  function stop() {
    disposeMonitor();
    server.close();
    process.exit(0);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('uncaughtException', (err) => fatal(`Unexpected error: ${err.stack ?? err}`));
  process.on('unhandledRejection', (err) => fatal(`Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
}
