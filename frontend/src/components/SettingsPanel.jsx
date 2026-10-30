/** Load settings: CORS proxy mode, custom request headers, low-latency and autoplay. Saved as they change. */
export default function SettingsPanel({ open, settings, onChange, proxyStatus }) {
  const set = (patch) => onChange({ ...settings, ...patch });
  return (
    <section id="settings" className="settings" hidden={!open}>
      <div className="field">
        <label htmlFor="proxy-mode">CORS proxy</label>
        <select id="proxy-mode" value={settings.proxyMode} onChange={(e) => set({ proxyMode: e.target.value })}>
          <option value="auto">Auto — retry through the local proxy on network/CORS errors</option>
          <option value="always">Always — send every request through the local proxy</option>
          <option value="off">Off — fetch directly from the browser</option>
        </select>
        <small id="proxy-status" className={proxyStatus.ok ? 'ok' : proxyStatus.text ? 'warn' : ''}>
          {proxyStatus.text}
        </small>
      </div>
      <div className="field">
        <label htmlFor="headers">
          Custom request headers <small>(one per line, <code>Name: value</code>)</small>
        </label>
        <textarea
          id="headers"
          rows="3"
          placeholder={'Authorization: Bearer …\nX-Custom: value'}
          value={settings.headers}
          onChange={(e) => set({ headers: e.target.value })}
        />
      </div>
      <div className="field checks">
        <label>
          <input type="checkbox" id="low-latency" checked={settings.lowLatency} onChange={(e) => set({ lowLatency: e.target.checked })} /> Low-latency mode (LL-HLS / LL-DASH)
        </label>
        <label>
          <input type="checkbox" id="autoplay" checked={settings.autoplay} onChange={(e) => set({ autoplay: e.target.checked })} /> Autoplay after load
        </label>
      </div>
    </section>
  );
}
