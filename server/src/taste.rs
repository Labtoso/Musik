//! Suggestions for songs from the public catalog (Spotify / Deezer songs that play through YouTube).
//!
//! Works like a streaming service: every play, skip and like of a catalog song is kept on the
//! server (`ext_plays`, `ext_likes`). From that, followed artists, the genres picked in the setup
//! assistant and the artists of the own library it builds a taste profile. Candidates come from the
//! catalog (artist radio, top songs, similar artists); they are scored against the taste,
//! songs heard a moment ago or skipped again and again drop out, and the list is spread so no
//! artist plays twice in a row and no song shows up twice.
//!
//! - Autoplay: `POST /api/catalog/radio` keeps playing in the mood of the last songs.
//! - Start page: `GET /api/catalog/foryou` gives Daily Mixes, a weekly discovery list of artists
//!   not heard yet, "on repeat", "because you listen to …", suggested artists and playlists.

use crate::api::{body_json, ApiError, Auth, St, R};
use crate::db::now_ms;
use crate::ext::{dz_artist, dz_track, http_get, norm, urlencode};
use crate::recommend::event_weight;
use axum::extract::{Query, Request, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS ext_plays (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  artist TEXT NOT NULL,
  ts INTEGER NOT NULL,
  played REAL NOT NULL,
  duration REAL NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_plays_user ON ext_plays(user_id, ts);
"#;

const DAY: i64 = 86_400_000;
const HALF_LIFE: f64 = 45.0 * DAY as f64;

/// Setup assistant genre → catalog genre id (same table as in the app).
const GENRES: [(&str, u32); 20] = [
    ("pop", 132), ("rap", 116), ("rock", 152), ("alt", 85), ("dance", 113), ("electro", 106), ("rnb", 165),
    ("soul", 169), ("metal", 464), ("jazz", 129), ("classic", 98), ("latin", 197), ("reggae", 144), ("folk", 466),
    ("country", 84), ("blues", 153), ("film", 173), ("asia", 16), ("africa", 2), ("kids", 95),
];

// ---------- songs ----------

/// The first named artist: "A, B & C feat. D" → "a".
pub fn main_artist(a: &str) -> String {
    let l = a.to_lowercase();
    let mut cut = l.len();
    for sep in [",", " & ", " feat", " ft.", " x ", " und ", " and ", " with ", ";", "/"] {
        if let Some(i) = l.find(sep) {
            cut = cut.min(i);
        }
    }
    norm(&l[..cut])
}

/// Same song = same main artist + same title without "(Remastered)", "- Live", "feat." …
pub fn song_key(artist: &str, title: &str) -> String {
    format!("{}|{}", main_artist(artist), norm(title))
}

#[derive(Clone, Debug)]
pub struct Song {
    pub v: Value,
    pub artist: String,
    pub key: String,
    pub rank: f64,
}

impl Song {
    pub fn from(v: Value, rank: f64) -> Option<Song> {
        let artist = main_artist(v["artist"].as_str()?);
        let title = v["title"].as_str()?;
        if artist.is_empty() || title.is_empty() {
            return None;
        }
        Some(Song { key: format!("{artist}|{}", norm(title)), artist, v, rank })
    }
}

#[derive(Clone, Debug)]
pub struct ArtistRef {
    pub id: String,
    pub name: String,
    pub v: Value,
}

/// Where songs and similar artists come from. The real one asks Deezer's public API; tests use a fake.
pub trait Catalog: Send + Sync {
    fn find_artist(&self, name: &str) -> Option<ArtistRef>;
    fn related(&self, id: &str) -> Vec<ArtistRef>;
    fn top(&self, id: &str) -> Vec<Song>;
    /// Songs that fit an artist (the catalog's own artist radio).
    fn radio(&self, id: &str) -> Vec<Song>;
    fn genre_artists(&self, genre: u32) -> Vec<ArtistRef>;
    fn playlists(&self, q: &str) -> Vec<Value>;
}

// ---------- Deezer, with a small cache so the start page is quick and the API is not hammered ----------

pub struct Deezer;

fn cached(url: &str) -> Option<Value> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();
    let c = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, v)) = c.lock().unwrap().get(url) {
        if at.elapsed() < Duration::from_secs(6 * 3600) {
            return Some(v.clone());
        }
    }
    let v = http_get(url).ok()?;
    if v.get("error").is_some() {
        return None;
    }
    let mut m = c.lock().unwrap();
    if m.len() > 3000 {
        m.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(6 * 3600));
        if m.len() > 3000 {
            m.clear();
        }
    }
    m.insert(url.to_string(), (Instant::now(), v.clone()));
    Some(v)
}

fn dz_songs(v: Option<Value>) -> Vec<Song> {
    let list = v.and_then(|v| v["data"].as_array().cloned()).unwrap_or_default();
    list.iter()
        .filter(|t| t["readable"].as_bool() != Some(false))
        .filter_map(|t| Song::from(dz_track(t), t["rank"].as_f64().unwrap_or(0.0)))
        .collect()
}
fn dz_artists(v: Option<Value>) -> Vec<ArtistRef> {
    let list = v.and_then(|v| v["data"].as_array().cloned()).unwrap_or_default();
    list.iter()
        .map(|a| ArtistRef { id: a["id"].to_string(), name: a["name"].as_str().unwrap_or("").to_string(), v: dz_artist(a) })
        .filter(|a| !a.name.is_empty())
        .collect()
}

impl Catalog for Deezer {
    fn find_artist(&self, name: &str) -> Option<ArtistRef> {
        let list = dz_artists(cached(&format!("https://api.deezer.com/search/artist?limit=5&q={}", urlencode(name))));
        let want = norm(name);
        // the exact name wins, else the first hit (the catalog sorts by fans)
        list.iter().find(|a| norm(&a.name) == want).or(list.first()).cloned()
    }
    fn related(&self, id: &str) -> Vec<ArtistRef> {
        dz_artists(cached(&format!("https://api.deezer.com/artist/{id}/related?limit=20")))
    }
    fn top(&self, id: &str) -> Vec<Song> {
        dz_songs(cached(&format!("https://api.deezer.com/artist/{id}/top?limit=15")))
    }
    fn radio(&self, id: &str) -> Vec<Song> {
        dz_songs(cached(&format!("https://api.deezer.com/artist/{id}/radio?limit=40")))
    }
    fn genre_artists(&self, genre: u32) -> Vec<ArtistRef> {
        dz_artists(cached(&format!("https://api.deezer.com/genre/{genre}/artists")))
    }
    fn playlists(&self, q: &str) -> Vec<Value> {
        let list = cached(&format!("https://api.deezer.com/search/playlist?limit=4&q={}", urlencode(q)))
            .and_then(|v| v["data"].as_array().cloned())
            .unwrap_or_default();
        list.into_iter()
            .filter(|p| p["nb_tracks"].as_i64().unwrap_or(0) >= 8)
            .map(|p| {
                json!({
                    "id": p["id"].to_string(), "title": p["title"].as_str().unwrap_or(""),
                    "cover": p["picture_medium"].as_str().unwrap_or(""),
                    "owner": p["user"]["name"].as_str().unwrap_or(""),
                    "count": p["nb_tracks"].as_i64().unwrap_or(0),
                })
            })
            .collect()
    }
}

// ---------- taste ----------

#[derive(Default, Debug)]
pub struct Taste {
    /// main artist → liking (likes, plays, follows; skips pull it down)
    pub artists: HashMap<String, f64>,
    /// main artist → how it is written
    pub names: HashMap<String, String>,
    /// song key → liking of that exact song
    pub songs: HashMap<String, f64>,
    /// song key → last time it played
    pub last: HashMap<String, i64>,
    /// song key → song data, for songs someone liked or played
    pub known: HashMap<String, Value>,
    pub liked: HashSet<String>,
    pub followed: HashSet<String>,
    pub genres: Vec<u32>,
    /// on repeat: most played lately
    pub repeat: Vec<(String, f64)>,
}

impl Taste {
    pub fn artist_score(&self, a: &str) -> f64 {
        let max = self.artists.values().fold(1.0f64, |m, v| m.max(*v));
        (self.artists.get(a).copied().unwrap_or(0.0) / max).clamp(-1.0, 1.0)
    }
    /// The artists someone likes most, best first.
    pub fn top_artists(&self, n: usize) -> Vec<String> {
        let mut v: Vec<(&String, &f64)> = self.artists.iter().filter(|(_, s)| **s > 0.4).collect();
        v.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(b.0)));
        v.into_iter().take(n).map(|(k, _)| self.names.get(k).cloned().unwrap_or_else(|| k.clone())).collect()
    }
    pub fn knows(&self, artist: &str) -> bool {
        self.artists.get(artist).copied().unwrap_or(0.0) > 0.0 || self.followed.contains(artist)
    }
    fn add_artist(&mut self, name: &str, w: f64) {
        let k = main_artist(name);
        if k.is_empty() {
            return;
        }
        *self.artists.entry(k.clone()).or_insert(0.0) += w;
        let first = name.split([',', '&', ';']).next().unwrap_or(name).trim();
        self.names.entry(k).or_insert_with(|| first.to_string());
    }
}

pub fn taste(db: &Connection, st_rec: Option<&crate::recommend::Recommender>, user_id: i64, now: i64) -> Taste {
    let mut t = Taste::default();
    // plays of catalog songs
    let mut s = db
        .prepare("SELECT key, artist, ts, played, duration, kind, data FROM ext_plays WHERE user_id = ? ORDER BY ts DESC LIMIT 5000")
        .unwrap();
    let rows: Vec<(String, String, i64, f64, f64, String, String)> = s
        .query_map([user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    let mut repeat: HashMap<String, f64> = HashMap::new();
    for (key, artist, ts, played, duration, kind, data) in rows {
        let w = event_weight(&crate::recommend::Event { track_id: 0, ts, played, duration, kind });
        let decay = 0.5f64.powf((now - ts).max(0) as f64 / HALF_LIFE);
        *t.songs.entry(key.clone()).or_insert(0.0) += w * decay;
        t.add_artist(&artist, w * decay);
        t.last.entry(key.clone()).or_insert(ts);
        if w > 0.5 && now - ts < 30 * DAY {
            *repeat.entry(key.clone()).or_insert(0.0) += w;
        }
        if !t.known.contains_key(&key) {
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                t.known.insert(key, v);
            }
        }
    }
    // liked catalog songs
    let mut s = db.prepare("SELECT data FROM ext_likes WHERE user_id = ?").unwrap();
    for d in s.query_map([user_id], |r| r.get::<_, String>(0)).unwrap().flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&d) else { continue };
        let (a, ti) = (v["artist"].as_str().unwrap_or(""), v["title"].as_str().unwrap_or(""));
        if a.is_empty() || ti.is_empty() {
            continue;
        }
        let key = song_key(a, ti);
        *t.songs.entry(key.clone()).or_insert(0.0) += 3.0;
        t.add_artist(a, 2.0);
        t.liked.insert(key.clone());
        t.known.entry(key).or_insert(v);
    }
    // followed artists (also the ones picked in the setup assistant)
    let mut s = db.prepare("SELECT name FROM follows WHERE user_id = ?").unwrap();
    for n in s.query_map([user_id], |r| r.get::<_, String>(0)).unwrap().flatten() {
        t.add_artist(&n, 4.0);
        t.followed.insert(main_artist(&n));
    }
    // artists of the own library
    if let Some(rec) = st_rec {
        let p = rec.profile_now(db, user_id);
        let mut v: Vec<(&String, &f64)> = p.artist_aff.iter().filter(|(_, s)| **s > 0.0).collect();
        v.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));
        for (name, s) in v.into_iter().take(30) {
            t.add_artist(name, s.min(6.0));
        }
    }
    // genres from the setup assistant
    let settings: Option<String> = db.query_row("SELECT data FROM user_settings WHERE user_id = ?", [user_id], |r| r.get(0)).ok();
    if let Some(v) = settings.and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
        for g in v["genres"].as_array().cloned().unwrap_or_default() {
            if let Some(id) = GENRES.iter().find(|(k, _)| Some(*k) == g.as_str()).map(|x| x.1) {
                t.genres.push(id);
            }
        }
    }
    let mut r: Vec<(String, f64)> = repeat.into_iter().filter(|(_, n)| *n >= 2.0).collect();
    r.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    t.repeat = r;
    t
}

// ---------- scoring + spreading ----------

#[derive(Clone)]
struct Cand {
    s: Song,
    score: f64,
}

/// What a song is worth to this person right now. None = leave it out.
fn judge(t: &Taste, s: &Song, now: i64) -> Option<f64> {
    let song = t.songs.get(&s.key).copied().unwrap_or(0.0);
    if song <= -1.5 {
        return None; // skipped again and again
    }
    let art = t.artist_score(&s.artist);
    let mut v = 0.8 * art + 0.25 * (s.rank / 900_000.0).min(1.0);
    if song < 0.0 {
        v += 0.5 * song; // skipped once
    }
    if t.liked.contains(&s.key) {
        v += 0.3;
    }
    if let Some(last) = t.last.get(&s.key) {
        let age = now - last;
        if age < 3 * 3_600_000 {
            return None;
        } else if age < DAY {
            v -= 0.7;
        } else if age < 4 * DAY {
            v -= 0.25;
        }
    }
    Some(v)
}

/// Greedy spread: best first, never the same artist twice in a row, at most `per_artist`
/// songs of one artist in any 8, no song twice.
fn spread(mut pool: Vec<Cand>, limit: usize, per_artist: usize, taken: &mut HashSet<String>) -> Vec<Song> {
    pool.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<Song> = Vec::new();
    let mut seen_title: HashSet<String> = HashSet::new();
    while out.len() < limit {
        let recent: Vec<&str> = out.iter().rev().take(7).map(|s| s.artist.as_str()).collect();
        let last = out.last().map(|s| s.artist.clone());
        let mut best: Option<(usize, f64)> = None;
        for (i, c) in pool.iter().enumerate().take(300) {
            if taken.contains(&c.s.key) {
                continue;
            }
            let title = c.s.key.split('|').nth(1).unwrap_or("").to_string();
            if seen_title.contains(&format!("{}|{title}", c.s.artist)) {
                continue;
            }
            let n = recent.iter().filter(|a| **a == c.s.artist).count();
            let mut v = c.score - 0.3 * n as f64;
            if Some(&c.s.artist) == last.as_ref() {
                v -= 10.0;
            }
            if n >= per_artist {
                v -= 5.0;
            }
            if best.map(|b| v > b.1).unwrap_or(true) {
                best = Some((i, v));
            }
        }
        let Some((i, _)) = best else { break };
        let c = pool.remove(i);
        taken.insert(c.s.key.clone());
        seen_title.insert(c.s.key.clone());
        out.push(c.s);
    }
    out
}

fn add_cands(pool: &mut HashMap<String, Cand>, t: &Taste, list: Vec<Song>, weight: f64, now: i64, rng: &mut StdRng) {
    let n = list.len().max(1) as f64;
    for (i, s) in list.into_iter().enumerate() {
        let Some(j) = judge(t, &s, now) else { continue };
        // earlier in the catalog's own list = fits better
        let score = weight * (1.0 - 0.5 * i as f64 / n) + j + rng.gen::<f64>() * 0.12;
        match pool.get_mut(&s.key) {
            // a song that several sources suggest is a safer bet
            Some(c) => c.score = c.score.max(score) + 0.15,
            None => {
                pool.insert(s.key.clone(), Cand { s, score });
            }
        }
    }
}

/// Runs the closures at the same time (the catalog answers one request at a time).
fn parallel<T: Send>(jobs: Vec<Box<dyn FnOnce() -> T + Send + '_>>) -> Vec<T> {
    std::thread::scope(|sc| {
        let hs: Vec<_> = jobs.into_iter().map(|j| sc.spawn(j)).collect();
        hs.into_iter().map(|h| h.join().ok()).collect::<Vec<_>>()
    })
    .into_iter()
    .flatten()
    .collect()
}

// ---------- autoplay ----------

pub struct Seed {
    pub artist: String,
    pub title: String,
}

/// Songs that keep the mood of the last songs: the catalog's radio of their artists, the
/// artists' best songs and songs of similar artists, scored against the taste.
pub fn radio(cat: &dyn Catalog, t: &Taste, seeds: &[Seed], exclude: &HashSet<String>, limit: usize, now: i64, seed: u64) -> Vec<Value> {
    let mut rng = StdRng::seed_from_u64(seed);
    // most recent seed counts most
    let mut artists: Vec<(String, f64)> = Vec::new();
    for (i, s) in seeds.iter().rev().enumerate() {
        let k = main_artist(&s.artist);
        if k.is_empty() {
            continue;
        }
        let w = 1.0 / (1.0 + i as f64 * 0.5);
        match artists.iter_mut().find(|a| main_artist(&a.0) == k) {
            Some(a) => a.1 += w * 0.5,
            None => artists.push((s.artist.split([',', '&']).next().unwrap_or("").trim().to_string(), w)),
        }
    }
    artists.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    artists.truncate(3);
    if artists.is_empty() {
        return vec![];
    }
    let found: Vec<Option<ArtistRef>> =
        parallel(artists.iter().map(|(n, _)| Box::new(move || cat.find_artist(n)) as Box<dyn FnOnce() -> _ + Send>).collect());
    let mut jobs: Vec<Box<dyn FnOnce() -> (f64, Vec<Song>) + Send>> = Vec::new();
    let mut related_of_first = Vec::new();
    for (i, a) in found.iter().enumerate() {
        let Some(a) = a.clone() else { continue };
        let w = artists[i].1;
        let id = a.id.clone();
        jobs.push(Box::new(move || (1.0 * w, cat.radio(&id))));
        let id = a.id.clone();
        jobs.push(Box::new(move || (0.55 * w, cat.top(&id).into_iter().take(6).collect())));
        if related_of_first.is_empty() {
            related_of_first = cat.related(&a.id);
        }
    }
    for r in related_of_first.iter().take(5) {
        let id = r.id.clone();
        jobs.push(Box::new(move || (0.7, cat.top(&id).into_iter().take(4).collect())));
    }
    let lists = parallel(jobs);
    let mut pool: HashMap<String, Cand> = HashMap::new();
    for (w, l) in lists {
        add_cands(&mut pool, t, l, w, now, &mut rng);
    }
    // the songs that just played: not again
    let mut taken: HashSet<String> = exclude.clone();
    for s in seeds {
        taken.insert(song_key(&s.artist, &s.title));
    }
    // the seed artist itself is fine, but not every other song
    let seed_artists: HashSet<String> = artists.iter().map(|a| main_artist(&a.0)).collect();
    let pool: Vec<Cand> = pool
        .into_values()
        .map(|mut c| {
            if seed_artists.contains(&c.s.artist) {
                c.score -= 0.25;
            }
            c
        })
        .collect();
    spread(pool, limit, 2, &mut taken).into_iter().map(|s| s.v).collect()
}

// ---------- start page ----------

fn day_seed(user: i64, now: i64, days: i64) -> u64 {
    (user as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ ((now / (days * DAY)) as u64)
}

pub fn for_you(cat: &dyn Catalog, t: &Taste, extra: &[String], user: i64, now: i64) -> Value {
    let mut names: Vec<String> = t.top_artists(6);
    for e in extra {
        if names.len() < 6 && !names.iter().any(|n| main_artist(n) == main_artist(e)) {
            names.push(e.clone());
        }
    }
    let cold = names.is_empty();
    // nothing heard yet: start from the genres picked in the setup assistant
    if cold {
        // no genres picked either: what is popular everywhere (genre 0 = all)
        let genres: Vec<u32> = if t.genres.is_empty() { vec![0] } else { t.genres.clone() };
        let lists: Vec<Vec<ArtistRef>> = parallel(genres.iter().take(4).map(|g| Box::new(move || cat.genre_artists(*g)) as Box<dyn FnOnce() -> _ + Send>).collect());
        for i in 0..3 {
            for l in &lists {
                if let Some(a) = l.get(i) {
                    names.push(a.name.clone());
                }
            }
        }
        names.truncate(5);
    }
    if names.is_empty() {
        return json!({ "rows": [], "artists": [], "playlists": [], "mixes": [], "discover": [], "onRepeat": on_repeat(t) });
    }
    // per artist: who they are, similar artists, best songs and the radio
    struct Info {
        a: ArtistRef,
        related: Vec<ArtistRef>,
        top: Vec<Song>,
        radio: Vec<Song>,
    }
    let infos: Vec<Option<Info>> = parallel(
        names
            .iter()
            .map(|n| {
                Box::new(move || {
                    let a = cat.find_artist(n)?;
                    let (related, (top, radio)) = std::thread::scope(|sc| {
                        let r = sc.spawn(|| cat.related(&a.id));
                        let tp = sc.spawn(|| cat.top(&a.id));
                        let rd = sc.spawn(|| cat.radio(&a.id));
                        (r.join().unwrap_or_default(), (tp.join().unwrap_or_default(), rd.join().unwrap_or_default()))
                    });
                    Some(Info { a, related, top, radio })
                }) as Box<dyn FnOnce() -> _ + Send>
            })
            .collect(),
    );
    let infos: Vec<Info> = infos.into_iter().flatten().collect();
    let playlists_for: Vec<String> = names.iter().take(3).cloned().collect();
    let pls: Vec<Vec<Value>> = parallel(playlists_for.iter().map(|n| Box::new(move || cat.playlists(n)) as Box<dyn FnOnce() -> _ + Send>).collect());

    // artists that several favourites point to are the best new ones (like "fans also like")
    let mut votes: HashMap<String, (f64, Value)> = HashMap::new();
    for inf in &infos {
        for (i, r) in inf.related.iter().enumerate() {
            let k = main_artist(&r.name);
            let e = votes.entry(k).or_insert((0.0, r.v.clone()));
            e.0 += 1.0 - i as f64 / 40.0;
        }
    }
    let mut taken: HashSet<String> = HashSet::new();

    // Daily Mixes: one per favourite, own favourites of that corner mixed with new songs, new each day
    let mut mixes = Vec::new();
    let mut rng = StdRng::seed_from_u64(day_seed(user, now, 1));
    let mut used_seed: HashSet<String> = HashSet::new();
    for inf in infos.iter().take(4) {
        let ak = main_artist(&inf.a.name);
        // an artist that is already "similar" to an earlier mix belongs to that one
        if used_seed.iter().any(|s| infos.iter().any(|o| main_artist(&o.a.name) == *s && o.related.iter().take(8).any(|r| main_artist(&r.name) == ak))) {
            continue;
        }
        used_seed.insert(ak.clone());
        let near: HashSet<String> = std::iter::once(ak.clone()).chain(inf.related.iter().take(10).map(|r| main_artist(&r.name))).collect();
        let mut pool: HashMap<String, Cand> = HashMap::new();
        // songs this person already loves from this corner
        let own: Vec<Song> = t
            .known
            .iter()
            .filter(|(k, _)| t.songs.get(*k).copied().unwrap_or(0.0) > 0.8)
            .filter_map(|(_, v)| Song::from(as_catalog(v), 0.0))
            .filter(|s| near.contains(&s.artist))
            .collect();
        add_cands(&mut pool, t, own, 1.0, now, &mut rng);
        add_cands(&mut pool, t, inf.top.iter().take(8).cloned().collect(), 0.8, now, &mut rng);
        add_cands(&mut pool, t, inf.radio.clone(), 0.9, now, &mut rng);
        let mut mt = HashSet::new();
        let songs = spread(pool.into_values().collect(), 30, 2, &mut mt);
        if songs.len() < 8 {
            continue;
        }
        let mut who: Vec<String> = Vec::new();
        for s in &songs {
            let n = s.v["artist"].as_str().unwrap_or("").split([',', '&']).next().unwrap_or("").trim().to_string();
            if !n.is_empty() && !who.iter().any(|w| main_artist(w) == main_artist(&n)) {
                who.push(n);
            }
        }
        // the seed artist first, then who else is in it
        who.retain(|w| main_artist(w) != ak);
        who.insert(0, inf.a.name.clone());
        who.truncate(4);
        mixes.push(json!({
            "title": format!("Daily Mix {}", mixes.len() + 1),
            "artists": who,
            "picture": inf.a.v["picture"],
            "tracks": songs.into_iter().map(|s| s.v).collect::<Vec<_>>(),
        }));
    }

    // Discover: songs of artists not heard yet, new every week
    let mut rng = StdRng::seed_from_u64(day_seed(user, now, 7));
    let mut pool: HashMap<String, Cand> = HashMap::new();
    for inf in &infos {
        let fresh: Vec<Song> = inf.radio.iter().filter(|s| !t.knows(&s.artist) && main_artist(&inf.a.name) != s.artist).cloned().collect();
        add_cands(&mut pool, t, fresh, 0.6, now, &mut rng);
    }
    let pool: Vec<Cand> = pool
        .into_values()
        .map(|mut c| {
            c.score += 0.4 * votes.get(&c.s.artist).map(|v| v.0).unwrap_or(0.0).min(3.0) / 3.0 + rng.gen::<f64>() * 0.3;
            c
        })
        .collect();
    let discover: Vec<Value> = spread(pool, 30, 1, &mut taken).into_iter().map(|s| s.v).collect();

    // "Because you listen to …": the radio of each favourite, without the favourite itself
    let mut rows = Vec::new();
    let mut rng = StdRng::seed_from_u64(day_seed(user, now, 1) ^ 7);
    for inf in infos.iter().take(4) {
        let ak = main_artist(&inf.a.name);
        let mut pool = HashMap::new();
        add_cands(&mut pool, t, inf.radio.iter().filter(|s| s.artist != ak).cloned().collect(), 1.0, now, &mut rng);
        let tracks: Vec<Value> = spread(pool.into_values().collect(), 12, 1, &mut taken).into_iter().map(|s| s.v).collect();
        if tracks.len() >= 4 {
            rows.push(json!({ "because": inf.a.name, "picture": inf.a.v["picture"], "tracks": tracks }));
        }
    }

    // artists to try: most votes, not known yet
    let mut va: Vec<(String, (f64, Value))> = votes.into_iter().filter(|(k, _)| !t.knows(k)).collect();
    va.sort_by(|a, b| b.1 .0.partial_cmp(&a.1 .0).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let artists: Vec<Value> = va.into_iter().take(16).map(|(_, (_, v))| v).collect();

    let mut playlists = Vec::new();
    let mut seen_p = HashSet::new();
    for l in pls {
        for p in l {
            if seen_p.insert(p["id"].to_string()) {
                playlists.push(p);
            }
        }
    }
    playlists.truncate(12);
    json!({
        "mixes": mixes, "discover": discover, "onRepeat": on_repeat(t), "rows": rows,
        "artists": artists, "playlists": playlists, "cold": cold,
    })
}

fn on_repeat(t: &Taste) -> Vec<Value> {
    t.repeat.iter().filter_map(|(k, _)| t.known.get(k).map(as_catalog)).take(30).collect()
}

// ---------- recording plays of catalog songs ----------

/// A play of a catalog song (from POST /api/events). `song` is the song as the app shows it.
pub fn record(db: &Connection, user_id: i64, song: &Value, kind: &str, played: f64, duration: f64, ts: i64) -> bool {
    let (artist, title) = (song["artist"].as_str().unwrap_or(""), song["title"].as_str().unwrap_or(""));
    if artist.is_empty() || title.is_empty() || !["complete", "skip", "partial"].contains(&kind) {
        return false;
    }
    let data = song.to_string();
    if data.len() > 4096 {
        return false;
    }
    db.execute(
        "INSERT INTO ext_plays (user_id, key, artist, ts, played, duration, kind, data) VALUES (?,?,?,?,?,?,?,?)",
        params![user_id, song_key(artist, title), artist, ts, played, duration, kind, data],
    )
    .is_ok()
}

// ---------- HTTP ----------

pub fn routes() -> Router<St> {
    Router::new().route("/catalog/radio", post(radio_route)).route("/catalog/foryou", get(foryou_route))
}

/// The song in the shape the catalog gives it (source, ext_id, title, artist, …).
fn as_catalog(v: &Value) -> Value {
    let ext = &v["ext"];
    json!({
        "source": v["source"].as_str().or(ext["source"].as_str()).unwrap_or(""),
        "ext_id": v["ext_id"].as_str().or(ext["id"].as_str()).unwrap_or(""),
        "title": v["title"].as_str().unwrap_or(""), "artist": v["artist"].as_str().unwrap_or(""),
        "album": v["album"].as_str().unwrap_or(""), "duration": v["duration"].as_f64().unwrap_or(0.0),
        "cover": v["cover"].as_str().unwrap_or(""), "url": v["url"].as_str().or(ext["url"].as_str()).unwrap_or(""),
    })
}

/// { seeds: [{title, artist}], exclude: ["artist|title" or song keys], limit }
async fn radio_route(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    let b: Value = body_json(req).await?;
    let seeds: Vec<Seed> = b["seeds"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .rev()
        .take(5)
        .rev()
        .filter_map(|s| {
            let (a, ti) = (s["artist"].as_str()?.trim(), s["title"].as_str()?.trim());
            (!a.is_empty() && !ti.is_empty()).then(|| Seed { artist: a.chars().take(200).collect(), title: ti.chars().take(200).collect() })
        })
        .collect();
    if seeds.is_empty() {
        return Err(ApiError::new(400, "bad_json"));
    }
    let exclude: HashSet<String> = b["exclude"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .take(500)
        .filter_map(|x| {
            let (a, ti) = (x["artist"].as_str()?, x["title"].as_str()?);
            Some(song_key(a, ti))
        })
        .collect();
    let limit = b["limit"].as_u64().unwrap_or(15).clamp(1, 50) as usize;
    let now = now_ms();
    let t = {
        let db = st.db.lock().unwrap();
        taste(&db, Some(&st.rec), u.id, now)
    };
    let out = tokio::task::spawn_blocking(move || radio(&Deezer, &t, &seeds, &exclude, limit, now, now as u64))
        .await
        .map_err(|_| ApiError::new(500, "internal"))?;
    Ok(Json(json!(out)))
}

/// Start page suggestions. ?artists=a|b also counts (artists the app knows of, e.g. from imports).
async fn foryou_route(State(st): State<St>, Auth(u, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let extra: Vec<String> = q
        .get("artists")
        .map(|s| s.split('|').map(|x| x.trim().chars().take(80).collect::<String>()).filter(|x| !x.is_empty()).take(5).collect())
        .unwrap_or_default();
    let now = now_ms();
    let t = {
        let db = st.db.lock().unwrap();
        taste(&db, Some(&st.rec), u.id, now)
    };
    let uid = u.id;
    let out = tokio::task::spawn_blocking(move || for_you(&Deezer, &t, &extra, uid, now))
        .await
        .map_err(|_| ApiError::new(500, "internal"))?;
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_794_398_400_000;

    fn song(artist: &str, title: &str, rank: f64) -> Song {
        Song::from(json!({ "source": "deezer", "ext_id": format!("{artist}-{title}"), "title": title, "artist": artist }), rank).unwrap()
    }
    fn art(name: &str) -> ArtistRef {
        ArtistRef { id: name.to_lowercase(), name: name.into(), v: json!({ "id": name, "name": name }) }
    }

    /// A small catalog: three corners (rock, pop, jazz), each artist has 6 songs.
    struct Fake;
    const CORNERS: [[&str; 4]; 3] = [["Rocker", "Stoner", "Indie", "Grunge"], ["Popstar", "Idol", "Diva", "Boyband"], ["Jazzman", "Sax", "Swing", "Bebop"]];
    fn corner(a: &str) -> Option<&'static [&'static str; 4]> {
        CORNERS.iter().find(|c| c.iter().any(|x| x.eq_ignore_ascii_case(a)))
    }
    fn songs_of(a: &str) -> Vec<Song> {
        (0..6).map(|i| song(a, &format!("{a} Song {i}"), 900_000.0 - i as f64 * 100_000.0)).collect()
    }
    impl Catalog for Fake {
        fn find_artist(&self, name: &str) -> Option<ArtistRef> {
            corner(name).map(|c| art(c.iter().find(|x| x.eq_ignore_ascii_case(name)).unwrap()))
        }
        fn related(&self, id: &str) -> Vec<ArtistRef> {
            corner(id).map(|c| c.iter().filter(|x| !x.eq_ignore_ascii_case(id)).map(|x| art(x)).collect()).unwrap_or_default()
        }
        fn top(&self, id: &str) -> Vec<Song> {
            corner(id).map(|c| songs_of(c.iter().find(|x| x.eq_ignore_ascii_case(id)).unwrap())).unwrap_or_default()
        }
        fn radio(&self, id: &str) -> Vec<Song> {
            let c = corner(id).unwrap();
            let mut v = Vec::new();
            for i in 0..5 {
                for a in c {
                    v.push(songs_of(a)[i].clone());
                }
            }
            v
        }
        fn genre_artists(&self, g: u32) -> Vec<ArtistRef> {
            if g == 129 { CORNERS[2].iter().map(|x| art(x)).collect() } else { vec![] }
        }
        fn playlists(&self, _q: &str) -> Vec<Value> {
            vec![]
        }
    }

    fn db() -> Connection {
        let db = crate::db::open(None).unwrap();
        db.execute_batch("INSERT INTO users (id, name, pass_hash, admin, created) VALUES (1,'a','x',1,0)").unwrap();
        db
    }
    fn play(db: &Connection, a: &str, ti: &str, kind: &str, played: f64, ts: i64) {
        record(db, 1, &json!({ "title": ti, "artist": a, "ext": { "source": "deezer", "id": "x" } }), kind, played, 200.0, ts);
    }

    #[test]
    fn keys_ignore_versions_and_features() {
        assert_eq!(song_key("Daft Punk, Pharrell", "Get Lucky (Radio Edit)"), song_key("Daft Punk", "Get Lucky - Remastered"));
        assert_eq!(main_artist("Beyoncé feat. Jay-Z"), "beyonce");
    }

    #[test]
    fn radio_keeps_the_mood_and_spreads() {
        let d = db();
        let t = taste(&d, None, 1, NOW);
        let seeds = [Seed { artist: "Rocker".into(), title: "Rocker Song 0".into() }];
        let out = radio(&Fake, &t, &seeds, &HashSet::new(), 15, NOW, 1);
        assert_eq!(out.len(), 15);
        let arts: Vec<String> = out.iter().map(|v| main_artist(v["artist"].as_str().unwrap())).collect();
        assert!(arts.iter().all(|a| corner(a) == corner("rocker")), "{arts:?}");
        for w in arts.windows(2) {
            assert_ne!(w[0], w[1]);
        }
        let keys: HashSet<String> = out.iter().map(|v| song_key(v["artist"].as_str().unwrap(), v["title"].as_str().unwrap())).collect();
        assert_eq!(keys.len(), out.len(), "no duplicates");
        assert!(!keys.contains(&song_key("Rocker", "Rocker Song 0")), "seed not repeated");
    }

    #[test]
    fn skips_and_recent_plays_drop_out() {
        let d = db();
        for _ in 0..2 {
            play(&d, "Stoner", "Stoner Song 0", "skip", 5.0, NOW - DAY);
        }
        play(&d, "Indie", "Indie Song 0", "complete", 200.0, NOW - 3_600_000);
        let t = taste(&d, None, 1, NOW);
        let seeds = [Seed { artist: "Rocker".into(), title: "Rocker Song 1".into() }];
        let out = radio(&Fake, &t, &seeds, &HashSet::new(), 30, NOW, 2);
        let keys: Vec<String> = out.iter().map(|v| song_key(v["artist"].as_str().unwrap(), v["title"].as_str().unwrap())).collect();
        assert!(!keys.contains(&song_key("Stoner", "Stoner Song 0")));
        assert!(!keys.contains(&song_key("Indie", "Indie Song 0")));
    }

    #[test]
    fn liked_artists_come_first() {
        let d = db();
        for i in 0..3 {
            d.execute(
                "INSERT INTO ext_likes (user_id, key, data, created) VALUES (1, ?, ?, 0)",
                params![format!("k{i}"), json!({ "title": format!("Grunge Song {i}"), "artist": "Grunge" }).to_string()],
            )
            .unwrap();
        }
        let t = taste(&d, None, 1, NOW);
        let seeds = [Seed { artist: "Rocker".into(), title: "Rocker Song 0".into() }];
        let out = radio(&Fake, &t, &seeds, &HashSet::new(), 10, NOW, 3);
        let grunge = out.iter().take(5).filter(|v| v["artist"] == "Grunge").count();
        assert!(grunge >= 2, "{out:?}");
    }

    #[test]
    fn for_you_mixes_discover_and_cold_start() {
        let d = db();
        for i in 0..4 {
            play(&d, "Popstar", &format!("Popstar Song {i}"), "complete", 200.0, NOW - 2 * DAY + i);
            play(&d, "Popstar", &format!("Popstar Song {i}"), "complete", 200.0, NOW - 3 * DAY + i);
        }
        d.execute("INSERT INTO follows (user_id, kind, ref, name, created) VALUES (1,'deezer','1','Jazzman',0)", []).unwrap();
        let t = taste(&d, None, 1, NOW);
        let v = for_you(&Fake, &t, &[], 1, NOW);
        let mixes = v["mixes"].as_array().unwrap();
        assert_eq!(mixes.len(), 2, "pop + jazz: {}", serde_json::to_string(&v["mixes"]).unwrap());
        for m in mixes {
            let tr = m["tracks"].as_array().unwrap();
            let c = corner(tr[0]["artist"].as_str().unwrap());
            assert!(tr.iter().all(|x| corner(x["artist"].as_str().unwrap()) == c));
        }
        // discover only has artists not heard or followed yet
        let disc = v["discover"].as_array().unwrap();
        assert!(!disc.is_empty());
        assert!(disc.iter().all(|x| !["Popstar", "Jazzman"].contains(&x["artist"].as_str().unwrap())));
        let rep = v["onRepeat"].as_array().unwrap();
        assert_eq!(rep.len(), 4);
        // same day = same mixes
        let again = for_you(&Fake, &t, &[], 1, NOW + 1000);
        assert_eq!(again["mixes"], v["mixes"]);

        // nobody heard anything yet: the genres from the setup assistant
        let d2 = db();
        d2.execute("INSERT INTO user_settings (user_id, data) VALUES (1, '{\"genres\":[\"jazz\"]}')", []).unwrap();
        let t2 = taste(&d2, None, 1, NOW);
        let v2 = for_you(&Fake, &t2, &[], 1, NOW);
        assert_eq!(v2["cold"], true);
        assert!(!v2["mixes"].as_array().unwrap().is_empty());
        assert_eq!(corner(v2["mixes"][0]["tracks"][0]["artist"].as_str().unwrap()), corner("jazzman"));
    }
}
