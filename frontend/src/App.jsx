import { useCallback, useEffect, useRef, useState } from 'react';
import { startEngine } from './app/engine';
import DetailColumn from './components/DetailColumn';
import SettingsPanel from './components/SettingsPanel';
import Sidebar from './components/Sidebar';
import Splitter from './components/Splitter';
import TilesColumn from './components/TilesColumn';
import Topbar from './components/Topbar';
import { loadHistory, loadSettings, saveSettings } from './settings';

const NO_SRT = { available: false, srt: { running: 0, total: 0, alerts: 0 }, udp: { running: 0, total: 0, alerts: 0 } };

/**
 * The Pulse screen. React owns the layout and everything the user sets or sees as text and buttons (menu, URL,
 * settings, toast, button labels, which columns are open). The media and monitoring engines (player, audio,
 * SRT client, stats tabs, wall) run in app/engine.js and report back through `ui`.
 */
export default function App() {
  const layoutRef = useRef(null);
  const engine = useRef(null);

  const [url, setUrlState] = useState('');
  const [history, setHistory] = useState(loadHistory);
  const [settings, setSettings] = useState(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [proxyStatus, setProxyStatus] = useState({ ok: false, text: '' });
  const [sideOpen, setSideOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [tilesEmpty, setTilesEmpty] = useState(false);
  const [srtInfo, setSrtInfo] = useState(NO_SRT);
  const [view, setView] = useState({ open: false, view: 'all' });
  const [drm, setDrm] = useState({ label: 'DRM', on: false, open: false });
  const [toast, setToast] = useState('');
  const [presetList, setPresetList] = useState([]);

  // The engine reads the latest URL and settings synchronously, so they live in refs as well as state.
  const urlRef = useRef('');
  const settingsRef = useRef(settings);
  const toastTimer = useRef(0);

  const setUrl = useCallback((u) => {
    urlRef.current = u;
    setUrlState(u);
  }, []);

  const changeSettings = useCallback((next) => {
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
  }, []);

  const showToast = useCallback((text, ms = 2500) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), ms);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ui = {
      getUrl: () => urlRef.current,
      setUrl,
      getSettings: () => settingsRef.current,
      toast: showToast,
      setHistory,
      setDetailOpen,
      setTilesEmpty,
      setSrtInfo,
      setView,
      setDrm,
      setProxyStatus,
    };
    startEngine(ui).then((actions) => {
      if (cancelled || !actions) return;
      engine.current = actions;
      setPresetList(actions.presetGroups);
    });
    return () => {
      cancelled = true;
    };
  }, [setUrl, showToast]);

  // Canvas views (the chart) size themselves from the window: tell them when a column opens or closes.
  useEffect(() => {
    window.dispatchEvent(new Event('resize'));
  }, [detailOpen]);

  const redraw = useCallback(() => engine.current?.redraw(), []);

  return (
    <>
      <Topbar
        url={url}
        onUrl={setUrl}
        history={history}
        onLoad={(u) => engine.current?.load(u)}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((o) => !o)}
        onThemeChange={redraw}
      />
      <SettingsPanel open={settingsOpen} settings={settings} onChange={changeSettings} proxyStatus={proxyStatus} />
      <section id="drm-panel" className="settings drm-panel" hidden aria-label="DRM settings" />

      <main className="layout" ref={layoutRef}>
        <Sidebar
          open={sideOpen}
          onToggle={() => setSideOpen((o) => !o)}
          presetList={presetList}
          onPreset={(u) => engine.current?.selectPreset(u)}
          srtInfo={srtInfo}
          view={view}
          drm={drm}
          onView={(v) => engine.current?.openView(v)}
          onToggleDrm={() => engine.current?.toggleDrm()}
        />
        <TilesColumn tilesEmpty={tilesEmpty} />
        <Splitter layoutRef={layoutRef} />
        <DetailColumn
          open={detailOpen}
          wallAvailable={srtInfo.available}
          onClose={() => engine.current?.closeDetail()}
          onWall={() => engine.current?.showWall()}
          onShare={() => engine.current?.share()}
          onExport={() => engine.current?.exportJson()}
        />
      </main>

      <div id="toast" className="toast" role="status" hidden={!toast}>
        {toast}
      </div>
    </>
  );
}
