/** Short, readable names for alert rules (what the tiles, the chart legend and the tooltips show). */
const LABELS = {
  no_connection: 'Not connected',
  no_signal: 'No signal',
  bitrate_drop: 'Bitrate drop',
  bitrate_low: 'Low bitrate',
  ts_cc: 'Lost packets',
  ts_sync: 'Stream unreadable',
  ts_tei: 'Damaged packets',
  ts_crc: 'Corrupt stream table',
  ts_pat: 'PAT missing',
  ts_pmt: 'PMT missing',
  ts_pcr: 'Timing (PCR) error',
  pid_missing: 'Video / audio missing',
  link_rtt: 'High network delay',
  link_loss: 'Packet loss',
  link_dropped: 'Packets lost for good',
  link_retrans: 'Unstable network',
  decode_errors: 'Damaged picture / sound',
  video_black: 'Black screen',
  audio_silence: 'No sound',
  disconnected: 'Disconnected',
  srt_error: 'Connection problem',
  scte: 'SCTE-35',
};
/** What an operator should check first, per rule. */
const HELP = {
  no_connection: 'Check that the encoder or source is running and that the address, port and firewall are right.',
  no_signal: 'The link is up but nothing is arriving. Check the encoder output; if it is running, restart it.',
  bitrate_drop: 'The encoder is sending less than usual. Check the encoder load and the source video.',
  bitrate_low: 'Check the encoder bitrate setting and that the source is not a still image or colour bars.',
  ts_cc: 'Packets went missing between the encoder and here. Look at the network path or the encoder output.',
  ts_sync: 'The data is not a valid transport stream. Check the encoder output format and the source URL.',
  ts_tei: 'The source or an earlier hop is flagging corrupt packets. Check cables, satellite or IP feed upstream.',
  ts_crc: 'The programme tables are damaged. Usually an upstream error; check the encoder or multiplexer.',
  ts_pat: 'Without the PAT a player cannot find the programme. Check the encoder or multiplexer.',
  ts_pmt: 'Without the PMT a player cannot find the video and audio. Check the encoder or multiplexer.',
  ts_pcr: 'The clock reference is irregular, so playback can stutter. Check the encoder or multiplexer settings.',
  pid_missing: 'One of the programme streams stopped. Check that the encoder is still sending video and audio.',
  link_rtt: 'The network round trip is slow. Check the route and congestion; SRT latency should be at least 4 x RTT.',
  link_loss: 'The network is dropping packets. If it continues, raise the SRT latency or fix the link.',
  link_dropped: 'SRT gave up on packets. Raise the SRT latency or reduce the bitrate.',
  link_retrans: 'Many packets are being re-sent. The network is struggling; check bandwidth and congestion.',
  decode_errors: 'The picture or sound is damaged. Check the source and the network for packet loss.',
  video_black: 'Check the source feed and the encoder input. It may be a real black or a camera or switcher problem.',
  audio_silence: 'Check the audio source and the encoder audio input.',
  disconnected: 'The source went away. It will reconnect on its own when it comes back.',
  srt_error: 'Check the address, port, passphrase and latency settings.',
};
export function ruleLabel(rule) {
  return LABELS[rule] ?? rule.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
export function ruleHelp(rule) {
  return HELP[rule] ?? '';
}
