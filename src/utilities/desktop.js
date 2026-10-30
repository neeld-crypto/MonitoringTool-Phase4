import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Opens the app in its own window (Edge / Chrome app mode), or the default browser. */
export function openWindow(url) {
  const launch = (cmd, args) =>
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: false })
      .on('error', () => undefined)
      .unref();
  if (process.platform === 'win32') {
    const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    const browsers = pf.flatMap((p) => [join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')]);
    const found = browsers.find((b) => existsSync(b));
    if (found) return launch(found, [`--app=${url}`, '--window-size=1500,950']);
    return launch('cmd', ['/c', 'start', '', url]);
  }
  launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

/** The executable has no console, so anything that goes wrong is written to a file next to it. */
export function reportFatal(message, { embedded, appDir }) {
  console.error(message);
  if (!embedded) return;
  try {
    appendFileSync(join(appDir, 'PlayProbe-error.txt'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* nowhere to write */
  }
}
