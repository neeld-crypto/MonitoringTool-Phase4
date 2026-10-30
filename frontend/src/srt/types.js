/** Types shared by the SRT monitoring back end (server/srt) and the UI (src/ui). */
export const DEFAULT_THRESHOLDS = {
  noSignalSec: 5,
  waitingSec: 30,
  bitrateDropPct: 50,
  minBitrateKbps: 0,
  rttMs: 250,
  lossPct: 1,
  droppedPackets: 1,
  retransPct: 5,
  ccErrors: 3,
  decodeErrors: 5,
  psiTimeoutMs: 1000,
  pcrMaxMs: 100,
  pidTimeoutSec: 5,
  blackSec: 3,
  silenceSec: 5,
  scteEvents: true,
};
export const DEFAULT_NOTIFY = {
  minSeverity: 'warning',
  notifyOnClear: true,
  cooldownSec: 60,
  webhook: { enabled: false, kind: 'slack', url: '' },
  email: { enabled: false, host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '' },
};
/** Marker the server substitutes for a stored secret; sending it back keeps the stored value. */
export const SECRET_MASK = '********';
export const kindLabel = (kind) => (kind === 'udp' ? 'UDP' : kind === 'hls' ? 'HLS' : 'SRT');
export const MAX_NAME_LENGTH = 40;
export const defaultChannelName = (id, kind = 'srt') => `${kindLabel(kind)} ${id}`;
/** Safety net against a runaway script: the real limit is the CPU limit below. */
export const MAX_CHANNELS = 200;
/** New channels are refused while the whole machine is at or above this CPU percentage (changeable in the panel). */
export const DEFAULT_MAX_CPU = 70;
export const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };
