import type { SrtClient } from '../../srt/client';
import type { AlertThresholds, SrtSnapshot } from '../../srt/types';
import { DEFAULT_THRESHOLDS } from '../../srt/types';
import { badge, dataTable, h, kvTable } from '../dom';
import { SrtChartView } from '../srt/chart';

const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
const num = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '—' : v.toFixed(digits));
const hex = (pid: number) => `0x${pid.toString(16).toUpperCase().padStart(4, '0')}`;

function duration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh ? `${hh}h ${mm}m ${ss}s` : mm ? `${mm}m ${ss}s` : `${ss}s`;
}

/** Colours a value by its alert threshold: ok / warn. */
const level = (bad: boolean, text: string) => badge(text, bad ? 'warn' : 'ok');

/** SRT tab: connection, link statistics, MPEG-TS health and audio/video health. */
export class SrtTab {
  readonly el = h('div', { class: 'tab-pane' });
  private body = h('div');
  /** Built once, outside the body that is replaced every second, so panning and the date picker are not interrupted. */
  private chart = new SrtChartView();

  constructor(private readonly client: SrtClient) {
    this.el.append(this.chart.el, this.body);
  }

  render(): void {
    const c = this.client;
    const s = c.snapshot;
    this.chart.el.hidden = true;
    if (!c.available) {
      this.body.replaceChildren(h('p', { class: 'muted' }, 'SRT monitoring runs on the local Pulse server (npm run dev / npm run preview) and is not available here.'));
      return;
    }
    if (!s || s.state === 'idle') {
      this.body.replaceChildren(h('p', { class: 'muted' }, `${c.current?.name ?? 'This channel'} is not running. Open the SRT panel in the header to start a listener or connect to a source. Link, transport stream and audio/video health show up here, and anything abnormal is raised in the Alerts tab.`));
      return;
    }
    this.chart.el.hidden = false;
    const th = c.settings?.thresholds ?? DEFAULT_THRESHOLDS;
    this.body.replaceChildren(
      h('h3', null, c.current?.name ?? 'SRT'),
      this.connection(s),
      ...(s.tsSource === 'remuxed'
        ? [h('p', { class: 'srt-notice warn' }, 'Basic mode: SRT link statistics and wire-level MPEG-TS checks (continuity, PCR, PAT/PMT timing) need srt-live-transmit, so they are hidden here. Bitrate, PIDs, black frames, silence and decode errors are still monitored.')]
        : []),
      ...(s.link ? [h('h3', null, 'SRT link'), this.linkTable(s, th)] : []),
      ...(s.ts ? [h('h3', null, 'MPEG-TS'), this.tsTable(s, th), this.pidTable(s)] : []),
      ...(s.av ? [h('h3', null, 'Audio / video'), this.avTable(s, th)] : []),
    );
    this.chart.update(c.current?.id ?? 0, c.history, c.alerts);
  }

  private connection(s: SrtSnapshot) {
    const cfg = s.config;
    const kind = s.state === 'connected' ? 'ok' : s.state === 'stalled' || s.state === 'reconnecting' ? 'warn' : 'accent';
    return kvTable([
      ['State', [badge(s.state, kind), s.state === 'stalled' ? ' no data' : '']],
      ['Source', cfg ? (cfg.mode === 'multicast' ? `UDP multicast · ${cfg.host}:${cfg.port}${cfg.iface ? ` · via ${cfg.iface}` : ''}` : `${cfg.mode} · ${cfg.host}:${cfg.port} · latency ${cfg.latencyMs} ms${cfg.passphrase ? ' · encrypted' : ''}`) : '—'],
      ['Ingest', s.ingest ?? '—'],
      ['Connected for', s.connectedAt ? duration((s.now - s.connectedAt) / 1000) : '—'],
      ['Connections', String(s.connections)],
      ['Last data', s.msSinceData !== null ? ms(s.msSinceData) + ' ago' : '—'],
      ...(s.lastError ? ([['Last error', h('span', { class: 'error' }, s.lastError)]] as [string, HTMLElement][]) : []),
    ]);
  }

  private linkTable(s: SrtSnapshot, th: AlertThresholds) {
    const l = s.link!;
    const lossPct = l.packets + l.lost > 0 ? (l.lost / (l.packets + l.lost)) * 100 : 0;
    return kvTable([
      ['Round-trip time', l.rttMs === null ? '—' : level(l.rttMs > th.rttMs, ms(l.rttMs))],
      ['Receive rate', l.recvRateMbps === null ? '—' : `${num(l.recvRateMbps, 2)} Mbps`],
      ['Estimated bandwidth', l.bandwidthMbps === null ? '—' : `${num(l.bandwidthMbps, 1)} Mbps`],
      ['Receive buffer', ms(l.recvBufferMs)],
      ['Packets received', l.packets.toLocaleString()],
      ['Packets lost', `${l.lost.toLocaleString()} (${lossPct.toFixed(3)}% since connect)`],
      ['Packets dropped', level(l.dropped > 0, l.dropped.toLocaleString())],
      ['Retransmitted', l.retransmitted.toLocaleString()],
      ['Belated', l.belated.toLocaleString()],
    ]);
  }

  private tsTable(s: SrtSnapshot, th: AlertThresholds) {
    const t = s.ts!;
    const basic: [string, string][] = [
      ['Bitrate', `${t.bitrateKbps >= 1000 ? `${(t.bitrateKbps / 1000).toFixed(2)} Mbps` : `${Math.round(t.bitrateKbps)} kbps`}`],
      ['Packets', t.packets.toLocaleString()],
      ['Programs', String(t.programs)],
    ];
    // In basic mode these are ffmpeg's own output, so showing "0 errors" would be false reassurance.
    if (s.tsSource !== 'wire') return kvTable(basic);
    return kvTable([
      ...basic,
      ['Null packets', `${t.nullPercent.toFixed(1)}%`],
      ['PAT / PMT', `${ms(t.msSincePat)} / ${ms(t.msSincePmt)} ago · longest PAT gap ${ms(t.patIntervalMaxMs)}`],
      ['PCR', t.pcrPid === null ? '—' : [`PID ${hex(t.pcrPid)} · max gap `, level((t.pcrIntervalMaxMs ?? 0) > th.pcrMaxMs, ms(t.pcrIntervalMaxMs)), ` · drift ${ms(t.pcrDriftMs)}`]],
      ['Continuity errors', level(t.ccErrors > 0, String(t.ccErrors))],
      ['Sync losses', level(t.syncLosses > 0, String(t.syncLosses))],
      ['Transport errors (TEI)', level(t.teiErrors > 0, String(t.teiErrors))],
      ['PSI CRC errors', level(t.psiCrcErrors > 0, String(t.psiCrcErrors))],
      ['PCR discontinuities', String(t.pcrDiscontinuities)],
    ]);
  }

  private pidTable(s: SrtSnapshot) {
    const rows = s.ts!.pids.map((p) => [
      h('span', { class: 'mono' }, hex(p.pid)),
      p.type,
      p.kind === 'psi' ? '' : `${Math.round(p.bitrateKbps)} kbps`,
      p.lastSeenAgoSec === null ? '—' : p.lastSeenAgoSec < 1 ? 'now' : `${p.lastSeenAgoSec.toFixed(0)}s ago`,
      p.ccErrors ? badge(String(p.ccErrors), 'warn') : '0',
    ]);
    return dataTable(['PID', 'Type', 'Bitrate', 'Last seen', 'CC err.'], rows);
  }

  private avTable(s: SrtSnapshot, th: AlertThresholds) {
    const a = s.av!;
    const v = a.video;
    const au = a.audio;
    return kvTable([
      ['Video', v ? `${v.codec}${v.width ? ` · ${v.width}×${v.height}` : ''}${v.fps ? ` · ${v.fps} fps` : ''}` : 'none detected'],
      ['Audio', au ? `${au.codec}${au.sampleRate ? ` · ${au.sampleRate} Hz` : ''}${au.channels ? ` · ${au.channels}` : ''}` : 'none detected'],
      ['Black video', a.black ? level(a.blackForSec >= th.blackSec, `black for ${a.blackForSec.toFixed(0)}s`) : badge('picture present', 'ok')],
      ['Black frames seen', a.blackFrames.toLocaleString()],
      ['Audio silence', a.silent ? level(a.silentForSec >= th.silenceSec, `silent for ${a.silentForSec.toFixed(0)}s`) : badge('audio present', 'ok')],
      ['Silences seen', String(a.silenceEvents)],
      ['Decode errors', level(a.decodeErrors > 0, String(a.decodeErrors))],
    ]);
  }
}
