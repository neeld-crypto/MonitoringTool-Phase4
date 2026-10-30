/**
 * DRM settings, kept generic: no provider-specific presets. Any license
 * server is described by a URL, headers and, when needed, how the request
 * body is wrapped and where the license sits in the response.
 */
export const DEFAULT_DRM = {
  mode: 'off',
  widevine: {
    licenseUrl: '',
    level: 'auto',
    requestFormat: 'raw',
    template: '{"challenge":"{{challenge}}"}',
    responseFormat: 'auto',
    responseField: 'license',
  },
  fairplay: {
    licenseUrl: '',
    certificateUrl: '',
    certificateData: '',
    certificateName: '',
    contentId: 'skd-host',
    customContentId: '',
    playback: 'auto',
    requestFormat: 'raw',
    template: '{"spc":"{{spc}}","assetId":"{{contentId}}"}',
    responseFormat: 'auto',
    responseField: 'ckc',
  },
  headers: '',
  useProxy: false,
};
/** Robustness strings requested from the Widevine CDM, best first. */
export const WIDEVINE_ROBUSTNESS = {
  auto: {
    video: ['HW_SECURE_ALL', 'HW_SECURE_DECODE', 'HW_SECURE_CRYPTO', 'SW_SECURE_DECODE', 'SW_SECURE_CRYPTO'],
    audio: ['HW_SECURE_CRYPTO', 'SW_SECURE_CRYPTO'],
  },
  hw: { video: ['HW_SECURE_ALL'], audio: ['HW_SECURE_CRYPTO', 'SW_SECURE_CRYPTO'] },
  sw: { video: ['SW_SECURE_DECODE', 'SW_SECURE_CRYPTO'], audio: ['SW_SECURE_CRYPTO'] },
};
/** Human label for a Widevine robustness string. */
export function widevineLevelName(robustness) {
  if (!robustness) return '';
  if (robustness === 'HW_SECURE_ALL') return 'L1 (hardware)';
  if (robustness.startsWith('HW_')) return 'L2 (hardware crypto)';
  return 'L3 (software)';
}
/** Merges a stored/partial object over the defaults (tolerates old shapes). */
export function normaliseDrm(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT_DRM,
    ...v,
    widevine: { ...DEFAULT_DRM.widevine, ...(v.widevine ?? {}) },
    fairplay: { ...DEFAULT_DRM.fairplay, ...(v.fairplay ?? {}) },
  };
}
export const isDrmConfigured = (s) =>
  Boolean(s.testKeySystem) || (s.mode !== 'off' && Boolean(s.widevine.licenseUrl.trim() || s.fairplay.licenseUrl.trim()));
// ------------------------------------------------------------- storage
const CURRENT_KEY = 'sap.drm.v1';
const PROFILES_KEY = 'sap.drmProfiles.v1';
function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full (large certificate) */
  }
}
/** Settings remembered with "Remember on this browser", or null. */
export function loadRememberedDrm() {
  const v = read(CURRENT_KEY);
  return v ? normaliseDrm(v) : null;
}
export function rememberDrm(settings) {
  write(CURRENT_KEY, settings);
}
export function loadProfiles() {
  const v = read(PROFILES_KEY);
  if (!Array.isArray(v)) return [];
  return v
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => ({ name: p.name, url: typeof p.url === 'string' ? p.url : '', drm: normaliseDrm(p.drm), savedAt: p.savedAt ?? '' }));
}
export function saveProfile(profile) {
  const list = [profile, ...loadProfiles().filter((p) => p.name !== profile.name)];
  write(PROFILES_KEY, list);
  return list;
}
export function deleteProfile(name) {
  const list = loadProfiles().filter((p) => p.name !== name);
  write(PROFILES_KEY, list);
  return list;
}
