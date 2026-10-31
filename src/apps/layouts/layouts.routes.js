import express from 'express';
import { config } from '../../config/index.js';
import { loadLayouts, saveLayouts } from '../../services/layouts.js';
import { json, requireSameOrigin } from '../../utilities/http.js';

/**
 * Saved monitoring-wall layouts (mounted at /__layouts). See FRONTEND_API.md.
 *
 *   GET /__layouts   { layouts }
 *   PUT /__layouts   { layouts }  replaces the whole list
 */
export const layoutsRouter = express.Router();

layoutsRouter.use(requireSameOrigin);
layoutsRouter.use(express.json({ limit: '512kb' }));

layoutsRouter.get('/', (req, res) => json(res, 200, { layouts: loadLayouts(config.layoutsPath) }));

layoutsRouter.put('/', (req, res) => {
  try {
    json(res, 200, { layouts: saveLayouts(config.layoutsPath, req.body?.layouts) });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

/** Bad JSON in a request body is a 400, like every other bad request. */
layoutsRouter.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  json(res, 400, { error: err instanceof Error ? err.message : String(err) });
});
