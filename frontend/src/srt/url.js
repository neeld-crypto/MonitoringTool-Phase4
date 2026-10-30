const ADDRESS = /\b(srt|udp|https?):\/\/\S+/i;
const PARTS = /^(srt|udp):\/\/@?(\[[^\]]*\]|[^:/?#]*)(?::(\d+))?\/?(?:\?(.*))?$/i;
/** A latency over 2000 can only be microseconds (ffmpeg's unit): convert it to the milliseconds the form uses. */
const toMs = (n) => (n > 2000 ? Math.round(n / 1000) : Math.round(n));
function parseHls(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'Not a valid web address' };
  }
  if (!u.hostname) return { error: 'The playlist address needs a host, e.g. https://example.com/live/master.m3u8' };
  return { mode: 'hls', url: u.href, host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) };
}
/**
 * Reads an HLS playlist address (`https://host/live/master.m3u8`), `srt://host:port?mode=caller&latency=120`, `srt://:9000` (a listener), `udp://@239.1.1.1:5000`
 * or `udp://239.1.1.1:5000?localaddr=10.0.0.5`. Returns null when the text is not such an address.
 */
export function parseStreamUrl(raw) {
  if (/^https?:\/\//i.test(raw.trim())) return parseHls(raw.trim());
  const m = PARTS.exec(raw.trim());
  if (!m) return null;
  const proto = m[1].toLowerCase();
  const host = m[2].replace(/^\[|\]$/g, '');
  const query = new URLSearchParams(m[4] ?? '');
  const port = m[3] ? Number(m[3]) : NaN;
  if (proto === 'udp') {
    if (!host) return { error: 'UDP needs a multicast group, e.g. udp://@239.1.1.1:5000' };
    const iface = query.get('localaddr') ?? query.get('iface') ?? '';
    return { mode: 'multicast', host, port: Number.isInteger(port) ? port : 5000, ...(iface ? { iface } : {}) };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'SRT address needs a port, e.g. srt://host:9000' };
  // With no host (srt://:9000) there is nobody to call: ffmpeg treats that as a listener, and so do we.
  const mode = query.get('mode') === 'listener' || (!host && query.get('mode') !== 'caller') ? 'listener' : 'caller';
  if (mode === 'caller' && !host) return { error: 'Caller mode needs the remote host' };
  const latency = Number(query.get('latency'));
  const passphrase = query.get('passphrase');
  const streamId = query.get('streamid');
  return {
    mode,
    host: mode === 'listener' && host === '0.0.0.0' ? '' : host,
    port,
    ...(latency > 0 ? { latencyMs: toMs(latency) } : {}),
    ...(passphrase ? { passphrase } : {}),
    ...(streamId ? { streamId } : {}),
  };
}
/** One line: an address, optionally preceded by a name (`Sports East | srt://…` or `Sports East, srt://…`). */
export function parseStreamLine(line) {
  const text = line.trim();
  if (!text || text.startsWith('#')) return null;
  const at = ADDRESS.exec(text);
  if (!at) return { error: 'No srt://, udp:// or http(s):// address found' };
  const config = parseStreamUrl(at[0]);
  if (!config) return { error: 'Not a valid address' };
  if ('error' in config) return config;
  const name = text
    .slice(0, at.index)
    .replace(/[\s|,;\t-]+$/, '')
    .trim();
  return { ...(name ? { name } : {}), config };
}
/** Many lines at once, e.g. pasted from a spreadsheet. Blank lines and lines starting with # are skipped. */
export function parseStreamList(text) {
  const out = { items: [], errors: [] };
  text.split(/\r?\n/).forEach((line, i) => {
    const r = parseStreamLine(line);
    if (!r) return;
    if ('error' in r) out.errors.push({ line: i + 1, text: line.trim().slice(0, 60), error: r.error });
    else out.items.push(r);
  });
  return out;
}
/** The address a saved configuration is shown as in the channel form (the passphrase is never shown). */
export function formatStreamUrl(cfg) {
  if (!cfg || !cfg.port) return '';
  if (cfg.mode === 'hls') return cfg.url ?? '';
  if (cfg.mode === 'multicast') return `udp://@${cfg.host ?? ''}:${cfg.port}${cfg.iface ? `?localaddr=${cfg.iface}` : ''}`;
  const host = cfg.host && cfg.host !== '0.0.0.0' ? cfg.host : '';
  const q = [];
  if (cfg.mode === 'listener' && host) q.push('mode=listener');
  if (cfg.mode === 'caller' && !host) q.push('mode=caller');
  if (cfg.latencyMs && cfg.latencyMs !== 120) q.push(`latency=${cfg.latencyMs}`);
  if (cfg.streamId) q.push(`streamid=${cfg.streamId}`);
  return `srt://${host}:${cfg.port}${q.length ? `?${q.join('&')}` : ''}`;
}
