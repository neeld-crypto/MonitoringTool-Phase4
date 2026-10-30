import { AudioTab } from './audio';
import { AlertsTab } from './alerts';
import { SrtTab } from './srt';
import { h } from '../dom';
import { DeviceTab } from './device';
import { DrmTab } from './drm';
import { LogTab } from './log';
import { ManifestTab } from './manifest';
import { NetworkTab } from './network';
import { OverviewTab } from './overview';
import { ScteTab } from './scte';
import { TracksTab } from './tracks';
const TAB_KEY = 'sap.tab.v1';
/** Tabbed "stats for nerds" side panel. Only the visible tab re-renders. */
export class StatsPanel {
  body;
  tabs;
  active;
  buttons = new Map();
  scteTab;
  pending = false;
  constructor(ctrl, nav, body, audio, openDrmSettings, srt) {
    this.body = body;
    this.scteTab = new ScteTab(ctrl);
    this.tabs = [
      { id: 'overview', label: 'Overview', view: new OverviewTab(ctrl), events: ['tick', 'loaded', 'tracks'] },
      { id: 'tracks', label: 'Tracks', view: new TracksTab(ctrl), events: ['tracks', 'loaded'] },
      { id: 'audio', label: 'Audio', view: new AudioTab(ctrl, audio), events: ['audio', 'tracks', 'loaded', 'documents'] },
      {
        id: 'drm',
        label: 'DRM',
        view: new DrmTab(ctrl, openDrmSettings),
        events: ['drm', 'loaded', 'tracks'],
        count: () => ctrl.drm.exchanges.filter((x) => x.error).length,
      },
      { id: 'scte', label: 'SCTE-35', view: this.scteTab, events: ['scte', 'tick', 'loaded'], count: () => ctrl.scte.size },
      {
        id: 'network',
        label: 'Network',
        view: new NetworkTab(ctrl),
        events: ['network'],
        count: () => ctrl.network.filter((e) => e.error).length,
      },
      { id: 'manifest', label: 'Manifest', view: new ManifestTab(ctrl), events: ['documents'] },
      { id: 'device', label: 'Device', view: new DeviceTab(), events: [] },
      { id: 'log', label: 'Log', view: new LogTab(ctrl), events: ['log'] },
    ];
    // SRT monitoring tabs follow SCTE-35: they are what the SRT panel in the header feeds.
    this.tabs.splice(
      this.tabs.findIndex((t) => t.id === 'scte') + 1,
      0,
      { id: 'srt', label: 'SRT / UDP', view: new SrtTab(srt), events: ['snapshot', 'status'], source: 'srt' },
      {
        id: 'alerts',
        label: 'Alerts',
        view: new AlertsTab(srt),
        events: ['alert', 'status', 'settings'],
        source: 'srt',
        count: () => srt.totalActive,
      },
    );
    let saved = null;
    try {
      saved = localStorage.getItem(TAB_KEY);
    } catch {
      /* storage unavailable */
    }
    this.active = this.tabs.find((t) => t.id === saved) ?? this.tabs[0];
    for (const tab of this.tabs) {
      const btn = h('button', { type: 'button', role: 'tab', class: 'tab', onclick: () => this.show(tab.id) }, tab.label);
      this.buttons.set(tab.id, btn);
      nav.append(btn);
    }
    const playerEvents = new Set(this.tabs.filter((t) => !t.source).flatMap((t) => t.events));
    for (const name of playerEvents) {
      ctrl.on(name, () => {
        if (!this.active.source && this.active.events.includes(name)) this.schedule();
        this.renderCounts();
      });
    }
    const srtEvents = new Set(this.tabs.filter((t) => t.source === 'srt').flatMap((t) => t.events));
    for (const name of srtEvents) {
      srt.on(name, () => {
        if (this.active.source === 'srt' && this.active.events.includes(name)) this.schedule();
        this.renderCounts();
      });
    }
    this.show(this.active.id);
  }
  show(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.active = tab;
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      /* storage unavailable */
    }
    for (const [tid, btn] of this.buttons) {
      btn.setAttribute('aria-selected', String(tid === id));
    }
    this.body.replaceChildren(tab.view.el);
    tab.view.render();
    this.renderCounts();
  }
  showScteEvent(e) {
    this.show('scte');
    this.scteTab.select(e);
  }
  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.active.view.render();
    });
  }
  renderCounts() {
    for (const tab of this.tabs) {
      if (!tab.count) continue;
      const n = tab.count();
      const btn = this.buttons.get(tab.id);
      btn.replaceChildren(
        tab.label,
        n ? h('span', { class: `count ${tab.id === 'network' || tab.id === 'drm' || tab.id === 'alerts' ? 'warn' : ''}` }, String(n)) : '',
      );
    }
  }
}
