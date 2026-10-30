import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import sea from 'node:sea';
import { MIME } from '../constants/index.js';

function headers(res, name, size) {
  res.setHeader('content-type', MIME[extname(name)] ?? 'application/octet-stream');
  res.setHeader('content-length', size);
  // Hashed assets never change; the page itself must always be re-checked.
  res.setHeader('cache-control', name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
}

/**
 * Serves the built frontend (single-page app: unknown paths get index.html), from the dist folder or,
 * in the single-file executable, from the files embedded in it.
 */
export function staticMiddleware({ dist, embedded }) {
  /** Embedded files, keyed by path relative to dist (e.g. `assets/index-abc.js`). */
  const assets = new Set(embedded ? JSON.parse(Buffer.from(sea.getRawAsset('manifest.json')).toString()) : []);
  const root = resolve(dist);

  return (req, res) => {
    let path;
    try {
      path = decodeURIComponent((req.originalUrl ?? req.url).split('?')[0]);
    } catch {
      return void res.status(400).send('Bad request');
    }
    // Relative, forward-slash name inside dist; anything that climbs out is refused.
    const rel = normalize(path)
      .replace(/^[\\/]+/, '')
      .replace(/\\/g, '/');
    if (rel.split('/').includes('..')) return void res.status(403).send('Forbidden');

    if (embedded) {
      const name = assets.has(rel) ? rel : 'index.html';
      const data = Buffer.from(sea.getRawAsset(name));
      headers(res, name, data.length);
      return void res.end(data);
    }

    let file = resolve(root, rel);
    if (file !== root && !file.startsWith(root + sep)) return void res.status(403).send('Forbidden');
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    headers(res, file.slice(root.length + 1).replace(/\\/g, '/'), statSync(file).size);
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  };
}
