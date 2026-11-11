//! Recommendation engine.
//!
//! Signals per user (half life 30 days): complete plays (+1), partial plays (+share played),
//! early skips (-1), late skips (-0.3), likes (+3, no decay). From those it builds affinities for
//! tracks, artists, albums and genres. Across all users it learns which songs are heard after each
//! other (co-listening = collaborative filtering). Content similarity (artist, album, genre, year)
//! covers songs nobody has played yet. Results are diversified: no artist twice in a row, similar
//! songs spread out.

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

const DAY: i64 = 86_400_000;
const HALF_LIFE: f64 = 30.0 * DAY as f64;
const SESSION_GAP: i64 = 45 * 60_000;

#[derive(Debug, Clone)]
pub struct Track {
    pub id: i64,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub year: Option<i64>,
    pub added: i64,
}

#[derive(Debug, Clone)]
pub struct Event {
    pub track_id: i64,
    pub ts: i64,
    pub played: f64,
    pub duration: f64,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Pick {
    pub id: i64,
    pub reason: &'static str,
}

pub fn split_genres(g: &str) -> Vec<String> {
    g.to_lowercase()
        .split(|c| c == ',' || c == ';' || c == '/' || c == '|')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn artist_key(t: &Track) -> String {
    if !t.artist.is_empty() { t.artist.to_lowercase() } else { t.album_artist.to_lowercase() }
}

pub fn event_weight(e: &Event) -> f64 {
    match e.kind.as_str() {
        "complete" => 1.0,
        "skip" => {
            let early = e.played < 30.0 || (e.duration > 0.0 && e.played / e.duration < 0.25);
            if early { -1.0 } else { -0.3 }
        }
        _ => {
            if e.duration > 0.0 { (e.played / e.duration).clamp(0.0, 1.0) } else { 0.3 }
        }
    }
}

pub fn similarity(a: &Track, b: &Track) -> f64 {
    let mut s = 0.0;
    let aa = artist_key(a);
    let same_artist = !aa.is_empty() && aa == artist_key(b);
    if same_artist {
        s += 0.5;
    }
    if !a.album.is_empty() && a.album.to_lowercase() == b.album.to_lowercase() && aa == artist_key(b) {
        s += 0.2;
    }
    let ga = split_genres(&a.genre);
    let gb = split_genres(&b.genre);
    if !ga.is_empty() && !gb.is_empty() {
        let sb: HashSet<_> = gb.iter().collect();
        let inter = ga.iter().filter(|g| sb.contains(g)).count() as f64;
        let uni = ga.iter().chain(gb.iter()).collect::<HashSet<_>>().len() as f64;
        s += 0.25 * inter / uni;
    }
    if let (Some(ya), Some(yb)) = (a.year, b.year) {
        s += 0.05 * (1.0 - (ya - yb).abs() as f64 / 10.0).max(0.0);
    }
    s
}

fn norm<K: std::hash::Hash + Eq + Clone>(m: &HashMap<K, f64>) -> HashMap<K, f64> {
    let max = m.values().fold(0.0f64, |a, v| a.max(v.abs()));
    if max == 0.0 {
        return m.clone();
    }
    m.iter().map(|(k, v)| (k.clone(), v / max)).collect()
}

pub struct Profile {
    pub track_aff: HashMap<i64, f64>,
    pub track_aff_n: HashMap<i64, f64>,
    pub artist_aff: HashMap<String, f64>,
    pub artist_aff_n: HashMap<String, f64>,
    pub album_aff_n: HashMap<String, f64>,
    pub genre_aff_n: HashMap<String, f64>,
    pub last_played: HashMap<i64, i64>,
    pub cold: bool,
}

struct Ctx {
    at: i64,
    rows: Vec<Track>,
    by_id: HashMap<i64, usize>,
    co: HashMap<i64, HashMap<i64, f64>>,
    popularity: HashMap<i64, f64>,
}

struct Cand {
    idx: usize,
    score: f64,
    reason: &'static str,
}

pub struct Recommender {
    cache: Mutex<Option<std::sync::Arc<Ctx>>>,
    rng: Mutex<StdRng>,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl Recommender {
    pub fn new(seed: Option<u64>, now: Option<Box<dyn Fn() -> i64 + Send + Sync>>) -> Self {
        Recommender {
            cache: Mutex::new(None),
            rng: Mutex::new(match seed {
                Some(s) => StdRng::seed_from_u64(s),
                None => StdRng::from_entropy(),
            }),
            now: now.unwrap_or_else(|| Box::new(crate::db::now_ms)),
        }
    }

    pub fn invalidate(&self) {
        *self.cache.lock().unwrap() = None;
    }

    fn rand(&self) -> f64 {
        self.rng.lock().unwrap().gen::<f64>()
    }

    fn ctx(&self, db: &Connection) -> std::sync::Arc<Ctx> {
        let now = (self.now)();
        if let Some(c) = self.cache.lock().unwrap().as_ref() {
            if now - c.at < 60_000 {
                return c.clone();
            }
        }
        let mut st = db.prepare("SELECT id, artist, album, album_artist, genre, year, added FROM tracks").unwrap();
        let rows: Vec<Track> = st
            .query_map([], |r| {
                Ok(Track {
                    id: r.get(0)?,
                    artist: r.get(1)?,
                    album: r.get(2)?,
                    album_artist: r.get(3)?,
                    genre: r.get(4)?,
                    year: r.get(5)?,
                    added: r.get(6)?,
                })
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        let by_id: HashMap<i64, usize> = rows.iter().enumerate().map(|(i, t)| (t.id, i)).collect();

        // Co-listening across all users.
        let mut st = db
            .prepare("SELECT user_id, track_id, ts, played, duration, kind FROM plays ORDER BY id DESC LIMIT 40000")
            .unwrap();
        let mut events: Vec<(i64, Event)> = st
            .query_map([], |r| {
                Ok((r.get(0)?, Event { track_id: r.get(1)?, ts: r.get(2)?, played: r.get(3)?, duration: r.get(4)?, kind: r.get(5)? }))
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        events.reverse();
        let mut per_user: HashMap<i64, Vec<Event>> = HashMap::new();
        for (u, e) in events {
            if event_weight(&e) >= 0.5 {
                per_user.entry(u).or_default().push(e);
            }
        }
        let mut co: HashMap<i64, HashMap<i64, f64>> = HashMap::new();
        let mut add = |a: i64, b: i64, w: f64| {
            if a == b || !by_id.contains_key(&a) || !by_id.contains_key(&b) {
                return;
            }
            *co.entry(a).or_default().entry(b).or_insert(0.0) += w;
        };
        for list in per_user.values() {
            for i in 0..list.len() {
                for d in 1..=3usize {
                    if i + d >= list.len() {
                        break;
                    }
                    let (a, b) = (&list[i], &list[i + d]);
                    if b.ts - a.ts > SESSION_GAP * d as i64 {
                        break;
                    }
                    let w = 1.0 / d as f64;
                    add(a.track_id, b.track_id, w);
                    add(b.track_id, a.track_id, w);
                }
            }
        }
        let mut pop = HashMap::new();
        let mut st = db
            .prepare("SELECT track_id, COUNT(*) FROM plays WHERE kind = 'complete' OR (duration > 0 AND played / duration > 0.5) GROUP BY track_id")
            .unwrap();
        for r in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))).unwrap().flatten() {
            pop.insert(r.0, r.1 as f64);
        }
        let ctx = std::sync::Arc::new(Ctx { at: now, rows, by_id, co, popularity: norm(&pop) });
        *self.cache.lock().unwrap() = Some(ctx.clone());
        ctx
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn profile(&self, db: &Connection, user_id: i64) -> Profile {
        let ctx = self.ctx(db);
        self.profile_with(db, user_id, &ctx)
    }

    fn profile_with(&self, db: &Connection, user_id: i64, ctx: &Ctx) -> Profile {
        let now = (self.now)();
        let mut st = db
            .prepare("SELECT track_id, ts, played, duration, kind FROM plays WHERE user_id = ? ORDER BY ts DESC LIMIT 5000")
            .unwrap();
        let events: Vec<Event> = st
            .query_map([user_id], |r| Ok(Event { track_id: r.get(0)?, ts: r.get(1)?, played: r.get(2)?, duration: r.get(3)?, kind: r.get(4)? }))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        let mut st = db.prepare("SELECT track_id FROM likes WHERE user_id = ?").unwrap();
        let likes: Vec<i64> = st.query_map([user_id], |r| r.get(0)).unwrap().filter_map(Result::ok).collect();

        let mut track_aff: HashMap<i64, f64> = HashMap::new();
        let mut last_played = HashMap::new();
        for e in &events {
            if !ctx.by_id.contains_key(&e.track_id) {
                continue;
            }
            let decay = 0.5f64.powf(((now - e.ts).max(0)) as f64 / HALF_LIFE);
            *track_aff.entry(e.track_id).or_insert(0.0) += event_weight(e) * decay;
            last_played.entry(e.track_id).or_insert(e.ts);
        }
        let liked: Vec<i64> = likes.into_iter().filter(|id| ctx.by_id.contains_key(id)).collect();
        for id in &liked {
            *track_aff.entry(*id).or_insert(0.0) += 3.0;
        }
        let mut artist_aff = HashMap::new();
        let mut album_aff = HashMap::new();
        let mut genre_aff = HashMap::new();
        for (id, a) in &track_aff {
            let t = &ctx.rows[ctx.by_id[id]];
            let ak = artist_key(t);
            if !ak.is_empty() {
                *artist_aff.entry(ak.clone()).or_insert(0.0) += a;
            }
            if !t.album.is_empty() {
                *album_aff.entry(format!("{ak}\u{0}{}", t.album.to_lowercase())).or_insert(0.0) += a;
            }
            for g in split_genres(&t.genre) {
                *genre_aff.entry(g).or_insert(0.0) += a;
            }
        }
        Profile {
            track_aff_n: norm(&track_aff),
            artist_aff_n: norm(&artist_aff),
            album_aff_n: norm(&album_aff),
            genre_aff_n: norm(&genre_aff),
            cold: events.is_empty() && liked.is_empty(),
            track_aff,
            artist_aff,
            last_played,
        }
    }

    fn collab(ctx: &Ctx, seeds: &HashMap<i64, f64>) -> HashMap<i64, f64> {
        let mut out: HashMap<i64, f64> = HashMap::new();
        for (id, w) in seeds {
            if *w <= 0.0 {
                continue;
            }
            if let Some(m) = ctx.co.get(id) {
                for (o, c) in m {
                    *out.entry(*o).or_insert(0.0) += c * w;
                }
            }
        }
        norm(&out)
    }

    fn score(&self, t: &Track, p: &Profile, ctx: &Ctx, collab: &HashMap<i64, f64>) -> (f64, &'static str) {
        let now = (self.now)();
        let ak = artist_key(t);
        let genre = split_genres(&t.genre).iter().map(|g| *p.genre_aff_n.get(g).unwrap_or(&0.0)).fold(0.0f64, f64::max);
        let parts: [(&'static str, f64); 5] = [
            ("artist", 1.0 * p.artist_aff_n.get(&ak).copied().unwrap_or(0.0)),
            ("genre", 0.6 * genre),
            ("album", 0.3 * p.album_aff_n.get(&format!("{ak}\u{0}{}", t.album.to_lowercase())).copied().unwrap_or(0.0)),
            ("collab", 0.9 * collab.get(&t.id).copied().unwrap_or(0.0)),
            ("favorite", 0.8 * p.track_aff_n.get(&t.id).copied().unwrap_or(0.0)),
        ];
        let mut s = 0.0;
        let mut reason = "new";
        let mut best = 0.0;
        for (k, v) in parts {
            s += v;
            if v > best {
                best = v;
                reason = k;
            }
        }
        if p.cold {
            s += 0.6 * ctx.popularity.get(&t.id).copied().unwrap_or(0.0);
        }
        if !p.last_played.contains_key(&t.id) {
            s += 0.15;
        }
        if now - t.added < 14 * DAY {
            s += 0.1;
        }
        if let Some(last) = p.last_played.get(&t.id) {
            let age = now - last;
            if age < 2 * 3_600_000 {
                s -= 1.0;
            } else if age < DAY {
                s -= 0.5;
            } else if age < 3 * DAY {
                s -= 0.2;
            }
        }
        (s, reason)
    }

    /// Greedy re-ranking: keeps the score order but spreads artists and similar songs.
    fn diversify(ctx: &Ctx, mut pool: Vec<Cand>, limit: usize) -> Vec<Pick> {
        let mut out: Vec<Cand> = Vec::new();
        let mut artist_count: HashMap<String, f64> = HashMap::new();
        while out.len() < limit && !pool.is_empty() {
            let recent = &out[out.len().saturating_sub(5)..];
            let last_artist = out.last().map(|c| artist_key(&ctx.rows[c.idx]));
            let mut best_i = 0;
            let mut best_v = f64::NEG_INFINITY;
            for (i, c) in pool.iter().enumerate().take(400) {
                let t = &ctx.rows[c.idx];
                let ak = artist_key(t);
                let max_sim = recent.iter().map(|r| similarity(t, &ctx.rows[r.idx])).fold(0.0f64, f64::max);
                let mut v = c.score - 0.35 * max_sim - 0.25 * artist_count.get(&ak).copied().unwrap_or(0.0);
                if !ak.is_empty() && Some(&ak) == last_artist.as_ref() {
                    v -= 10.0;
                }
                if v > best_v {
                    best_v = v;
                    best_i = i;
                }
            }
            let pick = pool.remove(best_i);
            *artist_count.entry(artist_key(&ctx.rows[pick.idx])).or_insert(0.0) += 1.0;
            out.push(pick);
        }
        out.into_iter().map(|c| Pick { id: ctx.rows[c.idx].id, reason: c.reason }).collect()
    }

    fn top(mut cands: Vec<Cand>, limit: usize) -> Vec<Cand> {
        cands.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        cands.truncate((limit * 4).max(100));
        cands
    }

    /// "Mix für dich": personal mix from the whole library.
    pub fn mix(&self, db: &Connection, user_id: i64, limit: usize) -> Vec<Pick> {
        let ctx = self.ctx(db);
        let p = self.profile_with(db, user_id, &ctx);
        let collab = Self::collab(&ctx, &p.track_aff);
        let mut cands = Vec::new();
        for (i, t) in ctx.rows.iter().enumerate() {
            if p.track_aff.get(&t.id).copied().unwrap_or(0.0) <= -1.5 {
                continue;
            }
            let (s, reason) = self.score(t, &p, &ctx, &collab);
            cands.push(Cand { idx: i, score: s + self.rand() * 0.15, reason });
        }
        Self::diversify(&ctx, Self::top(cands, limit), limit)
    }

    /// Radio: songs that fit a seed song.
    pub fn radio(&self, db: &Connection, user_id: i64, seed_id: i64, limit: usize, exclude: &HashSet<i64>) -> Vec<Pick> {
        let ctx = self.ctx(db);
        let Some(&si) = ctx.by_id.get(&seed_id) else { return vec![] };
        let seed = &ctx.rows[si];
        let p = self.profile_with(db, user_id, &ctx);
        let co_seed = ctx.co.get(&seed_id).map(norm).unwrap_or_default();
        let collab = Self::collab(&ctx, &p.track_aff);
        let mut cands = Vec::new();
        for (i, t) in ctx.rows.iter().enumerate() {
            if t.id == seed_id || exclude.contains(&t.id) || p.track_aff.get(&t.id).copied().unwrap_or(0.0) <= -1.5 {
                continue;
            }
            let sim = similarity(seed, t);
            let co = co_seed.get(&t.id).copied().unwrap_or(0.0);
            let base = self.score(t, &p, &ctx, &collab).0;
            let score = 1.2 * sim + 1.0 * co + 0.4 * base + self.rand() * 0.1;
            cands.push(Cand { idx: i, score, reason: if co > sim { "collab" } else { "similar" } });
        }
        Self::diversify(&ctx, Self::top(cands, limit), limit)
    }

    /// Most similar songs (no randomness).
    pub fn similar(&self, db: &Connection, seed_id: i64, limit: usize) -> Vec<i64> {
        let ctx = self.ctx(db);
        let Some(&si) = ctx.by_id.get(&seed_id) else { return vec![] };
        let seed = &ctx.rows[si];
        let co_seed = ctx.co.get(&seed_id).map(norm).unwrap_or_default();
        let mut v: Vec<(i64, f64)> = ctx
            .rows
            .iter()
            .filter(|t| t.id != seed_id)
            .map(|t| (t.id, similarity(seed, t) + co_seed.get(&t.id).copied().unwrap_or(0.0)))
            .filter(|(_, s)| *s > 0.0)
            .collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        v.into_iter().take(limit).map(|(id, _)| id).collect()
    }

    /// Smart shuffle: weighted random order, no artist twice in a row when avoidable.
    pub fn shuffle(&self, db: &Connection, user_id: i64, ids: &[i64]) -> Vec<i64> {
        let ctx = self.ctx(db);
        let p = self.profile_with(db, user_id, &ctx);
        let mut keyed: Vec<(i64, f64)> = ids
            .iter()
            .filter(|id| ctx.by_id.contains_key(id))
            .map(|id| {
                let a = p.track_aff_n.get(id).copied().unwrap_or(0.0).clamp(-1.0, 1.0);
                let art = p.artist_aff_n.get(&artist_key(&ctx.rows[ctx.by_id[id]])).copied().unwrap_or(0.0);
                let w = (0.8 * a + 0.4 * art).exp();
                let u = self.rand().max(1e-9);
                (*id, u.powf(1.0 / w))
            })
            .collect();
        keyed.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let mut out: Vec<i64> = keyed.into_iter().map(|(id, _)| id).collect();
        let art = |id: i64| artist_key(&ctx.rows[ctx.by_id[&id]]);
        for i in 1..out.len() {
            let prev = art(out[i - 1]);
            if prev.is_empty() || art(out[i]) != prev {
                continue;
            }
            if let Some(j) = (i + 1..out.len()).find(|&j| art(out[j]) != prev) {
                out.swap(i, j);
            }
        }
        out
    }

    /// Data for the start page.
    pub fn home(&self, db: &Connection, user_id: i64) -> (bool, Vec<i64>, Vec<Pick>, Vec<String>, Vec<i64>) {
        let ctx = self.ctx(db);
        let p = self.profile_with(db, user_id, &ctx);
        let now = (self.now)();
        let mut st = db.prepare("SELECT track_id FROM plays WHERE user_id = ? ORDER BY ts DESC LIMIT 200").unwrap();
        let mut recent = Vec::new();
        let mut seen = HashSet::new();
        for id in st.query_map([user_id], |r| r.get::<_, i64>(0)).unwrap().flatten() {
            if !ctx.by_id.contains_key(&id) || !seen.insert(id) {
                continue;
            }
            recent.push(id);
            if recent.len() >= 12 {
                break;
            }
        }
        let mut names: HashMap<String, String> = HashMap::new();
        for t in &ctx.rows {
            let k = artist_key(t);
            if !k.is_empty() {
                names.entry(k).or_insert_with(|| if t.artist.is_empty() { t.album_artist.clone() } else { t.artist.clone() });
            }
        }
        let mut arts: Vec<(&String, &f64)> = p.artist_aff.iter().filter(|(_, v)| **v > 0.0).collect();
        arts.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));
        let top_artists = arts.into_iter().take(10).filter_map(|(k, _)| names.get(k).cloned()).collect();
        let mut red: Vec<(i64, f64)> = p
            .track_aff
            .iter()
            .filter(|(id, v)| **v > 1.0 && now - p.last_played.get(id).copied().unwrap_or(0) > 30 * DAY)
            .map(|(a, b)| (*a, *b))
            .collect();
        red.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let rediscover = red.into_iter().take(12).map(|(id, _)| id).collect();
        drop(ctx);
        let mix = self.mix(db, user_id, 12);
        (p.cold, recent, mix, top_artists, rediscover)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    const NOW: i64 = 1_794_398_400_000; // 2026-11-11 12:00 UTC

    fn fixture() -> Connection {
        let db = crate::db::open(None).unwrap();
        db.execute_batch("INSERT INTO users (id, name, pass_hash, admin, created) VALUES (1,'a','x',1,0),(2,'b','x',0,0)").unwrap();
        let mut id = 1;
        for (artist, album, genre, year) in [
            ("Rocker", "Loud", "Rock", 1995),
            ("Stoner", "Heavy", "Rock; Metal", 1998),
            ("Popstar", "Shiny", "Pop", 2020),
            ("Jazzman", "Smooth", "Jazz", 1960),
            ("Indie", "Garage", "Rock", 2005),
        ] {
            for i in 0..6 {
                db.execute(
                    "INSERT INTO tracks (id, path, title, artist, album, genre, year, duration, added) VALUES (?,?,?,?,?,?,?,?,?)",
                    params![id, format!("/m/{id}.mp3"), format!("{artist} {i}"), artist, album, genre, year, 200.0, NOW - 100 * DAY],
                )
                .unwrap();
                id += 1;
            }
        }
        db
    }

    fn play(db: &Connection, user: i64, track: i64, ts: i64, kind: &str, played: f64) {
        db.execute(
            "INSERT INTO plays (user_id, track_id, ts, played, duration, kind) VALUES (?,?,?,?,?,?)",
            params![user, track, ts, played, 200.0, kind],
        )
        .unwrap();
    }

    fn rec(seed: u64) -> Recommender {
        Recommender::new(Some(seed), Some(Box::new(|| NOW)))
    }

    fn artist(db: &Connection, id: i64) -> String {
        db.query_row("SELECT artist FROM tracks WHERE id = ?", [id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn weights() {
        let e = |kind: &str, played: f64| Event { track_id: 1, ts: 0, played, duration: 200.0, kind: kind.into() };
        assert_eq!(event_weight(&e("complete", 200.0)), 1.0);
        assert_eq!(event_weight(&e("skip", 5.0)), -1.0);
        assert_eq!(event_weight(&e("skip", 150.0)), -0.3);
        assert_eq!(event_weight(&e("partial", 100.0)), 0.5);
    }

    #[test]
    fn mix_follows_taste() {
        let db = fixture();
        for i in 1..=4 {
            play(&db, 1, i, NOW - 5 * DAY + i * 60_000, "complete", 200.0);
        }
        db.execute("INSERT INTO likes (user_id, track_id, created) VALUES (1, 8, 0)", []).unwrap();
        for i in 19..=22 {
            play(&db, 1, i, NOW - 4 * DAY + i * 60_000, "skip", 5.0);
        }
        let mix = rec(7).mix(&db, 1, 12);
        assert_eq!(mix.len(), 12);
        let top8 = &mix[..8];
        let rock = top8.iter().filter(|m| m.id <= 12 || m.id >= 25).count();
        let jazz = top8.iter().filter(|m| (19..=24).contains(&m.id)).count();
        assert!(rock >= 5, "rock in top 8: {rock}");
        assert_eq!(jazz, 0);
        for w in mix.windows(2) {
            assert_ne!(artist(&db, w[0].id), artist(&db, w[1].id));
        }
    }

    #[test]
    fn collaborative_radio() {
        let db = fixture();
        for d in 0..5 {
            play(&db, 2, 1, NOW - (10 + d) * DAY, "complete", 200.0);
            play(&db, 2, 13, NOW - (10 + d) * DAY + 200_000, "complete", 200.0);
        }
        play(&db, 1, 1, NOW - 2 * DAY, "complete", 200.0);
        let radio = rec(3).radio(&db, 1, 1, 10, &HashSet::new());
        let pos = radio.iter().position(|r| r.id == 13).expect("popstar 13 in radio");
        assert!(pos < 4, "position {pos}");
        assert_eq!(radio[pos].reason, "collab");
    }

    #[test]
    fn recent_songs_move_down() {
        let db = fixture();
        for i in 1..=6 {
            play(&db, 1, i, NOW - 60 * DAY, "complete", 200.0);
        }
        play(&db, 1, 2, NOW - 10 * 60_000, "complete", 200.0);
        let mix = rec(5).mix(&db, 1, 30);
        let rocker: Vec<i64> = mix.iter().filter(|m| m.id <= 6).map(|m| m.id).collect();
        assert_eq!(*rocker.last().unwrap(), 2, "{rocker:?}");
    }

    #[test]
    fn cold_start_uses_popularity() {
        let db = fixture();
        for d in 0..6 {
            play(&db, 2, 20, NOW - d * DAY, "complete", 200.0);
        }
        let r = rec(9);
        assert!(r.profile(&db, 1).cold);
        let mix = r.mix(&db, 1, 30);
        assert_eq!(mix.len(), 30);
        assert!(mix.iter().position(|m| m.id == 20).unwrap() < 5);
    }

    #[test]
    fn shuffle_keeps_ids_and_spreads_artists() {
        let db = fixture();
        let ids = [1, 2, 3, 4, 13, 14, 19, 20];
        let out = rec(11).shuffle(&db, 1, &ids);
        let mut sorted = out.clone();
        sorted.sort();
        assert_eq!(sorted, ids.to_vec());
        let same = out.windows(2).filter(|w| artist(&db, w[0]) == artist(&db, w[1])).count();
        assert!(same <= 1, "same-artist neighbours: {same}");
    }
}
