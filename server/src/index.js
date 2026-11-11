import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, VERSION } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');

// Minimal .env loader (KEY=VALUE per line), environment variables win.
for (const file of [path.join(serverDir, '.env'), process.env.MUSIK_ENV].filter(Boolean)) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const env = process.env;
const port = Number(env.PORT || 8484);
const host = env.HOST || '0.0.0.0';
const dataDir = path.resolve(serverDir, env.DATA_DIR || 'data');
const musicDirs = (env.MUSIC_DIRS || path.join(dataDir, 'music'))
  .split(path.delimiter === ';' ? /[;|]/ : /[:|]/)
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => path.resolve(serverDir, d));
const webDir = path.resolve(serverDir, env.WEB_DIR || '../web');
const scanMinutes = Number(env.SCAN_INTERVAL ?? 30);

for (const d of musicDirs) fs.mkdirSync(d, { recursive: true });

const app = createApp({ dataDir, musicDirs, webDir: fs.existsSync(webDir) ? webDir : null, name: env.SERVER_NAME || 'Musik' });
const server = http.createServer(app.handler);
server.requestTimeout = 0; // long uploads and streams
server.headersTimeout = 60000;

server.listen(port, host, () => {
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${port}`);
  console.log(`Musik server ${VERSION}`);
  console.log(`Music folders: ${app.library.roots().join(', ')}`);
  console.log(`Data: ${dataDir}`);
  console.log(`Open: ${[`http://localhost:${port}`, ...addrs].join('  ')}`);
});

const scan = () =>
  app.library
    .scan()
    .then((r) => {
      app.rec.invalidate();
      console.log(`Scan: ${r.total} tracks (+${r.added} ~${r.updated} -${r.removed}) in ${r.ms} ms`);
    })
    .catch((e) => console.error('Scan failed:', e.message));
scan();
if (scanMinutes > 0) setInterval(scan, scanMinutes * 60000).unref();

const stop = () => {
  server.close();
  try {
    app.db.close();
  } catch {}
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
