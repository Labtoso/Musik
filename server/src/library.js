import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { tx } from './db.js';

export const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm'
};

const COVER_FILES = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'front.png', 'album.jpg', 'album.png'];

export function isAudio(file) {
  return Object.hasOwn(AUDIO_TYPES, path.extname(file).toLowerCase());
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && isAudio(e.name)) yield full;
  }
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

function cleanText(v) {
  return (v == null ? '' : String(v)).replace(/\u0000/g, '').trim();
}

/** Reads tags of one file. Falls back to "Artist - Title" in the file name. */
export async function readTags(file) {
  const base = path.basename(file, path.extname(file));
  let meta = null;
  try {
    meta = await parseFile(file, { duration: true, skipCovers: false });
  } catch {
    meta = null;
  }
  const c = meta?.common ?? {};
  let title = cleanText(c.title);
  let artist = cleanText(c.artist || first(c.artists));
  if (!title) {
    const m = base.match(/^\s*(?:\d+[\s.-]+)?(.+?)\s+-\s+(.+)$/);
    if (m && !artist) {
      artist = m[1].trim();
      title = m[2].trim();
    } else {
      title = base.replace(/^\s*\d+[\s.-]+/, '').trim() || base;
    }
  }
  return {
    title,
    artist,
    album: cleanText(c.album),
    album_artist: cleanText(c.albumartist),
    genre: cleanText(first(c.genre)),
    year: Number.isInteger(c.year) ? c.year : null,
    track_no: c.track?.no ?? null,
    disc_no: c.disk?.no ?? null,
    duration: Number(meta?.format?.duration) || 0,
    has_cover: c.picture && c.picture.length ? 1 : 0
  };
}

export class Library {
  constructor(db, { musicDirs = [], uploadDir = null, cacheDir = null } = {}) {
    this.db = db;
    this.musicDirs = musicDirs.filter(Boolean);
    this.uploadDir = uploadDir;
    this.cacheDir = cacheDir;
    this.scanning = null;
    this.lastScan = null;
    this.progress = { done: 0, found: 0 };
  }

  roots() {
    const r = [...this.musicDirs];
    if (this.uploadDir && !r.includes(this.uploadDir)) r.push(this.uploadDir);
    return r;
  }

  /** Full scan; only changed files are parsed again. */
  scan() {
    if (!this.scanning) {
      this.scanning = this.#doScan().finally(() => {
        this.scanning = null;
      });
    }
    return this.scanning;
  }

  async #doScan() {
    const started = Date.now();
    const db = this.db;
    const known = new Map();
    for (const r of db.prepare('SELECT id, path, mtime, size FROM tracks').all()) known.set(r.path, r);
    const seen = new Set();
    let added = 0;
    let updated = 0;
    this.progress = { done: 0, found: 0 };
    const batch = [];
    const flush = () => {
      if (!batch.length) return;
      tx(db, () => {
        for (const item of batch) this.#upsert(item.file, item.stat, item.tags);
      });
      batch.length = 0;
    };
    for (const root of this.roots()) {
      if (!fs.existsSync(root)) continue;
      for await (const file of walk(root)) {
        this.progress.found++;
        seen.add(file);
        let stat;
        try {
          stat = await fsp.stat(file);
        } catch {
          continue;
        }
        const k = known.get(file);
        const mtime = Math.floor(stat.mtimeMs);
        if (k && k.mtime === mtime && k.size === stat.size) {
          this.progress.done++;
          continue;
        }
        const tags = await readTags(file);
        batch.push({ file, stat, tags });
        if (k) updated++;
        else added++;
        this.progress.done++;
        if (batch.length >= 200) flush();
      }
    }
    flush();
    // Remove files that are gone (only inside the scanned roots).
    const roots = this.roots().map((r) => path.resolve(r) + path.sep);
    let removed = 0;
    const del = db.prepare('DELETE FROM tracks WHERE id = ?');
    tx(db, () => {
      for (const [p, row] of known) {
        if (seen.has(p)) continue;
        if (!roots.some((r) => path.resolve(p).startsWith(r))) continue;
        if (fs.existsSync(p)) continue;
        del.run(row.id);
        removed++;
      }
    });
    this.lastScan = { at: Date.now(), ms: Date.now() - started, added, updated, removed, total: this.count() };
    return this.lastScan;
  }

  #upsert(file, stat, tags) {
    this.db
      .prepare(
        `INSERT INTO tracks (path, title, artist, album, album_artist, genre, year, track_no, disc_no, duration, size, mtime, has_cover, added)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album,
           album_artist=excluded.album_artist, genre=excluded.genre, year=excluded.year, track_no=excluded.track_no,
           disc_no=excluded.disc_no, duration=excluded.duration, size=excluded.size, mtime=excluded.mtime, has_cover=excluded.has_cover`
      )
      .run(
        file,
        tags.title,
        tags.artist,
        tags.album,
        tags.album_artist,
        tags.genre,
        tags.year,
        tags.track_no,
        tags.disc_no,
        tags.duration,
        stat.size,
        Math.floor(stat.mtimeMs),
        tags.has_cover,
        Date.now()
      );
    return this.db.prepare('SELECT * FROM tracks WHERE path = ?').get(file);
  }

  /** Indexes a single file right away (used after an upload). */
  async addFile(file) {
    const stat = await fsp.stat(file);
    const tags = await readTags(file);
    return this.#upsert(file, stat, tags);
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) n FROM tracks').get().n;
  }

  /** Returns { data, type } for the cover of a track or null. */
  async cover(track) {
    if (this.cacheDir) {
      const cached = path.join(this.cacheDir, `${track.id}-${track.mtime}`);
      for (const ext of ['.jpg', '.png']) {
        if (fs.existsSync(cached + ext)) {
          return { data: await fsp.readFile(cached + ext), type: ext === '.png' ? 'image/png' : 'image/jpeg' };
        }
      }
    }
    let result = null;
    if (track.has_cover) {
      try {
        const meta = await parseFile(track.path, { duration: false, skipCovers: false });
        const pic = meta.common.picture?.find((p) => /front/i.test(p.type || '')) ?? meta.common.picture?.[0];
        if (pic) result = { data: Buffer.from(pic.data), type: pic.format?.includes('png') ? 'image/png' : 'image/jpeg' };
      } catch {
        result = null;
      }
    }
    if (!result) {
      const dir = path.dirname(track.path);
      let names = [];
      try {
        names = await fsp.readdir(dir);
      } catch {
        names = [];
      }
      const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
      for (const c of COVER_FILES) {
        if (lower.has(c)) {
          result = { data: await fsp.readFile(path.join(dir, lower.get(c))), type: c.endsWith('.png') ? 'image/png' : 'image/jpeg' };
          break;
        }
      }
    }
    if (result && this.cacheDir) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const ext = result.type === 'image/png' ? '.png' : '.jpg';
      await fsp.writeFile(path.join(this.cacheDir, `${track.id}-${track.mtime}${ext}`), result.data).catch(() => {});
    }
    return result;
  }
}
