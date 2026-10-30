import { config } from '../../config/index.js';
import { SrtMonitor } from './monitor.js';

let monitor = null;

/** The one SRT / UDP / HLS monitor of this process, created on first use. */
export function getMonitor() {
  monitor ??= new SrtMonitor({
    ffmpegPath: config.ffmpegPath,
    previewDir: config.previewDir,
    settingsPath: config.settingsPath,
    logDir: config.logDir,
  });
  return monitor;
}

/** Stops every running channel. */
export function disposeMonitor() {
  monitor?.dispose();
  monitor = null;
}

/** Open browser pages and running channels, for the desktop app's auto-exit. */
export function activity() {
  return { clients: monitor?.clientCount ?? 0, running: monitor?.runningCount ?? 0 };
}
