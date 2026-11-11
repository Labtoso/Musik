import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/app.js';

/** Writes a short silent 16-bit mono WAV file. */
export function writeWav(file, seconds = 2, rate = 8000) {
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

export async function startServer(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'musik-test-'));
  const music = path.join(root, 'music');
  fs.mkdirSync(music, { recursive: true });
  if (opts.files) for (const f of opts.files) writeWav(path.join(music, f), 2);
  const app = createApp({ dataDir: path.join(root, 'data'), musicDirs: [music], webDir: opts.webDir ?? null, ...opts.config });
  await app.library.scan();
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = null;
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  return {
    app,
    base,
    root,
    music,
    api,
    setToken: (t) => (token = t),
    close: async () => {
      await new Promise((r) => server.close(r));
      app.db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
