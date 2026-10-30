import { icons } from '../ui/icons';
import Icon from './Icon';

/** Collapsible left menu: test streams, Load, SRT, UDP and DRM. */
export default function Sidebar({ open, onToggle, presetList, onPreset, srtInfo, view, drm, onView, onToggleDrm }) {
  const groups = [...new Set(presetList.map((p) => p.group))];
  const { srt, udp } = srtInfo;
  const srtOpen = view.open && view.view === 'all';
  const udpOpen = view.open && view.view === 'udp';
  return (
    <aside className="side-bar" aria-label="Sources">
      <button type="button" id="side-toggle" className="theme-btn side-toggle" aria-expanded={open} aria-controls="side-menu" title="Menu" onClick={onToggle}>
        ☰ <span>Menu</span>
      </button>
      <div id="side-menu" className="side-menu" hidden={!open}>
        <h2 className="side-title">Test streams</h2>
        <select id="presets" aria-label="Test streams" value="" onChange={(e) => onPreset(e.target.value)}>
          <option value="">Test streams…</option>
          {groups.map((group) => (
            <optgroup key={group} label={group}>
              {presetList
                .filter((p) => p.group === group)
                .map((p) => (
                  <option key={p.url} value={p.url} title={p.notes ?? p.url}>
                    {p.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <button type="submit" className="primary" id="load-btn" form="load-form">
          Load
        </button>
        <button
          type="button"
          id="srt-btn"
          className={`theme-btn${srt.running > 0 ? ' active' : ''}${srtOpen ? ' current' : ''}`}
          title={`SRT monitoring (${srt.running} of ${srt.total} channels running)`}
          aria-expanded={srtOpen}
          onClick={() => onView('all')}
        >
          <Icon html={icons.srt} />
          <span>SRT{srt.alerts ? ` · ${srt.alerts}` : ''}</span>
        </button>
        <button
          type="button"
          id="udp-btn"
          className={`theme-btn${udp.running > 0 ? ' active' : ''}${udpOpen ? ' current' : ''}`}
          title={`UDP / multicast monitoring (${udp.running} of ${udp.total} UDP channels running)`}
          aria-expanded={udpOpen}
          onClick={() => onView('udp')}
        >
          <Icon html={icons.udp} />
          <span>
            UDP{udp.total ? ` ${udp.running}/${udp.total}` : ''}
            {udp.alerts ? ` · ${udp.alerts}` : ''}
          </span>
        </button>
        <button
          type="button"
          id="drm-btn"
          className={`theme-btn${drm.on ? ' active' : ''}`}
          title="DRM settings (Widevine / FairPlay)"
          aria-expanded={drm.open}
          onClick={onToggleDrm}
        >
          <Icon html={icons.lock} />
          <span>{drm.label}</span>
        </button>
      </div>
    </aside>
  );
}
