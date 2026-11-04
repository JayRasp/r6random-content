// npm run preview
//   Serves dist/ on http://localhost:8080 with the same content types and
//   ETag / 304 behaviour as content.jojaweb.com, so a debug build of the app
//   can load a local pack: About → tap the content version 7 times →
//   Content source → http://<this computer's IP>:8080/v1/manifest.json
//
// Options
//   --port <n>   default 8080 (or env PORT)
//   --dir <dir>  default dist

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { ROOT, UserError, sha256, runCli, isMain, args, paint } from './lib.mjs';

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.sig': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '': 'text/plain; charset=utf-8',
};

function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

async function main() {
  const { values } = args({
    port: { type: 'string', default: process.env.PORT ?? '8080' },
    dir: { type: 'string', default: 'dist' },
  }, 'npm run preview [-- --port 8080]');
  const root = path.resolve(ROOT, values.dir);
  const port = Number(values.port);
  try {
    await stat(path.join(root, 'v1', 'manifest.json'));
  } catch {
    throw new UserError(`${path.relative(ROOT, root) || '.'}/v1/manifest.json does not exist.`, 'Build first: npm run build -- --version 2026.09.0');
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const done = (status) => console.log(`${new Date().toISOString().slice(11, 19)}  ${status === 200 ? paint('green', status) : status === 304 ? paint('cyan', status) : paint('yellow', status)}  ${req.method} ${req.url}  ${Date.now() - started} ms`);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return done(405);
    }
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return done(400);
    }
    let file = path.join(root, path.normalize(rel));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return done(403);
    }
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const body = await readFile(file);
      const etag = `"${sha256(body).slice(0, 16)}"`;
      const headers = {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        etag,
        'cache-control': 'max-age=0, must-revalidate',
        'access-control-allow-origin': '*',
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return done(304);
      }
      res.writeHead(200, { ...headers, 'content-length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
      return done(200);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');
      return done(404);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', (err) => reject(err.code === 'EADDRINUSE' ? new UserError(`Port ${port} is already in use.`, `Stop the other server or use another port: npm run preview -- --port ${port + 1}`) : err));
    server.listen(port, '0.0.0.0', resolve);
  });
  console.log(paint('bold', `Serving ${path.relative(ROOT, root) || '.'}/ (Ctrl+C to stop)`));
  console.log(`  this computer   http://localhost:${port}/v1/manifest.json`);
  for (const ip of lanAddresses()) console.log(`  phone (Wi-Fi)   http://${ip}:${port}/v1/manifest.json`);
  console.log(paint('dim', '  Debug builds of the app only: About → tap the content version 7 times → Content source.'));
  return new Promise(() => {});
}

if (isMain(import.meta)) runCli(main);
