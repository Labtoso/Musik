import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, writeWav } from './helpers.js';

const FILES = ['Alpha - Sunrise.wav', 'Alpha - Noon.wav', 'Beta - Rain.wav', 'Gamma/Gamma - Snow.wav'];

test('setup, login, library, stream, likes, playlists, events, recommendations', async (t) => {
  const s = await startServer({ files: FILES });
  t.after(() => s.close());

  let r = await s.api('GET', '/api/info');
  assert.equal(r.json.setup, true);
  assert.equal(r.json.app, 'musik');

  r = await s.api('GET', '/api/tracks');
  assert.equal(r.status, 401);

  r = await s.api('POST', '/api/setup', { name: 'Sebastian', password: 'geheim1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.admin, true);
  s.setToken(r.json.token);

  r = await s.api('POST', '/api/setup', { name: 'x', password: 'yyyyy' });
  assert.equal(r.status, 409);

  r = await s.api('POST', '/api/login', { name: 'sebastian', password: 'falsch' });
  assert.equal(r.status, 401);
  r = await s.api('POST', '/api/login', { name: 'Sebastian', password: 'geheim1' });
  assert.equal(r.status, 200);
  s.setToken(r.json.token);

  r = await s.api('GET', '/api/library');
  assert.equal(r.json.tracks, 4);
  assert.equal(r.json.artists, 3);

  r = await s.api('GET', '/api/tracks?sort=title');
  assert.equal(r.json.total, 4);
  const byTitle = Object.fromEntries(r.json.items.map((x) => [x.title, x]));
  assert.equal(byTitle.Rain.artist, 'Beta');
  assert.ok(byTitle.Rain.duration > 1.9 && byTitle.Rain.duration < 2.1);

  r = await s.api('GET', '/api/tracks?q=alp%20noo');
  assert.equal(r.json.total, 1);
  assert.equal(r.json.items[0].title, 'Noon');
  r = await s.api('GET', '/api/tracks?q=' + encodeURIComponent('100%_'));
  assert.equal(r.json.total, 0);

  // streaming with range, token in query
  const rain = byTitle.Rain;
  const full = fs.readFileSync(path.join(s.music, 'Beta - Rain.wav'));
  let res = await fetch(`${s.base}/api/stream/${rain.id}`);
  assert.equal(res.status, 401);
  const tok = (await s.api('POST', '/api/login', { name: 'Sebastian', password: 'geheim1' })).json.token;
  res = await fetch(`${s.base}/api/stream/${rain.id}?t=${tok}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), full);
  res = await fetch(`${s.base}/api/stream/${rain.id}?t=${tok}`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 10-19/${full.length}`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), full.subarray(10, 20));
  res = await fetch(`${s.base}/api/stream/${rain.id}?t=${tok}`, { headers: { Range: 'bytes=-4' } });
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), full.subarray(full.length - 4));
  res = await fetch(`${s.base}/api/stream/${rain.id}?t=${tok}`, { headers: { Range: `bytes=${full.length}-` } });
  assert.equal(res.status, 416);

  // likes
  r = await s.api('PUT', `/api/likes/${rain.id}`);
  assert.equal(r.json.liked, true);
  r = await s.api('GET', '/api/likes');
  assert.deepEqual(r.json.map((x) => x.id), [rain.id]);
  assert.equal(r.json[0].liked, true);

  // playlists
  r = await s.api('POST', '/api/playlists', { name: 'Chill', trackIds: [byTitle.Snow.id] });
  const pid = r.json.id;
  r = await s.api('POST', `/api/playlists/${pid}/tracks`, { trackIds: [rain.id, 99999] });
  r = await s.api('GET', `/api/playlists/${pid}`);
  assert.deepEqual(r.json.tracks.map((x) => x.title), ['Snow', 'Rain']);
  r = await s.api('PUT', `/api/playlists/${pid}`, { name: 'Abend', trackIds: [rain.id] });
  r = await s.api('GET', '/api/playlists');
  assert.equal(r.json[0].name, 'Abend');
  assert.equal(r.json[0].tracks, 1);

  // events + recommendations
  r = await s.api('POST', '/api/events', {
    events: [
      { trackId: byTitle.Sunrise.id, kind: 'complete', played: 2, duration: 2 },
      { trackId: byTitle.Noon.id, kind: 'complete', played: 2, duration: 2 },
      { trackId: byTitle.Snow.id, kind: 'skip', played: 1, duration: 2 },
      { trackId: 123456, kind: 'complete' },
      { trackId: rain.id, kind: 'bogus' }
    ]
  });
  assert.equal(r.json.saved, 3);
  r = await s.api('GET', '/api/history');
  assert.equal(r.json.length, 3);
  r = await s.api('GET', '/api/recommend/mix?limit=10');
  assert.equal(r.json.length, 4);
  assert.equal(new Set(r.json.map((x) => x.id)).size, 4);
  r = await s.api('GET', `/api/recommend/radio/${byTitle.Sunrise.id}?limit=10`);
  assert.ok(r.json.length >= 2);
  assert.ok(!r.json.some((x) => x.id === byTitle.Sunrise.id));
  r = await s.api('POST', '/api/recommend/shuffle', { ids: [1, 2, 3, 4] });
  assert.deepEqual([...r.json.ids].sort(), [1, 2, 3, 4]);
  r = await s.api('GET', '/api/home');
  assert.equal(r.json.cold, false);
  assert.ok(r.json.recent.length >= 2);
  assert.ok(r.json.topArtists.includes('Alpha'));
});

test('users: admin creates user, user cannot admin', async (t) => {
  const s = await startServer({ files: ['A - B.wav'] });
  t.after(() => s.close());
  let r = await s.api('POST', '/api/setup', { name: 'admin', password: 'pass1' });
  s.setToken(r.json.token);
  r = await s.api('POST', '/api/users', { name: 'Lea', password: 'abcd' });
  assert.equal(r.status, 200);
  r = await s.api('POST', '/api/users', { name: 'lea', password: 'abcd' });
  assert.equal(r.status, 409);
  r = await s.api('POST', '/api/users', { name: 'x', password: 'abcd' });
  assert.equal(r.status, 400);
  r = await s.api('POST', '/api/login', { name: 'Lea', password: 'abcd' });
  s.setToken(r.json.token);
  r = await s.api('GET', '/api/users');
  assert.equal(r.status, 403);
  r = await s.api('PUT', '/api/me/password', { old: 'abcd', password: 'neues1' });
  assert.equal(r.status, 200);
  s.setToken(r.json.token);
  r = await s.api('GET', '/api/me');
  assert.equal(r.json.name, 'Lea');
  r = await s.api('POST', '/api/login', { name: 'Lea', password: 'abcd' });
  assert.equal(r.status, 401);
});

test('upload indexes the file, rescan picks up changes and removals', async (t) => {
  const s = await startServer({ files: ['One - First.wav'] });
  t.after(() => s.close());
  let r = await s.api('POST', '/api/setup', { name: 'admin', password: 'pass1' });
  s.setToken(r.json.token);
  const tmp = path.join(s.root, 'up.wav');
  const data = writeWav(tmp, 1);
  r = await s.api('POST', '/api/upload?name=' + encodeURIComponent('../Two - Second.wav'), data, { 'Content-Type': 'application/octet-stream' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.artist, 'Two');
  r = await s.api('POST', '/api/upload?name=evil.exe', data);
  assert.equal(r.status, 400);
  r = await s.api('GET', '/api/library');
  assert.equal(r.json.tracks, 2);
  assert.ok(!fs.existsSync(path.join(s.root, 'Two - Second.wav')));

  writeWav(path.join(s.music, 'Three - Third.wav'), 1);
  fs.rmSync(path.join(s.music, 'One - First.wav'));
  const scan = await s.app.library.scan();
  assert.equal(scan.added, 1);
  assert.equal(scan.removed, 1);
  assert.equal(scan.total, 2);
});

test('static web files and SPA fallback', async (t) => {
  const s = await startServer({ files: [], webDir: path.resolve(import.meta.dirname, '../../web') });
  t.after(() => s.close());
  let res = await fetch(s.base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<html/i);
  res = await fetch(s.base + '/../../etc/passwd');
  assert.notEqual(res.status, 500);
  res = await fetch(s.base + '/nope.js');
  assert.equal(res.status, 404);
  res = await fetch(s.base + '/api/info', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
