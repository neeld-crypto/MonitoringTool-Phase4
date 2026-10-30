/** Short, readable names for alert rules (what the tiles, the chart legend and the tooltips show). */
const LABELS = {
  no_connection: 'Not connected',
  no_signal: 'No signal',
  bitrate_drop: 'Bitrate drop',
  bitrate_low: 'Low bitrate',
  ts_cc: 'Continuity errors',
  ts_sync: 'Sync lost',
  ts_tei: 'Transport errors',
  ts_crc: 'PSI CRC error',
  ts_pat: 'PAT missing',
  ts_pmt: 'PMT missing',
  ts_pcr: 'PCR error',
  pid_missing: 'PID missing',
  link_rtt: 'High RTT',
  link_loss: 'Packet loss',
  link_dropped: 'Packets dropped',
  link_retrans: 'Retransmits',
  decode_errors: 'Decode errors',
  video_black: 'Black video',
  audio_silence: 'Audio silence',
  disconnected: 'Disconnected',
  srt_error: 'Connection problem',
  scte: 'SCTE-35',
};
export function ruleLabel(rule) {
  return LABELS[rule] ?? rule.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
