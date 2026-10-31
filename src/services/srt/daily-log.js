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
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A channel's name as a safe file name: no path characters, no reserved Windows names, not empty. */
export function safeFileName(name) {
  const base = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|[. ]+$/g, '')
    .slice(0, 80)
    .trim();
  return RESERVED.test(base) ? `${base}_` : base;
}

/**
 * Writes plain-text logs into `<root>/<YYYY-MM-DD>/`. The folder is picked from the local clock on
 * every write, so the first line after midnight starts the next day's folder on its own.
 *
 *   all-channels.log   the alerts of every channel (raised, recovered, events, notification results) and server lines
 *   <channel name>.log everything for one channel, named after the name given in the app ("Sports East.log").
 *                      Stopping and starting a channel keeps appending to the same file; renaming it starts a new file.
 *
 * Two channels with the same name must not mix: the first keeps `<name>.log`, the other gets `<name> (<id>).log`.
 */
export class DailyLog {
  root;
  now;
  madeDir = '';
  /** lower-case file base -> id of the channel that owns it */
  owners = new Map();
  constructor(root, now = () => new Date()) {
    this.root = root;
    this.now = now;
  }
  /** Folder for today's logs. */
  todayDir() {
    return join(this.root, dayFolder(this.now()));
  }
  /** Claims a channel's file name, so the same channel gets the same file after a restart. */
  reserve(channel, name, kind = 'srt') {
    this.fileBase(channel, name, kind);
  }
  /** File name (without `.log`) for a channel. */
  fileBase(channel, name, kind = 'srt') {
    const base = safeFileName(name) || `${kind}-${channel}`;
    const key = base.toLowerCase();
    const owner = this.owners.get(key);
    if (owner === undefined) this.owners.set(key, channel);
    return owner === undefined || owner === channel ? base : `${base} (${channel})`;
  }
  /**
   * @param channel 1..n, or 0 for lines that belong to no channel (server start-up, notification setup)
   * @param alert   also copy the line to all-channels.log (lines of channel 0 always go there)
   * @param kind    only used to name a channel that has no name
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
      if (alert || !channel) appendFileSync(join(dir, 'all-channels.log'), line);
      if (channel) appendFileSync(join(dir, `${this.fileBase(channel, name, kind)}.log`), line);
    } catch {
      // A full disk or a locked file must never take the monitor down.
      this.madeDir = '';
    }
  }
}
