import express from 'express';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config/index.js';
import { HLS_MIME, MAX_JSON_BYTES } from '../../constants/index.js';
import { getMonitor } from '../../services/srt/index.js';
import { loadReport } from '../../services/srt/load.js';
import { json, requireSameOrigin } from '../../utilities/http.js';

/**
 * SRT / UDP / HLS monitoring API (mounted at /__srt, local use only). See FRONTEND_API.md.
 *
 * Browsers cannot speak SRT (it runs over UDP), so ffmpeg (and srt-live-transmit when installed)
 * terminates the SRT socket on the server and the page talks plain HTTP. Everything is also written
 * to ./logs/<YYYY-MM-DD>/.
 */
export const srtRouter = express.Router();

srtRouter.use(requireSameOrigin);
srtRouter.use(express.json({ limit: MAX_JSON_BYTES }));

/** Wraps a handler: a thrown error becomes a 400 with its message, as the frontend expects. */
const route = (fn) => async (req, res) => {
  try {
    await fn(getMonitor(), req, res);
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
};

const channelId = (req) => (/^\d+$/.test(req.params.id) ? req.params.id : null);
const unknown = (res) => json(res, 404, { error: 'Unknown SRT endpoint' });

srtRouter.get('/status', route((m, req, res) => json(res, 200, m.status())));
srtRouter.get('/events', route((m, req, res) => m.addClient(res)));
srtRouter.get('/load', route(async (m, req, res) => json(res, 200, await loadReport())));

/** HLS preview written by ffmpeg: /__srt/hls/ch<n>/<file>. */
srtRouter.get(
  '/hls/*name',
  route((m, req, res) => {
    const name = [].concat(req.params.name).join('/');
    if (!/^ch\d{1,4}\/[\w.-]+$/.test(name)) return json(res, 400, { error: 'Bad file name' });
    const file = join(config.previewDir, name);
    const ext = name.slice(name.lastIndexOf('.'));
    if (!HLS_MIME[ext] || !existsSync(file)) return json(res, 404, { error: 'Not found' });
    res.setHeader('content-type', HLS_MIME[ext]);
    res.setHeader('content-length', statSync(file).size);
    res.setHeader('cache-control', 'no-store');
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  }),
);

/** Small live picture of channel n, for the wall. */
srtRouter.get(
  '/thumb/:file',
  route((m, req, res) => {
    const match = /^(\d{1,4})\.jpg$/.exec(req.params.file);
    if (!match) return unknown(res);
    const file = m.thumbPath(Number(match[1]));
    if (!existsSync(file)) return json(res, 404, { error: 'No picture yet' });
    res.setHeader('content-type', 'image/jpeg');
    res.setHeader('cache-control', 'no-store');
    // Read whole: the file is a few KB and ffmpeg swaps it in atomically, so a half-written picture is never served.
    res.end(readFileSync(file));
  }),
);

srtRouter.post(
  '/channels',
  route((m, req, res) => {
    const { kind, name } = req.body ?? {};
    m.addChannel(kind === 'udp' ? 'udp' : kind === 'hls' ? 'hls' : 'srt', name);
    json(res, 200, m.status());
  }),
);

srtRouter.post(
  '/bulk',
  route((m, req, res) => {
    const { items, start } = req.body ?? {};
    const result = m.bulkAdd(items, start === true);
    json(res, 200, { ...m.status(), ...result });
  }),
);

srtRouter.put(
  '/limits',
  route((m, req, res) => {
    m.updateLimits(req.body ?? {});
    json(res, 200, m.status());
  }),
);

/** Channel actions: start, stop, copy-rules, watch; update (PUT) and remove (DELETE). */
srtRouter.post(
  '/ch/:id/:action',
  route((m, req, res) => {
    const id = channelId(req);
    if (!id) return unknown(res);
    const body = req.body ?? {};
    switch (req.params.action) {
      case 'start':
        m.start(id, body);
        break;
      case 'stop':
        m.stop(id);
        break;
      case 'copy-rules':
        m.copyRules(id);
        break;
      case 'watch':
        m.watch(id);
        break;
      default:
        return unknown(res);
    }
    json(res, 200, m.status());
  }),
);

srtRouter.put(
  '/ch/:id',
  route((m, req, res) => {
    const id = channelId(req);
    if (!id) return unknown(res);
    m.updateChannel(id, req.body ?? {});
    json(res, 200, m.status());
  }),
);

srtRouter.delete(
  '/ch/:id',
  route((m, req, res) => {
    const id = channelId(req);
    if (!id) return unknown(res);
    m.removeChannel(id);
    json(res, 200, m.status());
  }),
);

/** start-all launches one by one and stops at the CPU limit. */
srtRouter.post(
  '/start-all',
  route((m, req, res) => {
    const queued = m.startAll();
    json(res, 200, { ...m.status(), queued });
  }),
);

srtRouter.post(
  '/stop-all',
  route((m, req, res) => {
    m.stopAll();
    json(res, 200, m.status());
  }),
);

srtRouter.put(
  '/notify',
  route((m, req, res) => json(res, 200, m.updateNotify(req.body ?? {}))),
);

srtRouter.post(
  '/notify-test',
  route(async (m, req, res) => {
    const results = await m.testNotify((req.body ?? {}).ch);
    json(res, 200, { results });
  }),
);

srtRouter.use((req, res) => unknown(res));

/** Bad JSON in a request body is a 400, like every other bad request. */
srtRouter.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  json(res, 400, { error: err instanceof Error ? err.message : String(err) });
});
