import { useEffect, useRef } from 'react';

const KEY = 'sap.statsWidth.v1';
const DEFAULT = 560;
const MIN_STATS = 320;
const MIN_PLAYER = 360;

/**
 * Drag handle between the tiles and the preview / analysis column. Dragging left widens the right column;
 * the width is remembered. Arrow keys resize by 20px (80 with Shift), Home / double-click reset.
 */
export default function Splitter({ layoutRef }) {
  const handle = useRef(null);
  const layout = () => layoutRef.current;

  const max = () => Math.max(MIN_STATS, layout().clientWidth - MIN_PLAYER - 60);
  const clamp = (w) => Math.round(Math.min(max(), Math.max(MIN_STATS, w)));
  const current = () => parseFloat(getComputedStyle(layout()).getPropertyValue('--stats-width')) || DEFAULT;

  function apply(w, save = true) {
    const width = clamp(w);
    layout().style.setProperty('--stats-width', `${width}px`);
    handle.current?.setAttribute('aria-valuenow', String(width));
    if (save) {
      try {
        localStorage.setItem(KEY, String(width));
      } catch {
        /* storage unavailable */
      }
    }
    // Let the stats chart redraw at the new size.
    window.dispatchEvent(new Event('resize'));
  }

  useEffect(() => {
    let saved = DEFAULT;
    try {
      saved = Number(localStorage.getItem(KEY)) || DEFAULT;
    } catch {
      /* storage unavailable */
    }
    apply(saved, false);
    // Keep the saved width valid when the window shrinks.
    const onResize = () => {
      const w = current();
      if (w !== clamp(w)) layout().style.setProperty('--stats-width', `${clamp(w)}px`);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function onPointerDown(e) {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    document.body.classList.add('resizing');
    const right = layout().getBoundingClientRect().right - parseFloat(getComputedStyle(layout()).paddingRight);
    const move = (ev) => apply(right - ev.clientX - 10);
    const up = () => {
      el.classList.remove('dragging');
      document.body.classList.remove('resizing');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  function onKeyDown(e) {
    const step = e.shiftKey ? 80 : 20;
    if (e.key === 'ArrowLeft') apply(current() + step);
    else if (e.key === 'ArrowRight') apply(current() - step);
    else if (e.key === 'Home') apply(DEFAULT);
    else return;
    e.preventDefault();
  }

  return (
    <div
      id="splitter"
      ref={handle}
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={MIN_STATS}
      aria-label="Resize preview panel (drag, arrow keys, double-click to reset)"
      title="Drag to resize · double-click to reset"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => apply(DEFAULT)}
      onKeyDown={onKeyDown}
    />
  );
}
