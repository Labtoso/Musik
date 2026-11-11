/**
 * Recommendation engine.
 *
 * Signals per user (with a half life of 30 days):
 *   - complete plays (+1), partial plays (+share played), early skips (-1), late skips (-0.3)
 *   - likes (+3, no decay)
 * From those it builds affinities for tracks, artists, albums and genres.
 * Across all users it learns which songs are heard after each other (co-listening),
 * which acts as collaborative filtering. Content similarity (artist, album, genre, year)
 * covers songs nobody has played yet.
 *
 * Results are diversified (no artist twice in a row, similar songs spread out).
 */

const DAY = 86400000;
const HALF_LIFE = 30 * DAY;
const SESSION_GAP = 45 * 60000;

export function splitGenres(g) {
  return String(g || '')
    .toLowerCase()
    .split(/[,;/|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function norm(map) {
  let max = 0;
  for (const v of map.values()) max = Math.max(max, Math.abs(v));
  if (max === 0) return map;
  const out = new Map();
  for (const [k, v] of map) out.set(k, v / max);
  return out;
}

function artistKey(t) {
  return (t.artist || t.album_artist || '').toLowerCase();
}

export function eventWeight(e) {
  if (e.kind === 'complete') return 1;
  if (e.kind === 'skip') {
    const early = e.played < 30 || (e.duration > 0 && e.played / e.duration < 0.25);
    return early ? -1 : -0.3;
  }
  // partial / play
  if (e.duration > 0) return Math.min(1, Math.max(0, e.played / e.duration));
  return 0.3;
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  const aa = artistKey(a);
  if (aa && aa === artistKey(b)) s += 0.5;
  if (a.album && a.album.toLowerCase() === (b.album || '').toLowerCase() && aa === artistKey(b)) s += 0.2;
  const ga = splitGenres(a.genre);
  const gb = splitGenres(b.genre);
  if (ga.length && gb.length) {
    const setB = new Set(gb);
    const inter = ga.filter((g) => setB.has(g)).length;
    const uni = new Set([...ga, ...gb]).size;
    s += 0.25 * (inter / uni);
  }
  if (a.year && b.year) s += 0.05 * Math.max(0, 1 - Math.abs(a.year - b.year) / 10);
  return s;
}

/** Small seeded random generator so tests can be deterministic. */
export function seededRandom(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export class Recommender {
  constructor(db, { random = Math.random, now = () => Date.now() } = {}) {
    this.db = db;
    this.random = random;
    this.now = now;
    this.cache = null;
  }

  invalidate() {
    this.cache = null;
  }

  #tracks() {
    const now = this.now();
    if (this.cache && now - this.cache.at < 60000) return this.cache;
    const rows = this.db
      .prepare('SELECT id, title, artist, album, album_artist, genre, year, duration, added, has_cover FROM tracks')
      .all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const co = this.#coListening(byId);
    const popularity = new Map();
    for (const r of this.db
      .prepare("SELECT track_id, COUNT(*) n FROM plays WHERE kind = 'complete' OR (duration > 0 AND played / duration > 0.5) GROUP BY track_id")
      .all()) {
      popularity.set(r.track_id, r.n);
    }
    this.cache = { at: now, rows, byId, co, popularity: norm(popularity) };
    return this.cache;
  }

  /** Songs heard after each other in one listening session, across all users. */
  #coListening(byId) {
    const events = this.db
      .prepare('SELECT user_id, track_id, ts, played, duration, kind FROM plays ORDER BY id DESC LIMIT 40000')
      .all()
      .reverse();
    const co = new Map();
    const add = (a, b, w) => {
      if (a === b || !byId.has(a) || !byId.has(b)) return;
      let m = co.get(a);
      if (!m) co.set(a, (m = new Map()));
      m.set(b, (m.get(b) || 0) + w);
    };
    const perUser = new Map();
    for (const e of events) {
      if (eventWeight(e) < 0.5) continue;
      let list = perUser.get(e.user_id);
      if (!list) perUser.set(e.user_id, (list = []));
      list.push(e);
    }
    for (const list of perUser.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let d = 1; d <= 3 && i + d < list.length; d++) {
          const a = list[i];
          const b = list[i + d];
          if (b.ts - a.ts > SESSION_GAP * d) break;
          const w = 1 / d;
          add(a.track_id, b.track_id, w);
          add(b.track_id, a.track_id, w);
        }
      }
    }
    return co;
  }

  /** Everything we know about one user's taste. */
  profile(userId) {
    const { byId } = this.#tracks();
    const now = this.now();
    const events = this.db
      .prepare('SELECT track_id, ts, played, duration, kind FROM plays WHERE user_id = ? ORDER BY ts DESC LIMIT 5000')
      .all(userId);
    const likes = this.db.prepare('SELECT track_id FROM likes WHERE user_id = ?').all(userId).map((r) => r.track_id);
    const trackAff = new Map();
    const lastPlayed = new Map();
    const playCount = new Map();
    for (const e of events) {
      if (!byId.has(e.track_id)) continue;
      const decay = Math.pow(0.5, Math.max(0, now - e.ts) / HALF_LIFE);
      trackAff.set(e.track_id, (trackAff.get(e.track_id) || 0) + eventWeight(e) * decay);
      if (!lastPlayed.has(e.track_id)) lastPlayed.set(e.track_id, e.ts);
      playCount.set(e.track_id, (playCount.get(e.track_id) || 0) + 1);
    }
    const liked = new Set(likes.filter((id) => byId.has(id)));
    for (const id of liked) trackAff.set(id, (trackAff.get(id) || 0) + 3);

    const artistAff = new Map();
    const albumAff = new Map();
    const genreAff = new Map();
    for (const [id, a] of trackAff) {
      const t = byId.get(id);
      const ak = artistKey(t);
      if (ak) artistAff.set(ak, (artistAff.get(ak) || 0) + a);
      if (t.album) {
        const k = ak + '\u0000' + t.album.toLowerCase();
        albumAff.set(k, (albumAff.get(k) || 0) + a);
      }
      for (const g of splitGenres(t.genre)) genreAff.set(g, (genreAff.get(g) || 0) + a);
    }
    return {
      trackAff,
      trackAffN: norm(trackAff),
      artistAff,
      artistAffN: norm(artistAff),
      albumAffN: norm(albumAff),
      genreAffN: norm(genreAff),
      lastPlayed,
      playCount,
      liked,
      cold: events.length === 0 && liked.size === 0
    };
  }

  /** Base score of a track for a user, without randomness. */
  #score(t, p, ctx, collab) {
    const now = this.now();
    const ak = artistKey(t);
    let s = 0;
    let reason = 'new';
    let best = 0;
    const parts = [
      ['artist', 1.0 * (p.artistAffN.get(ak) || 0)],
      ['genre', 0.6 * Math.max(0, ...splitGenres(t.genre).map((g) => p.genreAffN.get(g) || 0))],
      ['album', 0.3 * (p.albumAffN.get(ak + '\u0000' + (t.album || '').toLowerCase()) || 0)],
      ['collab', 0.9 * (collab.get(t.id) || 0)],
      ['favorite', 0.8 * (p.trackAffN.get(t.id) || 0)]
    ];
    for (const [k, v] of parts) {
      s += v;
      if (v > best) {
        best = v;
        reason = k;
      }
    }
    if (p.cold) s += 0.6 * (ctx.popularity.get(t.id) || 0);
    if (!p.lastPlayed.has(t.id)) s += 0.15;
    if (now - t.added < 14 * DAY) s += 0.1;
    const last = p.lastPlayed.get(t.id);
    if (last) {
      const age = now - last;
      if (age < 2 * 3600000) s -= 1;
      else if (age < DAY) s -= 0.5;
      else if (age < 3 * DAY) s -= 0.2;
    }
    return { score: s, reason };
  }

  #collab(p, ctx, seeds) {
    const out = new Map();
    for (const [id, w] of seeds) {
      if (w <= 0) continue;
      const m = ctx.co.get(id);
      if (!m) continue;
      for (const [other, c] of m) out.set(other, (out.get(other) || 0) + c * w);
    }
    return norm(out);
  }

  /** Greedy re-ranking: keeps the score order but spreads artists and similar songs. */
  diversify(cands, limit) {
    const pool = [...cands];
    const out = [];
    const artistCount = new Map();
    while (out.length < limit && pool.length) {
      let bestI = -1;
      let bestV = -Infinity;
      const recent = out.slice(-5);
      const lastArtist = out.length ? artistKey(out[out.length - 1].track) : null;
      for (let i = 0; i < pool.length && i < 400; i++) {
        const c = pool[i];
        const ak = artistKey(c.track);
        let v = c.score;
        let maxSim = 0;
        for (const r of recent) maxSim = Math.max(maxSim, similarity(c.track, r.track));
        v -= 0.35 * maxSim;
        v -= 0.25 * (artistCount.get(ak) || 0);
        if (ak && ak === lastArtist) v -= 10;
        if (v > bestV) {
          bestV = v;
          bestI = i;
        }
      }
      const [pick] = pool.splice(bestI, 1);
      out.push(pick);
      const ak = artistKey(pick.track);
      artistCount.set(ak, (artistCount.get(ak) || 0) + 1);
    }
    return out;
  }

  /** "Mix für dich": personal mix from the whole library. */
  mix(userId, limit = 50) {
    const ctx = this.#tracks();
    const p = this.profile(userId);
    const collab = this.#collab(p, ctx, p.trackAff);
    const cands = [];
    for (const t of ctx.rows) {
      if ((p.trackAff.get(t.id) || 0) <= -1.5) continue; // skipped again and again
      const { score, reason } = this.#score(t, p, ctx, collab);
      cands.push({ track: t, score: score + this.random() * 0.15, reason });
    }
    cands.sort((a, b) => b.score - a.score);
    return this.diversify(cands.slice(0, Math.max(limit * 4, 100)), limit).map((c) => ({ id: c.track.id, reason: c.reason }));
  }

  /** Radio: endless list of songs that fit a seed song. */
  radio(userId, seedId, limit = 50, exclude = []) {
    const ctx = this.#tracks();
    const seed = ctx.byId.get(Number(seedId));
    if (!seed) return [];
    const p = this.profile(userId);
    const coSeed = norm(ctx.co.get(seed.id) || new Map());
    const collab = this.#collab(p, ctx, p.trackAff);
    const skip = new Set(exclude.map(Number));
    const cands = [];
    for (const t of ctx.rows) {
      if (t.id === seed.id || skip.has(t.id)) continue;
      if ((p.trackAff.get(t.id) || 0) <= -1.5) continue;
      const sim = similarity(seed, t);
      const co = coSeed.get(t.id) || 0;
      const base = this.#score(t, p, ctx, collab).score;
      const score = 1.2 * sim + 1.0 * co + 0.4 * base + this.random() * 0.1;
      cands.push({ track: t, score, reason: co > sim ? 'collab' : 'similar' });
    }
    cands.sort((a, b) => b.score - a.score);
    return this.diversify(cands.slice(0, Math.max(limit * 4, 100)), limit).map((c) => ({ id: c.track.id, reason: c.reason }));
  }

  /** Songs most similar to one song (no randomness). */
  similar(seedId, limit = 20) {
    const ctx = this.#tracks();
    const seed = ctx.byId.get(Number(seedId));
    if (!seed) return [];
    const coSeed = norm(ctx.co.get(seed.id) || new Map());
    return ctx.rows
      .filter((t) => t.id !== seed.id)
      .map((t) => ({ id: t.id, score: similarity(seed, t) + (coSeed.get(t.id) || 0) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((c) => c.id);
  }

  /**
   * Smart shuffle: weighted random order (favourites come earlier more often),
   * and never the same artist twice in a row when it can be avoided.
   */
  shuffle(userId, ids) {
    const ctx = this.#tracks();
    const p = this.profile(userId);
    const keyed = ids
      .map(Number)
      .filter((id) => ctx.byId.has(id))
      .map((id) => {
        const a = Math.max(-1, Math.min(1, p.trackAffN.get(id) || 0));
        const art = p.artistAffN.get(artistKey(ctx.byId.get(id))) || 0;
        const w = Math.exp(0.8 * a + 0.4 * art);
        return { id, key: Math.pow(this.random() || 1e-9, 1 / w) };
      })
      .sort((a, b) => b.key - a.key)
      .map((x) => x.id);
    // Spread artists: if two neighbours share an artist, swap with the next different one.
    for (let i = 1; i < keyed.length; i++) {
      const prev = artistKey(ctx.byId.get(keyed[i - 1]));
      if (!prev || artistKey(ctx.byId.get(keyed[i])) !== prev) continue;
      for (let j = i + 1; j < keyed.length; j++) {
        if (artistKey(ctx.byId.get(keyed[j])) !== prev) {
          [keyed[i], keyed[j]] = [keyed[j], keyed[i]];
          break;
        }
      }
    }
    return keyed;
  }

  /** Data for the start page. */
  home(userId) {
    const ctx = this.#tracks();
    const p = this.profile(userId);
    const now = this.now();
    const recent = [];
    const seen = new Set();
    for (const r of this.db
      .prepare('SELECT track_id FROM plays WHERE user_id = ? ORDER BY ts DESC LIMIT 200')
      .all(userId)) {
      if (seen.has(r.track_id) || !ctx.byId.has(r.track_id)) continue;
      seen.add(r.track_id);
      recent.push(r.track_id);
      if (recent.length >= 12) break;
    }
    const names = new Map();
    for (const t of ctx.rows) {
      const k = artistKey(t);
      if (k && !names.has(k)) names.set(k, t.artist || t.album_artist);
    }
    const topArtists = [...p.artistAff.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k]) => names.get(k))
      .filter(Boolean);
    const rediscover = [...p.trackAff.entries()]
      .filter(([id, v]) => v > 1 && now - (p.lastPlayed.get(id) || 0) > 30 * DAY)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([id]) => id);
    const albums = this.db
      .prepare(
        `SELECT album, COALESCE(NULLIF(album_artist,''), artist) AS artist, MIN(id) AS cover_id, MAX(added) AS added
         FROM tracks WHERE album <> '' GROUP BY album, COALESCE(NULLIF(album_artist,''), artist)
         ORDER BY added DESC LIMIT 12`
      )
      .all();
    return { cold: p.cold, recent, mix: this.mix(userId, 12), topArtists, rediscover, newAlbums: albums };
  }
}
