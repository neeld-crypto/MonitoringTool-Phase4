/** Sends a JSON body that browsers must not cache. */
export function json(res, status, body) {
  res.status(status);
  res.set('cache-control', 'no-store');
  res.type('application/json').send(JSON.stringify(body));
}

/**
 * These endpoints start processes and hold credentials, so refuse requests that come
 * from another website (CSRF / DNS rebinding): the Origin, if sent, must match the Host.
 */
export function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Express middleware form of sameOrigin. */
export function requireSameOrigin(req, res, next) {
  if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-origin request refused' });
  next();
}
