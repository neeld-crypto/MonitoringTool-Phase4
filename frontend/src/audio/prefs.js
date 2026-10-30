const STD_KEY = 'sap.loudness.v1';
const OVERLAY_KEY = 'sap.meters.v1';
const listeners = new Set();
function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
let standard = read(STD_KEY) === 'atsc' ? 'atsc' : 'ebu';
let overlay = read(OVERLAY_KEY) !== 'off'; // on by default
export const audioPrefs = {
  get standard() {
    return standard;
  },
  set standard(v) {
    standard = v;
    write(STD_KEY, v);
    listeners.forEach((fn) => fn());
  },
  get overlay() {
    return overlay;
  },
  set overlay(v) {
    overlay = v;
    write(OVERLAY_KEY, v ? 'on' : 'off');
    listeners.forEach((fn) => fn());
  },
  onChange(fn) {
    listeners.add(fn);
  },
};
