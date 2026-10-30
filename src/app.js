import express from 'express';
import { corsProxyHandler } from './apps/proxy/proxy.routes.js';
import { srtRouter } from './apps/srt/srt.routes.js';
import { createSystemRouter } from './apps/system/system.routes.js';
import { config } from './config/index.js';
import { staticMiddleware } from './utilities/static.js';

/**
 * The Express application: the monitoring API (/__srt), the CORS proxy (/__proxy), the desktop
 * endpoints (/__app) and the built React frontend for everything else.
 */
export function createApp({ onQuit }) {
  const app = express();
  app.disable('x-powered-by');

  app.use('/__app', createSystemRouter({ onQuit }));
  app.use('/__proxy', corsProxyHandler);
  app.use('/__srt', srtRouter);
  app.use(staticMiddleware({ dist: config.dist, embedded: config.embedded }));

  // Anything that escapes a handler.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).send(String(err));
  });

  return app;
}
