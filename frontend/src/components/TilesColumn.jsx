/**
 * Centre column: the monitoring wall (drawn by the SRT panel into #srt-panel) and, while no wall is open,
 * a calm backdrop with the logo instead of empty space.
 */
export default function TilesColumn({ tilesEmpty }) {
  return (
    <section className="tiles-col" aria-label="Monitoring tiles">
      <h2 className="col-title">Monitoring tiles</h2>
      {/* The wall fills this section itself; React only renders the empty, initially hidden container. */}
      <section id="srt-panel" className="settings drm-panel" hidden aria-label="SRT monitoring" />
      <p id="tiles-empty" className="tiles-empty muted" hidden={!tilesEmpty}>
        Monitoring tiles need the local Pulse server. Paste a URL above or pick a test stream.
      </p>
      <div className="tiles-idle" aria-hidden="true">
        <div className="idle-orbit">
          <span />
          <span />
          <span />
          <img src="skandha-logo.png" alt="" width="132" height="116" />
        </div>
        <div className="idle-title">Skandha Media Services</div>
        <div className="idle-sub">Live stream monitoring</div>
        <div className="idle-hint">
          Open <b>SRT</b> or <b>UDP</b> from the menu to start watching your channels
        </div>
      </div>
    </section>
  );
}
