const START_MESSAGE = {
  __html: '<div><strong>Load a stream to start</strong><p>Paste a DASH or HLS URL above, or pick one of the test streams.</p></div>',
};

/**
 * Right column: the preview player over the full analysis. The video, controls, overlays and the analysis tabs are
 * filled in by the player engine (they update many times a second), so they are empty containers here.
 */
export default function DetailColumn({ open, wallAvailable, onClose, onWall, onShare, onExport }) {
  return (
    <div id="detail-col" className="detail-col" hidden={!open}>
      <section className="player-col">
        <div className="col-head">
          <h2 className="col-title">Full preview</h2>
          <button type="button" id="detail-close" className="detail-close" title="Close preview and analysis" aria-label="Close preview and analysis" onClick={onClose}>
            ×
          </button>
        </div>
        <div id="player" className="player" tabIndex={-1}>
          <video id="video" playsInline />
          <div id="ad-banner" className="ad-banner" hidden />
          <div className="overlay-stack">
            <div id="audio-overlay" className="audio-overlay" hidden />
            <div id="nerd-overlay" className="nerd-overlay" hidden />
          </div>
          <div id="player-message" className="player-message" dangerouslySetInnerHTML={START_MESSAGE} />
          <div id="spinner" className="spinner" hidden />
          <div id="controls" className="controls" />
        </div>
        <div id="stream-summary" className="stream-summary" />
      </section>

      <aside className="stats-col">
        <div className="stats-head">
          <h2>Full analysis</h2>
          <div className="stats-actions">
            <button type="button" id="wall-btn" title="Back to the SRT / UDP multiviewer wall" hidden={!wallAvailable} onClick={onWall}>
              ↑ Wall
            </button>
            <button type="button" id="share-btn" title="Copy a link that loads this stream" onClick={onShare}>
              Copy link
            </button>
            <button type="button" id="export-btn" title="Download stats, tracks, SCTE log and network log as JSON" onClick={onExport}>
              Export JSON
            </button>
          </div>
        </div>
        <nav id="tabs" className="tabs" role="tablist" />
        <div id="tab-body" className="tab-body" />
      </aside>
    </div>
  );
}
