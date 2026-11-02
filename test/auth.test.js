import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createAuth, readCookie } from '../src/services/auth.js';

describe('auth service', () => {
  it('accepts only the right name and password', () => {
    const auth = createAuth({ user: 'ops', password: 's3cret' });
    expect(auth.check('ops', 's3cret')).toBe(true);
    expect(auth.check('ops', 'wrong')).toBe(false);
    expect(auth.check('admin', 's3cret')).toBe(false);
    expect(auth.check(undefined, undefined)).toBe(false);
  });

  it('expires sessions and forgets them on close', () => {
    let t = 1000;
    const auth = createAuth({ user: 'a', password: 'b', sessionMs: 500, now: () => t });
    const token = auth.open();
    expect(auth.valid(token)).toBe(true);
    t += 600;
    expect(auth.valid(token)).toBe(false);
    const again = auth.open();
    auth.close(again);
    expect(auth.valid(again)).toBe(false);
    expect(auth.valid('')).toBe(false);
  });

  it('locks an address after repeated failures, then lets it try again', () => {
    let t = 0;
    const auth = createAuth({ user: 'a', password: 'b', now: () => t });
    for (let i = 0; i < 5; i++) auth.fail('1.2.3.4');
    expect(auth.lockedFor('1.2.3.4')).toBeGreaterThan(0);
    expect(auth.lockedFor('5.6.7.8')).toBe(0);
    t += 61_000;
    expect(auth.lockedFor('1.2.3.4')).toBe(0);
  });

  it('reads one cookie out of a header', () => {
    expect(readCookie('a=1; pulse_session=xyz; b=2', 'pulse_session')).toBe('xyz');
    expect(readCookie('', 'pulse_session')).toBe('');
  });
});

describe('sign-in gate', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = createApp({ onQuit: () => undefined, auth: createAuth({ user: 'ops', password: 's3cret' }) });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => server.close());

  const login = (user, password, extra = {}) =>
    fetch(`${base}/__auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user, password, ...extra }),
    });

  it('sends pages to the sign-in page and refuses the APIs', async () => {
    const page = await fetch(`${base}/`, { redirect: 'manual', headers: { accept: 'text/html' } });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toMatch(/^\/login/);
    for (const path of ['/__srt/status', '/__layouts', '/__auth/status']) {
      expect((await fetch(base + path)).status).toBe(401);
    }
    const form = await fetch(`${base}/login`);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('name="password"');
  });

  it('rejects a wrong password and sets no session', async () => {
    const res = await login('ops', 'nope');
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('signs in, opens the APIs, and signs out again', async () => {
    const res = await login('ops', 's3cret', { next: '/' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const set = res.headers.get('set-cookie');
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    const cookie = set.split(';')[0];

    const status = await fetch(`${base}/__auth/status`, { headers: { cookie } });
    expect(await status.json()).toEqual({ enabled: true, user: 'ops' });
    expect((await fetch(`${base}/__layouts`, { headers: { cookie } })).status).toBe(200);

    await fetch(`${base}/__auth/logout`, { method: 'POST', headers: { cookie } });
    expect((await fetch(`${base}/__layouts`, { headers: { cookie } })).status).toBe(401);
  });

  it('never redirects to another website after signing in', async () => {
    const res = await login('ops', 's3cret', { next: '//evil.example/' });
    expect(res.headers.get('location')).toBe('/');
  });

  it('refuses a sign-in posted from another website', async () => {
    const res = await fetch(`${base}/__auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.example' },
      body: new URLSearchParams({ user: 'ops', password: 's3cret' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('sign-in switched off', () => {
  it('lets everything through', async () => {
    const app = createApp({ onQuit: () => undefined, auth: createAuth({ enabled: false, user: 'a', password: 'b' }) });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/__layouts`);
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
