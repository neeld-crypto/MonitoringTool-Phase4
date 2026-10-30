/** Types shared by the SRT monitoring back end (server/srt) and the UI (src/ui). */

/** `multicast` is the UDP channel: join a multicast group and receive MPEG-TS datagrams. */
export type SrtMode = 'listener' | 'caller' | 'multicast' | 'hls';

export interface SrtConfig {
  mode: SrtMode;
  /** Listener: address to bind (default 0.0.0.0). Caller: remote host. */
  host: string;
  port: number;
  /** HLS only: the playlist address (`host` and `port` are then just its origin, for display). */
  url?: string;
  /** Multicast only: IPv4 address of the network interface to join on (blank = system default). */
  iface?: string;
  /** Receive latency in milliseconds. */
  latencyMs: number;
  passphrase?: string;
  streamId?: string;
  /** Re-encode the browser preview to H.264/AAC (needed for HEVC / AC-3 / MP2 sources). */
  transcodePreview: boolean;
  /**
   * Light analysis (default): black-frame detection decodes keyframes only, which costs a fraction of the CPU.
   * Turn it off to decode every frame (finds corrupt P/B frames, needs several times more CPU).
   */
  lightAnalysis?: boolean;
}

export type Severity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: number;
  /** Which channel raised it and the name it had at that moment. */
  channelId?: number;
  channelName?: string;
  /** Rule id, e.g. `link_loss`. */
  rule: string;
  /** Rule id plus qualifier (e.g. a PID), identifies one raise/clear pair. */
  key: string;
  severity: Severity;
  /** `event` alerts are one-shot (SCTE-35, connect); the others have a lifecycle. */
  state: 'raised' | 'cleared' | 'event';
  message: string;
  at: number;
  clearedAt?: number;
  details?: Record<string, string | number | boolean>;
}

export type SessionState = 'idle' | 'starting' | 'waiting' | 'connected' | 'stalled' | 'reconnecting' | 'error';

/** SRT link statistics (only with `srt-live-transmit`; ffmpeg does not expose them). */
export interface LinkStats {
  rttMs: number | null;
  bandwidthMbps: number | null;
  recvRateMbps: number | null;
  recvBufferMs: number | null;
  /** Cumulative counters. */
  packets: number;
  lost: number;
  dropped: number;
  retransmitted: number;
  belated: number;
}

export interface PidStats {
  pid: number;
  type: string;
  kind: 'video' | 'audio' | 'data' | 'scte35' | 'psi' | 'other';
  bitrateKbps: number;
  /** Seconds since the PID was last seen (null if never). */
  lastSeenAgoSec: number | null;
  ccErrors: number;
}

export interface TsStats {
  packets: number;
  bytes: number;
  bitrateKbps: number;
  nullPercent: number;
  /** Cumulative error counters. */
  syncLosses: number;
  ccErrors: number;
  teiErrors: number;
  psiCrcErrors: number;
  pcrPid: number | null;
  /** Largest PCR-to-PCR distance (stream time) in the last seconds, and time since the last PCR. */
  pcrIntervalMaxMs: number | null;
  /** Largest |arrival delta - PCR delta| in the last seconds. */
  pcrDriftMs: number | null;
  pcrDiscontinuities: number;
  msSincePat: number | null;
  msSincePmt: number | null;
  patIntervalMaxMs: number | null;
  programs: number;
  pids: PidStats[];
}

export interface AvStats {
  video?: { codec: string; width?: number; height?: number; fps?: number; description: string };
  audio?: { codec: string; sampleRate?: number; channels?: string; description: string };
  streams: string[];
  black: boolean;
  blackForSec: number;
  blackFrames: number;
  silent: boolean;
  silentForSec: number;
  silenceEvents: number;
  /** Recent audio peak per channel in dBFS (about every half second), for the wall's level meters; null when no audio is arriving. */
  audioDb: number[] | null;
  /** ffmpeg decoder complaints (corrupt packets, concealment, bad timestamps): the best sign of wire damage when ffmpeg owns the socket. */
  decodeErrors: number;
}

/** What the HLS playlist watcher reports for one channel. */
export interface HlsInfo {
  /** Renditions in the master playlist (0 for a plain media playlist). */
  variants: number;
  /** Picture size and bitrate of the rendition the wall decodes (the cheapest one). */
  resolution: string | null;
  kbps: number | null;
  targetDuration: number | null;
  /** Milliseconds since the playlist last got a new segment; null for a finished (VOD) playlist. */
  staleMs: number | null;
  ended: boolean;
  /** Why the last playlist fetch failed, while it keeps failing. */
  fetchError: string | null;
  lastOkMs: number | null;
}

export interface SrtSnapshot {
  state: SessionState;
  config: SrtConfig | null;
  ingest: 'srt-live-transmit' | 'ffmpeg' | 'udp' | 'hls' | null;
  /** Whether true SRT link statistics are available. */
  linkStatsAvailable: boolean;
  /** `wire`: the analyser sees the bytes as received. `remuxed`: it sees ffmpeg's re-multiplexed copy, so CC / PCR / PSI results describe ffmpeg's output, not the sender's. */
  tsSource: 'wire' | 'remuxed' | null;
  startedAt: number | null;
  connectedAt: number | null;
  connections: number;
  msSinceData: number | null;
  /** How long the session has been waiting / reconnecting without a connection (null while connected or idle). */
  waitingForMs: number | null;
  link: LinkStats | null;
  ts: TsStats | null;
  av: AvStats | null;
  /** Relative URL of the HLS preview, once it has segments. */
  previewUrl: string | null;
  /** HLS channels: what the playlist checks found; null for SRT / UDP. */
  hls?: HlsInfo | null;
  /** When the wall thumbnail (a small JPEG at `/__srt/thumb/<id>.jpg`) was last refreshed; null until the first picture. */
  thumbAt: number | null;
  lastError: string | null;
  now: number;
}

export interface ScteMessage {
  /** Base64 splice_info_section. */
  raw: string;
  pid: number;
  receivedAt: number;
}

export interface AlertThresholds {
  /** No data for this many seconds while connected. */
  noSignalSec: number;
  /** Still not connected this many seconds after starting or dropping (0 = off). */
  waitingSec: number;
  /** Bitrate falls this many percent below its 30 s average (0 = off). */
  bitrateDropPct: number;
  /** Absolute minimum bitrate in kbps (0 = off). */
  minBitrateKbps: number;
  rttMs: number;
  /** Packet loss percent over 10 s. */
  lossPct: number;
  /** Unrecoverable (dropped) packets over 10 s. */
  droppedPackets: number;
  retransPct: number;
  /** Continuity counter errors over 10 s. */
  ccErrors: number;
  /** ffmpeg decode errors over 10 s. */
  decodeErrors: number;
  /** PAT/PMT not seen for this long (TR 101 290 says 500 ms). */
  psiTimeoutMs: number;
  /** PCR repetition limit (TR 101 290 says 40 ms; 100 ms is more forgiving). */
  pcrMaxMs: number;
  /** A PID goes missing for this long. */
  pidTimeoutSec: number;
  blackSec: number;
  silenceSec: number;
  /** Raise SCTE-35 splice events as info alerts. */
  scteEvents: boolean;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
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

export interface NotifySettings {
  /** Lowest severity that gets sent to webhook / email. */
  minSeverity: Severity;
  notifyOnClear: boolean;
  /** Do not re-send the same alert key within this many seconds. */
  cooldownSec: number;
  webhook: { enabled: boolean; kind: 'slack' | 'teams' | 'generic'; url: string };
  email: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
    to: string;
  };
}

export const DEFAULT_NOTIFY: NotifySettings = {
  minSeverity: 'warning',
  notifyOnClear: true,
  cooldownSec: 60,
  webhook: { enabled: false, kind: 'slack', url: '' },
  email: { enabled: false, host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '' },
};

/** Marker the server substitutes for a stored secret; sending it back keeps the stored value. */
export const SECRET_MASK = '********';

/** Settings the Alerts tab edits: the selected channel's rules plus the shared notification setup. */
export interface SrtSettings {
  thresholds: AlertThresholds;
  notify: NotifySettings;
}

/** An SRT channel receives listener / caller SRT; a UDP channel joins a multicast group. */
export type ChannelKind = 'srt' | 'udp' | 'hls';
export const kindLabel = (kind: ChannelKind) => (kind === 'udp' ? 'UDP' : kind === 'hls' ? 'HLS' : 'SRT');
export const MAX_NAME_LENGTH = 40;
export const defaultChannelName = (id: number, kind: ChannelKind = 'srt') => `${kindLabel(kind)} ${id}`;
/** Safety net against a runaway script: the real limit is the CPU limit below. */
export const MAX_CHANNELS = 200;
/** New channels are refused while the whole machine is at or above this CPU percentage (changeable in the panel). */
export const DEFAULT_MAX_CPU = 70;

/** Machine CPU as the server sees it, smoothed over the last few seconds. */
export interface CpuStatus {
  pct: number;
  limit: number;
  cores: number;
}

export interface ChannelStatus {
  /** Unique and never reused while the server runs. */
  id: number;
  kind: ChannelKind;
  /** User-chosen name, shown in the grid and in every alert / notification. */
  name: string;
  /** Last connection settings used for this channel (never includes secrets). */
  config: SrtConfig | null;
  thresholds: AlertThresholds;
  snapshot: SrtSnapshot;
  alerts: Alert[];
}

export interface SrtStatus {
  available: true;
  ffmpeg: boolean;
  srtLiveTransmit: boolean;
  channels: ChannelStatus[];
  notify: NotifySettings;
  /** Folder the daily logs are written to. */
  logDir: string;
  cpu: CpuStatus;
}

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
