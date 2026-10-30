import type { Alert } from './types';

const KEY = 'sap.srt.alerts.v1';

export interface AlertPrefs {
  sound: boolean;
  desktop: boolean;
}

export function loadPrefs(): AlertPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<AlertPrefs>;
    return { sound: raw.sound !== false, desktop: raw.desktop === true };
  } catch {
    return { sound: true, desktop: false };
  }
}

export function savePrefs(p: AlertPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

let ctx: AudioContext | null = null;

/** Short beeps: three for critical, two for warning. Needs a prior user gesture, else it stays silent. */
export function beep(severity: Alert['severity']): void {
  if (severity === 'info') return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const count = severity === 'critical' ? 3 : 2;
    const freq = severity === 'critical' ? 880 : 660;
    for (let i = 0; i < count; i++) {
      const t = ctx.currentTime + i * 0.22;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    }
  } catch {
    /* audio unavailable */
  }
}

export async function enableDesktopNotifications(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

export function describe(a: Alert): string {
  const who = a.channelName ? `${a.channelName}: ` : '';
  return a.state === 'cleared' ? `Recovered: ${who}${a.message}` : `${who}${a.message}`;
}

/** In-app delivery of an alert: toast, optional beep and optional desktop notification. */
export function deliver(a: Alert, prefs: AlertPrefs, toast: (text: string) => void): void {
  if (a.state === 'cleared') {
    toast(`✅ ${describe(a)}`);
    return;
  }
  const icon = a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '🟠' : 'ℹ️';
  toast(`${icon} ${describe(a)}`);
  if (prefs.sound) beep(a.severity);
  if (prefs.desktop && a.severity !== 'info' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(`Pulse SRT${a.channelName ? ` · ${a.channelName}` : ''}: ${a.severity}`, { body: a.message, tag: `${a.channelId ?? 0}:${a.key}` });
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  }
}
