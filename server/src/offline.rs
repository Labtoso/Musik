// Offline mode: the apps start this server on the device itself (MUSIK_OFFLINE=1, only on 127.0.0.1).
// It copies playlists from the real server so they play without a connection.
use crate::api::{body_json, ApiError, St, R};
use crate::db::now_ms;
use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::io::Read;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS offline_sets (
  key TEXT PRIMARY KEY,
  server TEXT NOT NULL,
  remote_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  local_id INTEGER,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued',
  bytes INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS offline_files (
  set_key TEXT NOT NULL,
  pos INTEGER NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (set_key, pos)
);
"#;

pub fn enabled() -> bool {
    std::env::var("MUSIK_OFFLINE").map(|v| v == "1").unwrap_or(false)
}

pub fn routes() -> Router<St> {
    Router::new()
        .route("/offline/session", post(session))
        .route("/offline/status", get(status))
        .route("/offline/add", post(add))
        .route("/offline/remove", post(remove))
}

/// Only the app that started this server knows the key (MUSIK_KEY).
fn check_key(h: &HeaderMap) -> Result<(), ApiError> {
    if !enabled() {
        return Err(ApiError::new(404, "not_found"));
    }
    let want = std::env::var("MUSIK_KEY").unwrap_or_default();
    let got = h.get("x-musik-key").and_then(|v| v.to_str().ok()).unwrap_or("");
    if want.is_empty() || got != want {
        return Err(ApiError::new(403, "forbidden"));
    }
    Ok(())
}

/// The one person on this device: created on first use, signed in without a password.
fn device_user(db: &Connection, name: &str) -> i64 {
    if let Some(id) = db.query_row("SELECT id FROM users ORDER BY id LIMIT 1", [], |r| r.get(0)).optional().unwrap_or(None) {
        return id;
    }
    let mut pw = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut pw);
    let name = if name.trim().chars().count() >= 2 { name.trim() } else { "Musik" };
    crate::auth::create_user(db, name, &hex::encode(pw), true)
        .or_else(|_| crate::auth::create_user(db, "Musik", &hex::encode(pw), true))
        .map(|u| u.id)
        .unwrap_or(1)
}

async fn session(State(st): State<St>) -> R {
    if !enabled() {
        return Err(ApiError::new(404, "not_found"));
    }
    let db = st.db.lock().unwrap();
    let uid = device_user(&db, "");
    // no wizard on the device: it only plays what was copied
    db.execute("INSERT INTO user_settings (user_id, data) VALUES (?, '{\"setupDone\":true}') ON CONFLICT(user_id) DO NOTHING", [uid]).ok();
    let token = crate::auth::issue(&db, uid, "offline");
    Ok(Json(json!({ "token": token, "user": crate::auth::user(&db, uid) })))
}

fn sets(db: &Connection) -> Vec<Value> {
    let mut s = db.prepare("SELECT key, server, remote_id, name, local_id, total, done, state, bytes, updated FROM offline_sets ORDER BY name COLLATE NOCASE").unwrap();
    s.query_map([], |r| {
        Ok(json!({ "key": r.get::<_, String>(0)?, "server": r.get::<_, String>(1)?, "id": r.get::<_, i64>(2)?, "name": r.get::<_, String>(3)?,
            "local": r.get::<_, Option<i64>>(4)?, "total": r.get::<_, i64>(5)?, "done": r.get::<_, i64>(6)?, "state": r.get::<_, String>(7)?,
            "bytes": r.get::<_, i64>(8)?, "updated": r.get::<_, i64>(9)? }))
    })
    .unwrap()
    .filter_map(Result::ok)
    .collect()
}

async fn status(State(st): State<St>, h: HeaderMap) -> R {
    check_key(&h)?;
    Ok(Json(json!({ "sets": sets(&st.db.lock().unwrap()) })))
}

#[derive(serde::Deserialize, Default)]
struct AddBody {
    server: String,
    token: String,
    id: i64,
    #[serde(default)]
    user: String,
    /// the server's address already looked up by the app (Android has no DNS for this program)
    #[serde(default)]
    ip: String,
}

/// One server per device: the same playlist reached at home or on the go is one copy.
pub fn key_of(id: i64) -> String {
    format!("pl{id}")
}

async fn add(State(st): State<St>, h: HeaderMap, req: Request) -> R {
    check_key(&h)?;
    let b: AddBody = body_json(req).await?;
    let server = b.server.trim().trim_end_matches('/').to_string();
    if !(server.starts_with("http://") || server.starts_with("https://")) || b.token.len() != 64 || b.id <= 0 {
        return Err(ApiError::new(400, "bad_request"));
    }
    let key = key_of(b.id);
    {
        let db = st.db.lock().unwrap();
        device_user(&db, &b.user);
        let busy: Option<String> = db.query_row("SELECT state FROM offline_sets WHERE key = ?", [&key], |r| r.get(0)).optional().unwrap_or(None);
        if busy.as_deref() == Some("loading") {
            return Ok(Json(json!({ "key": key, "state": "loading" })));
        }
        db.execute(
            "INSERT INTO offline_sets (key, server, remote_id, name, state, updated) VALUES (?, ?, ?, '', 'loading', ?)
             ON CONFLICT(key) DO UPDATE SET state = 'loading', server = excluded.server, updated = excluded.updated",
            params![key, server, b.id, now_ms()],
        )
        .ok();
    }
    let st2 = st.clone();
    let k2 = key.clone();
    std::thread::spawn(move || {
        let res = copy_playlist(&st2, &k2, &server, &b.token, b.id, &b.ip);
        let state = match res {
            Ok(()) => "ready",
            Err(e) => e,
        };
        st2.db.lock().unwrap().execute("UPDATE offline_sets SET state = ?, updated = ? WHERE key = ?", params![state, now_ms(), k2]).ok();
    });
    Ok(Json(json!({ "key": key, "state": "loading" })))
}

fn agent(server: &str, ip: &str) -> ureq::Agent {
    let host = url_host(server);
    let ip = ip.trim().to_string();
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(60))
        .resolver(move |addr: &str| -> std::io::Result<Vec<SocketAddr>> {
            let (h, port) = addr.rsplit_once(':').unwrap_or((addr, "80"));
            if !ip.is_empty() && h.trim_matches(['[', ']']) == host {
                if let Ok(a) = format!("{}:{port}", if ip.contains(':') { format!("[{ip}]") } else { ip.clone() }).parse() {
                    return Ok(vec![a]);
                }
            }
            addr.to_socket_addrs().map(|i| i.collect())
        })
        .build()
}

fn url_host(u: &str) -> String {
    let rest = u.split("://").nth(1).unwrap_or(u);
    let hostport = rest.split('/').next().unwrap_or("");
    if let Some(v6) = hostport.strip_prefix('[') {
        return v6.split(']').next().unwrap_or("").to_string();
    }
    hostport.rsplit_once(':').map(|(h, _)| h).unwrap_or(hostport).to_string()
}

fn clean(s: &str) -> String {
    let c: String = s.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 32 { '_' } else { c }).collect();
    let c = c.trim().trim_matches('.').to_string();
    c.chars().take(80).collect()
}

fn ext_for(mime: &str) -> &'static str {
    match mime.split(';').next().unwrap_or("").trim() {
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/aac" => "aac",
        "audio/ogg" | "audio/opus" => "ogg",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/webm" => "webm",
        _ => "mp3",
    }
}

fn save(res: ureq::Response, dest: &Path) -> Result<u64, &'static str> {
    let tmp = dest.with_extension("part");
    let mut r = res.into_reader().take(2 << 30);
    let mut f = std::fs::File::create(&tmp).map_err(|_| "error_disk")?;
    let n = std::io::copy(&mut r, &mut f).map_err(|_| "error_network")?;
    drop(f);
    std::fs::rename(&tmp, dest).map_err(|_| "error_disk")?;
    Ok(n)
}

fn copy_playlist(st: &St, key: &str, server: &str, token: &str, id: i64, ip: &str) -> Result<(), &'static str> {
    let ag = agent(server, ip);
    let pl: Value = ag
        .get(&format!("{server}/api/playlists/{id}"))
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(401, _) | ureq::Error::Status(403, _) => "error_auth",
            ureq::Error::Status(404, _) => "error_gone",
            _ => "error_network",
        })?
        .into_json()
        .map_err(|_| "error_network")?;
    let name = pl["name"].as_str().unwrap_or("Playlist").to_string();
    let tracks = pl["tracks"].as_array().cloned().unwrap_or_default();
    {
        let db = st.db.lock().unwrap();
        db.execute("UPDATE offline_sets SET name = ?, total = ?, done = 0 WHERE key = ?", params![name, tracks.len() as i64, key]).ok();
    }
    let root = st.library.roots().into_iter().next().ok_or("error_disk")?;
    let base = root.join("songs");
    let mut files: Vec<PathBuf> = Vec::new();
    for (i, t) in tracks.iter().enumerate() {
        let tid = t["id"].as_i64().unwrap_or(0);
        let dir = base.join(tid.to_string());
        std::fs::create_dir_all(&dir).map_err(|_| "error_disk")?;
        // already here from an earlier copy (also from another playlist)
        let have = std::fs::read_dir(&dir).ok().and_then(|rd| {
            rd.filter_map(Result::ok).map(|e| e.path()).find(|p| crate::library::audio_type(p).is_some())
        });
        let file = match have {
            Some(p) => p,
            None => {
                let res = ag.get(&format!("{server}/api/stream/{tid}?t={token}")).call().map_err(|_| "error_network")?;
                let ext = ext_for(res.header("Content-Type").unwrap_or(""));
                let fname = format!("{} - {}.{ext}", clean(t["artist"].as_str().unwrap_or("")), clean(t["title"].as_str().unwrap_or("Song")));
                let dest = dir.join(fname.trim_start_matches(" - "));
                save(res, &dest)?;
                if t["has_cover"].as_bool().unwrap_or(false) || !dir.join("cover.jpg").exists() {
                    if let Ok(c) = ag.get(&format!("{server}/api/cover/{tid}?t={token}")).call() {
                        if c.status() == 200 {
                            let _ = save(c, &dir.join("cover.jpg"));
                        }
                    }
                }
                dest
            }
        };
        files.push(file);
        st.db.lock().unwrap().execute("UPDATE offline_sets SET done = ? WHERE key = ?", params![i as i64 + 1, key]).ok();
    }
    // index the new files, then build the playlist from them in the same order
    loop {
        if st.library.scan(&st.db).is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    st.rec.invalidate();
    let art = ag.get(&format!("{server}/api/art/playlist/{id}?t={token}")).call().ok().filter(|r| r.status() == 200).and_then(|r| {
        let mut v = Vec::new();
        r.into_reader().take(4 << 20).read_to_end(&mut v).ok().map(|_| v)
    });
    let mut db = st.db.lock().unwrap();
    let uid = device_user(&db, "");
    let ids: Vec<i64> = files
        .iter()
        .filter_map(|p| db.query_row("SELECT id FROM tracks WHERE path = ?", [crate::library::path_str(p)], |r| r.get(0)).ok())
        .collect();
    let local: Option<i64> = db
        .query_row("SELECT local_id FROM offline_sets WHERE key = ?", [key], |r| r.get(0))
        .optional()
        .unwrap_or(None)
        .flatten()
        .filter(|l: &i64| db.query_row("SELECT 1 FROM playlists WHERE id = ?", [l], |r| r.get::<_, i64>(0)).is_ok());
    let now = now_ms();
    let lid = match local {
        Some(l) => {
            db.execute("UPDATE playlists SET name = ?, description = ? WHERE id = ?", params![name, pl["description"].as_str().unwrap_or(""), l]).ok();
            l
        }
        None => {
            db.execute(
                "INSERT INTO playlists (user_id, name, description, created, updated) VALUES (?,?,?,?,?)",
                params![uid, name, pl["description"].as_str().unwrap_or(""), now, now],
            )
            .ok();
            db.last_insert_rowid()
        }
    };
    crate::api::set_playlist_tracks(&mut db, lid, &ids);
    if let Some(a) = art {
        db.execute(
            "INSERT INTO art (user_id, kind, ref_id, data, updated) VALUES (?, 'playlist', ?, ?, ?)
             ON CONFLICT(kind, ref_id) DO UPDATE SET data = excluded.data, updated = excluded.updated",
            params![uid, lid, a, now],
        )
        .ok();
    }
    let total: u64 = files.iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
    let tx = db.transaction().map_err(|_| "error_disk")?;
    tx.execute("DELETE FROM offline_files WHERE set_key = ?", [key]).ok();
    for (i, p) in files.iter().enumerate() {
        tx.execute("INSERT INTO offline_files (set_key, pos, path) VALUES (?,?,?)", params![key, i as i64, crate::library::path_str(p)]).ok();
    }
    tx.execute("UPDATE offline_sets SET local_id = ?, bytes = ? WHERE key = ?", params![lid, total as i64, key]).ok();
    tx.commit().ok();
    Ok(())
}

#[derive(serde::Deserialize, Default)]
struct RemoveBody {
    key: String,
}

async fn remove(State(st): State<St>, h: HeaderMap, req: Request) -> R {
    check_key(&h)?;
    let b: RemoveBody = body_json(req).await?;
    let gone: Vec<String> = {
        let db = st.db.lock().unwrap();
        let local: Option<i64> = db.query_row("SELECT local_id FROM offline_sets WHERE key = ?", [&b.key], |r| r.get(0)).optional().unwrap_or(None).flatten();
        if let Some(l) = local {
            db.execute("DELETE FROM playlists WHERE id = ?", [l]).ok();
        }
        let mut s = db
            .prepare("SELECT path FROM offline_files WHERE set_key = ?1 AND path NOT IN (SELECT path FROM offline_files WHERE set_key != ?1)")
            .unwrap();
        let paths: Vec<String> = s.query_map([&b.key], |r| r.get(0)).unwrap().filter_map(Result::ok).collect();
        db.execute("DELETE FROM offline_files WHERE set_key = ?", [&b.key]).ok();
        db.execute("DELETE FROM offline_sets WHERE key = ?", [&b.key]).ok();
        paths
    };
    // only files this app copied, inside its own music folder
    let roots = st.library.roots();
    for p in &gone {
        let p = Path::new(p);
        if roots.iter().any(|r| p.starts_with(r)) {
            if let Some(dir) = p.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
    let st2 = st.clone();
    tokio::task::spawn_blocking(move || {
        st2.library.scan(&st2.db);
        st2.rec.invalidate();
    });
    Ok(Json(json!({ "ok": true, "sets": sets(&st.db.lock().unwrap()) })))
}
