import express from 'express';
import { readCookie, SESSION_COOKIE } from '../../services/auth.js';
import { json, requireSameOrigin } from '../../utilities/http.js';
import { loginPage } from './login-page.js';

/** Pages and files anyone may fetch: the sign-in page and the pictures it shows. */
const PUBLIC = new Set(['/login', '/skandha-logo.png', '/favicon-32.png', '/apple-touch-icon.png']);
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

/** Only same-site paths are followed after signing in (never another website). */
const safeNext = (next) => (typeof next === 'string' && /^\/(?![/\\])/.test(next) && !next.startsWith('/__') ? next : '/');

const cookie = (value, maxAge) => `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

/**
 * Middleware that lets a request through only when it carries a valid session. Pages redirect to /login,
 * API calls get 401. `/__app/quit` from this machine stays open: the uninstaller and "Stop Pulse" call it without a browser.
 */
export function requireLogin(auth) {
  return (req, res, next) => {
    if (!auth.enabled || PUBLIC.has(req.path) || req.path === '/__auth/login') return next();
    if (auth.valid(readCookie(req.headers.cookie, SESSION_COOKIE))) return next();
    if (req.method === 'POST' && req.path === '/__app/quit' && isLoopback(req.socket.remoteAddress)) return next();
    if (req.method === 'GET' && !req.path.startsWith('/__') && req.accepts(['html', 'json']) === 'html') {
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    json(res, 401, { error: 'Sign in required' });
  };
}

/**
 * Sign-in and sign-out (see FRONTEND_API.md):
 *
 *   GET  /login          the sign-in page
 *   POST /__auth/login   form `user`, `password`, `next`: sets the session cookie and redirects
 *   POST /__auth/logout  ends the session
 *   GET  /__auth/status  { enabled, user }
 */
export function createAuthRouter(auth) {
  const router = express.Router();
  const page = (res, status, opts) => res.status(status).set('cache-control', 'no-store').type('html').send(loginPage(opts));

  router.get('/login', (req, res) => {
    if (!auth.enabled || auth.valid(readCookie(req.headers.cookie, SESSION_COOKIE))) return res.redirect('/');
    page(res, 200, { next: safeNext(req.query.next) });
  });

  router.use('/__auth', requireSameOrigin);

  router.post('/__auth/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const next = safeNext(req.body?.next);
    const ip = req.socket.remoteAddress ?? '';
    const wait = auth.lockedFor(ip);
    if (wait) return page(res, 429, { error: `Too many wrong attempts. Try again in ${wait} seconds.`, next });
    if (!auth.check(req.body?.user, req.body?.password)) {
      auth.fail(ip);
      return page(res, 401, { error: 'Wrong user name or password.', next });
    }
    auth.clearFailures(ip);
    res.set('set-cookie', cookie(auth.open(), auth.sessionSeconds));
    res.redirect(303, next);
  });

  router.post('/__auth/logout', (req, res) => {
    auth.close(readCookie(req.headers.cookie, SESSION_COOKIE));
    res.set('set-cookie', cookie('', 0));
    json(res, 200, { ok: true });
  });

  router.get('/__auth/status', (req, res) => {
    if (auth.enabled && !auth.valid(readCookie(req.headers.cookie, SESSION_COOKIE))) return json(res, 401, { error: 'Sign in required' });
    json(res, 200, { enabled: auth.enabled, user: auth.enabled ? auth.user : null });
  });

  return router;
}
