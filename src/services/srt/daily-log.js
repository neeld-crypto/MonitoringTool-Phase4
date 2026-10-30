import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const pad = (n, width = 2) => String(n).padStart(width, '0');
/** Local date as YYYY-MM-DD: the name of the day's folder. */
export function dayFolder(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function timestamp(d) {
  return `${dayFolder(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
/**
 * Writes plain-text logs into `<root>/<YYYY-MM-DD>/`. The folder is picked from the local clock on
 * every write, so the first line after midnight starts the next day's folder on its own.
 *
 *   all-channels.log   everything, from every channel, in time order
 *   alerts.log         raised / recovered alerts, events and notification results
 *   srt-<id>.log       everything for one SRT channel (udp-<id>.log for UDP channels)
 */
export class DailyLog {
  root;
  now;
  madeDir = '';
  constructor(root, now = () => new Date()) {
    this.root = root;
    this.now = now;
  }
  /** Folder for today's logs. */
  todayDir() {
    return join(this.root, dayFolder(this.now()));
  }
  /**
   * @param channel 1..n, or 0 for lines that belong to no channel (server start-up, notification setup)
   * @param alert   also copy the line to alerts.log
   * @param kind    picks the file name: `srt-<id>.log`, `udp-<id>.log` or `hls-<id>.log`
   */
  write(channel, name, level, category, text, alert = false, kind = 'srt') {
    const at = this.now();
    const dir = join(this.root, dayFolder(at));
    const who = channel ? `[${name || `SRT ${channel}`}]` : '[server]';
    const line = `${timestamp(at)} ${level.padEnd(5)} ${who} ${category}: ${text.replace(/\r?\n/g, ' ⏎ ')}\n`;
    try {
      if (this.madeDir !== dir) {
        mkdirSync(dir, { recursive: true });
        this.madeDir = dir;
      }
      appendFileSync(join(dir, 'all-channels.log'), line);
      if (channel) appendFileSync(join(dir, `${kind}-${channel}.log`), line);
      if (alert) appendFileSync(join(dir, 'alerts.log'), line);
    } catch {
      // A full disk or a locked file must never take the monitor down.
      this.madeDir = '';
    }
  }
}
