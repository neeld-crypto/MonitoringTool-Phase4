import express from 'express';
import { config } from '../../config/index.js';
import { json, sameOrigin } from '../../utilities/http.js';

/**
 * Desktop app endpoints (mounted at /__app):
 *
 *   GET  /__app/info    { desktop }  whether the single-file executable is running
 *   POST /__app/quit    stops the server (executable only, same-origin only)
 */
export function createSystemRouter({ onQuit }) {
  const router = express.Router();

  router.get('/info', (req, res) => json(res, 200, { desktop: config.embedded }));

  router.post('/quit', (req, res) => {
    if (!config.embedded || !sameOrigin(req)) return json(res, 403, { error: 'Not available' });
    json(res, 200, { ok: true });
    setTimeout(onQuit, 200);
  });

  return router;
}
