import { useTheme } from '../hooks/useTheme';
import { icons } from '../ui/icons';
import Icon from './Icon';

/** Brand, stream URL box, theme and load-settings buttons. */
export default function Topbar({ url, onUrl, history, onLoad, settingsOpen, onToggleSettings, onThemeChange }) {
  const theme = useTheme(onThemeChange);
  return (
    <header className="topbar">
      <div className="brand">
        <img className="logo" src="skandha-logo.png" alt="Skandha Media Services" width="41" height="36" />
        <span className="brand-name">Pulse</span>
        <span className="tagline">DASH · HLS · SRT · DRM · SCTE-35</span>
      </div>
      <form
        id="load-form"
        className="load-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          onLoad(url);
        }}
      >
        <input
          id="url"
          type="url"
          list="url-history"
          required
          placeholder="Paste an MPEG-DASH (.mpd) or HLS (.m3u8) URL"
          aria-label="Stream URL"
          value={url}
          onChange={(e) => onUrl(e.target.value)}
        />
        <datalist id="url-history">
          {history.map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
      </form>
      <div className="top-actions">
        <button type="button" id="theme-btn" className="theme-btn" title={theme.title} aria-label={theme.title} onClick={theme.cycle}>
          <Icon html={theme.icon} />
          <span>{theme.label}</span>
        </button>
        <button
          type="button"
          id="settings-btn"
          className="icon-btn"
          title="Load settings"
          aria-label="Load settings"
          aria-expanded={settingsOpen}
          onClick={onToggleSettings}
        >
          <Icon html={icons.settings} />
        </button>
      </div>
    </header>
  );
}
