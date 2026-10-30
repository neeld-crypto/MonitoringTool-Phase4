import { AudioEngine } from '../audio/engine';
import { drmHint } from '../drm/errors';
import { isDrmConfigured, normaliseDrm } from '../drm/settings';
import { PlayerController, describeShakaError } from '../player/controller';
import { presets } from '../presets';
import { parseHeaders, pushHistory } from '../settings';
import { SrtClient } from '../srt/client';
import { deliver, loadPrefs } from '../srt/notify';
import { AudioOverlay } from '../ui/audio/overlay';
import { Controls } from '../ui/controls';
import { $, clear, h } from '../ui/dom';
import { DrmPanel } from '../ui/drm/panel';
import { formatBitrate, formatTime } from '../ui/format';
import { snapshot } from '../ui/stats/overview';
import { StatsPanel } from '../ui/stats/panel';
import { SrtPanel } from '../ui/srt/panel';

const DRM_LABEL = { auto: 'DRM auto', widevine: 'Widevine', fairplay: 'FairPlay', off: 'DRM' };

/**
 * The media and monitoring engines behind the React screens: Shaka player, audio analysis, SRT / UDP / HLS client,
 * stats tabs, controls, DRM and monitoring panels. These draw into canvases and update many times a second, so they
 * keep their own DOM inside the containers React renders (ids such as #video, #tab-body, #srt-panel).
 *
 * `ui` is the bridge to React: it reads the URL box and settings and reports back what the screens must show
 * (toast, detail column, button labels, history, proxy status). Returns the actions React calls, or null when the
 * browser cannot play streams.
 */
export async function startEngine(ui) {
  const video = $('#video');
  const playerEl = $('#player');
  const message = $('#player-message');
  const spinner = $('#spinner');
  const adBanner = $('#ad-banner');
  const nerdOverlay = $('#nerd-overlay');
  const summary = $('#stream-summary');

  /** The preview and analysis column stays hidden until a tile, a test stream or a URL is chosen. */
  const showDetail = () => ui.setDetailOpen(true);

  function showMessage(title, body = '', isError = false) {
    if (!title) {
      message.hidden = true;
      return;
    }
    message.hidden = false;
    message.classList.toggle('error', isError);
    clear(message, h('div', null, h('strong', null, title), body ? h('p', null, body) : ''));
  }

  // ---------------------------------------------------------------------- DRM

  const drmPanel = new DrmPanel($('#drm-panel'), {
    getUrl: () => ui.getUrl().trim(),
    setUrl: (u) => ui.setUrl(u),
    toast: (m) => ui.toast(m),
  });
  function reportDrm() {
    const s = drmPanel.settings;
    const on = isDrmConfigured(s);
    ui.setDrm({ label: on ? DRM_LABEL[s.mode] : 'DRM', on, open: !$('#drm-panel').hidden });
  }
  function toggleDrmPanel(open) {
    drmPanel.toggle(open);
    reportDrm();
  }
  drmPanel.onChange(reportDrm);
  reportDrm();

  // ---------------------------------------------------------------------- SRT

  const srt = new SrtClient();
  let srtPanel;
  const srtPanelHost = $('#srt-panel');
  let srtPreviewShown = false;

  function syncViewButtons() {
    ui.setView({ open: srtPanel.isOpen, view: srtPanel.view });
  }
  /** SRT opens the all-channels wall, UDP the same wall showing only UDP channels; the open one closes when pressed again. */
  function openView(view) {
    if (srtPanel.isOpen && srtPanel.view === view) srtPanel.toggle(false);
    else srtPanel.showView(view);
    syncViewButtons();
  }
  function showWall() {
    srtPanel.showView(srtPanel.view);
    syncViewButtons();
    $('#srt-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function reportSrt() {
    const running = srt.channels.filter((c) => srt.isRunning(c)).length;
    const udp = srt.channels.filter((c) => c.kind === 'udp');
    ui.setSrtInfo({
      available: srt.available,
      srt: { running, total: srt.channels.length, alerts: srt.totalActive },
      udp: { running: udp.filter((c) => srt.isRunning(c)).length, total: udp.length, alerts: udp.reduce((n, c) => n + srt.activeCount(c), 0) },
    });
  }
  // Every channel reports every second: with dozens of channels the header buttons are refreshed at most twice a second.
  let srtButtonTimer = null;
  function scheduleSrtButton() {
    if (srtButtonTimer) return;
    srtButtonTimer = setTimeout(() => {
      srtButtonTimer = null;
      reportSrt();
    }, 500);
  }
  for (const name of ['status', 'channels', 'alert']) srt.on(name, scheduleSrtButton);

  // -------------------------------------------------------------------- player

  if (!PlayerController.isBrowserSupported()) {
    showMessage('Browser not supported', 'This browser lacks Media Source Extensions, which are required for DASH/HLS playback.', true);
    return null;
  }

  const ctrl = new PlayerController(video, playerEl);
  const overlay = {
    visible: false,
    toggle() {
      this.visible = !this.visible;
      nerdOverlay.hidden = !this.visible;
      renderOverlay();
      return this.visible;
    },
  };
  const audio = new AudioEngine(video);
  ctrl.onAudioSegment = (kind, id, data, start) => (kind === 'init' ? audio.stream.init(id, data) : audio.stream.segment(id, data, start));
  // Forward audio updates as controller events so the stats panel can subscribe.
  audio.on('levels', () => ctrl.dispatchEvent(new CustomEvent('audio')));
  audio.on('state', () => ctrl.dispatchEvent(new CustomEvent('audio')));
  new AudioOverlay($('#audio-overlay'), audio, ctrl);
  // Integrated loudness is "since load / since the audio track changed".
  let audioTrackKey = '';
  const resetAudioOnTrackChange = () => {
    const t = ctrl.loadedUrl ? ctrl.player.getAudioTracks().find((x) => x.active) : undefined;
    audio.activeStreamId = ctrl.loadedUrl ? (ctrl.player.getVariantTracks().find((v) => v.active)?.audioId ?? null) : null;
    const key = `${ctrl.loadedUrl}|${t?.language}|${t?.label}|${t?.channelsCount}|${t?.codecs}`;
    if (key !== audioTrackKey) {
      audioTrackKey = key;
      audio.reset();
    }
  };
  // A new load starts a new measurement session.
  ctrl.on('reset', () => audio.clearStream());
  ctrl.on('loaded', resetAudioOnTrackChange);
  ctrl.on('tracks', resetAudioOnTrackChange);
  const panel = new StatsPanel(ctrl, $('#tabs'), $('#tab-body'), audio, () => toggleDrmPanel(true), srt);
  new Controls(ctrl, $('#controls'), playerEl, overlay, (e) => panel.showScteEvent(e), audio);

  function renderOverlay() {
    if (!overlay.visible) return;
    const s = snapshot(ctrl);
    const rows = [
      ['Format', `${s.format} ${s.live ? 'live' : 'VOD'}${s.proxied ? ' (proxy)' : ''}`],
      ['Viewport / frames', `${playerEl.clientWidth}×${playerEl.clientHeight} / ${s.droppedFrames} dropped of ${s.decodedFrames}`],
      ['Current / optimal res', `${s.resolution} / ${s.variant}`],
      ['Codecs', s.codecs],
      ['Connection speed', formatBitrate(s.estimatedBandwidth)],
      ['Buffer health', `${s.bufferAhead.toFixed(2)} s`],
      ...(s.live ? [['Live latency', s.liveLatency !== null ? `${s.liveLatency.toFixed(2)} s` : '—']] : []),
      ['SCTE-35 markers', String(ctrl.scte.size)],
    ];
    clear(
      nerdOverlay,
      h('button', { type: 'button', class: 'close', 'aria-label': 'Close stats overlay', onclick: () => overlay.toggle() }, '×'),
      h('table', null, rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v)))),
    );
  }

  function renderAdBanner() {
    const br = ctrl.loadedUrl ? ctrl.scte.activeBreak(video.currentTime) : null;
    adBanner.hidden = !br;
    playerEl.classList.toggle('in-break', Boolean(br));
    if (br) {
      adBanner.textContent = br.remaining !== undefined ? `AD BREAK · ${Math.ceil(br.remaining)}s remaining` : `AD BREAK · since ${formatTime(br.start)}`;
      adBanner.title = br.event.summary;
    }
  }

  function renderSummary() {
    if (!ctrl.loadedUrl) {
      summary.replaceChildren();
      return;
    }
    const s = snapshot(ctrl);
    summary.replaceChildren(
      h('span', { class: 'badge accent' }, s.format),
      h('span', { class: `badge ${s.live ? 'live' : ''}` }, s.live ? 'LIVE' : 'VOD'),
      s.proxied ? h('span', { class: 'badge' }, 'via proxy') : '',
      h('span', null, `${s.variants} variants · ${s.audioTracks} audio · ${s.textTracks} subtitles`),
      h('span', { class: 'mono' }, s.codecs),
      h('span', null, `SCTE-35 markers: ${ctrl.scte.size}`),
    );
  }

  // DRM-protected frames can't be read back by the page (even Widevine L3),
  // and hardware-secure ones (L1/L2) go through a protected overlay plane.
  // Rounded clipping and backdrop blur over the video need those pixels, and
  // Chrome then shows a blank (white) picture, so drop those effects while any
  // DRM is in use.
  function updateProtectedVideo() {
    playerEl.classList.toggle('drm-protected', ctrl.activeDrm() !== null);
  }
  ctrl.on('drm', updateProtectedVideo);
  ctrl.on('loaded', updateProtectedVideo);

  ctrl.on('tick', () => {
    renderOverlay();
    renderSummary();
  });
  ctrl.on('scte', renderSummary);
  ctrl.on('tracks', renderSummary);
  video.addEventListener('timeupdate', renderAdBanner);
  ctrl.on('scte', renderAdBanner);
  ctrl.on('buffering', (b) => (spinner.hidden = !b));
  ctrl.on('error', (err) => {
    // Severity 2 = CRITICAL: playback stopped.
    if (err?.severity === 2) {
      showMessage('Playback error', `${describeShakaError(err)}. ${hintFor(err, ctrl.loadedUrl ?? '')}`, true);
    }
  });

  // ---------------------------------------------------------------------- load

  function hintFor(err, url) {
    const code = err?.code;
    const hints = [];
    if (location.protocol === 'https:' && url.startsWith('http:')) {
      hints.push('This page is served over HTTPS, so the browser blocks http:// streams (mixed content). Run the app locally with `npm start`.');
    }
    if (code === 1002 || code === 1001) {
      hints.push(
        ctrl.proxyAvailable
          ? 'The request failed. If the server does not send CORS headers, set CORS proxy to "Always" in the settings (⚙).'
          : 'The request failed, most often because the server does not send CORS headers. Run the app with `npm start` to use the built-in CORS proxy.',
      );
    }
    if (code === 4032 || code === 4040) hints.push('The stream uses codecs this browser cannot decode — see the Device tab.');
    const drm = drmHint(err);
    if (drm) hints.push(drm);
    if (drm || (code && code >= 6000 && code < 7000)) hints.push('Details are in the DRM tab.');
    return hints.join(' ');
  }

  let loading = false;
  /** `transient` loads (the SRT preview) are not remembered in the URL or the history list. */
  async function load(url, opts = {}) {
    url = url.trim();
    if (!url || loading) return;
    showDetail();
    // Browsers (and Shaka) cannot open srt:// or udp:// addresses: hand them to the SRT monitor instead.
    if (/^(srt|udp):\/\//i.test(url)) {
      const done = await srtPanel.prefillFromUrl(url);
      showMessage(
        'This is an SRT / UDP address',
        `${done ?? 'Not a valid address.'} Browsers cannot play srt:// or udp:// directly, so Pulse receives it on this computer and plays a preview here.`,
        false,
      );
      return;
    }
    loading = true;
    const settings = ui.getSettings();
    showMessage(null);
    spinner.hidden = false;
    if (!opts.transient) {
      const params = new URLSearchParams(location.search);
      params.set('url', url);
      history.replaceState(null, '', `${location.pathname}?${params}`);
    }
    try {
      await ctrl.load({
        url,
        proxyMode: opts.transient ? 'off' : settings.proxyMode,
        headers: opts.transient ? {} : parseHeaders(settings.headers),
        lowLatency: opts.transient ? false : settings.lowLatency,
        drm: opts.transient ? undefined : structuredClone(drmPanel.settings),
      });
      if (opts.transient) {
        // ctrl.load starts a fresh SCTE list: put back the markers the server already found.
        for (const m of [...srt.scte].reverse()) ctrl.scte.addSrtSection(m.raw, m.receivedAt, m.pid);
      } else {
        ui.setHistory(pushHistory(url));
      }
      playerEl.classList.add('has-media');
      if (settings.autoplay || opts.transient) {
        try {
          await video.play();
        } catch {
          // Autoplay with sound is blocked until the user interacts: retry muted.
          audio.setMuted(true);
          await video.play().catch(() => undefined);
          ui.toast('Autoplay with sound was blocked — playing muted');
        }
      }
    } catch (err) {
      playerEl.classList.remove('has-media');
      showMessage('Could not load the stream', `${describeShakaError(err)}. ${hintFor(err, url)}`, true);
    } finally {
      spinner.hidden = true;
      loading = false;
    }
  }

  // SRT monitoring panel and tiles. A tile click opens the preview and analysis column.
  srtPanel = new SrtPanel(srtPanelHost, srt, {
    toast: (m) => ui.toast(m, 4000),
    onSelect: (id) => {
      showDetail();
      const ch = srt.channels.find((c) => c.id === id);
      // An HLS channel is played by the player itself, from its own address, so every normal HLS tab works on it.
      if (ch?.kind === 'hls' && ch.config?.url) {
        ui.setUrl(ch.config.url);
        srtPreviewShown = true; // so choosing an SRT tile that has no picture yet clears this stream
        void load(ch.config.url);
        return;
      }
      panel.show('srt');
    },
    // A tile click: the wall can be taller than the screen, so bring the player and the analysis tabs into view.
    reveal: () => $('#detail-col').scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
  });

  // SRT: play the server's HLS preview of the incoming feed, route alerts to the user, and
  // show server-detected SCTE-35 in the existing SCTE-35 tab.
  srt.on('preview', (url) => {
    const href = new URL(String(url), location.origin).href;
    showDetail();
    ui.setUrl('');
    srtPreviewShown = true;
    ui.toast(`${srt.current?.name ?? 'SRT'}: preview ready, loading it into the player`, 3000);
    void load(href, { transient: true });
  });
  // Switching to a tile that has no video yet must not leave another channel's picture on screen.
  srt.on('select', () => {
    if (!srtPreviewShown || srt.snapshot?.previewUrl || srt.current?.kind === 'hls') return;
    srtPreviewShown = false;
    void ctrl.unload();
    playerEl.classList.remove('has-media');
    ui.toast(`${srt.current?.name ?? 'This channel'}: preparing the preview…`, 3000);
  });
  // Alerts are not shown as pop-ups: they live in the Alerts tab, on the tiles and on the chart. Sound / desktop notifications still follow their settings.
  srt.on('alert', (a) => deliver(a, loadPrefs(), () => undefined));
  srt.on('scte', (m) => {
    // An HLS channel's ad tags are read from the playlist by the player itself; only transport-stream sections are added here.
    if (m.source === 'hls') return;
    ctrl.scte.addSrtSection(m.raw, m.receivedAt, m.pid);
  });

  // ------------------------------------------------------------ actions for React

  const presetList = presets();
  const presetByUrl = new Map(presetList.map((p) => [p.url, p]));

  const actions = {
    load,
    openView,
    showWall,
    toggleDrm: () => toggleDrmPanel(),
    presetGroups: presetList,
    selectPreset(url) {
      if (!url) return;
      ui.setUrl(url);
      const preset = presetByUrl.get(url);
      if (preset?.drm) {
        // DRM test streams fill in their license server.
        const base = normaliseDrm(drmPanel.settings);
        drmPanel.setSettings({ ...base, ...preset.drm, widevine: { ...base.widevine, ...preset.drm.widevine } });
        ui.toast('DRM settings filled in for this test stream');
      }
      void load(url);
    },
    closeDetail() {
      video.pause();
      ui.setDetailOpen(false);
    },
    /** Redraw canvas-based views (the chart) in new colours. */
    redraw: () => ctrl.dispatchEvent(new CustomEvent('tick')),
    async share() {
      const url = ctrl.loadedUrl ?? ui.getUrl();
      if (!url) return ui.toast('Load a stream first');
      const link = `${location.origin}${location.pathname}?url=${encodeURIComponent(url)}`;
      try {
        await navigator.clipboard.writeText(link);
        ui.toast('Link copied');
      } catch {
        prompt('Copy this link', link);
      }
    },
    exportJson() {
      const p = ctrl.player;
      const loaded = Boolean(ctrl.loadedUrl);
      const data = {
        exportedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        snapshot: snapshot(ctrl),
        shakaStats: p.getStats(),
        variants: loaded ? p.getVariantTracks() : [],
        audioTracks: loaded ? p.getAudioTracks() : [],
        textTracks: loaded ? p.getTextTracks() : [],
        scte35: ctrl.scte.list().map(({ hls: _hls, ...e }) => e),
        // DRM: what was used and what happened, but never settings, headers or bodies.
        drm: {
          active: ctrl.activeDrm(),
          declared: [...ctrl.drm.declared.values()],
          keyStatuses: ctrl.drm.keyStatuses,
          exchanges: ctrl.drm.exchanges.map(({ requestPreview: _q, responsePreview: _r, ...x }) => x),
        },
        audio: { state: audio.state, decodedChannels: audio.channels, sampleRate: audio.sampleRate, reading: audio.lastReading },
        network: ctrl.network,
        log: ctrl.log,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `pulse-stats-${Date.now()}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  };

  // ---------------------------------------------------------------------- boot

  await ctrl.init();
  await srt.init();
  reportSrt();
  // The monitoring tiles are the home screen when the local server can run SRT / UDP / HLS channels.
  if (srt.available) {
    srtPanel.showView(srtPanel.view);
    syncViewButtons();
  } else {
    ui.setTilesEmpty(true);
  }
  ui.setProxyStatus(
    ctrl.proxyAvailable
      ? { ok: true, text: `${ctrl.proxyDescription()[0].toUpperCase()}${ctrl.proxyDescription().slice(1)}.` }
      : { ok: false, text: 'No CORS proxy on this server: streams must send CORS headers.' },
  );
  drmPanel.proxyAvailable = ctrl.proxyAvailable;

  const initial = new URLSearchParams(location.search).get('url');
  if (initial) {
    ui.setUrl(initial);
    void load(initial);
  }

  // Exposed for debugging from the console.
  Object.assign(window, { abrPlayer: ctrl, abrAudio: audio, abrSrt: srt });
  return actions;
}
