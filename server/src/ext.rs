//! Other platforms: per-user source settings, imported playlists (matched against the
//! local library), fetching public playlist data, and share links.
use crate::api::{
    body_json, nf, serve_cover, serve_track, set_playlist_tracks, track_json, tracks_by_ids,
    with_likes, ApiError, Auth, St, R, TRACK_COLS,
};
use crate::db::now_ms;
use axum::extract::{Path, Query, Request, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

pub const SCHEMA: &str = r#"
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
        .route("/fetch/oembed", get(fetch_oembed))
        .route("/lyrics", get(lyrics_lookup))
        .route("/lyrics/{id}", get(lyrics))
        .route("/shares", post(create_share))
        .route("/public/{token}", get(public_share))
        .route("/public/{token}/save", post(save_share))
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
    items: Vec<ItemIn>,
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
    db.execute(
        "INSERT INTO imports (user_id, source, name, url, cover, created, updated) VALUES (?,?,?,?,?,?,?)",
        params![u.id, clip(&b.source, 20), name, clip(&b.url, 1000), clip(&b.cover, 1000), now, now],
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
                    (SELECT track_id FROM import_items WHERE import_id = i.id AND track_id IS NOT NULL ORDER BY pos LIMIT 1)
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
                "cover_id": r.get::<_, Option<i64>>(9)?,
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
    let (source, name, url, cover, updated): (String, String, String, String, i64) = db
        .query_row(
            "SELECT source, name, url, cover, updated FROM imports WHERE id = ?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|_| nf())?;
    Ok(Json(
        json!({ "id": id, "source": source, "name": name, "url": url, "cover": cover, "updated": updated, "items": import_items(&db, &u, id) }),
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
        "playlist" => reference
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
        json!({ "title": title, "sub": sub, "kind": kind, "tracks": list, "external": ext, "server": st.name }),
    ))
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
