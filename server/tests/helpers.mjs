// Black-box tests: start the real server binary on a free port with a temp music folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const BIN = process.env.STREYN_BIN || path.resolve(import.meta.dirname, '../target/debug/streyn-server' + (process.platform === 'win32' ? '.exe' : ''));

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

const freePort = () =>
  new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streyn-test-'));
  const music = path.join(root, 'music');
  fs.mkdirSync(music, { recursive: true });
  if (opts.files) for (const f of opts.files) writeWav(path.join(music, f), 2);
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(root, 'data'), MUSIC_DIRS: music, SCAN_INTERVAL: '0' };
  // never pick up a WEB_DIR from the environment of the test run
  if (opts.webDir) env.WEB_DIR = opts.webDir;
  else delete env.WEB_DIR;
  const proc = spawn(BIN, [], { env, cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  // registered right away, so neither a failed start nor an early exit is missed
  let spawnError = null;
  proc.once('error', (e) => (spawnError = e));
  const exited = new Promise((r) => proc.once('close', r));
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  const deadline = Date.now() + 10_000;
  while (!ready && !spawnError && Date.now() < deadline) {
    try {
      const r = await fetch(base + '/api/info', { signal: AbortSignal.timeout(1000) });
      ready = r.ok;
    } catch {}
    if (!ready) await sleep(50);
  }
  if (!ready) {
    if (!spawnError) proc.kill();
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`server ${BIN} did not start${spawnError ? `: ${spawnError.message}` : ''}`);
  }
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
  /** Waits until the running scan is finished (needs an admin token). */
  const waitScan = async () => {
    for (let i = 0; i < 200; i++) {
      const r = await api('GET', '/api/library');
      if (r.status === 200 && !r.json.scanning && r.json.lastScan) return r.json;
      await sleep(25);
    }
    throw new Error('scan did not finish');
  };
  return {
    base,
    root,
    music,
    api,
    waitScan,
    setToken: (t) => (token = t),
    close: async () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      await exited;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
