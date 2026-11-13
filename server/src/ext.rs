//! Other platforms: per-user source settings, imported playlists (matched against the
//! local library), fetching public playlist data, and share links.
use crate::api::{
    body_json, nf, serve_cover, serve_track, set_playlist_tracks, track_json, tracks_by_ids,
    with_likes, ApiError, Auth, AuthQ, St, R, TRACK_COLS,
};
use crate::db::now_ms;
use axum::extract::{Path, Query, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS spotify_tokens (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  access TEXT NOT NULL,
  refresh TEXT NOT NULL DEFAULT '',
  exp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS art (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  data BLOB NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (kind, ref_id)
);
CREATE TABLE IF NOT EXISTS yt_find (
  q TEXT PRIMARY KEY,
  vid TEXT NOT NULL,
  found INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS import_items (
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL,
  source TEXT NOT NULL,
  ext_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  cover TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  PRIMARY KEY (import_id, pos)
);
CREATE TABLE IF NOT EXISTS lyrics (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  synced TEXT NOT NULL DEFAULT '',
  plain TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  fetched INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  name TEXT NOT NULL,
  cover TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, ref)
);
"#;

pub fn routes() -> Router<St> {
    Router::new()
        .route("/me/settings", get(get_settings).put(put_settings))
        .route("/imports", get(list_imports).post(create_import))
        .route(
            "/imports/{id}",
            get(get_import).put(replace_import).delete(delete_import),
        )
        .route("/imports/{id}/rematch", post(rematch))
        .route("/imports/{id}/playlist", post(import_to_playlist))
        .route("/fetch/deezer", get(fetch_deezer))
        .route("/catalog/search", get(catalog_search))
        .route("/catalog/artist/{id}", get(catalog_artist))
        .route("/catalog/foryou", get(catalog_foryou))
        .route("/catalog/preview/{id}", get(catalog_preview))
        .route("/fetch/oembed", get(fetch_oembed))
        .route("/ytfind", get(yt_find))
        .route("/ytsearch", get(yt_search))
        .route("/ytmsearch", get(ytm_search))
        .route("/ytsong", get(yt_song))
        .route("/ytaudio/{id}", get(yt_audio))
        .route("/ytprefetch", post(yt_prefetch))
        .route("/ytcheck", get(yt_check))
        .route("/art/{kind}/{id}", get(get_art).put(put_art).delete(delete_art))
        .route("/lyrics", get(lyrics_lookup))
        .route("/lyrics/{id}", get(lyrics))
        .route("/follows", get(list_follows).put(follow).delete(unfollow))
        .route("/shares", post(create_share))
        .route("/public/{token}", get(public_share))
        .route("/public/{token}/save", post(save_share))
        .route("/public/{token}/join", post(join_share))
        .route("/public/{token}/stream/{i}", get(public_stream))
        .route("/public/{token}/cover/{i}", get(public_cover))
}

// ---------- settings ----------
async fn get_settings(State(st): State<St>, Auth(u, _): Auth) -> R {
    let db = st.db.lock().unwrap();
    let data: Option<String> = db
        .query_row(
            "SELECT data FROM user_settings WHERE user_id = ?",
            [u.id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);
    Ok(Json(
        data.and_then(|d| serde_json::from_str(&d).ok())
            .unwrap_or_else(|| json!({})),
    ))
}
async fn put_settings(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    let v: Value = body_json(req).await?;
    if !v.is_object() {
        return Err(ApiError::new(400, "bad_json"));
    }
    let text = v.to_string();
    if text.len() > 64 * 1024 {
        return Err(ApiError::new(413, "too_large"));
    }
    let db = st.db.lock().unwrap();
    db.execute("INSERT INTO user_settings (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data", params![u.id, text]).ok();
    Ok(Json(v))
}

// ---------- followed artists ----------
const FOLLOW_KINDS: [&str; 3] = ["local", "spotify", "deezer"];

async fn list_follows(State(st): State<St>, Auth(u, _): Auth) -> R {
    let db = st.db.lock().unwrap();
    let mut s = db
        .prepare("SELECT kind, ref, name, cover, created FROM follows WHERE user_id = ? ORDER BY created DESC")
        .unwrap();
    let rows: Vec<Value> = s
        .query_map([u.id], |r| {
            Ok(json!({
                "kind": r.get::<_, String>(0)?,
                "ref": r.get::<_, String>(1)?,
                "name": r.get::<_, String>(2)?,
                "cover": r.get::<_, String>(3)?,
                "created": r.get::<_, i64>(4)?,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    Ok(Json(json!(rows)))
}
async fn follow(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    let v: Value = body_json(req).await?;
    let text = |k: &str| v[k].as_str().unwrap_or("").trim().to_string();
    let (kind, rf, name, cover) = (text("kind"), text("ref"), text("name"), text("cover"));
    if !FOLLOW_KINDS.contains(&kind.as_str()) || rf.is_empty() || name.is_empty() {
        return Err(ApiError::new(400, "bad_json"));
    }
    if rf.len() > 300 || name.len() > 300 || cover.len() > 1000 {
        return Err(ApiError::new(413, "too_large"));
    }
    st.db.lock().unwrap().execute(
        "INSERT INTO follows (user_id, kind, ref, name, cover, created) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, kind, ref) DO UPDATE SET name = excluded.name, cover = excluded.cover",
        params![u.id, kind, rf, name, cover, now_ms()],
    ).ok();
    Ok(Json(json!({ "following": true })))
}
async fn unfollow(
    State(st): State<St>,
    Auth(u, _): Auth,
    Query(q): Query<HashMap<String, String>>,
) -> R {
    let kind = q.get("kind").map(String::as_str).unwrap_or("");
    let rf = q.get("ref").map(String::as_str).unwrap_or("");
    st.db
        .lock()
        .unwrap()
        .execute(
            "DELETE FROM follows WHERE user_id = ? AND kind = ? AND ref = ?",
            params![u.id, kind, rf],
        )
        .ok();
    Ok(Json(json!({ "following": false })))
}

// ---------- matching ----------
/// Lowercase, no accents, no "(Remastered 2011)", "- Live", "feat. X", no punctuation.
pub fn norm(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in s.chars() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = (depth - 1i32).max(0),
            _ if depth > 0 => {}
            _ => out.push(c),
        }
    }
    let lower = out.to_lowercase();
    // drop " - remastered ...", " - live ..." style suffixes and featured artists
    let mut base = lower.as_str();
    for cut in [" - ", " feat.", " feat ", " ft.", " ft ", " featuring "] {
        if let Some(i) = base.find(cut) {
            base = &base[..i];
        }
    }
    base.chars()
        .map(fold)
        .filter(|c| c.is_alphanumeric() || *c == ' ')
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn fold(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'å' | 'ā' => 'a',
        'ä' => 'a',
        'ç' => 'c',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ñ' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ø' => 'o',
        'ö' => 'o',
        'ù' | 'ú' | 'û' => 'u',
        'ü' => 'u',
        'ß' => 's',
        '&' => ' ',
        _ => c,
    }
}
fn artist_tokens(s: &str) -> Vec<String> {
    s.to_lowercase()
        .replace(" & ", ",")
        .replace(" and ", ",")
        .replace(" x ", ",")
        .replace(" feat. ", ",")
        .replace(" feat ", ",")
        .replace(" ft. ", ",")
        .replace(';', ",")
        .replace(" - topic", "")
        .split(',')
        .map(norm)
        .filter(|a| !a.is_empty())
        .collect()
}

struct Local {
    id: i64,
    artists: Vec<String>,
    duration: f64,
}
/// Index of the library by normalised title.
pub struct Matcher {
    by_title: HashMap<String, Vec<Local>>,
}
impl Matcher {
    pub fn new(db: &Connection) -> Self {
        let mut by_title: HashMap<String, Vec<Local>> = HashMap::new();
        let mut st = db
            .prepare("SELECT id, title, artist, album_artist, duration FROM tracks")
            .unwrap();
        let rows = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, f64>(4)?,
                ))
            })
            .unwrap();
        for (id, title, artist, aa, duration) in rows.filter_map(Result::ok) {
            let mut artists = artist_tokens(&artist);
            artists.extend(artist_tokens(&aa));
            by_title.entry(norm(&title)).or_default().push(Local {
                id,
                artists,
                duration,
            });
        }
        Matcher { by_title }
    }
    pub fn find(&self, title: &str, artist: &str, duration: f64) -> Option<i64> {
        let cands = self.by_title.get(&norm(title))?;
        let want = artist_tokens(artist);
        let mut best: Option<(i64, f64)> = None;
        for c in cands {
            let artist_hit = want.is_empty()
                || want.iter().any(|a| {
                    c.artists
                        .iter()
                        .any(|b| b == a || b.contains(a.as_str()) || a.contains(b.as_str()))
                });
            let dur_ok =
                duration <= 0.0 || c.duration <= 0.0 || (duration - c.duration).abs() <= 6.0;
            if !artist_hit && !(dur_ok && duration > 0.0 && (duration - c.duration).abs() <= 2.0) {
                continue;
            }
            let score = (if artist_hit { 2.0 } else { 0.0 }) + (if dur_ok { 1.0 } else { 0.0 })
                - (duration - c.duration).abs().min(60.0) / 60.0;
            if best.map(|b| score > b.1).unwrap_or(true) {
                best = Some((c.id, score));
            }
        }
        best.filter(|b| b.1 >= 2.0).map(|b| b.0)
    }
}

// ---------- imports ----------
#[derive(Deserialize, Default, Clone)]
#[serde(default)]
struct ItemIn {
    source: String,
    ext_id: String,
    title: String,
    artist: String,
    album: String,
    duration: f64,
    cover: String,
    url: String,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct ImportIn {
    source: String,
    name: String,
    url: String,
    cover: String,
    /// description, owner, followers … shown like on the platform
    meta: Value,
    items: Vec<ItemIn>,
}
fn meta_text(v: &Value) -> String {
    let t = if v.is_object() { v.to_string() } else { "{}".into() };
    if t.len() > 8000 { "{}".into() } else { t }
}

fn clip(s: &str, n: usize) -> String {
    s.trim().chars().take(n).collect()
}

fn own_import(db: &Connection, uid: i64, id: i64) -> Result<(), ApiError> {
    db.query_row(
        "SELECT id FROM imports WHERE id = ? AND user_id = ?",
        params![id, uid],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .unwrap_or(None)
    .map(|_| ())
    .ok_or_else(nf)
}

fn write_items(db: &mut Connection, id: i64, source: &str, items: &[ItemIn]) {
    let m = Matcher::new(db);
    let tx = db.transaction().unwrap();
    tx.execute("DELETE FROM import_items WHERE import_id = ?", [id])
        .ok();
    for (i, it) in items.iter().take(10000).enumerate() {
        let title = clip(&it.title, 300);
        if title.is_empty() {
            continue;
        }
        let local = m.find(&title, &it.artist, it.duration);
        let src = if it.source.is_empty() {
            source
        } else {
            it.source.as_str()
        };
        tx.execute(
            "INSERT INTO import_items (import_id, pos, source, ext_id, title, artist, album, duration, cover, url, track_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            params![id, i as i64, clip(src, 20), clip(&it.ext_id, 200), title, clip(&it.artist, 300), clip(&it.album, 300), it.duration.max(0.0), clip(&it.cover, 1000), clip(&it.url, 1000), local],
        )
        .ok();
    }
    tx.execute(
        "UPDATE imports SET updated = ? WHERE id = ?",
        params![now_ms(), id],
    )
    .ok();
    tx.commit().ok();
}

async fn create_import(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    let b: ImportIn = body_json_big(req).await?;
    let name = clip(&b.name, 120);
    if name.is_empty() || b.items.is_empty() {
        return Err(ApiError::new(400, "empty_import"));
    }
    let mut db = st.db.lock().unwrap();
    let now = now_ms();
    // the same playlist imported again updates the one already there instead of adding a copy
    let url = clip(&b.url, 1000);
    if !url.is_empty() {
        let old: Option<i64> = db
            .query_row("SELECT id FROM imports WHERE user_id = ? AND url = ? ORDER BY id LIMIT 1", params![u.id, url], |r| r.get(0))
            .optional()
            .unwrap_or(None);
        if let Some(id) = old {
            db.execute(
                "UPDATE imports SET name = ?, cover = ?, meta = ? WHERE id = ?",
                params![name, clip(&b.cover, 1000), meta_text(&b.meta), id],
            )
            .ok();
            write_items(&mut db, id, &b.source, &b.items);
            return Ok(Json(json!({ "id": id, "existing": true })));
        }
    }
    db.execute(
        "INSERT INTO imports (user_id, source, name, url, cover, created, updated, meta) VALUES (?,?,?,?,?,?,?,?)",
        params![u.id, clip(&b.source, 20), name, clip(&b.url, 1000), clip(&b.cover, 1000), now, now, meta_text(&b.meta)],
    )
    .ok();
    let id = db.last_insert_rowid();
    write_items(&mut db, id, &b.source, &b.items);
    Ok(Json(json!({ "id": id })))
}

async fn replace_import(
    State(st): State<St>,
    Auth(u, _): Auth,
    Path(id): Path<i64>,
    req: Request,
) -> R {
    let b: ImportIn = body_json_big(req).await?;
    let mut db = st.db.lock().unwrap();
    own_import(&db, u.id, id)?;
    if !b.name.trim().is_empty() {
        db.execute(
            "UPDATE imports SET name = ? WHERE id = ?",
            params![clip(&b.name, 120), id],
        )
        .ok();
    }
    if b.meta.is_object() {
        db.execute("UPDATE imports SET meta = ? WHERE id = ?", params![meta_text(&b.meta), id]).ok();
    }
    if !b.cover.trim().is_empty() {
        db.execute("UPDATE imports SET cover = ? WHERE id = ?", params![clip(&b.cover, 1000), id]).ok();
    }
    if !b.items.is_empty() {
        let src: String = db
            .query_row("SELECT source FROM imports WHERE id = ?", [id], |r| {
                r.get(0)
            })
            .unwrap_or_default();
        write_items(&mut db, id, &src, &b.items);
    }
    Ok(Json(json!({ "id": id })))
}

/// Up to 16 MB, imports can be large.
async fn body_json_big<T: serde::de::DeserializeOwned + Default>(
    req: Request,
) -> Result<T, ApiError> {
    let bytes = axum::body::to_bytes(req.into_body(), 16 << 20)
        .await
        .map_err(|_| ApiError::new(413, "too_large"))?;
    if bytes.is_empty() {
        return Ok(T::default());
    }
    serde_json::from_slice(&bytes).map_err(|_| ApiError::new(400, "bad_json"))
}

async fn list_imports(State(st): State<St>, Auth(u, _): Auth) -> R {
    let db = st.db.lock().unwrap();
    let mut s = db
        .prepare(
            "SELECT i.id, i.source, i.name, i.url, i.cover, i.updated, COUNT(it.pos), COUNT(it.track_id),
                    (SELECT cover FROM import_items WHERE import_id = i.id AND cover != '' ORDER BY pos LIMIT 1),
                    (SELECT track_id FROM import_items WHERE import_id = i.id AND track_id IS NOT NULL ORDER BY pos LIMIT 1),
                    (SELECT updated FROM art WHERE kind = 'import' AND ref_id = i.id)
             FROM imports i LEFT JOIN import_items it ON it.import_id = i.id
             WHERE i.user_id = ? GROUP BY i.id ORDER BY i.updated DESC",
        )
        .unwrap();
    let rows: Vec<Value> = s
        .query_map([u.id], |r| {
            let cover: String = r.get(4)?;
            let first: Option<String> = r.get(8)?;
            Ok(json!({
                "id": r.get::<_, i64>(0)?, "source": r.get::<_, String>(1)?, "name": r.get::<_, String>(2)?,
                "url": r.get::<_, String>(3)?, "cover": if cover.is_empty() { first.unwrap_or_default() } else { cover },
                "updated": r.get::<_, i64>(5)?, "total": r.get::<_, i64>(6)?, "matched": r.get::<_, i64>(7)?,
                "cover_id": r.get::<_, Option<i64>>(9)?, "art": r.get::<_, Option<i64>>(10)?.unwrap_or(0),
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    Ok(Json(json!(rows)))
}

fn import_items(db: &Connection, u: &crate::auth::User, id: i64) -> Vec<Value> {
    let mut s = db
        .prepare("SELECT pos, source, ext_id, title, artist, album, duration, cover, url, track_id FROM import_items WHERE import_id = ? ORDER BY pos")
        .unwrap();
    let mut items: Vec<Value> = s
        .query_map([id], |r| {
            Ok(json!({
                "pos": r.get::<_, i64>(0)?, "source": r.get::<_, String>(1)?, "ext_id": r.get::<_, String>(2)?,
                "title": r.get::<_, String>(3)?, "artist": r.get::<_, String>(4)?, "album": r.get::<_, String>(5)?,
                "duration": r.get::<_, f64>(6)?, "cover": r.get::<_, String>(7)?, "url": r.get::<_, String>(8)?,
                "track_id": r.get::<_, Option<i64>>(9)?,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    let ids: Vec<i64> = items
        .iter()
        .filter_map(|i| i["track_id"].as_i64())
        .collect();
    let locals: HashMap<i64, Value> = with_likes(db, u, tracks_by_ids(db, &ids))
        .into_iter()
        .map(|t| (t["id"].as_i64().unwrap(), t))
        .collect();
    for it in items.iter_mut() {
        if let Some(t) = it["track_id"].as_i64().and_then(|i| locals.get(&i)) {
            it["local"] = t.clone();
        }
    }
    items
}

async fn get_import(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>) -> R {
    let db = st.db.lock().unwrap();
    own_import(&db, u.id, id)?;
    let (source, name, url, cover, updated, meta): (String, String, String, String, i64, String) = db
        .query_row(
            "SELECT source, name, url, cover, updated, meta FROM imports WHERE id = ?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .map_err(|_| nf())?;
    let meta: Value = serde_json::from_str(&meta).unwrap_or_else(|_| json!({}));
    Ok(Json(
        json!({ "id": id, "source": source, "name": name, "url": url, "cover": cover, "updated": updated, "meta": meta, "art": art_version(&db, "import", id), "items": import_items(&db, &u, id) }),
    ))
}

async fn delete_import(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>) -> R {
    let db = st.db.lock().unwrap();
    own_import(&db, u.id, id)?;
    db.execute("DELETE FROM import_items WHERE import_id = ?", [id])
        .ok();
    db.execute("DELETE FROM imports WHERE id = ?", [id]).ok();
    Ok(Json(json!({ "ok": true })))
}

async fn rematch(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>) -> R {
    let mut db = st.db.lock().unwrap();
    own_import(&db, u.id, id)?;
    let m = Matcher::new(&db);
    let rows: Vec<(i64, String, String, f64)> = {
        let mut s = db
            .prepare("SELECT pos, title, artist, duration FROM import_items WHERE import_id = ?")
            .unwrap();
        let v = s
            .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        v
    };
    let tx = db.transaction().unwrap();
    let mut matched = 0;
    for (pos, title, artist, dur) in rows {
        let local = m.find(&title, &artist, dur);
        if local.is_some() {
            matched += 1;
        }
        tx.execute(
            "UPDATE import_items SET track_id = ? WHERE import_id = ? AND pos = ?",
            params![local, id, pos],
        )
        .ok();
    }
    tx.commit().ok();
    Ok(Json(json!({ "matched": matched })))
}

/// Save the songs that exist locally as a normal playlist.
async fn import_to_playlist(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>) -> R {
    let mut db = st.db.lock().unwrap();
    own_import(&db, u.id, id)?;
    let name: String = db
        .query_row("SELECT name FROM imports WHERE id = ?", [id], |r| r.get(0))
        .map_err(|_| nf())?;
    let ids: Vec<i64> = {
        let mut s = db.prepare("SELECT track_id FROM import_items WHERE import_id = ? AND track_id IS NOT NULL ORDER BY pos").unwrap();
        let v = s
            .query_map([id], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        v
    };
    // playlists hold songs on the server only; an empty copy would just be clutter
    if ids.is_empty() {
        return Err(ApiError::new(400, "no_local_tracks"));
    }
    let now = now_ms();
    db.execute(
        "INSERT INTO playlists (user_id, name, created, updated) VALUES (?,?,?,?)",
        params![u.id, name, now, now],
    )
    .ok();
    let pid = db.last_insert_rowid();
    set_playlist_tracks(&mut db, pid, &ids);
    Ok(Json(
        json!({ "id": pid, "name": name, "tracks": ids.len() }),
    ))
}

// ---------- fetching public data (server side because these APIs have no CORS) ----------
fn http_get(url: &str) -> Result<Value, ApiError> {
    ureq::get(url)
        .set("User-Agent", "Musik-Server")
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => ApiError::new(404, "not_found"),
            ureq::Error::Status(401 | 403, _) => ApiError::new(403, "private"),
            _ => ApiError::new(502, "source_unreachable"),
        })?
        .into_json::<Value>()
        .map_err(|_| ApiError::new(502, "bad_source_data"))
}

/// Deezer playlist or album: ?type=playlist|album&id=123
async fn fetch_deezer(Auth(_, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let kind = match q.get("type").map(String::as_str) {
        Some("album") => "album",
        _ => "playlist",
    };
    let id: String = q
        .get("id")
        .map(|s| s.chars().filter(|c| c.is_ascii_digit()).collect())
        .unwrap_or_default();
    if id.is_empty() {
        return Err(ApiError::new(400, "bad_link"));
    }
    let res = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let head = http_get(&format!("https://api.deezer.com/{kind}/{id}"))?;
        if head.get("error").is_some() {
            return Err(ApiError::new(404, "not_found"));
        }
        let name = head["title"].as_str().unwrap_or("Deezer").to_string();
        let cover = head["picture_xl"].as_str().or(head["cover_xl"].as_str()).unwrap_or("").to_string();
        let mut items = vec![];
        let mut next = Some(format!("https://api.deezer.com/{kind}/{id}/tracks?limit=100"));
        let mut pages = 0;
        while let Some(url) = next.take() {
            pages += 1;
            let page = http_get(&url)?;
            for t in page["data"].as_array().cloned().unwrap_or_default() {
                items.push(json!({
                    "source": "deezer", "ext_id": t["id"].to_string(), "title": t["title"].as_str().unwrap_or(""),
                    "artist": t["artist"]["name"].as_str().unwrap_or(""),
                    "album": t["album"]["title"].as_str().or(head["title"].as_str()).unwrap_or(""),
                    "duration": t["duration"].as_f64().unwrap_or(0.0),
                    "cover": t["album"]["cover_medium"].as_str().or(head["cover_medium"].as_str()).unwrap_or(""),
                    "url": t["link"].as_str().unwrap_or(""),
                }));
            }
            next = page["next"].as_str().map(str::to_string);
            if pages >= 50 {
                break;
            }
        }
        Ok(json!({ "name": name, "cover": cover, "items": items }))
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))??;
    Ok(Json(res))
}

// ---------- own covers for playlists and imports (cropped in the app, stored as JPEG) ----------
fn art_kind(k: &str) -> Result<&'static str, ApiError> {
    match k {
        "playlist" => Ok("playlist"),
        "import" => Ok("import"),
        "user" => Ok("user"),
        _ => Err(nf()),
    }
}
fn own_ref(db: &Connection, uid: i64, kind: &str, id: i64) -> Result<(), ApiError> {
    // a profile picture belongs to the user with that id
    if kind == "user" {
        return if id == uid { Ok(()) } else { Err(nf()) };
    }
    let table = if kind == "playlist" { "playlists" } else { "imports" };
    db.query_row(&format!("SELECT id FROM {table} WHERE id = ? AND user_id = ?"), params![id, uid], |r| r.get::<_, i64>(0))
        .optional()
        .unwrap_or(None)
        .map(|_| ())
        .ok_or_else(nf)
}
/// Version of an own cover (0 = none), for lists and cache busting.
pub fn art_version(db: &Connection, kind: &str, id: i64) -> i64 {
    db.query_row("SELECT updated FROM art WHERE kind = ? AND ref_id = ?", params![kind, id], |r| r.get(0))
        .optional()
        .unwrap_or(None)
        .unwrap_or(0)
}
async fn get_art(State(st): State<St>, a: crate::api::AuthQ, Path((kind, id)): Path<(String, i64)>) -> Result<Response, ApiError> {
    let kind = art_kind(&kind)?;
    let db = st.db.lock().unwrap();
    let member = kind == "playlist"
        && db.query_row("SELECT 1 FROM playlist_members WHERE playlist_id = ? AND user_id = ?", params![id, a.0.id], |r| r.get::<_, i64>(0)).is_ok();
    // profile pictures are visible to everyone on the server
    if !member && kind != "user" {
        own_ref(&db, a.0.id, kind, id)?;
    }
    let data: Vec<u8> = db
        .query_row("SELECT data FROM art WHERE kind = ? AND ref_id = ?", params![kind, id], |r| r.get(0))
        .optional()
        .unwrap_or(None)
        .ok_or_else(nf)?;
    use axum::response::IntoResponse;
    Ok(([(axum::http::header::CONTENT_TYPE, "image/jpeg"), (axum::http::header::CACHE_CONTROL, "private, max-age=31536000")], data).into_response())
}
async fn put_art(State(st): State<St>, Auth(u, _): Auth, Path((kind, id)): Path<(String, i64)>, req: Request) -> R {
    let kind = art_kind(&kind)?;
    let bytes = axum::body::to_bytes(req.into_body(), 4 << 20).await.map_err(|_| ApiError::new(413, "too_large"))?;
    // JPEG or PNG only
    if !(bytes.starts_with(&[0xFF, 0xD8, 0xFF]) || bytes.starts_with(&[0x89, b'P', b'N', b'G'])) {
        return Err(ApiError::new(400, "bad_image"));
    }
    let db = st.db.lock().unwrap();
    own_ref(&db, u.id, kind, id)?;
    let v = now_ms();
    db.execute(
        "INSERT INTO art (user_id, kind, ref_id, data, updated) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, ref_id) DO UPDATE SET data = excluded.data, updated = excluded.updated",
        params![u.id, kind, id, bytes.to_vec(), v],
    )
    .ok();
    Ok(Json(json!({ "art": v })))
}
async fn delete_art(State(st): State<St>, Auth(u, _): Auth, Path((kind, id)): Path<(String, i64)>) -> R {
    let kind = art_kind(&kind)?;
    let db = st.db.lock().unwrap();
    own_ref(&db, u.id, kind, id)?;
    db.execute("DELETE FROM art WHERE kind = ? AND ref_id = ?", params![kind, id]).ok();
    Ok(Json(json!({ "ok": true })))
}

// ---------- YouTube video for a song (name + artist from Spotify), cached for every device ----------
fn yt_key(st: &St, uid: i64) -> String {
    let db = st.db.lock().unwrap();
    let data: Option<String> = db
        .query_row("SELECT data FROM user_settings WHERE user_id = ?", [uid], |r| r.get(0))
        .optional()
        .unwrap_or(None);
    let k = data
        .and_then(|d| serde_json::from_str::<Value>(&d).ok())
        .and_then(|v| v["youtubeKey"].as_str().map(|s| s.trim().to_string()))
        .unwrap_or_default();
    if k.is_empty() {
        std::env::var("YOUTUBE_KEY").unwrap_or_default().trim().to_string()
    } else {
        k
    }
}
/// The YouTube video for a song. Like the Msik bot: one YouTube search for "<first artist> - <title>"
/// and YouTube's first hit (versions that are not the original, like piano or karaoke, are passed
/// over unless the song itself is one). With `embed`, only videos that may play inside other apps
/// count (for the YouTube player fallback). Remembered per song.
fn find_video(st: &St, uid: i64, title: &str, artist: &str, duration: f64, q: &str, skip: &[String], embed: bool) -> Result<String, ApiError> {
    let first = artist.split(',').next().unwrap_or("").trim().to_string();
    let term = if title.is_empty() { q.to_string() } else { format!("{first} - {title}").trim_matches(|c: char| c == ' ' || c == '-').to_string() };
    if term.is_empty() {
        return Err(ApiError::new(400, "bad_query"));
    }
    // the whole "artist - title" (ext::norm would cut at " - " and give every song of an artist one key)
    let ck = format!("{}:{}|{}", if embed { "e" } else { "s" }, crate::yt::plain(&first), crate::yt::plain(if title.is_empty() { q } else { title }));
    let cached: Option<(String, i64)> = {
        let db = st.db.lock().unwrap();
        db.query_row("SELECT vid, found FROM yt_find WHERE q = ?", [&ck], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .unwrap_or(None)
    };
    // misses are tried again after a day
    if let Some((vid, found)) = cached {
        if (!vid.is_empty() && !skip.contains(&vid)) || (vid.is_empty() && skip.is_empty() && now_ms() / 1000 - found < 86400) {
            return Ok(vid);
        }
    }
    let t2 = if title.is_empty() { term.clone() } else { title.to_string() };
    // only YouTube Music songs (the album tracks, the same recordings as on Spotify), no videos
    let mut reached = false;
    let mut cands: Vec<String> = Vec::new();
    for q in [format!("{first} {t2}"), format!("{t2} {artist}")] {
        if let Ok(sg) = crate::yt::music_search(&q) {
            reached = true;
            cands = crate::yt::pick_song(&sg, &t2, artist, duration);
            if !cands.is_empty() {
                break;
            }
        }
    }
    // not on YouTube Music as a song: the artist's own upload on YouTube ("<artist> - Topic" or
    // the artist's channel), never somebody else's version
    if cands.is_empty() {
        if let Ok(v) = crate::yt::search(&term) {
            reached = true;
            let fa = crate::yt::plain(&first);
            let own: Vec<Value> = v
                .into_iter()
                .filter(|x| {
                    let ch = crate::yt::plain(x["channel"].as_str().unwrap_or(""));
                    !fa.is_empty() && (ch == fa || ch == format!("{fa} topic") || ch == format!("{fa}vevo") || ch == format!("{fa} vevo") || ch == format!("{fa} official"))
                })
                .collect();
            cands = crate::yt::msik_order(&own, &t2, artist, duration);
        }
    }
    let mut seen = std::collections::HashSet::new();
    cands.retain(|c| !skip.contains(c) && seen.insert(c.clone()));
    let vid = if embed {
        cands.truncate(6);
        let ok: Vec<bool> = std::thread::scope(|sc| {
            let hs: Vec<_> = cands.iter().map(|c| sc.spawn(move || crate::yt::embeddable(c))).collect();
            hs.into_iter().map(|h| h.join().unwrap_or(true)).collect()
        });
        cands.iter().zip(ok).find(|(_, ok)| *ok).map(|(c, _)| c.clone()).unwrap_or_default()
    } else {
        cands.first().cloned().unwrap_or_default()
    };
    if vid.is_empty() && !reached {
        // YouTube's own search is down: the official API with the user's key, if there is one
        let key = yt_key(st, uid);
        if key.is_empty() {
            return Err(ApiError::new(502, "youtube_unreachable"));
        }
        let url = format!(
            "https://www.googleapis.com/youtube/v3/search?part=id&type=video&videoEmbeddable=true&maxResults=1&q={}&key={}",
            urlencode(&term),
            urlencode(&key)
        );
        let res = ureq::get(&url)
            .timeout(Duration::from_secs(15))
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(400, _) => ApiError::new(400, "youtube_key_bad"),
                ureq::Error::Status(403, _) => ApiError::new(429, "youtube_quota"),
                _ => ApiError::new(502, "youtube_unreachable"),
            })?
            .into_json::<Value>()
            .map_err(|_| ApiError::new(502, "bad_source_data"))?;
        let v = res["items"][0]["id"]["videoId"].as_str().unwrap_or("").to_string();
        return Ok(v);
    }
    let db = st.db.lock().unwrap();
    db.execute(
        "INSERT INTO yt_find (q, vid, found) VALUES (?, ?, ?) ON CONFLICT(q) DO UPDATE SET vid = excluded.vid, found = excluded.found",
        params![ck, vid, now_ms() / 1000],
    )
    .ok();
    Ok(vid)
}

fn song_query(q: &HashMap<String, String>) -> (String, String, f64, String, Vec<String>) {
    let g = |k: &str| q.get(k).map(|s| s.trim().chars().take(200).collect::<String>()).unwrap_or_default();
    let skip = g("skip").split(',').map(|x| x.trim().to_string()).filter(|x| x.len() == 11).collect();
    (g("title"), g("artist"), g("duration").parse().unwrap_or(0.0), g("q"), skip)
}

/// ?title=&artist=&duration= (or ?q=) [&skip=id,id] → { id } of a YouTube video that may be embedded
async fn yt_find(State(st): State<St>, Auth(u, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let (title, artist, duration, qq, skip) = song_query(&q);
    let vid = tokio::task::spawn_blocking(move || find_video(&st, u.id, &title, &artist, duration, &qq, &skip, true))
        .await
        .map_err(|_| ApiError::new(500, "internal"))??;
    Ok(Json(json!({ "id": vid })))
}

/// The sound of a song, streamed like the Msik bot: ?title=&artist=&duration=&t=
async fn yt_song(State(st): State<St>, AuthQ(u): AuthQ, Query(q): Query<HashMap<String, String>>, headers: axum::http::HeaderMap) -> Response {
    let (title, artist, duration, qq, skip) = song_query(&q);
    let st2 = st.clone();
    let vid = match tokio::task::spawn_blocking(move || find_video(&st2, u.id, &title, &artist, duration, &qq, &skip, false)).await {
        Ok(Ok(v)) if !v.is_empty() => v,
        Ok(Ok(_)) => return ApiError::new(404, "notfound").into_response(),
        Ok(Err(e)) => return e.into_response(),
        Err(_) => return ApiError::new(500, "internal").into_response(),
    };
    // the bot looks up the next songs ahead; here the app asks with ?next= (title|artist per line)
    proxy_audio(vid, headers).await
}

/// The sound of one YouTube video: /api/ytaudio/{id}?t=
async fn yt_audio(AuthQ(_): AuthQ, Path(vid): Path<String>, headers: axum::http::HeaderMap) -> Response {
    if vid.len() != 11 || !vid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return ApiError::new(400, "bad_query").into_response();
    }
    proxy_audio(vid, headers).await
}

/// Passes the audio stream on, with Range so seeking works. The googlevideo link only works from
/// this server's address, so the app can't fetch it itself.
async fn proxy_audio(vid: String, headers: axum::http::HeaderMap) -> Response {
    use axum::body::Body;
    use axum::http::{header, StatusCode};
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from);
    let res = tokio::task::spawn_blocking(move || {
        for attempt in 0..2 {
            // a link from the light way that does not play: ask yt-dlp the second time
            let s = crate::ytdl::stream_with(&vid, attempt > 0).map_err(|e| {
                eprintln!("yt-dlp {vid}: {e}");
                ApiError::new(502, "youtube_unreachable")
            })?;
            let mut req = ureq::get(&s.url);
            for (k, v) in &s.headers {
                req = req.set(k, v);
            }
            req = req.set("range", range.as_deref().unwrap_or("bytes=0-"));
            match req.call() {
                Ok(r) => return Ok(r),
                Err(ureq::Error::Status(416, r)) => return Ok(r),
                // an old link: look it up again once
                Err(_) if attempt == 0 => crate::ytdl::forget(&vid),
                Err(e) => {
                    eprintln!("stream {vid}: {e}");
                    return Err(ApiError::new(502, "youtube_unreachable"));
                }
            }
        }
        Err(ApiError::new(502, "youtube_unreachable"))
    })
    .await;
    let r = match res {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return e.into_response(),
        Err(_) => return ApiError::new(500, "internal").into_response(),
    };
    let status = StatusCode::from_u16(r.status()).unwrap_or(StatusCode::OK);
    let mut out = axum::http::HeaderMap::new();
    for h in ["content-type", "content-length", "content-range", "accept-ranges"] {
        if let Some(v) = r.header(h).and_then(|v| v.parse().ok()) {
            out.insert(h, v);
        }
    }
    if !out.contains_key("accept-ranges") {
        out.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    }
    out.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(8);
    std::thread::spawn(move || {
        let mut rd = r.into_reader();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match rd.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
                        break; // the app stopped listening (skip, seek)
                    }
                }
                Err(e) => {
                    tx.blocking_send(Err(e)).ok();
                    break;
                }
            }
        }
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|x| (x, rx)) });
    (status, out, Body::from_stream(stream)).into_response()
}

/// Checks the whole way for one known song: search on YouTube Music, pick, stream. For the settings.
async fn yt_check(State(st): State<St>, Auth(u, _): Auth) -> R {
    let out = tokio::task::spawn_blocking(move || {
        let t = std::time::Instant::now();
        let songs = crate::yt::music_search("Red Hot Chili Peppers Californication");
        let search_ms = t.elapsed().as_millis() as u64;
        let pick = songs.as_ref().ok().and_then(|s| crate::yt::pick_song(s, "Californication", "Red Hot Chili Peppers", 329.0).into_iter().next());
        let title = pick.as_ref().and_then(|id| songs.as_ref().ok()?.iter().find(|s| s["id"] == id.as_str()).map(|s| format!("{} - {}", s["artist"].as_str().unwrap_or(""), s["title"].as_str().unwrap_or(""))));
        let stream = pick.as_ref().map(|id| crate::ytdl::diagnose(id));
        let cached: i64 = st.db.lock().unwrap().query_row("SELECT COUNT(*) FROM yt_find", [], |r| r.get(0)).unwrap_or(0);
        let _ = u;
        json!({ "search": songs.is_ok(), "search_error": songs.err(), "search_ms": search_ms, "pick": pick, "title": title, "stream": stream, "remembered": cached, "version": crate::api::VERSION })
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))?;
    Ok(Json(out))
}

/// POST {ids:[...]} or ?songs= : the next songs' streams are looked up ahead (like the bot does)
async fn yt_prefetch(State(st): State<St>, Auth(u, _): Auth, Json(b): Json<Value>) -> R {
    let songs: Vec<(String, String, f64)> = b["songs"]
        .as_array()
        .map(|a| a.iter().take(3).map(|x| (x["title"].as_str().unwrap_or("").to_string(), x["artist"].as_str().unwrap_or("").to_string(), x["duration"].as_f64().unwrap_or(0.0))).collect())
        .unwrap_or_default();
    let ids: Vec<String> = b["ids"].as_array().map(|a| a.iter().take(3).filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        for id in ids.into_iter().filter(|i| i.len() == 11) {
            crate::ytdl::prefetch(id);
        }
        for (t, a, d) in songs {
            if let Ok(v) = find_video(&st, u.id, &t, &a, d, "", &[], false) {
                if !v.is_empty() {
                    crate::ytdl::prefetch(v);
                }
            }
        }
    });
    Ok(Json(json!({ "ok": true })))
}
/// ?q= → YouTube videos (no key needed)
async fn yt_search(Auth(_, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let term: String = q.get("q").map(|s| s.trim().chars().take(200).collect()).unwrap_or_default();
    if term.is_empty() {
        return Ok(Json(json!([])));
    }
    let v = tokio::task::spawn_blocking(move || crate::yt::search(&term))
        .await
        .map_err(|_| ApiError::new(500, "internal"))?
        .map_err(|_| ApiError::new(502, "youtube_unreachable"))?;
    Ok(Json(json!(v.into_iter().take(20).collect::<Vec<_>>())))
}
/// ?q= → songs on YouTube Music (no videos, no key needed)
async fn ytm_search(Auth(_, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let term: String = q.get("q").map(|s| s.trim().chars().take(200).collect()).unwrap_or_default();
    if term.is_empty() {
        return Ok(Json(json!([])));
    }
    let v = tokio::task::spawn_blocking(move || crate::yt::music_search(&term))
        .await
        .map_err(|_| ApiError::new(500, "internal"))?
        .map_err(|_| ApiError::new(502, "youtube_unreachable"))?;
    Ok(Json(json!(v.into_iter().take(20).collect::<Vec<_>>())))
}
fn urlencode(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

// ---------- catalog: the public Deezer catalog (no key needed) for search like on Spotify ----------
fn dz_track(t: &Value) -> Value {
    json!({
        "source": "deezer", "ext_id": t["id"].to_string(), "title": t["title"].as_str().unwrap_or(""),
        "artist": t["artist"]["name"].as_str().unwrap_or(""),
        "album": t["album"]["title"].as_str().unwrap_or(""),
        "duration": t["duration"].as_f64().unwrap_or(0.0),
        "cover": t["album"]["cover_medium"].as_str().unwrap_or(""),
        "url": t["link"].as_str().unwrap_or(""),
    })
}
fn dz_album(a: &Value) -> Value {
    json!({ "id": a["id"].to_string(), "title": a["title"].as_str().unwrap_or(""), "artist": a["artist"]["name"].as_str().unwrap_or(""),
            "cover": a["cover_medium"].as_str().unwrap_or(""), "url": a["link"].as_str().unwrap_or("") })
}
fn dz_artist(a: &Value) -> Value {
    json!({ "id": a["id"].to_string(), "name": a["name"].as_str().unwrap_or(""), "picture": a["picture_medium"].as_str().unwrap_or(""),
            "fans": a["nb_fan"].as_i64().unwrap_or(0) })
}
fn dz_list(v: &Value, f: fn(&Value) -> Value) -> Vec<Value> {
    v["data"].as_array().map(|a| a.iter().map(f).collect()).unwrap_or_default()
}

/// ?q=… songs, artists and albums from the catalog
async fn catalog_search(Auth(_, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let term = q.get("q").map(|s| s.trim().to_string()).unwrap_or_default();
    if term.is_empty() {
        return Ok(Json(json!({ "tracks": [], "artists": [], "albums": [] })));
    }
    let res = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let enc: String = term.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        let tracks = http_get(&format!("https://api.deezer.com/search/track?q={enc}&limit=20"))?;
        let artists = http_get(&format!("https://api.deezer.com/search/artist?q={enc}&limit=8")).unwrap_or(Value::Null);
        let albums = http_get(&format!("https://api.deezer.com/search/album?q={enc}&limit=12")).unwrap_or(Value::Null);
        Ok(json!({ "tracks": dz_list(&tracks, dz_track), "artists": dz_list(&artists, dz_artist), "albums": dz_list(&albums, dz_album) }))
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))??;
    Ok(Json(res))
}

/// An artist with top songs and albums
async fn catalog_artist(Auth(_, _): Auth, Path(id): Path<String>) -> R {
    let id: String = id.chars().filter(|c| c.is_ascii_digit()).collect();
    if id.is_empty() {
        return Err(ApiError::new(400, "bad_link"));
    }
    let res = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let a = http_get(&format!("https://api.deezer.com/artist/{id}"))?;
        if a.get("error").is_some() {
            return Err(ApiError::new(404, "not_found"));
        }
        let top = http_get(&format!("https://api.deezer.com/artist/{id}/top?limit=20")).unwrap_or(Value::Null);
        let albums = http_get(&format!("https://api.deezer.com/artist/{id}/albums?limit=24")).unwrap_or(Value::Null);
        let mut artist = dz_artist(&a);
        artist["picture"] = json!(a["picture_xl"].as_str().unwrap_or(""));
        let name = artist["name"].clone();
        let albums: Vec<Value> = albums["data"].as_array().map(|l| l.iter().map(|x| {
            let mut v = dz_album(x);
            v["artist"] = name.clone();
            v
        }).collect()).unwrap_or_default();
        Ok(json!({ "artist": artist, "tracks": dz_list(&top, dz_track), "albums": albums }))
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))??;
    Ok(Json(res))
}

/// ?artists=a|b|c → suggestions from what someone listens to: for each artist the related
/// artists and their best songs, mixed so no artist dominates.
async fn catalog_foryou(Auth(_, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let names: Vec<String> = q
        .get("artists")
        .map(|s| s.split('|').map(|x| x.trim().chars().take(80).collect::<String>()).filter(|x| !x.is_empty()).take(5).collect())
        .unwrap_or_default();
    if names.is_empty() {
        return Ok(Json(json!({ "rows": [], "artists": [] })));
    }
    let res = tokio::task::spawn_blocking(move || {
        let mut rows = Vec::new();
        let mut artists: Vec<Value> = Vec::new();
        let mut seen_a = std::collections::HashSet::new();
        let mut seen_t = std::collections::HashSet::new();
        for n in &names {
            seen_a.insert(norm(n));
        }
        for name in &names {
            let Ok(found) = http_get(&format!("https://api.deezer.com/search/artist?limit=1&q={}", urlencode(name))) else { continue };
            let Some(a) = found["data"].get(0) else { continue };
            let id = a["id"].to_string();
            let related = http_get(&format!("https://api.deezer.com/artist/{id}/related?limit=8")).unwrap_or(Value::Null);
            let mut tracks = Vec::new();
            for r in related["data"].as_array().cloned().unwrap_or_default().iter().take(6) {
                if seen_a.insert(norm(r["name"].as_str().unwrap_or(""))) {
                    artists.push(dz_artist(r));
                }
                let rid = r["id"].to_string();
                if let Ok(top) = http_get(&format!("https://api.deezer.com/artist/{rid}/top?limit=2")) {
                    for t in dz_list(&top, dz_track) {
                        if seen_t.insert(format!("{}|{}", norm(t["artist"].as_str().unwrap_or("")), norm(t["title"].as_str().unwrap_or("")))) {
                            tracks.push(t);
                        }
                    }
                }
            }
            if !tracks.is_empty() {
                rows.push(json!({ "because": a["name"], "picture": a["picture_medium"], "tracks": tracks }));
            }
        }
        json!({ "rows": rows, "artists": artists.into_iter().take(16).collect::<Vec<_>>() })
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))?;
    Ok(Json(res))
}

/// Fresh address of the official 30 second preview (the links expire)
async fn catalog_preview(Auth(_, _): Auth, Path(id): Path<String>) -> R {
    let id: String = id.chars().filter(|c| c.is_ascii_digit()).collect();
    let res = tokio::task::spawn_blocking(move || http_get(&format!("https://api.deezer.com/track/{id}")))
        .await
        .map_err(|_| ApiError::new(500, "internal"))??;
    let preview = res["preview"].as_str().unwrap_or("").to_string();
    if preview.is_empty() {
        return Err(ApiError::new(404, "not_found"));
    }
    Ok(Json(json!({ "preview": preview, "duration": 30 })))
}

/// Titles and channels for YouTube videos: ?ids=a,b,c (official oEmbed endpoint, no key needed)
async fn fetch_oembed(Auth(_, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let ids: Vec<String> = q
        .get("ids")
        .map(|s| {
            s.split(',')
                .map(|x| {
                    x.chars()
                        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                        .collect::<String>()
                })
                .filter(|x| x.len() == 11)
                .take(60)
                .collect()
        })
        .unwrap_or_default();
    let mut handles = vec![];
    for chunk in ids.chunks(8) {
        let chunk = chunk.to_vec();
        handles.push(tokio::task::spawn_blocking(move || {
            chunk
                .into_iter()
                .map(|id| {
                    let v = http_get(&format!("https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v={id}")).ok();
                    json!({ "id": id, "title": v.as_ref().and_then(|v| v["title"].as_str()), "author": v.as_ref().and_then(|v| v["author_name"].as_str()) })
                })
                .collect::<Vec<_>>()
        }));
    }
    let mut out = vec![];
    for h in handles {
        out.extend(h.await.unwrap_or_default());
    }
    Ok(Json(json!(out)))
}

// ---------- lyrics ----------
/// Lyrics for a local song: from the file's tags first, then LRCLIB (free, no key). Cached.
async fn lyrics(
    State(st): State<St>,
    crate::api::AuthQ(_): crate::api::AuthQ,
    Path(id): Path<i64>,
) -> R {
    let cached: Option<(String, String, String, i64)> = st
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT synced, plain, source, fetched FROM lyrics WHERE track_id = ?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .unwrap_or(None);
    // a miss is retried after a week
    if let Some((synced, plain, source, fetched)) = cached {
        if !source.is_empty() || now_ms() - fetched < 7 * 86_400_000 {
            return Ok(Json(
                json!({ "synced": synced, "plain": plain, "source": source }),
            ));
        }
    }
    let row: (String, String, String, String, f64) = st
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT path, title, artist, album, duration FROM tracks WHERE id = ?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .unwrap_or(None)
        .ok_or_else(nf)?;
    let (synced, plain, source) = tokio::task::spawn_blocking(move || {
        let (path, title, artist, album, duration) = row;
        // 1. embedded
        if let Ok(tf) = lofty::read_from_path(&path) {
            use lofty::file::TaggedFileExt;
            for tag in tf.tags() {
                if let Some(text) = tag.get_string(&lofty::tag::ItemKey::Lyrics) {
                    let text = text.trim().to_string();
                    if !text.is_empty() {
                        let synced = if is_lrc(&text) {
                            text.clone()
                        } else {
                            String::new()
                        };
                        let plain = if synced.is_empty() {
                            text
                        } else {
                            strip_lrc(&text)
                        };
                        return (synced, plain, "file".to_string());
                    }
                }
            }
        }
        // 2. LRCLIB
        lrclib(&title, &artist, &album, duration)
    })
    .await
    .unwrap_or_default();
    st.db
        .lock()
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO lyrics (track_id, synced, plain, source, fetched) VALUES (?,?,?,?,?)",
            params![id, synced, plain, source, now_ms()],
        )
        .ok();
    Ok(Json(
        json!({ "synced": synced, "plain": plain, "source": source }),
    ))
}
/// LRCLIB lookup (free, no key): exact first, then a looser search. Returns (synced, plain, source).
fn lrclib(title: &str, artist: &str, album: &str, duration: f64) -> (String, String, String) {
    let enc = |s: &str| -> String {
        s.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect()
    };
    if title.trim().is_empty() {
        return Default::default();
    }
    let mut url = format!(
        "https://lrclib.net/api/get?track_name={}&artist_name={}",
        enc(title),
        enc(artist)
    );
    if !album.is_empty() {
        url += &format!("&album_name={}", enc(album));
    }
    if duration > 0.0 {
        url += &format!("&duration={}", duration.round() as i64);
    }
    let got = http_get(&url).ok().or_else(|| {
        let list = http_get(&format!(
            "https://lrclib.net/api/search?track_name={}&artist_name={}",
            enc(title),
            enc(artist)
        ))
        .ok()?;
        list.as_array()?
            .iter()
            .find(|v| {
                duration <= 0.0 || (v["duration"].as_f64().unwrap_or(0.0) - duration).abs() < 8.0
            })
            .cloned()
    });
    if let Some(v) = got {
        let synced = v["syncedLyrics"].as_str().unwrap_or("").to_string();
        let plain = v["plainLyrics"].as_str().unwrap_or("").to_string();
        if !synced.is_empty() || !plain.is_empty() {
            return (synced, plain, "lrclib".to_string());
        }
    }
    Default::default()
}

/// Lyrics for a song from another platform: ?title=&artist=&duration= (not cached, LRCLIB only).
async fn lyrics_lookup(
    crate::api::AuthQ(_): crate::api::AuthQ,
    Query(q): Query<HashMap<String, String>>,
) -> R {
    let title = clip(q.get("title").map(String::as_str).unwrap_or(""), 300);
    let artist = clip(q.get("artist").map(String::as_str).unwrap_or(""), 300);
    let duration: f64 = q
        .get("duration")
        .and_then(|d| d.parse().ok())
        .unwrap_or(0.0);
    let (synced, plain, source) =
        tokio::task::spawn_blocking(move || lrclib(&title, &artist, "", duration))
            .await
            .unwrap_or_default();
    Ok(Json(
        json!({ "synced": synced, "plain": plain, "source": source }),
    ))
}

fn is_lrc(t: &str) -> bool {
    t.lines()
        .filter(|l| {
            l.starts_with('[')
                && l.get(1..3)
                    .map(|d| d.chars().all(|c| c.is_ascii_digit()))
                    .unwrap_or(false)
        })
        .count()
        >= 3
}
fn strip_lrc(t: &str) -> String {
    t.lines()
        .map(|l| {
            if l.starts_with('[') {
                l.rsplit(']').next().unwrap_or("").trim()
            } else {
                l.trim()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------- share links ----------
#[derive(Deserialize, Default)]
#[serde(default)]
struct ShareIn {
    kind: String,
    #[serde(rename = "ref")]
    reference: Value,
}

async fn create_share(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    let b: ShareIn = body_json(req).await?;
    let reference = match &b.reference {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    };
    let reference = clip(&reference, 600);
    let db = st.db.lock().unwrap();
    // check the thing exists and belongs to the user where that matters
    let ok = match b.kind.as_str() {
        "track" => reference
            .parse::<i64>()
            .ok()
            .map(|id| !tracks_by_ids(&db, &[id]).is_empty())
            .unwrap_or(false),
        "playlist" | "collab" => reference
            .parse::<i64>()
            .ok()
            .and_then(|id| {
                db.query_row(
                    "SELECT id FROM playlists WHERE id = ? AND user_id = ?",
                    params![id, u.id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()
                .ok()
                .flatten()
            })
            .is_some(),
        "album" => serde_json::from_str::<Value>(&reference)
            .map(|v| v["album"].is_string())
            .unwrap_or(false),
        "import" => reference
            .parse::<i64>()
            .ok()
            .map(|id| own_import(&db, u.id, id).is_ok())
            .unwrap_or(false),
        _ => false,
    };
    if !ok {
        return Err(ApiError::new(400, "bad_share"));
    }
    let existing: Option<String> = db
        .query_row(
            "SELECT token FROM shares WHERE user_id = ? AND kind = ? AND ref = ?",
            params![u.id, b.kind, reference],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);
    let token = existing.unwrap_or_else(|| {
        let t: String = {
            use rand::Rng;
            let mut rng = rand::thread_rng();
            (0..12)
                .map(|_| {
                    b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
                        [rng.gen_range(0..56)] as char
                })
                .collect()
        };
        db.execute(
            "INSERT INTO shares (token, user_id, kind, ref, created) VALUES (?,?,?,?,?)",
            params![t, u.id, b.kind, reference, now_ms()],
        )
        .ok();
        t
    });
    Ok(Json(
        json!({ "token": token, "path": format!("/s/{token}") }),
    ))
}

/// What a share link shows: (title, subtitle, kind, local tracks, external items)
fn resolve_share(
    db: &Connection,
    token: &str,
) -> Result<(String, String, String, Vec<Value>, Vec<Value>), ApiError> {
    let (uid, kind, reference): (i64, String, String) = db
        .query_row(
            "SELECT user_id, kind, ref FROM shares WHERE token = ?",
            [token],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .unwrap_or(None)
        .ok_or_else(nf)?;
    let owner: String = db
        .query_row("SELECT name FROM users WHERE id = ?", [uid], |r| r.get(0))
        .unwrap_or_default();
    let q = |sql: &str, args: Vec<rusqlite::types::Value>| -> Vec<Value> {
        let mut s = db.prepare(sql).unwrap();
        let v = s
            .query_map(rusqlite::params_from_iter(args.iter()), track_json)
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        v
    };
    // an invitation shows the same playlist as a listening link
    let kind = if kind == "collab" { "playlist".to_string() } else { kind };
    match kind.as_str() {
        "track" => {
            let id: i64 = reference.parse().map_err(|_| nf())?;
            let t = tracks_by_ids(db, &[id]);
            let first = t.first().ok_or_else(nf)?;
            let sub = first["artist"].as_str().unwrap_or("").to_string();
            Ok((
                first["title"].as_str().unwrap_or("").to_string(),
                sub,
                kind,
                t,
                vec![],
            ))
        }
        "album" => {
            let v: Value = serde_json::from_str(&reference).map_err(|_| nf())?;
            let album = v["album"].as_str().unwrap_or("").to_string();
            let artist = v["artist"].as_str().unwrap_or("").to_string();
            let t = q(
                &format!("SELECT {TRACK_COLS} FROM tracks WHERE album = ? AND (album_artist = ? OR artist = ? OR ? = '') ORDER BY disc_no, track_no, title"),
                vec![album.clone().into(), artist.clone().into(), artist.clone().into(), artist.clone().into()],
            );
            if t.is_empty() {
                return Err(nf());
            }
            Ok((album, artist, kind, t, vec![]))
        }
        "playlist" => {
            let id: i64 = reference.parse().map_err(|_| nf())?;
            let name: String = db
                .query_row("SELECT name FROM playlists WHERE id = ?", [id], |r| {
                    r.get(0)
                })
                .map_err(|_| nf())?;
            let ids: Vec<i64> = {
                let mut s = db
                    .prepare(
                        "SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos",
                    )
                    .unwrap();
                let v = s
                    .query_map([id], |r| r.get(0))
                    .unwrap()
                    .filter_map(Result::ok)
                    .collect();
                v
            };
            Ok((
                name,
                format!("Playlist · {owner}"),
                kind,
                tracks_by_ids(db, &ids),
                vec![],
            ))
        }
        "import" => {
            let id: i64 = reference.parse().map_err(|_| nf())?;
            let name: String = db
                .query_row("SELECT name FROM imports WHERE id = ?", [id], |r| r.get(0))
                .map_err(|_| nf())?;
            let user = crate::auth::User {
                id: uid,
                name: owner.clone(),
                admin: false,
                created: 0,
            };
            let items = import_items(db, &user, id);
            let locals = items
                .iter()
                .filter_map(|i| i.get("local").cloned())
                .collect();
            let ext = items
                .into_iter()
                .filter(|i| i.get("local").is_none())
                .collect();
            Ok((name, format!("Playlist · {owner}"), kind, locals, ext))
        }
        _ => Err(nf()),
    }
}

async fn public_share(State(st): State<St>, Path(token): Path<String>) -> R {
    let db = st.db.lock().unwrap();
    let (title, sub, kind, tracks, ext) = resolve_share(&db, &token)?;
    // public view: no internal ids, songs are addressed by their position
    let list: Vec<Value> = tracks
        .iter()
        .enumerate()
        .map(|(i, t)| json!({ "i": i, "title": t["title"], "artist": t["artist"], "album": t["album"], "duration": t["duration"], "cover": t["has_cover"] }))
        .collect();
    let ext: Vec<Value> = ext.iter().map(|e| json!({ "title": e["title"], "artist": e["artist"], "source": e["source"], "url": e["url"], "cover": e["cover"], "ext_id": e["ext_id"], "duration": e["duration"] })).collect();
    Ok(Json(
        json!({ "title": title, "sub": sub, "kind": kind, "tracks": list, "external": ext, "server": st.name, "collab": share_is_collab(&db, &token) }),
    ))
}
fn share_is_collab(db: &Connection, token: &str) -> bool {
    db.query_row("SELECT kind = 'collab' FROM shares WHERE token = ?", [token], |r| r.get(0)).unwrap_or(false)
}
/// Accept an invitation: the signed-in user becomes a collaborator of the playlist.
async fn join_share(State(st): State<St>, Auth(u, _): Auth, Path(token): Path<String>) -> R {
    let db = st.db.lock().unwrap();
    let (owner, pid): (i64, i64) = db
        .query_row("SELECT user_id, CAST(ref AS INTEGER) FROM shares WHERE token = ? AND kind = 'collab'", [&token], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .unwrap_or(None)
        .ok_or_else(nf)?;
    let name: String = db
        .query_row("SELECT name FROM playlists WHERE id = ? AND user_id = ?", params![pid, owner], |r| r.get(0))
        .optional()
        .unwrap_or(None)
        .ok_or_else(nf)?;
    if owner != u.id {
        db.execute("INSERT OR IGNORE INTO playlist_members (playlist_id, user_id, added) VALUES (?,?,?)", params![pid, u.id, now_ms()]).ok();
    }
    Ok(Json(json!({ "kind": "playlist", "id": pid, "name": name })))
}

/// Save a shared playlist / album / song into the own library: as a playlist when every song
/// is on this server, otherwise as an imported playlist (platform songs stay playable there).
async fn save_share(State(st): State<St>, Auth(u, _): Auth, Path(token): Path<String>) -> R {
    let mut db = st.db.lock().unwrap();
    let (title, _, _, tracks, ext) = resolve_share(&db, &token)?;
    let now = now_ms();
    if ext.is_empty() {
        let ids: Vec<i64> = tracks.iter().filter_map(|t| t["id"].as_i64()).collect();
        db.execute(
            "INSERT INTO playlists (user_id, name, created, updated) VALUES (?,?,?,?)",
            params![u.id, clip(&title, 120), now, now],
        )
        .ok();
        let pid = db.last_insert_rowid();
        set_playlist_tracks(&mut db, pid, &ids);
        return Ok(Json(
            json!({ "kind": "playlist", "id": pid, "name": title, "tracks": ids.len() }),
        ));
    }
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    let mut items: Vec<ItemIn> = tracks
        .iter()
        .map(|t| ItemIn {
            source: "local".into(),
            ext_id: String::new(),
            title: s(&t["title"]),
            artist: s(&t["artist"]),
            album: s(&t["album"]),
            duration: t["duration"].as_f64().unwrap_or(0.0),
            cover: String::new(),
            url: String::new(),
        })
        .collect();
    items.extend(ext.iter().map(|e| ItemIn {
        source: s(&e["source"]),
        ext_id: s(&e["ext_id"]),
        title: s(&e["title"]),
        artist: s(&e["artist"]),
        album: s(&e["album"]),
        duration: e["duration"].as_f64().unwrap_or(0.0),
        cover: s(&e["cover"]),
        url: s(&e["url"]),
    }));
    db.execute(
        "INSERT INTO imports (user_id, source, name, url, cover, created, updated) VALUES (?,?,?,?,?,?,?)",
        params![u.id, "share", clip(&title, 120), format!("/s/{token}"), "", now, now],
    )
    .ok();
    let id = db.last_insert_rowid();
    write_items(&mut db, id, "share", &items);
    Ok(Json(
        json!({ "kind": "import", "id": id, "name": title, "tracks": items.len() }),
    ))
}

fn share_track_id(st: &St, token: &str, i: usize) -> Result<i64, ApiError> {
    let db = st.db.lock().unwrap();
    let (_, _, _, tracks, _) = resolve_share(&db, token)?;
    tracks.get(i).and_then(|t| t["id"].as_i64()).ok_or_else(nf)
}

async fn public_stream(
    State(st): State<St>,
    Path((token, i)): Path<(String, usize)>,
    req: Request,
) -> Result<Response, ApiError> {
    let id = share_track_id(&st, &token, i)?;
    serve_track(&st, id, req).await
}
async fn public_cover(
    State(st): State<St>,
    Path((token, i)): Path<(String, usize)>,
) -> Result<Response, ApiError> {
    let id = share_track_id(&st, &token, i)?;
    serve_cover(&st, id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalises_titles() {
        assert_eq!(
            norm("Bohemian Rhapsody - Remastered 2011"),
            "bohemian rhapsody"
        );
        assert_eq!(norm("Café del Mar (Energy 52 Remix)"), "cafe del mar");
        assert_eq!(norm("Song feat. Someone"), "song");
        assert_eq!(norm("  Don't Stop  Me Now! "), "dont stop me now");
    }
    #[test]
    fn matches_library() {
        let db = crate::db::open(None).unwrap();
        db.execute("INSERT INTO tracks (path, title, artist, album, duration, size, mtime, added) VALUES ('/a.mp3', 'Nightdrive', 'Neon Coast', 'Nightdrive', 200, 1, 0, 0)", []).unwrap();
        let m = Matcher::new(&db);
        assert!(m
            .find("Nightdrive (Official Video)", "Neon Coast - Topic", 0.0)
            .is_some());
        assert!(m.find("nightdrive", "Neon Coast, Someone", 201.0).is_some());
        assert!(m.find("Nightdrive", "Other Band", 260.0).is_none());
    }
}
