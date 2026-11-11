import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { openDb, tx } from './db.js';
import { Auth } from './auth.js';
import { Library, AUDIO_TYPES, isAudio } from './library.js';
import { Recommender } from './recommend.js';

export const VERSION = '1.0.0';

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json'
};

const TRACK_COLS = 'id, title, artist, album, album_artist, genre, year, track_no, disc_no, duration, has_cover, added';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

async function readJson(req, limit = 1 << 20) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too_large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

function int(v, def, min = 0, max = 1e9) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return base.slice(0, 180);
}

export function createApp(config = {}) {
  const dataDir = config.dataDir ?? null;
  const db = config.db ?? openDb(dataDir);
  const uploadDir = config.uploadDir ?? (dataDir ? path.join(dataDir, 'uploads') : null);
  const library = new Library(db, {
    musicDirs: config.musicDirs ?? [],
    uploadDir,
    cacheDir: dataDir ? path.join(dataDir, 'covers') : null
  });
  const auth = new Auth(db);
  const rec = new Recommender(db, config.recommender ?? {});
  const webDir = config.webDir ?? null;
  const serverName = config.name || 'Musik';

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$'
    );
    routes.push({ method, re, keys, handler, auth: opts.auth ?? 'user' });
  };

  const tracksByIds = (ids) => {
    if (!ids.length) return [];
    const rows = db.prepare(`SELECT ${TRACK_COLS} FROM tracks WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const m = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => m.get(id)).filter(Boolean);
  };
  const withLikes = (user, tracks) => {
    const liked = new Set(db.prepare('SELECT track_id FROM likes WHERE user_id = ?').all(user.id).map((r) => r.track_id));
    return tracks.map((t) => ({ ...t, has_cover: !!t.has_cover, liked: liked.has(t.id) }));
  };
  const getPlaylist = (user, id) => {
    const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
    if (!pl || pl.user_id !== user.id) throw new HttpError(404, 'not_found');
    return pl;
  };

  // ---------- public ----------
  route('GET', '/api/info', () => ({ name: serverName, app: 'musik', version: VERSION, setup: auth.needsSetup() }), { auth: 'none' });

  route(
    'POST',
    '/api/setup',
    async ({ req }) => {
      if (!auth.needsSetup()) throw new HttpError(409, 'already_setup');
      const b = await readJson(req);
      const user = auth.createUser(b.name, b.password, true);
      return { token: auth.issue(user.id, b.client), user };
    },
    { auth: 'none' }
  );

  route(
    'POST',
    '/api/login',
    async ({ req }) => {
      const b = await readJson(req);
      return auth.login(b.name, b.password, b.client);
    },
    { auth: 'none' }
  );

  // ---------- account ----------
  route('POST', '/api/logout', ({ token }) => {
    auth.logout(token);
    return { ok: true };
  });
  route('GET', '/api/me', ({ user }) => user);
  route('PUT', '/api/me/password', async ({ req, user }) => {
    const b = await readJson(req);
    const row = db.prepare('SELECT name FROM users WHERE id = ?').get(user.id);
    auth.login(row.name, b.old); // throws on wrong password
    auth.setPassword(user.id, b.password);
    return { token: auth.issue(user.id, b.client), user };
  });

  // ---------- admin ----------
  route('GET', '/api/users', () => auth.users(), { auth: 'admin' });
  route(
    'POST',
    '/api/users',
    async ({ req }) => {
      const b = await readJson(req);
      return auth.createUser(b.name, b.password, !!b.admin);
    },
    { auth: 'admin' }
  );
  route(
    'DELETE',
    '/api/users/:id',
    ({ params, user }) => {
      const id = int(params.id, 0);
      if (id === user.id) throw new HttpError(400, 'cannot_delete_self');
      auth.deleteUser(id);
      return { ok: true };
    },
    { auth: 'admin' }
  );
  route(
    'POST',
    '/api/library/scan',
    () => {
      library.scan().then(() => rec.invalidate(), () => {});
      return { scanning: true };
    },
    { auth: 'admin' }
  );

  // ---------- library ----------
  route('GET', '/api/library', () => {
    const s = db
      .prepare(
        "SELECT COUNT(*) tracks, COUNT(DISTINCT NULLIF(artist,'')) artists, COUNT(DISTINCT NULLIF(album,'')) albums, COALESCE(SUM(duration),0) duration FROM tracks"
      )
      .get();
    return { ...s, scanning: !!library.scanning, progress: library.progress, lastScan: library.lastScan, dirs: library.roots() };
  });

  route('GET', '/api/tracks', ({ url, user }) => {
    const q = (url.searchParams.get('q') || '').trim();
    const limit = int(url.searchParams.get('limit'), 100, 1, 1000);
    const offset = int(url.searchParams.get('offset'), 0);
    const sorts = {
      title: 'title COLLATE NOCASE',
      artist: 'artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no',
      added: 'added DESC, id DESC',
      album: 'album COLLATE NOCASE, disc_no, track_no'
    };
    const order = sorts[url.searchParams.get('sort')] || sorts.artist;
    let where = '';
    const args = [];
    if (q) {
      const words = q.split(/\s+/).slice(0, 6);
      where =
        'WHERE ' +
        words
          .map(() => "(title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\' OR genre LIKE ? ESCAPE '\\')")
          .join(' AND ');
      for (const w of words) {
        const like = '%' + w.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
        args.push(like, like, like, like);
      }
    }
    const total = db.prepare(`SELECT COUNT(*) n FROM tracks ${where}`).get(...args).n;
    const rows = db.prepare(`SELECT ${TRACK_COLS} FROM tracks ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { total, items: withLikes(user, rows) };
  });

  route('GET', '/api/tracks/:id', ({ params, user }) => {
    const t = tracksByIds([int(params.id, 0)])[0];
    if (!t) throw new HttpError(404, 'not_found');
    return withLikes(user, [t])[0];
  });

  route('POST', '/api/tracks/batch', async ({ req, user }) => {
    const b = await readJson(req);
    const ids = (Array.isArray(b.ids) ? b.ids : []).slice(0, 2000).map((x) => int(x, 0));
    return withLikes(user, tracksByIds(ids));
  });

  route('GET', '/api/albums', () =>
    db
      .prepare(
        `SELECT album, COALESCE(NULLIF(album_artist,''), artist) AS artist, COUNT(*) tracks, MIN(year) year,
                MIN(CASE WHEN has_cover THEN id END) cover_id, MIN(id) first_id, MAX(added) added
         FROM tracks WHERE album <> '' GROUP BY album COLLATE NOCASE, COALESCE(NULLIF(album_artist,''), artist) COLLATE NOCASE
         ORDER BY artist COLLATE NOCASE, year, album COLLATE NOCASE`
      )
      .all()
      .map((a) => ({ ...a, cover_id: a.cover_id ?? a.first_id }))
  );

  route('GET', '/api/album', ({ url, user }) => {
    const album = url.searchParams.get('album') || '';
    const artist = url.searchParams.get('artist') || '';
    const rows = db
      .prepare(
        `SELECT ${TRACK_COLS} FROM tracks WHERE album = ? COLLATE NOCASE AND COALESCE(NULLIF(album_artist,''), artist) = ? COLLATE NOCASE
         ORDER BY disc_no, track_no, title COLLATE NOCASE`
      )
      .all(album, artist);
    return { album, artist, tracks: withLikes(user, rows) };
  });

  route('GET', '/api/artists', () =>
    db
      .prepare(
        `SELECT artist AS name, COUNT(*) tracks, COUNT(DISTINCT NULLIF(album,'')) albums,
                MIN(CASE WHEN has_cover THEN id END) cover_id, MIN(id) first_id
         FROM tracks WHERE artist <> '' GROUP BY artist COLLATE NOCASE ORDER BY artist COLLATE NOCASE`
      )
      .all()
      .map((a) => ({ ...a, cover_id: a.cover_id ?? a.first_id }))
  );

  route('GET', '/api/artist', ({ url, user }) => {
    const name = url.searchParams.get('name') || '';
    const rows = db
      .prepare(`SELECT ${TRACK_COLS} FROM tracks WHERE artist = ? COLLATE NOCASE OR album_artist = ? COLLATE NOCASE ORDER BY year, album COLLATE NOCASE, disc_no, track_no`)
      .all(name, name);
    const plays = new Map(
      db
        .prepare(
          `SELECT track_id, COUNT(*) n FROM plays WHERE user_id = ? AND track_id IN (SELECT id FROM tracks WHERE artist = ? COLLATE NOCASE) GROUP BY track_id`
        )
        .all(user.id, name)
        .map((r) => [r.track_id, r.n])
    );
    const top = [...rows].sort((a, b) => (plays.get(b.id) || 0) - (plays.get(a.id) || 0)).slice(0, 10);
    return { name, tracks: withLikes(user, rows), top: withLikes(user, top) };
  });

  // ---------- media ----------
  route(
    'GET',
    '/api/stream/:id',
    async ({ req, res, params }) => {
      const t = db.prepare('SELECT path FROM tracks WHERE id = ?').get(int(params.id, 0));
      if (!t) throw new HttpError(404, 'not_found');
      let stat;
      try {
        stat = await fsp.stat(t.path);
      } catch {
        throw new HttpError(404, 'file_missing');
      }
      const type = AUDIO_TYPES[path.extname(t.path).toLowerCase()] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
      const range = req.headers.range;
      let start = 0;
      let end = stat.size - 1;
      let status = 200;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!m || (m[1] === '' && m[2] === '')) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }
        if (m[1] === '') {
          start = Math.max(0, stat.size - Number(m[2]));
        } else {
          start = Number(m[1]);
          if (m[2] !== '') end = Math.min(end, Number(m[2]));
        }
        if (start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length'] = end - start + 1;
      res.writeHead(status, headers);
      if (req.method === 'HEAD') return res.end();
      await pipeline(fs.createReadStream(t.path, { start, end }), res).catch(() => {});
    },
    { auth: 'query' }
  );

  route(
    'GET',
    '/api/cover/:id',
    async ({ res, params }) => {
      const t = db.prepare('SELECT id, path, mtime, has_cover FROM tracks WHERE id = ?').get(int(params.id, 0));
      if (!t) throw new HttpError(404, 'not_found');
      const c = await library.cover(t);
      if (!c) throw new HttpError(404, 'no_cover');
      res.writeHead(200, { 'Content-Type': c.type, 'Content-Length': c.data.length, 'Cache-Control': 'private, max-age=604800' });
      res.end(c.data);
    },
    { auth: 'query' }
  );

  route('POST', '/api/upload', async ({ req, url }) => {
    if (!uploadDir) throw new HttpError(400, 'no_upload_dir');
    const name = safeName(url.searchParams.get('name'));
    if (!name || !isAudio(name)) throw new HttpError(400, 'unsupported_type');
    const max = 1024 * 1024 * 1024;
    if (Number(req.headers['content-length'] || 0) > max) throw new HttpError(413, 'too_large');
    await fsp.mkdir(uploadDir, { recursive: true });
    let target = path.join(uploadDir, name);
    const ext = path.extname(name);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(uploadDir, `${path.basename(name, ext)} (${i})${ext}`);
    let size = 0;
    const tmp = target + '.part';
    const out = fs.createWriteStream(tmp);
    try {
      await pipeline(
        req,
        async function* (src) {
          for await (const c of src) {
            size += c.length;
            if (size > max) throw new HttpError(413, 'too_large');
            yield c;
          }
        },
        out
      );
      await fsp.rename(tmp, target);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    const track = await library.addFile(target);
    rec.invalidate();
    return { id: track.id, title: track.title, artist: track.artist };
  });

  // ---------- likes ----------
  route('GET', '/api/likes', ({ user }) => {
    const ids = db.prepare('SELECT track_id FROM likes WHERE user_id = ? ORDER BY created DESC').all(user.id).map((r) => r.track_id);
    return withLikes(user, tracksByIds(ids));
  });
  route('PUT', '/api/likes/:id', ({ user, params }) => {
    const id = int(params.id, 0);
    if (!db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(id)) throw new HttpError(404, 'not_found');
    db.prepare('INSERT OR IGNORE INTO likes (user_id, track_id, created) VALUES (?,?,?)').run(user.id, id, Date.now());
    return { liked: true };
  });
  route('DELETE', '/api/likes/:id', ({ user, params }) => {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND track_id = ?').run(user.id, int(params.id, 0));
    return { liked: false };
  });

  // ---------- playlists ----------
  route('GET', '/api/playlists', ({ user }) =>
    db
      .prepare(
        `SELECT p.id, p.name, p.updated, COUNT(pt.track_id) tracks, MIN(pt.track_id) cover_id
         FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
         WHERE p.user_id = ? GROUP BY p.id ORDER BY p.updated DESC`
      )
      .all(user.id)
  );
  route('POST', '/api/playlists', async ({ req, user }) => {
    const b = await readJson(req);
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'name_required');
    const now = Date.now();
    const r = db.prepare('INSERT INTO playlists (user_id, name, created, updated) VALUES (?,?,?,?)').run(user.id, name, now, now);
    const id = Number(r.lastInsertRowid);
    if (Array.isArray(b.trackIds)) setPlaylistTracks(id, b.trackIds);
    return { id, name };
  });
  const setPlaylistTracks = (id, ids) => {
    tx(db, () => {
      db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id);
      const ins = db.prepare('INSERT INTO playlist_tracks (playlist_id, pos, track_id) VALUES (?,?,?)');
      ids.slice(0, 5000).forEach((t, i) => ins.run(id, i, int(t, 0)));
      db.prepare('UPDATE playlists SET updated = ? WHERE id = ?').run(Date.now(), id);
    });
  };
  const playlistIds = (id) =>
    db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos').all(id).map((r) => r.track_id);
  route('GET', '/api/playlists/:id', ({ user, params }) => {
    const pl = getPlaylist(user, int(params.id, 0));
    return { id: pl.id, name: pl.name, tracks: withLikes(user, tracksByIds(playlistIds(pl.id))) };
  });
  route('PUT', '/api/playlists/:id', async ({ req, user, params }) => {
    const pl = getPlaylist(user, int(params.id, 0));
    const b = await readJson(req);
    if (typeof b.name === 'string' && b.name.trim()) {
      db.prepare('UPDATE playlists SET name = ?, updated = ? WHERE id = ?').run(b.name.trim().slice(0, 80), Date.now(), pl.id);
    }
    if (Array.isArray(b.trackIds)) setPlaylistTracks(pl.id, b.trackIds);
    return { ok: true };
  });
  route('POST', '/api/playlists/:id/tracks', async ({ req, user, params }) => {
    const pl = getPlaylist(user, int(params.id, 0));
    const b = await readJson(req);
    const ids = (Array.isArray(b.trackIds) ? b.trackIds : []).map((x) => int(x, 0));
    const valid = new Set(tracksByIds(ids).map((t) => t.id));
    setPlaylistTracks(pl.id, [...playlistIds(pl.id), ...ids.filter((x) => valid.has(x))]);
    return { ok: true };
  });
  route('DELETE', '/api/playlists/:id', ({ user, params }) => {
    const pl = getPlaylist(user, int(params.id, 0));
    db.prepare('DELETE FROM playlists WHERE id = ?').run(pl.id);
    return { ok: true };
  });

  // ---------- listening events + recommendations ----------
  route('POST', '/api/events', async ({ req, user }) => {
    const b = await readJson(req);
    const list = Array.isArray(b.events) ? b.events : [b];
    const ins = db.prepare('INSERT INTO plays (user_id, track_id, ts, played, duration, kind) VALUES (?,?,?,?,?,?)');
    let n = 0;
    tx(db, () => {
      for (const e of list.slice(0, 200)) {
        const id = int(e.trackId, 0);
        const kind = ['complete', 'skip', 'partial'].includes(e.kind) ? e.kind : null;
        if (!kind || !db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(id)) continue;
        const ts = Number.isFinite(e.ts) && Math.abs(Date.now() - e.ts) < 30 * 86400000 ? e.ts : Date.now();
        ins.run(user.id, id, ts, Math.max(0, Number(e.played) || 0), Math.max(0, Number(e.duration) || 0), kind);
        n++;
      }
    });
    return { saved: n };
  });

  route('GET', '/api/history', ({ user, url }) => {
    const limit = int(url.searchParams.get('limit'), 50, 1, 500);
    const rows = db
      .prepare('SELECT track_id, ts, kind FROM plays WHERE user_id = ? ORDER BY ts DESC LIMIT ?')
      .all(user.id, limit);
    const tracks = new Map(withLikes(user, tracksByIds([...new Set(rows.map((r) => r.track_id))])).map((t) => [t.id, t]));
    return rows.filter((r) => tracks.has(r.track_id)).map((r) => ({ ts: r.ts, kind: r.kind, track: tracks.get(r.track_id) }));
  });

  const recTracks = (user, list) => {
    const tracks = new Map(withLikes(user, tracksByIds(list.map((x) => x.id))).map((t) => [t.id, t]));
    return list.filter((x) => tracks.has(x.id)).map((x) => ({ ...tracks.get(x.id), reason: x.reason }));
  };
  route('GET', '/api/recommend/mix', ({ user, url }) => recTracks(user, rec.mix(user.id, int(url.searchParams.get('limit'), 50, 1, 300))));
  route('GET', '/api/recommend/radio/:id', ({ user, params, url }) => {
    const exclude = (url.searchParams.get('exclude') || '').split(',').filter(Boolean);
    return recTracks(user, rec.radio(user.id, int(params.id, 0), int(url.searchParams.get('limit'), 50, 1, 300), exclude));
  });
  route('GET', '/api/recommend/similar/:id', ({ user, params }) => withLikes(user, tracksByIds(rec.similar(int(params.id, 0)))));
  route('POST', '/api/recommend/shuffle', async ({ req, user }) => {
    const b = await readJson(req);
    return { ids: rec.shuffle(user.id, Array.isArray(b.ids) ? b.ids.slice(0, 5000) : []) };
  });
  route('GET', '/api/home', ({ user }) => {
    const h = rec.home(user.id);
    return {
      cold: h.cold,
      recent: withLikes(user, tracksByIds(h.recent)),
      mix: recTracks(user, h.mix),
      rediscover: withLikes(user, tracksByIds(h.rediscover)),
      topArtists: h.topArtists,
      newAlbums: h.newAlbums
    };
  });

  // ---------- handler ----------
  const serveStatic = async (req, res, pathname) => {
    if (!webDir) return false;
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    let file = path.resolve(webDir, rel);
    if (!file.startsWith(path.resolve(webDir))) return false;
    let stat = await fsp.stat(file).catch(() => null);
    if (stat?.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fsp.stat(file).catch(() => null);
    }
    if (!stat) {
      if (path.extname(rel)) return false;
      file = path.join(webDir, 'index.html');
      stat = await fsp.stat(file).catch(() => null);
      if (!stat) return false;
    }
    const type = STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end(), true;
    await pipeline(fs.createReadStream(file), res).catch(() => {});
    return true;
  };

  const handler = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Max-Age': '86400' });
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const method = req.method === 'HEAD' ? 'GET' : req.method;
        for (const r of routes) {
          if (r.method !== method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const params = {};
          r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
          let user = null;
          let token = null;
          if (r.auth !== 'none') {
            const h = req.headers.authorization || '';
            token = h.startsWith('Bearer ') ? h.slice(7) : null;
            if (!token && r.auth === 'query') token = url.searchParams.get('t');
            user = auth.verify(token);
            if (!user) throw new HttpError(401, 'unauthorized');
            if (r.auth === 'admin' && !user.admin) throw new HttpError(403, 'forbidden');
          }
          const result = await r.handler({ req, res, url, params, user, token });
          if (!res.headersSent && !res.writableEnded) send(res, 200, result);
          return;
        }
        throw new HttpError(404, 'not_found');
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(req, res, url.pathname))) return;
      throw new HttpError(404, 'not_found');
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: e.message || 'error' });
      else res.destroy();
    }
  };

  return { handler, db, auth, library, rec };
}
