/**
 * Parses one line of `srt-live-transmit -pf:json` statistics, e.g.
 *
 *   {"sid":123,"time":1234,"window":{...},"link":{"rtt":12.3,"bandwidth":80.5,...},
 *    "send":{...},"recv":{"packets":10,"packetsLost":0,"packetsDropped":0,
 *    "packetsRetransmitted":0,"packetsBelated":0,"mbitRate":4.2,"msBuf":120,...}}
 *
 * Returns null for lines that are not a statistics object. Missing fields come back as null/0.
 */
export function parseLinkStats(line) {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  const link = o.link;
  const recv = o.recv;
  if (!link && !recv) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    rttMs: num(link?.rtt),
    bandwidthMbps: num(link?.bandwidth),
    recvRateMbps: num(recv?.mbitRate),
    recvBufferMs: num(recv?.msBuf),
    packets: num(recv?.packets) ?? 0,
    lost: num(recv?.packetsLost) ?? 0,
    dropped: num(recv?.packetsDropped) ?? 0,
    retransmitted: num(recv?.packetsRetransmitted) ?? 0,
    belated: num(recv?.packetsBelated) ?? 0,
  };
}
