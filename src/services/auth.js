import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'pulse_session';
/** Wrong passwords allowed from one address before it is locked out for LOCK_MS. */
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;

const digest = (text) => createHash('sha256').update(String(text)).digest();
/** Compares without leaking, through timing, how much of the text matched. */
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

/** Value of one cookie from a Cookie header, or ''. */
export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/**
 * One shared user name and password (from the environment) and the browser sessions that signed in with it.
 * Sessions live in memory: restarting Pulse signs everyone out.
 */
export function createAuth({ enabled = true, user, password, sessionMs = 12 * 3600_000, now = Date.now }) {
  const sessions = new Map();
  const failures = new Map();

  return {
    enabled,
    user,

    /** Whether the name and password are right. Always compares both, so timing says nothing about which was wrong. */
    check(name, pass) {
      const userOk = same(name ?? '', user);
      const passOk = same(pass ?? '', password);
      return userOk && passOk;
    },

    /** Seconds the address must wait before trying again, or 0. */
    lockedFor(ip) {
      const f = failures.get(ip);
      if (!f || f.count < MAX_FAILURES) return 0;
      const left = f.at + LOCK_MS - now();
      if (left <= 0) {
        failures.delete(ip);
        return 0;
      }
      return Math.ceil(left / 1000);
    },
    fail(ip) {
      const f = failures.get(ip) ?? { count: 0, at: 0 };
      failures.set(ip, { count: f.count + 1, at: now() });
    },
    clearFailures(ip) {
      failures.delete(ip);
    },

    /** Starts a session and returns its token (the cookie value). */
    open() {
      for (const [token, until] of sessions) if (until <= now()) sessions.delete(token);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, now() + sessionMs);
      return token;
    },
    valid(token) {
      const until = token ? sessions.get(token) : undefined;
      if (until === undefined) return false;
      if (until <= now()) {
        sessions.delete(token);
        return false;
      }
      return true;
    },
    close(token) {
      sessions.delete(token);
    },
    sessionSeconds: Math.floor(sessionMs / 1000),
  };
}
