import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFY, DEFAULT_THRESHOLDS, SECRET_MASK, type Alert, type AvStats, type SrtSnapshot, type TsStats } from '../src/srt/types';
import { AlertEngine, EvalHistory, evaluate } from '../server/srt/alerts';
import { AvDetector, friendlyError } from '../server/srt/av-detect';
import { parseLinkStats } from '../server/srt/link-stats';
import { mergeNotify, redactNotify, sanitizeThresholds } from '../server/srt/monitor';
import { Notifier, webhookBody } from '../server/srt/notifiers';
import { AUDIO_METER_FILTERS, buildFfmpegArgs, buildViewerArgs, ffmpegSrtUrl, liveTransmitSrtUrl, validateConfig } from '../server/srt/session';

const baseTs: TsStats = {
  packets: 1000, bytes: 188000, bitrateKbps: 4000, nullPercent: 0, syncLosses: 0, ccErrors: 0, teiErrors: 0, psiCrcErrors: 0,
  pcrPid: 0x101, pcrIntervalMaxMs: 40, pcrDriftMs: 5, pcrDiscontinuities: 0, msSincePat: 100, msSincePmt: 100,
  patIntervalMaxMs: 100, programs: 1, pids: [],
};
const baseAv: AvStats = { streams: [], black: false, blackForSec: 0, blackFrames: 0, silent: false, silentForSec: 0, silenceEvents: 0, audioDb: null, decodeErrors: 0 };
const snap = (over: Partial<SrtSnapshot> = {}): SrtSnapshot => ({
  state: 'connected', config: null, ingest: 'ffmpeg', linkStatsAvailable: false, tsSource: 'wire', startedAt: 0, connectedAt: 0, connections: 1,
  msSinceData: 50, waitingForMs: null, link: null, ts: baseTs, av: baseAv, previewUrl: null, thumbAt: null, lastError: null, now: 100_000, ...over,
});
const link = (over = {}) => ({ rttMs: 20, bandwidthMbps: 50, recvRateMbps: 4, recvBufferMs: 100, packets: 0, lost: 0, dropped: 0, retransmitted: 0, belated: 0, ...over });
const rules = (s: SrtSnapshot, h = new EvalHistory(), now = s.now) => evaluate(s, DEFAULT_THRESHOLDS, h, now).map((c) => c.rule);

describe('evaluate', () => {
  it('is quiet for a healthy stream', () => {
    expect(rules(snap())).toEqual([]);
  });
  it('does nothing before the stream is connected', () => {
    expect(rules(snap({ state: 'waiting', msSinceData: 99_000 }))).toEqual([]);
  });
  it('raises no_connection when still waiting after the limit', () => {
    const waiting = (ms: number) => snap({ state: 'waiting', msSinceData: null, waitingForMs: ms, config: { mode: 'listener', host: '0.0.0.0', port: 9000, latencyMs: 120, transcodePreview: false } });
    expect(rules(waiting(10_000))).toEqual([]);
    expect(rules(waiting(31_000))).toEqual(['no_connection']);
    expect(rules(snap({ state: 'reconnecting', msSinceData: null, waitingForMs: 99_000, lastError: 'boom' }))).toEqual(['no_connection']);
  });
  it('raises no_signal', () => {
    expect(rules(snap({ state: 'stalled', msSinceData: 6000 }))).toContain('no_signal');
  });
  it('detects black video and silent audio after their thresholds', () => {
    expect(rules(snap({ av: { ...baseAv, black: true, blackForSec: 2 } }))).not.toContain('video_black');
    expect(rules(snap({ av: { ...baseAv, black: true, blackForSec: 4 } }))).toContain('video_black');
    expect(rules(snap({ av: { ...baseAv, silent: true, silentForSec: 6 } }))).toContain('audio_silence');
  });
  it('detects a missing PID, PAT timeout and PCR repetition', () => {
    const ts: TsStats = {
      ...baseTs,
      msSincePat: 1500,
      pcrIntervalMaxMs: 250,
      pids: [{ pid: 0x101, type: 'H.264 / AVC', kind: 'video', bitrateKbps: 0, lastSeenAgoSec: 9, ccErrors: 0 }],
    };
    expect(rules(snap({ ts }))).toEqual(expect.arrayContaining(['ts_pat', 'ts_pcr', 'pid_missing']));
  });
  it('raises decode_errors from the 10 s window', () => {
    const h = new EvalHistory();
    for (let i = 0; i < 6; i++) h.record(snap({ now: 100_000 + i * 1000, av: { ...baseAv, decodeErrors: i * 2 } }), 100_000 + i * 1000);
    expect(rules(snap({ now: 105_000, av: { ...baseAv, decodeErrors: 10 } }), h, 105_000)).toContain('decode_errors');
  });
  it('uses 10 s windows for counters', () => {
    const h = new EvalHistory();
    for (let i = 0; i < 12; i++) {
      const t = 100_000 + i * 1000;
      h.record(snap({ now: t, ts: { ...baseTs, ccErrors: i < 6 ? 0 : 5 }, link: link({ packets: i * 1000, lost: i < 6 ? 0 : 200 }) }), t);
    }
    const s = snap({ now: 111_000, ts: { ...baseTs, ccErrors: 5 }, link: link({ packets: 11_000, lost: 200 }) });
    const r = rules(s, h, 111_000);
    expect(r).toContain('ts_cc');
    expect(r).toContain('link_loss');
  });
  it('skips wire-level rules when ffmpeg re-multiplexes the stream', () => {
    const ts: TsStats = { ...baseTs, msSincePat: 5000, pcrIntervalMaxMs: 400, ccErrors: 50, syncLosses: 3 };
    expect(rules(snap({ ts }))).toEqual(expect.arrayContaining(['ts_pat', 'ts_pcr']));
    const remux = rules(snap({ ts, tsSource: 'remuxed' }));
    expect(remux).not.toContain('ts_pat');
    expect(remux).not.toContain('ts_pcr');
    // Still watching what ffmpeg can vouch for.
    expect(rules(snap({ tsSource: 'remuxed', av: { ...baseAv, black: true, blackForSec: 9 } }))).toContain('video_black');
  });
  it('raises SRT link rules only when link stats exist', () => {
    expect(rules(snap({ link: link({ rttMs: 400 }) }))).toContain('link_rtt');
    expect(rules(snap({ link: null }))).not.toContain('link_rtt');
  });
  it('detects a bitrate drop against the rolling baseline', () => {
    const h = new EvalHistory();
    for (let i = 0; i < 20; i++) h.record(snap({ now: i * 1000, ts: { ...baseTs, bitrateKbps: 4000 } }), i * 1000);
    for (let i = 20; i < 24; i++) h.record(snap({ now: i * 1000, ts: { ...baseTs, bitrateKbps: 300 } }), i * 1000);
    expect(rules(snap({ ts: { ...baseTs, bitrateKbps: 300 } }), h)).toContain('bitrate_drop');
  });
});

describe('AlertEngine', () => {
  const make = () => {
    const out: { alert: Alert; notify: boolean }[] = [];
    return { out, engine: new AlertEngine((alert, notify) => out.push({ alert, notify }), 3) };
  };
  const cond = (holdSec = 0) => [{ key: 'k', rule: 'r', severity: 'warning' as const, message: 'm', holdSec }];

  it('raises once and clears after the clear delay', () => {
    const { out, engine } = make();
    engine.apply(cond(), 0);
    engine.apply(cond(), 1000);
    expect(out.map((o) => o.alert.state)).toEqual(['raised']);
    engine.apply([], 2000);
    expect(out).toHaveLength(1);
    engine.apply([], 5000);
    expect(out.map((o) => o.alert.state)).toEqual(['raised', 'cleared']);
    expect(out[1].alert.id).toBe(out[0].alert.id);
    expect(engine.activeAlerts()).toHaveLength(0);
  });
  it('waits out the hold time and ignores blips shorter than it', () => {
    const { out, engine } = make();
    engine.apply(cond(3), 0);
    engine.apply([], 1000); // blip is over: hold restarts
    engine.apply(cond(3), 2000);
    engine.apply(cond(3), 4000);
    expect(out).toHaveLength(0);
    engine.apply(cond(3), 5100);
    expect(out).toHaveLength(1);
  });
  it('does not clear while the condition flickers off briefly', () => {
    const { out, engine } = make();
    engine.apply(cond(), 0);
    engine.apply([], 1000);
    engine.apply(cond(), 2000);
    engine.apply([], 3000);
    expect(out.filter((o) => o.alert.state === 'cleared')).toHaveLength(0);
  });
  it('clearAll closes alerts silently and events are one-shot', () => {
    const { out, engine } = make();
    engine.apply(cond(), 0);
    engine.clearAll(10);
    expect(out[1]).toMatchObject({ notify: false, alert: { state: 'cleared' } });
    engine.event('scte', 'info', 'x', 20);
    expect(out[2].alert.state).toBe('event');
    expect(engine.history.map((a) => a.state)).toEqual(['event', 'cleared']);
  });
});

describe('AvDetector', () => {
  const at = (t: { v: number }) => new AvDetector({ now: () => t.v });
  const black = (n: number) => `[Parsed_blackframe_0 @ 0000] frame:${n} pblack:100 pts:${n} t:${n / 25} type:I last_keyframe:0`;
  it('tracks a continuous black period and ends it after a gap', () => {
    const t = { v: 0 };
    const d = at(t);
    for (let i = 0; i < 100; i++) {
      t.v = i * 40;
      d.feed(black(i));
    }
    const s = d.stats();
    expect(s.black).toBe(true);
    expect(s.blackForSec).toBeGreaterThan(3.8);
    t.v += 2000;
    expect(d.stats().black).toBe(false);
    expect(d.stats().blackFrames).toBe(100);
  });
  it('tracks silence start and end', () => {
    const t = { v: 10_000 };
    const d = at(t);
    d.feed('[silencedetect @ 0000] silence_start: 12.3');
    t.v = 15_000;
    expect(d.stats()).toMatchObject({ silent: true, silenceEvents: 1 });
    expect(d.stats().silentForSec).toBeCloseTo(6, 1);
    d.feed('[silencedetect @ 0000] silence_end: 18 | silence_duration: 5.7');
    expect(d.stats().silent).toBe(false);
  });
  it('counts decoder complaints separately from connection errors', () => {
    const d = new AvDetector();
    d.feed('[h264 @ 0000] error while decoding MB 12 3, bytestream -5');
    d.feed('[mpegts @ 0000] Packet corrupt (stream = 0, dts = 123).');
    d.feed('[mpegts @ 0000] PES packet size mismatch');
    expect(d.decodeErrors).toBe(3);
    expect(d.lastError).toBeNull();
  });
  it('reports the audio peak per channel for the wall meters, and blanks them when the lines stop', () => {
    const t = { v: 1000 };
    const d = new AvDetector({ now: () => t.v });
    expect(d.stats().audioDb).toBeNull();
    d.feed('frame:3    pts:24000   pts_time:1.5');
    d.feed('lavfi.astats.1.Peak_level=-17.714427');
    d.feed('lavfi.astats.2.Peak_level=-inf');
    expect(d.stats().audioDb).toEqual([-17.714427, -90]);
    // These lines are not decoder complaints, black frames or silence.
    expect(d.decodeErrors).toBe(0);
    expect(d.stats().silent).toBe(false);
    t.v += 2500;
    expect(d.stats().audioDb).not.toBeNull();
    t.v += 1000;
    expect(d.stats().audioDb).toBeNull();
  });
  it('ignores meter lines for channels beyond the eighth and clamps very low levels', () => {
    const d = new AvDetector();
    d.feed('lavfi.astats.9.Peak_level=-3');
    expect(d.stats().audioDb).toBeNull();
    d.feed('lavfi.astats.1.Peak_level=-200');
    expect(d.stats().audioDb).toEqual([-90]);
  });
  it('reads the input streams and connection errors', () => {
    const d = new AvDetector();
    d.feed('Input #0, mpegts, from \'srt://0.0.0.0:9000\':');
    d.feed('  Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(tv, bt709, progressive), 1280x720 [SAR 1:1 DAR 16:9], 25 fps, 25 tbr, 90k tbn');
    d.feed('  Stream #0:1[0x101]: Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp, 130 kb/s');
    d.feed('Output #0, mpegts, to \'pipe:1\':');
    d.feed('  Stream #0:0: Video: h264, 640x360');
    const s = d.stats();
    expect(s.video).toMatchObject({ codec: 'h264', width: 1280, height: 720, fps: 25 });
    expect(s.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 'stereo' });
    expect(s.streams).toHaveLength(2);
    d.feed('[srt @ 0000] Connection setup failure: wrong passphrase');
    expect(d.lastError).toContain('wrong passphrase');
  });
});

describe('friendlyError', () => {
  it('explains a passphrase rejection and strips the libsrt prefix', () => {
    const msg = friendlyError('14:15:06.898000/!W:SRT.cn: @367414086:newConnection: connection rejected due to: INTERNAL REJECTION - ERROR:UNSECURE');
    expect(msg).toMatch(/^Passphrase mismatch/);
    expect(msg).toContain('connection rejected due to');
    expect(msg).not.toContain('14:15:06');
  });
  it('explains a busy port and leaves unknown errors as they are', () => {
    expect(friendlyError('[srt @ 000] bind failed: Address already in use')).toMatch(/already in use/);
    expect(friendlyError('[x @ 0] something odd')).toBe('something odd');
  });
});

describe('parseLinkStats', () => {
  it('reads srt-live-transmit JSON', () => {
    const l = parseLinkStats('{"sid":1,"link":{"rtt":12.5,"bandwidth":80},"recv":{"packets":100,"packetsLost":2,"packetsDropped":1,"packetsRetransmitted":3,"packetsBelated":0,"mbitRate":4.2,"msBuf":110}}');
    expect(l).toEqual({ rttMs: 12.5, bandwidthMbps: 80, recvRateMbps: 4.2, recvBufferMs: 110, packets: 100, lost: 2, dropped: 1, retransmitted: 3, belated: 0 });
  });
  it('ignores other output', () => {
    expect(parseLinkStats('Accepted SRT target connection')).toBeNull();
    expect(parseLinkStats('{not json')).toBeNull();
    expect(parseLinkStats('{"foo":1}')).toBeNull();
  });
});

describe('notifications', () => {
  const alert: Alert = { id: 1, rule: 'video_black', key: 'video_black', severity: 'critical', state: 'raised', message: 'Loss 3%', at: 0 };
  it('formats Slack, Teams and generic payloads', () => {
    expect(webhookBody('slack', alert)).toMatchObject({ text: expect.stringContaining('Loss 3%') });
    const teams = webhookBody('teams', alert) as { type: string; attachments: { contentType: string }[] };
    expect(teams.type).toBe('message');
    expect(teams.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(webhookBody('generic', alert)).toMatchObject({ source: 'playprobe-srt', rule: 'video_black', severity: 'critical' });
  });
  it('filters by severity, applies the cooldown and sends recovery only for notified alerts', async () => {
    const sent: unknown[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: RequestInit) => (sent.push(JSON.parse(String(init.body))), new Response('ok'))) as typeof fetch;
    try {
      const settings = { ...DEFAULT_NOTIFY, webhook: { enabled: true, kind: 'generic' as const, url: 'https://example.test/hook' } };
      let now = 0;
      const n = new Notifier(() => settings, undefined, () => now);
      await n.notify({ ...alert, severity: 'info', key: 'i' }); // below min severity
      await n.notify({ ...alert, rule: 'link_loss', key: 'link_loss' }); // not a main fault: log only
      expect(sent).toHaveLength(0);
      await n.notify(alert);
      expect(sent).toHaveLength(1);
      now = 10_000;
      await n.notify({ ...alert, id: 2 }); // inside the cooldown
      expect(sent).toHaveLength(1);
      await n.notify({ ...alert, state: 'cleared', clearedAt: 12_000 });
      expect(sent).toHaveLength(2);
      await n.notify({ ...alert, key: 'never-raised', state: 'cleared' });
      expect(sent).toHaveLength(2);
    } finally {
      globalThis.fetch = orig;
    }
  });
  it('keeps stored secrets when the browser sends the mask back', () => {
    const stored = { ...DEFAULT_NOTIFY, webhook: { ...DEFAULT_NOTIFY.webhook, url: 'https://hooks.example/secret' }, email: { ...DEFAULT_NOTIFY.email, pass: 'pw' } };
    const red = redactNotify(stored);
    expect(red.webhook.url).toBe(SECRET_MASK);
    expect(red.email.pass).toBe(SECRET_MASK);
    const merged = mergeNotify({ ...red, minSeverity: 'critical' }, stored);
    expect(merged.webhook.url).toBe('https://hooks.example/secret');
    expect(merged.email.pass).toBe('pw');
    expect(merged.minSeverity).toBe('critical');
    expect(mergeNotify({ webhook: { url: 'https://new.example' } }, stored).webhook.url).toBe('https://new.example');
  });
  it('clamps thresholds', () => {
    expect(sanitizeThresholds({ rttMs: -5, lossPct: 'x', blackSec: 99999 })).toMatchObject({ rttMs: 1, lossPct: DEFAULT_THRESHOLDS.lossPct, blackSec: 600 });
  });
});

describe('session config', () => {
  it('validates and normalises input', () => {
    expect(validateConfig({ mode: 'listener', port: '9000' })).toMatchObject({ mode: 'listener', host: '0.0.0.0', port: 9000, latencyMs: 120 });
    expect(() => validateConfig({ mode: 'caller', port: 9000 })).toThrow(/remote host/);
    expect(() => validateConfig({ mode: 'listener', port: 70000 })).toThrow(/port/);
    expect(() => validateConfig({ mode: 'listener', port: 1, host: 'a b; rm' })).toThrow();
    expect(() => validateConfig({ mode: 'listener', port: 1, passphrase: 'short' })).toThrow(/10-79/);
    expect(() => validateConfig({ mode: 'x', port: 1 })).toThrow(/mode/);
  });
  it('adds the wall thumbnail as a second output of the same ffmpeg, and the audio meter filters', () => {
    const c = validateConfig({ mode: 'listener', port: 9000 });
    const light = buildFfmpegArgs(c, { viaLiveTransmit: true, thumbPath: '/t/5.jpg' });
    expect(light.at(-1)).toBe('/t/5.jpg');
    expect(light).toContain('image2');
    expect(light).toContain('-update');
    // One picture a second in both modes, made with the `fps` filter: `-fps_mode` does not exist before ffmpeg 5.1.
    expect(light.join(' ')).toContain('fps=1,scale=320:-2');
    expect(light).not.toContain('-fps_mode:v');
    // Without `-y` ffmpeg exits when an old picture is still there, and the channel would restart in a loop.
    expect(light).toContain('-y');
    const full = buildFfmpegArgs({ ...c, lightAnalysis: false }, { viaLiveTransmit: true, thumbPath: '/t/5.jpg' });
    expect(full.join(' ')).toContain('fps=1,scale=320:-2');
    expect(full).not.toContain('-skip_frame');
    expect(light).toContain('-skip_frame');
    // The meter lines go to ffmpeg's own stderr unbuffered, with the colon escaped for the filter parser.
    expect(AUDIO_METER_FILTERS).toContain("file='pipe\\:2'");
    expect(AUDIO_METER_FILTERS).toContain('direct=1');
    expect(light.join(' ')).toContain(AUDIO_METER_FILTERS);
  });
  it('builds URLs with the right latency unit and escaping', () => {
    const c = validateConfig({ mode: 'caller', host: 'example.com', port: 4000, latencyMs: 200, passphrase: 'pass phrase&1', streamId: 'a/b c' });
    expect(ffmpegSrtUrl(c)).toBe('srt://example.com:4000?mode=caller&latency=200000&passphrase=pass%20phrase%261&pbkeylen=16&streamid=a%2Fb%20c');
    expect(liveTransmitSrtUrl(c)).toContain('latency=200&');
  });
  it('builds ffmpeg arguments for both ingest paths', () => {
    const c = validateConfig({ mode: 'listener', port: 9000 });
    const direct = buildFfmpegArgs(c, { viaLiveTransmit: false });
    expect(direct).toContain('pipe:1');
    expect(direct.join(' ')).toContain('blackframe');
    expect(direct.join(' ')).toContain('silencedetect');
    // The browser preview is made by a separate on-demand encoder, not by the monitoring ffmpeg.
    expect(direct).not.toContain('hls');
    const viaLive = buildFfmpegArgs(c, { viaLiveTransmit: true });
    expect(viaLive).toContain('pipe:0');
    expect(viaLive).not.toContain('pipe:1');
    // Without a thumbnail path there is no picture output.
    expect(direct).not.toContain('image2');
    const viewer = buildViewerArgs('/p');
    expect(viewer).toContain('libx264');
    expect(viewer).toContain('aac');
    expect(viewer).toContain('pipe:0');
    expect(viewer.join(' ')).toContain('yadif');
  });
});
