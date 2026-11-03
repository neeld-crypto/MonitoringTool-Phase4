import { badge, dataTable, h } from '../dom';
/** Re-read the list of files at most this often while the tab is open. */
const REFRESH_MS = 5000;
const clock = (t) => new Date(t).toLocaleString([], { hour12: false });
const bytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const length = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
/**
 * Recordings tab: record the selected channel's incoming stream on the server as 10-minute segment files (a plain
 * copy, nothing is re-encoded), see the files and download or delete them. The server removes old segments by itself.
 */
export class RecordingsTab {
  client;
  el = h('div', { class: 'tab-pane' });
  head = h('div');
  list = h('div');
  note = h('p', { class: 'small' });
  data = null;
  dataFor = -1;
  fetchedAt = 0;
  fetching = false;
  constructor(client) {
    this.client = client;
    this.el.append(this.head, this.note, this.list);
  }
  say(text, error = false) {
    this.note.className = `small ${error ? 'error' : 'muted'}`;
    this.note.textContent = text;
  }
  refresh() {
    const ch = this.client.current;
    if (!ch || this.fetching) return;
    this.fetching = true;
    this.client
      .recordings(ch.id)
      .then((d) => {
        this.data = d;
        this.dataFor = ch.id;
        this.fetchedAt = Date.now();
        this.render(false);
      })
      .catch((err) => this.say(err instanceof Error ? err.message : String(err), true))
      .finally(() => {
        this.fetching = false;
      });
  }
  async toggle(on) {
    const ch = this.client.current;
    if (!ch) return;
    try {
      await this.client.record(ch.id, on);
      this.say(on ? 'Recording started.' : 'Recording stopped.');
      this.fetchedAt = 0;
      this.render();
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err), true);
    }
  }
  async remove(name) {
    const ch = this.client.current;
    if (!ch || !confirm(`Delete ${name}?`)) return;
    try {
      this.data = await this.client.deleteRecording(ch.id, name);
      this.render(false);
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err), true);
    }
  }
  render(poll = true) {
    const c = this.client;
    const ch = c.current;
    if (!c.available || !ch) {
      this.head.replaceChildren(h('p', { class: 'muted' }, 'Recording runs on the Pulse server and is not available here.'));
      this.list.replaceChildren();
      return;
    }
    if (this.dataFor !== ch.id) this.data = null;
    if (poll && Date.now() - this.fetchedAt >= REFRESH_MS) {
      this.fetchedAt = Date.now();
      this.refresh();
    }
    const rec = ch.snapshot.recording;
    const hls = ch.snapshot.config?.mode === 'hls' || ch.kind === 'hls';
    const segMin = this.data ? Math.round(this.data.segmentSec / 60) : 10;
    const keep = this.data?.keepHours ?? 24;
    this.head.replaceChildren(
      h('h3', null, `${ch.name}: recordings`),
      h(
        'div',
        { class: 'srt-actions' },
        rec
          ? h('button', { type: 'button', class: 'danger', onclick: () => void this.toggle(false) }, '■ Stop recording')
          : h(
              'button',
              { type: 'button', class: 'primary', disabled: !c.running || hls, onclick: () => void this.toggle(true) },
              '● Start recording',
            ),
        rec ? badge(`recording since ${new Date(rec.since).toLocaleTimeString([], { hour12: false })}`, 'warn') : '',
      ),
      h(
        'p',
        { class: 'muted small' },
        hls
          ? 'HLS channels cannot be recorded here: the source already is a set of files.'
          : `The incoming stream is saved as it arrives (no re-encoding) in ${segMin}-minute files. Files older than ${keep} hours are deleted automatically. Recording stops when the channel stops, and carries on if the feed drops and comes back.`,
      ),
      rec?.error ? h('p', { class: 'small error' }, `Recorder message: ${rec.error}`) : '',
      !c.running && !hls ? h('p', { class: 'muted small' }, 'Start the channel first, then start recording.') : '',
    );
    const files = this.data?.files ?? [];
    if (!files.length) {
      this.list.replaceChildren(h('p', { class: 'muted small' }, this.data ? 'No recordings yet.' : 'Loading…'));
      return;
    }
    const total = files.reduce((n, f) => n + f.size, 0);
    // While recording, the newest file is still being written.
    const openName = rec ? files[0].name : null;
    this.list.replaceChildren(
      h('h4', null, `${files.length} file${files.length === 1 ? '' : 's'} · ${bytes(total)}`),
      dataTable(
        ['Started', 'Length', 'Size', ''],
        files.map((f) => [
          clock(f.startAt),
          f.name === openName ? badge('recording…', 'warn') : length((f.modifiedAt - f.startAt) / 1000),
          bytes(f.size),
          [
            h('a', { class: 'button', href: c.recordingUrl(ch.id, f.name), download: '' }, 'Download'),
            ' ',
            h('button', { type: 'button', onclick: () => void this.remove(f.name) }, 'Delete'),
          ],
        ]),
      ),
    );
  }
}
