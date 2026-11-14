use crate::auth::{self, User};
use crate::db::now_ms;
use crate::library::{audio_type, path_str, Library};
use crate::recommend::{Pick, Recommender};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, Query, Request, State};
use axum::http::{header, request::Parts, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use futures_util::StreamExt;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeFile;

pub const VERSION: &str = match option_env!("MUSIK_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

#[derive(rust_embed::RustEmbed)]
#[folder = "../web/"]
struct WebAssets;

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub library: Library,
    pub rec: Recommender,
    pub web_dir: Option<PathBuf>,
    pub name: String,
    /// Address that also works away from home, e.g. the Tailscale name (REMOTE_URL).
    pub remote: Option<String>,
    /// Address anyone on the internet can open, e.g. Tailscale Funnel (PUBLIC_URL).
    pub public: Option<String>,
}

/// Marks requests that came in over the public listener (internet, not the home network).
#[derive(Clone, Copy)]
pub struct PublicSide;

/// Requests from the internet: no first-time setup, no admin tools, admin accounts stay at
/// home, and sign-in attempts are rationed so passwords can't be guessed in bulk.
pub async fn public_guard(mut req: Request, next: axum::middleware::Next) -> Response {
    let path = req.uri().path().to_string();
    const HOME_ONLY: [&str; 7] = ["/api/setup", "/api/update", "/api/remote", "/api/public-url", "/api/users", "/api/library/scan", "/api/upload"];
    if HOME_ONLY.iter().any(|p| path == *p || path.starts_with(&format!("{p}/"))) {
        return ApiError::new(403, "local_only").into_response();
    }
    if req.method() == Method::POST && (path == "/api/login" || path.ends_with("/signup")) && !login_budget() {
        return ApiError::new(429, "too_many").into_response();
    }
    req.extensions_mut().insert(PublicSide);
    next.run(req).await
}
/// At most 20 sign-ins or sign-ups per minute over the public address.
fn login_budget() -> bool {
    static B: Mutex<(u64, u32)> = Mutex::new((0, 0));
    let minute = (now_ms() / 60_000) as u64;
    let mut b = B.lock().unwrap();
    if b.0 != minute {
        *b = (minute, 0);
    }
    b.1 += 1;
    b.1 <= 20
}
fn home_only(parts: &Parts, u: &User) -> Result<(), ApiError> {
    if u.admin && parts.extensions.get::<PublicSide>().is_some() {
        return Err(ApiError::new(403, "local_only"));
    }
    Ok(())
}

pub type St = Arc<AppState>;

// ---------- errors ----------
pub struct ApiError(pub StatusCode, pub &'static str);

impl ApiError {
    pub fn new(code: u16, msg: &'static str) -> Self {
        ApiError(
            StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            msg,
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({ "error": self.1 })),
        )
            .into_response()
    }
}
impl From<auth::AuthError> for ApiError {
    fn from(e: auth::AuthError) -> Self {
        ApiError::new(e.0, e.1)
    }
}

pub type R<T = Value> = Result<Json<T>, ApiError>;

pub fn nf() -> ApiError {
    ApiError::new(404, "not_found")
}

// ---------- auth extractors ----------
fn bearer(parts: &Parts) -> Option<String> {
    parts
        .headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::to_string)
}
fn query_token(parts: &Parts) -> Option<String> {
    parts
        .uri
        .query()?
        .split('&')
        .find_map(|kv| kv.strip_prefix("t=").map(str::to_string))
}

/// Logged-in user (Authorization: Bearer).
pub struct Auth(pub User, pub String);
/// Logged-in user, token may also come as ?t= (for audio and images).
pub struct AuthQ(#[allow(dead_code)] pub User);

impl FromRequestParts<St> for Auth {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, st: &St) -> Result<Self, Self::Rejection> {
        let token = bearer(parts).ok_or(ApiError::new(401, "unauthorized"))?;
        let u = auth::verify(&st.db.lock().unwrap(), &token)
            .ok_or(ApiError::new(401, "unauthorized"))?;
        home_only(parts, &u)?;
        Ok(Auth(u, token))
    }
}
impl FromRequestParts<St> for AuthQ {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, st: &St) -> Result<Self, Self::Rejection> {
        let token = bearer(parts)
            .or_else(|| query_token(parts))
            .ok_or(ApiError::new(401, "unauthorized"))?;
        let u = auth::verify(&st.db.lock().unwrap(), &token)
            .ok_or(ApiError::new(401, "unauthorized"))?;
        home_only(parts, &u)?;
        Ok(AuthQ(u))
    }
}
fn admin(u: &User) -> Result<(), ApiError> {
    if u.admin {
        Ok(())
    } else {
        Err(ApiError::new(403, "forbidden"))
    }
}

// ---------- track helpers ----------
pub const TRACK_COLS: &str = "id, title, artist, album, album_artist, genre, year, track_no, disc_no, duration, has_cover, added";

pub fn track_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "title": r.get::<_, String>(1)?,
        "artist": r.get::<_, String>(2)?,
        "album": r.get::<_, String>(3)?,
        "album_artist": r.get::<_, String>(4)?,
        "genre": r.get::<_, String>(5)?,
        "year": r.get::<_, Option<i64>>(6)?,
        "track_no": r.get::<_, Option<i64>>(7)?,
        "disc_no": r.get::<_, Option<i64>>(8)?,
        "duration": r.get::<_, f64>(9)?,
        "has_cover": r.get::<_, i64>(10)? != 0,
        "added": r.get::<_, i64>(11)?,
    }))
}

pub fn query_tracks(db: &Connection, sql: &str, args: &[rusqlite::types::Value]) -> Vec<Value> {
    let mut st = db.prepare(sql).unwrap();
    st.query_map(params_from_iter(args.iter()), track_json)
        .unwrap()
        .filter_map(Result::ok)
        .collect()
}

pub fn tracks_by_ids(db: &Connection, ids: &[i64]) -> Vec<Value> {
    let mut out: HashMap<i64, Value> = HashMap::new();
    for chunk in ids.chunks(500) {
        let q = format!(
            "SELECT {TRACK_COLS} FROM tracks WHERE id IN ({})",
            vec!["?"; chunk.len()].join(",")
        );
        let args: Vec<rusqlite::types::Value> = chunk.iter().map(|i| (*i).into()).collect();
        for t in query_tracks(db, &q, &args) {
            out.insert(t["id"].as_i64().unwrap(), t);
        }
    }
    ids.iter().filter_map(|id| out.get(id).cloned()).collect()
}

pub fn with_likes(db: &Connection, user: &User, mut tracks: Vec<Value>) -> Vec<Value> {
    let mut st = db
        .prepare("SELECT track_id FROM likes WHERE user_id = ?")
        .unwrap();
    let liked: HashSet<i64> = st
        .query_map([user.id], |r| r.get(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    for t in tracks.iter_mut() {
        let id = t["id"].as_i64().unwrap_or(0);
        t["liked"] = json!(liked.contains(&id));
    }
    tracks
}

fn rec_tracks(db: &Connection, user: &User, picks: &[Pick]) -> Vec<Value> {
    let ids: Vec<i64> = picks.iter().map(|p| p.id).collect();
    let tracks = with_likes(db, user, tracks_by_ids(db, &ids));
    let reasons: HashMap<i64, &str> = picks.iter().map(|p| (p.id, p.reason)).collect();
    tracks
        .into_iter()
        .map(|mut t| {
            let id = t["id"].as_i64().unwrap();
            t["reason"] = json!(reasons.get(&id).copied().unwrap_or("new"));
            t
        })
        .collect()
}

fn int(v: Option<&String>, def: i64, min: i64, max: i64) -> i64 {
    v.and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(def)
        .clamp(min, max)
}

// ---------- request bodies ----------
#[derive(Deserialize, Default)]
#[serde(default)]
struct Login {
    name: String,
    password: String,
    client: String,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct NewUser {
    name: String,
    password: String,
    admin: bool,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct PwChange {
    old: String,
    password: String,
    client: String,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct Ids {
    ids: Vec<Value>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct PlaylistBody {
    name: Option<String>,
    description: Option<String>,
    #[serde(rename = "trackIds")]
    track_ids: Option<Vec<Value>>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct EventIn {
    #[serde(rename = "trackId")]
    track_id: Value,
    kind: String,
    played: Value,
    duration: Value,
    ts: Value,
}

fn to_ids(v: &[Value]) -> Vec<i64> {
    v.iter()
        .filter_map(|x| {
            x.as_i64()
                .or_else(|| x.as_str().and_then(|s| s.parse().ok()))
        })
        .collect()
}

/// Lenient JSON body: empty or invalid → default / 400.
pub async fn body_json<T: serde::de::DeserializeOwned + Default>(
    req: Request,
) -> Result<T, ApiError> {
    let bytes = axum::body::to_bytes(req.into_body(), 1 << 20)
        .await
        .map_err(|_| ApiError::new(413, "too_large"))?;
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(T::default());
    }
    serde_json::from_slice(&bytes).map_err(|_| ApiError::new(400, "bad_json"))
}

// ---------- handlers ----------
/// The address for on the go: the one an admin saved in the settings, else REMOTE_URL of the installation.
fn remote_url(st: &St) -> Option<String> {
    let saved: Option<String> = st
        .db
        .lock()
        .unwrap()
        .query_row("SELECT v FROM kv WHERE k = 'remote_url'", [], |r| r.get(0))
        .ok();
    saved.filter(|s| !s.is_empty()).or_else(|| st.remote.clone())
}
/// The address for public links: saved in the app, else PUBLIC_URL. Only https works from the
/// download site, plain http only as a direct link.
pub fn public_url(st: &St) -> Option<String> {
    let saved: Option<String> = st
        .db
        .lock()
        .unwrap()
        .query_row("SELECT v FROM kv WHERE k = 'public_url'", [], |r| r.get(0))
        .ok();
    match saved {
        Some(s) if s == "-" => None,
        Some(s) if !s.is_empty() => Some(s),
        _ => st.public.clone(),
    }
}
async fn info(State(st): State<St>, req: Request) -> Json<Value> {
    let setup = auth::needs_setup(&st.db.lock().unwrap());
    let remote = remote_url(&st);
    let public = public_url(&st);
    let here = req.extensions().get::<PublicSide>().is_some();
    Json(
        json!({ "name": st.name, "app": "musik", "version": VERSION, "setup": setup && !here, "remote": remote, "public": public, "publicSide": here, "ytdlp": crate::ytdl::available(), "offline": crate::offline::enabled() }),
    )
}
async fn set_public(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    admin(&u)?;
    let v: Value = body_json(req).await?;
    let url = v["url"].as_str().unwrap_or("").trim().trim_end_matches('/').to_string();
    // "-" switches public links off even when PUBLIC_URL is set
    if !url.is_empty() && url != "-" && !(url.starts_with("http://") || url.starts_with("https://")) || url.len() > 300 {
        return Err(ApiError::new(400, "bad_url"));
    }
    st.db
        .lock()
        .unwrap()
        .execute("INSERT INTO kv (k, v) VALUES ('public_url', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [&url])
        .ok();
    Ok(Json(json!({ "public": public_url(&st) })))
}
async fn set_remote(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    admin(&u)?;
    let v: Value = body_json(req).await?;
    let url = v["url"].as_str().unwrap_or("").trim().trim_end_matches('/').to_string();
    if !url.is_empty() && !(url.starts_with("http://") || url.starts_with("https://")) || url.len() > 300 {
        return Err(ApiError::new(400, "bad_url"));
    }
    st.db
        .lock()
        .unwrap()
        .execute("INSERT INTO kv (k, v) VALUES ('remote_url', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [&url])
        .ok();
    Ok(Json(json!({ "remote": remote_url(&st) })))
}

async fn setup(State(st): State<St>, req: Request) -> R {
    let b: Login = body_json(req).await?;
    let db = st.db.lock().unwrap();
    if !auth::needs_setup(&db) {
        return Err(ApiError::new(409, "already_setup"));
    }
    let u = auth::create_user(&db, &b.name, &b.password, true)?;
    let token = auth::issue(&db, u.id, &b.client);
    Ok(Json(json!({ "token": token, "user": u })))
}

async fn login(State(st): State<St>, req: Request) -> R {
    let public = req.extensions().get::<PublicSide>().is_some();
    let b: Login = body_json(req).await?;
    let st2 = st.clone();
    // Password hashing is CPU heavy, keep it off the async workers.
    let res = tokio::task::spawn_blocking(move || {
        let db = st2.db.lock().unwrap();
        let u = auth::check_login(&db, &b.name, &b.password)?;
        if public && u.admin {
            return Err(auth::AuthError(403, "local_only"));
        }
        Ok((auth::issue(&db, u.id, &b.client), u))
    })
    .await
    .map_err(|_| ApiError::new(500, "error"))??;
    Ok(Json(json!({ "token": res.0, "user": res.1 })))
}

async fn logout(State(st): State<St>, Auth(_, token): Auth) -> R {
    auth::logout(&st.db.lock().unwrap(), &token);
    Ok(Json(json!({ "ok": true })))
}

async fn me(State(st): State<St>, Auth(u, _): Auth) -> R {
    let avatar = crate::ext::art_version(&st.db.lock().unwrap(), "user", u.id);
    let mut v = json!(u);
    v["avatar"] = json!(avatar);
    Ok(Json(v))
}

#[derive(Deserialize, Default)]
struct MeBody {
    name: String,
}
async fn update_me(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    let b: MeBody = body_json(req).await?;
    let db = st.db.lock().unwrap();
    let nu = auth::rename_user(&db, u.id, &b.name)?;
    let mut v = json!(nu);
    v["avatar"] = json!(crate::ext::art_version(&db, "user", u.id));
    Ok(Json(v))
}

async fn change_password(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    let b: PwChange = body_json(req).await?;
    let db = st.db.lock().unwrap();
    auth::check_login(&db, &u.name, &b.old)?;
    auth::set_password(&db, u.id, &b.password)?;
    let token = auth::issue(&db, u.id, &b.client);
    Ok(Json(json!({ "token": token, "user": u })))
}

async fn list_users(State(st): State<St>, Auth(u, _): Auth) -> R {
    admin(&u)?;
    Ok(Json(json!(auth::users(&st.db.lock().unwrap()))))
}

async fn add_user(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    admin(&u)?;
    let b: NewUser = body_json(req).await?;
    let nu = auth::create_user(&st.db.lock().unwrap(), &b.name, &b.password, b.admin)?;
    Ok(Json(json!(nu)))
}

async fn del_user(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>) -> R {
    admin(&u)?;
    if id == u.id {
        return Err(ApiError::new(400, "cannot_delete_self"));
    }
    auth::delete_user(&st.db.lock().unwrap(), id);
    Ok(Json(json!({ "ok": true })))
}

pub fn start_scan(st: &St) {
    let st = st.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(r) = st.library.scan(&st.db) {
            st.rec.invalidate();
            println!(
                "Scan: {} tracks (+{} ~{} -{}) in {} ms",
                r.total, r.added, r.updated, r.removed, r.ms
            );
        }
    });
}

async fn scan(State(st): State<St>, Auth(u, _): Auth) -> R {
    admin(&u)?;
    start_scan(&st);
    Ok(Json(json!({ "scanning": true })))
}

async fn library_info(State(st): State<St>, Auth(_, _): Auth) -> R {
    use std::sync::atomic::Ordering;
    let db = st.db.lock().unwrap();
    let (tracks, artists, albums, duration): (i64, i64, i64, f64) = db
        .query_row(
            "SELECT COUNT(*), COUNT(DISTINCT NULLIF(artist,'')), COUNT(DISTINCT NULLIF(album,'')), COALESCE(SUM(duration),0) FROM tracks",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    let l = &st.library;
    Ok(Json(json!({
        "tracks": tracks, "artists": artists, "albums": albums, "duration": duration,
        "scanning": l.scanning.load(Ordering::Relaxed),
        "progress": { "found": l.found.load(Ordering::Relaxed), "done": l.done.load(Ordering::Relaxed) },
        "lastScan": *l.last_scan.lock().unwrap(),
        "dirs": l.roots().iter().map(|p| path_str(p)).collect::<Vec<_>>(),
    })))
}

async fn tracks(
    State(st): State<St>,
    Auth(u, _): Auth,
    Query(q): Query<HashMap<String, String>>,
) -> R {
    let search = q.get("q").map(|s| s.trim().to_string()).unwrap_or_default();
    let limit = int(q.get("limit"), 100, 1, 1000);
    let offset = int(q.get("offset"), 0, 0, i64::MAX);
    let order = match q.get("sort").map(String::as_str) {
        Some("title") => "title COLLATE NOCASE",
        Some("added") => "added DESC, id DESC",
        Some("album") => "album COLLATE NOCASE, disc_no, track_no",
        _ => "artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no",
    };
    let mut wh = String::new();
    let mut args: Vec<rusqlite::types::Value> = Vec::new();
    if !search.is_empty() {
        let words: Vec<&str> = search.split_whitespace().take(6).collect();
        wh = format!(
            "WHERE {}",
            words
                .iter()
                .map(|_| "(title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\' OR genre LIKE ? ESCAPE '\\')")
                .collect::<Vec<_>>()
                .join(" AND ")
        );
        for w in words {
            let esc: String = w
                .chars()
                .flat_map(|c| {
                    if "\\%_".contains(c) {
                        vec!['\\', c]
                    } else {
                        vec![c]
                    }
                })
                .collect();
            let like = format!("%{esc}%");
            for _ in 0..4 {
                args.push(like.clone().into());
            }
        }
    }
    let db = st.db.lock().unwrap();
    let total: i64 = db
        .query_row(
            &format!("SELECT COUNT(*) FROM tracks {wh}"),
            params_from_iter(args.iter()),
            |r| r.get(0),
        )
        .unwrap_or(0);
    args.push(limit.into());
    args.push(offset.into());
    let rows = query_tracks(
        &db,
        &format!("SELECT {TRACK_COLS} FROM tracks {wh} ORDER BY {order} LIMIT ? OFFSET ?"),
        &args,
    );
    Ok(Json(
        json!({ "total": total, "items": with_likes(&db, &u, rows) }),
    ))
}

async fn track(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>) -> R {
    let db = st.db.lock().unwrap();
    let t = tracks_by_ids(&db, &[id]);
    if t.is_empty() {
        return Err(nf());
    }
    Ok(Json(with_likes(&db, &u, t).remove(0)))
}

async fn tracks_batch(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    let b: Ids = body_json(req).await?;
    let ids: Vec<i64> = to_ids(&b.ids).into_iter().take(2000).collect();
    let db = st.db.lock().unwrap();
    Ok(Json(json!(with_likes(&db, &u, tracks_by_ids(&db, &ids)))))
}

async fn albums(State(st): State<St>, Auth(_, _): Auth) -> R {
    let db = st.db.lock().unwrap();
    let mut s = db
        .prepare(
            "SELECT album, COALESCE(NULLIF(album_artist,''), artist) AS artist, COUNT(*), MIN(year),
                    COALESCE(MIN(CASE WHEN has_cover THEN id END), MIN(id)), MAX(added)
             FROM tracks WHERE album <> '' GROUP BY album COLLATE NOCASE, COALESCE(NULLIF(album_artist,''), artist) COLLATE NOCASE
             ORDER BY artist COLLATE NOCASE, MIN(year), album COLLATE NOCASE",
        )
        .unwrap();
    let rows: Vec<Value> = s
        .query_map([], |r| {
            Ok(json!({ "album": r.get::<_, String>(0)?, "artist": r.get::<_, String>(1)?, "tracks": r.get::<_, i64>(2)?,
                "year": r.get::<_, Option<i64>>(3)?, "cover_id": r.get::<_, i64>(4)?, "added": r.get::<_, i64>(5)? }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    Ok(Json(json!(rows)))
}

async fn album(
    State(st): State<St>,
    Auth(u, _): Auth,
    Query(q): Query<HashMap<String, String>>,
) -> R {
    let album = q.get("album").cloned().unwrap_or_default();
    let artist = q.get("artist").cloned().unwrap_or_default();
    let db = st.db.lock().unwrap();
    let rows = query_tracks(
        &db,
        &format!(
            "SELECT {TRACK_COLS} FROM tracks WHERE album = ? COLLATE NOCASE AND COALESCE(NULLIF(album_artist,''), artist) = ? COLLATE NOCASE
             ORDER BY disc_no, track_no, title COLLATE NOCASE"
        ),
        &[album.clone().into(), artist.clone().into()],
    );
    Ok(Json(
        json!({ "album": album, "artist": artist, "tracks": with_likes(&db, &u, rows) }),
    ))
}

async fn artists(State(st): State<St>, Auth(_, _): Auth) -> R {
    let db = st.db.lock().unwrap();
    let mut s = db
        .prepare(
            "SELECT artist, COUNT(*), COUNT(DISTINCT NULLIF(album,'')), COALESCE(MIN(CASE WHEN has_cover THEN id END), MIN(id))
             FROM tracks WHERE artist <> '' GROUP BY artist COLLATE NOCASE ORDER BY artist COLLATE NOCASE",
        )
        .unwrap();
    let rows: Vec<Value> = s
        .query_map([], |r| {
            Ok(json!({ "name": r.get::<_, String>(0)?, "tracks": r.get::<_, i64>(1)?, "albums": r.get::<_, i64>(2)?, "cover_id": r.get::<_, i64>(3)? }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    Ok(Json(json!(rows)))
}

async fn artist(
    State(st): State<St>,
    Auth(u, _): Auth,
    Query(q): Query<HashMap<String, String>>,
) -> R {
    let name = q.get("name").cloned().unwrap_or_default();
    let db = st.db.lock().unwrap();
    let rows = query_tracks(
        &db,
        &format!(
            "SELECT {TRACK_COLS} FROM tracks WHERE artist = ? COLLATE NOCASE OR album_artist = ? COLLATE NOCASE
             ORDER BY year, album COLLATE NOCASE, disc_no, track_no"
        ),
        &[name.clone().into(), name.clone().into()],
    );
    let mut s = db
        .prepare("SELECT track_id, COUNT(*) FROM plays WHERE user_id = ? GROUP BY track_id")
        .unwrap();
    let plays: HashMap<i64, i64> = s
        .query_map([u.id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    let mut top = rows.clone();
    top.sort_by_key(|t| {
        std::cmp::Reverse(plays.get(&t["id"].as_i64().unwrap()).copied().unwrap_or(0))
    });
    top.truncate(10);
    Ok(Json(
        json!({ "name": name, "tracks": with_likes(&db, &u, rows), "top": with_likes(&db, &u, top) }),
    ))
}

async fn stream(
    State(st): State<St>,
    _a: AuthQ,
    Path(id): Path<i64>,
    req: Request,
) -> Result<Response, ApiError> {
    serve_track(&st, id, req).await
}

pub async fn serve_track(st: &St, id: i64, req: Request) -> Result<Response, ApiError> {
    let path: String = st
        .db
        .lock()
        .unwrap()
        .query_row("SELECT path FROM tracks WHERE id = ?", [id], |r| r.get(0))
        .optional()
        .unwrap_or(None)
        .ok_or_else(nf)?;
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(ApiError::new(404, "file_missing"));
    }
    let mime = audio_type(&p).unwrap_or("application/octet-stream");
    // ServeFile handles Range, HEAD and conditional requests.
    let (parts, _) = req.into_parts();
    let mut fwd = Request::from_parts(parts, Body::empty());
    fwd.headers_mut().remove(header::IF_MODIFIED_SINCE);
    let mut res = ServeFile::new_with_mime(&p, &mime.parse().unwrap())
        .oneshot(fwd)
        .await
        .unwrap()
        .map(Body::new);
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    Ok(res)
}

async fn cover(State(st): State<St>, _a: AuthQ, Path(id): Path<i64>, headers: axum::http::HeaderMap) -> Result<Response, ApiError> {
    // the picture belongs to the file as it is now: when a song is replaced (ids are reused), the app asks again
    let tag: Option<String> = st
        .db
        .lock()
        .unwrap()
        .query_row("SELECT path, mtime FROM tracks WHERE id = ?", [id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .optional()
        .unwrap_or(None)
        .map(|(p, m)| format!("\"{id}-{m}-{}\"", p.len()));
    if let (Some(tag), Some(have)) = (&tag, headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok())) {
        if have == tag {
            return Ok((axum::http::StatusCode::NOT_MODIFIED, [(header::ETAG, tag.clone()), (header::CACHE_CONTROL, "private, no-cache".to_string())]).into_response());
        }
    }
    let mut res = serve_cover(&st, id).await?;
    if let Some(tag) = tag {
        if let Ok(v) = tag.parse() {
            res.headers_mut().insert(header::ETAG, v);
        }
        res.headers_mut().insert(header::CACHE_CONTROL, axum::http::HeaderValue::from_static("private, no-cache"));
    }
    Ok(res)
}

pub async fn serve_cover(st: &St, id: i64) -> Result<Response, ApiError> {
    let row: (String, i64, bool) = st
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT path, mtime, has_cover FROM tracks WHERE id = ?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
        )
        .optional()
        .unwrap_or(None)
        .ok_or_else(nf)?;
    let st2 = st.clone();
    let c = tokio::task::spawn_blocking(move || st2.library.cover(id, &row.0, row.1, row.2))
        .await
        .ok()
        .flatten();
    let (data, mime) = c.ok_or(ApiError::new(404, "no_cover"))?;
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "private, max-age=604800"),
        ],
        data,
    )
        .into_response())
}

fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || (c as u32) < 32 {
                '_'
            } else {
                c
            }
        })
        .collect();
    cleaned.trim().chars().take(180).collect()
}

async fn upload(
    State(st): State<St>,
    Auth(_, _): Auth,
    Query(q): Query<HashMap<String, String>>,
    req: Request,
) -> R {
    let dir = st
        .library
        .upload_dir
        .clone()
        .ok_or(ApiError::new(400, "no_upload_dir"))?;
    let name = safe_name(q.get("name").map(String::as_str).unwrap_or(""));
    if name.is_empty() || audio_type(std::path::Path::new(&name)).is_none() {
        return Err(ApiError::new(400, "unsupported_type"));
    }
    const MAX: u64 = 1 << 30;
    let len: u64 = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok()?.parse().ok())
        .unwrap_or(0);
    if len > MAX {
        return Err(ApiError::new(413, "too_large"));
    }
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| ApiError::new(500, "error"))?;
    let p = std::path::Path::new(&name);
    let (stem, ext) = (
        p.file_stem().unwrap().to_string_lossy().to_string(),
        p.extension().unwrap().to_string_lossy().to_string(),
    );
    let mut target = dir.join(&name);
    let mut i = 1;
    while target.exists() {
        target = dir.join(format!("{stem} ({i}).{ext}"));
        i += 1;
    }
    let tmp = target.with_extension(format!("{ext}.part"));
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|_| ApiError::new(500, "error"))?;
    let mut stream = req.into_body().into_data_stream();
    let mut size = 0u64;
    let mut failed: Option<ApiError> = None;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => {
                size += c.len() as u64;
                if size > MAX {
                    failed = Some(ApiError::new(413, "too_large"));
                    break;
                }
                if file.write_all(&c).await.is_err() {
                    failed = Some(ApiError::new(500, "error"));
                    break;
                }
            }
            Err(_) => {
                failed = Some(ApiError::new(400, "aborted"));
                break;
            }
        }
    }
    file.flush().await.ok();
    drop(file);
    if let Some(e) = failed {
        tokio::fs::remove_file(&tmp).await.ok();
        return Err(e);
    }
    tokio::fs::rename(&tmp, &target)
        .await
        .map_err(|_| ApiError::new(500, "error"))?;
    let st2 = st.clone();
    let t2 = target.clone();
    let id =
        tokio::task::spawn_blocking(move || st2.library.add_file(&st2.db.lock().unwrap(), &t2))
            .await
            .ok()
            .flatten()
            .ok_or(ApiError::new(500, "error"))?;
    st.rec.invalidate();
    let db = st.db.lock().unwrap();
    let (title, artist): (String, String) = db
        .query_row("SELECT title, artist FROM tracks WHERE id = ?", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    Ok(Json(json!({ "id": id, "title": title, "artist": artist })))
}

// ---------- likes ----------
async fn likes(State(st): State<St>, Auth(u, _): Auth) -> R {
    let db = st.db.lock().unwrap();
    let mut s = db
        .prepare("SELECT track_id FROM likes WHERE user_id = ? ORDER BY created DESC")
        .unwrap();
    let ids: Vec<i64> = s
        .query_map([u.id], |r| r.get(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    Ok(Json(json!(with_likes(&db, &u, tracks_by_ids(&db, &ids)))))
}
async fn like(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>) -> R {
    let db = st.db.lock().unwrap();
    let exists: Option<i64> = db
        .query_row("SELECT 1 FROM tracks WHERE id = ?", [id], |r| r.get(0))
        .optional()
        .unwrap_or(None);
    exists.ok_or_else(nf)?;
    db.execute(
        "INSERT OR IGNORE INTO likes (user_id, track_id, created) VALUES (?,?,?)",
        params![u.id, id, now_ms()],
    )
    .ok();
    Ok(Json(json!({ "liked": true })))
}
async fn unlike(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>) -> R {
    st.db
        .lock()
        .unwrap()
        .execute(
            "DELETE FROM likes WHERE user_id = ? AND track_id = ?",
            params![u.id, id],
        )
        .ok();
    Ok(Json(json!({ "liked": false })))
}

// ---------- playlists ----------
fn own_playlist(db: &Connection, u: &User, id: i64) -> Result<(i64, String), ApiError> {
    let row: Option<(i64, String, i64)> = db
        .query_row(
            "SELECT id, name, user_id FROM playlists WHERE id = ?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .unwrap_or(None);
    match row {
        Some((id, name, uid)) if uid == u.id => Ok((id, name)),
        _ => Err(nf()),
    }
}
/// A playlist the user may listen to and add songs to: their own, or one they were invited to.
/// Returns id, name, and whether they own it.
fn open_playlist(db: &Connection, u: &User, id: i64) -> Result<(i64, String, bool), ApiError> {
    if let Ok((id, name)) = own_playlist(db, u, id) {
        return Ok((id, name, true));
    }
    db.query_row(
        "SELECT p.id, p.name FROM playlists p JOIN playlist_members m ON m.playlist_id = p.id WHERE p.id = ? AND m.user_id = ?",
        params![id, u.id],
        |r| Ok((r.get(0)?, r.get(1)?, false)),
    )
    .optional()
    .unwrap_or(None)
    .ok_or_else(nf)
}
fn playlist_ids(db: &Connection, id: i64) -> Vec<i64> {
    let mut s = db
        .prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY pos")
        .unwrap();
    s.query_map([id], |r| r.get(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect()
}
pub fn set_playlist_tracks(db: &mut Connection, id: i64, ids: &[i64]) {
    let tx = db.transaction().unwrap();
    tx.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", [id])
        .ok();
    for (i, t) in ids.iter().take(5000).enumerate() {
        tx.execute(
            "INSERT INTO playlist_tracks (playlist_id, pos, track_id) VALUES (?,?,?)",
            params![id, i as i64, t],
        )
        .ok();
    }
    tx.execute(
        "UPDATE playlists SET updated = ? WHERE id = ?",
        params![now_ms(), id],
    )
    .ok();
    tx.commit().ok();
}
fn valid_ids(db: &Connection, ids: &[i64]) -> Vec<i64> {
    let ok: HashSet<i64> = tracks_by_ids(db, ids)
        .iter()
        .filter_map(|t| t["id"].as_i64())
        .collect();
    ids.iter().copied().filter(|i| ok.contains(i)).collect()
}

async fn playlists(State(st): State<St>, Auth(u, _): Auth) -> R {
    let db = st.db.lock().unwrap();
    let mut s = db
        .prepare(
            "SELECT p.id, p.name, p.updated, COUNT(pt.track_id), MIN(pt.track_id),
                    (SELECT updated FROM art WHERE kind = 'playlist' AND ref_id = p.id),
                    p.description, p.user_id = ?1, (SELECT name FROM users WHERE id = p.user_id),
                    (SELECT COUNT(*) FROM playlist_members WHERE playlist_id = p.id)
             FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
             WHERE p.user_id = ?1 OR p.id IN (SELECT playlist_id FROM playlist_members WHERE user_id = ?1)
             GROUP BY p.id ORDER BY p.updated DESC",
        )
        .unwrap();
    let rows: Vec<Value> = s
        .query_map([u.id], |r| {
            Ok(json!({ "id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?, "updated": r.get::<_, i64>(2)?,
                "tracks": r.get::<_, i64>(3)?, "cover_id": r.get::<_, Option<i64>>(4)?, "art": r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                "description": r.get::<_, String>(6)?, "mine": r.get::<_, bool>(7)?, "owner": r.get::<_, Option<String>>(8)?.unwrap_or_default(),
                "members": r.get::<_, i64>(9)? }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    Ok(Json(json!(rows)))
}
async fn create_playlist(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    let b: PlaylistBody = body_json(req).await?;
    let name: String = b.name.unwrap_or_default().trim().chars().take(80).collect();
    if name.is_empty() {
        return Err(ApiError::new(400, "name_required"));
    }
    let mut db = st.db.lock().unwrap();
    let now = now_ms();
    db.execute(
        "INSERT INTO playlists (user_id, name, description, created, updated) VALUES (?,?,?,?,?)",
        params![u.id, name, b.description.as_deref().unwrap_or("").trim().chars().take(300).collect::<String>(), now, now],
    )
    .ok();
    let id = db.last_insert_rowid();
    if let Some(ids) = b.track_ids {
        let ids = valid_ids(&db, &to_ids(&ids));
        set_playlist_tracks(&mut db, id, &ids);
    }
    Ok(Json(json!({ "id": id, "name": name })))
}
async fn get_playlist(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>) -> R {
    let db = st.db.lock().unwrap();
    let (id, name, mine) = open_playlist(&db, &u, id)?;
    let ids = playlist_ids(&db, id);
    let (description, owner): (String, String) = db
        .query_row(
            "SELECT p.description, COALESCE((SELECT name FROM users WHERE id = p.user_id), '') FROM playlists p WHERE p.id = ?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or_default();
    let mut s = db
        .prepare("SELECT u.id, u.name FROM playlist_members m JOIN users u ON u.id = m.user_id WHERE m.playlist_id = ? ORDER BY m.added")
        .unwrap();
    let members: Vec<Value> = s
        .query_map([id], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)? })))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    Ok(Json(
        json!({ "id": id, "name": name, "description": description, "mine": mine, "owner": owner, "members": members,
            "art": crate::ext::art_version(&db, "playlist", id), "tracks": with_likes(&db, &u, tracks_by_ids(&db, &ids)) }),
    ))
}
/// The owner removes a collaborator, or a collaborator leaves.
async fn remove_member(State(st): State<St>, Auth(u, _): Auth, Path((id, uid)): Path<(i64, i64)>) -> R {
    let db = st.db.lock().unwrap();
    let (id, _, mine) = open_playlist(&db, &u, id)?;
    if !mine && uid != u.id {
        return Err(nf());
    }
    db.execute("DELETE FROM playlist_members WHERE playlist_id = ? AND user_id = ?", params![id, uid]).ok();
    Ok(Json(json!({ "ok": true })))
}
async fn update_playlist(
    State(st): State<St>,
    Auth(u, _): Auth,
    Path(id): Path<i64>,
    req: Request,
) -> R {
    let b: PlaylistBody = body_json(req).await?;
    let mut db = st.db.lock().unwrap();
    let (id, _, mine) = open_playlist(&db, &u, id)?;
    if mine {
        if let Some(n) = b.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            let n: String = n.chars().take(80).collect();
            db.execute("UPDATE playlists SET name = ?, updated = ? WHERE id = ?", params![n, now_ms(), id]).ok();
        }
        if let Some(d) = b.description.as_deref() {
            let d: String = d.trim().chars().take(300).collect();
            db.execute("UPDATE playlists SET description = ?, updated = ? WHERE id = ?", params![d, now_ms(), id]).ok();
        }
    }
    if let Some(ids) = b.track_ids {
        let ids = valid_ids(&db, &to_ids(&ids));
        set_playlist_tracks(&mut db, id, &ids);
    }
    Ok(Json(json!({ "ok": true })))
}
async fn add_to_playlist(
    State(st): State<St>,
    Auth(u, _): Auth,
    Path(id): Path<i64>,
    req: Request,
) -> R {
    let b: PlaylistBody = body_json(req).await?;
    let mut db = st.db.lock().unwrap();
    let (id, _, _) = open_playlist(&db, &u, id)?;
    let mut ids = playlist_ids(&db, id);
    ids.extend(valid_ids(&db, &to_ids(&b.track_ids.unwrap_or_default())));
    set_playlist_tracks(&mut db, id, &ids);
    Ok(Json(json!({ "ok": true })))
}
async fn delete_playlist(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>) -> R {
    let db = st.db.lock().unwrap();
    let (id, _) = own_playlist(&db, &u, id)?;
    db.execute("DELETE FROM playlists WHERE id = ?", [id]).ok();
    Ok(Json(json!({ "ok": true })))
}

// ---------- events + recommendations ----------
async fn events(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    let v: Value = body_json(req).await?;
    let list: Vec<EventIn> = if let Some(arr) = v.get("events").and_then(Value::as_array) {
        arr.iter()
            .filter_map(|e| serde_json::from_value(e.clone()).ok())
            .collect()
    } else {
        serde_json::from_value(v).ok().into_iter().collect()
    };
    let mut db = st.db.lock().unwrap();
    let tx = db.transaction().unwrap();
    let now = now_ms();
    let mut n = 0;
    for e in list.into_iter().take(200) {
        let Some(id) = to_ids(&[e.track_id]).first().copied() else {
            continue;
        };
        if !["complete", "skip", "partial"].contains(&e.kind.as_str()) {
            continue;
        }
        let exists: Option<i64> = tx
            .query_row("SELECT 1 FROM tracks WHERE id = ?", [id], |r| r.get(0))
            .optional()
            .unwrap_or(None);
        if exists.is_none() {
            continue;
        }
        let ts =
            e.ts.as_i64()
                .filter(|t| (now - t).abs() < 30 * 86_400_000)
                .unwrap_or(now);
        let f = |v: &Value| v.as_f64().unwrap_or(0.0).max(0.0);
        tx.execute(
            "INSERT INTO plays (user_id, track_id, ts, played, duration, kind) VALUES (?,?,?,?,?,?)",
            params![u.id, id, ts, f(&e.played), f(&e.duration), e.kind],
        )
        .ok();
        n += 1;
    }
    tx.commit().ok();
    Ok(Json(json!({ "saved": n })))
}

async fn history(
    State(st): State<St>,
    Auth(u, _): Auth,
    Query(q): Query<HashMap<String, String>>,
) -> R {
    let limit = int(q.get("limit"), 50, 1, 500);
    let db = st.db.lock().unwrap();
    let mut s = db
        .prepare("SELECT track_id, ts, kind FROM plays WHERE user_id = ? ORDER BY ts DESC LIMIT ?")
        .unwrap();
    let rows: Vec<(i64, i64, String)> = s
        .query_map(params![u.id, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    let ids: Vec<i64> = rows
        .iter()
        .map(|r| r.0)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let tracks: HashMap<i64, Value> = with_likes(&db, &u, tracks_by_ids(&db, &ids))
        .into_iter()
        .map(|t| (t["id"].as_i64().unwrap(), t))
        .collect();
    let out: Vec<Value> = rows
        .into_iter()
        .filter_map(|(id, ts, kind)| {
            tracks
                .get(&id)
                .map(|t| json!({ "ts": ts, "kind": kind, "track": t }))
        })
        .collect();
    Ok(Json(json!(out)))
}

async fn rec_mix(
    State(st): State<St>,
    Auth(u, _): Auth,
    Query(q): Query<HashMap<String, String>>,
) -> R {
    let limit = int(q.get("limit"), 50, 1, 300) as usize;
    let db = st.db.lock().unwrap();
    let picks = st.rec.mix(&db, u.id, limit);
    Ok(Json(json!(rec_tracks(&db, &u, &picks))))
}
async fn rec_radio(
    State(st): State<St>,
    Auth(u, _): Auth,
    Path(id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
) -> R {
    let limit = int(q.get("limit"), 50, 1, 300) as usize;
    let exclude: HashSet<i64> = q
        .get("exclude")
        .map(|s| s.split(',').filter_map(|x| x.parse().ok()).collect())
        .unwrap_or_default();
    let db = st.db.lock().unwrap();
    let picks = st.rec.radio(&db, u.id, id, limit, &exclude);
    Ok(Json(json!(rec_tracks(&db, &u, &picks))))
}
async fn rec_similar(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>) -> R {
    let db = st.db.lock().unwrap();
    let ids = st.rec.similar(&db, id, 20);
    Ok(Json(json!(with_likes(&db, &u, tracks_by_ids(&db, &ids)))))
}
async fn rec_shuffle(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    let b: Ids = body_json(req).await?;
    let ids: Vec<i64> = to_ids(&b.ids).into_iter().take(5000).collect();
    let db = st.db.lock().unwrap();
    Ok(Json(json!({ "ids": st.rec.shuffle(&db, u.id, &ids) })))
}
async fn home(State(st): State<St>, Auth(u, _): Auth) -> R {
    let db = st.db.lock().unwrap();
    let (cold, recent, mix, top_artists, rediscover) = st.rec.home(&db, u.id);
    let mut s = db
        .prepare(
            "SELECT album, COALESCE(NULLIF(album_artist,''), artist), MIN(id), MAX(added) AS a
             FROM tracks WHERE album <> '' GROUP BY album, COALESCE(NULLIF(album_artist,''), artist)
             ORDER BY a DESC LIMIT 12",
        )
        .unwrap();
    let new_albums: Vec<Value> = s
        .query_map([], |r| {
            Ok(json!({ "album": r.get::<_, String>(0)?, "artist": r.get::<_, String>(1)?, "cover_id": r.get::<_, i64>(2)?, "added": r.get::<_, i64>(3)? }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    Ok(Json(json!({
        "cold": cold,
        "recent": with_likes(&db, &u, tracks_by_ids(&db, &recent)),
        "mix": rec_tracks(&db, &u, &mix),
        "rediscover": with_likes(&db, &u, tracks_by_ids(&db, &rediscover)),
        "topArtists": top_artists,
        "newAlbums": new_albums,
    })))
}

// ---------- static web app ----------
async fn web(State(st): State<St>, method: Method, uri: axum::http::Uri) -> Response {
    let rel = uri.path().trim_start_matches('/');
    let rel = if rel.is_empty() {
        "index.html"
    } else if rel.starts_with("s/") {
        "share.html"
    } else {
        rel
    };
    if rel.split('/').any(|s| s == "..") {
        return ApiError::new(404, "not_found").into_response();
    }
    let has_ext = std::path::Path::new(rel).extension().is_some();
    let load = |name: &str| -> Option<Vec<u8>> {
        if let Some(dir) = &st.web_dir {
            let f = dir.join(name);
            if f.is_file() {
                return std::fs::read(f).ok();
            }
            if f.is_dir() {
                return std::fs::read(f.join("index.html")).ok();
            }
            return None;
        }
        WebAssets::get(name).map(|f| f.data.into_owned())
    };
    let (name, data) = match load(rel) {
        Some(d) => (rel.to_string(), d),
        None if !has_ext => match load("index.html") {
            Some(d) => ("index.html".to_string(), d),
            None => return ApiError::new(404, "not_found").into_response(),
        },
        None => return ApiError::new(404, "not_found").into_response(),
    };
    let mime = mime_guess::from_path(&name).first_or_octet_stream();
    let mut headers = HeaderMap::new();
    let ct = if mime.type_() == "text" || mime.subtype() == "javascript" {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    };
    headers.insert(header::CONTENT_TYPE, ct.parse().unwrap());
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if method == Method::HEAD {
        headers.insert(header::CONTENT_LENGTH, data.len().into());
        return (headers, Body::empty()).into_response();
    }
    (headers, data).into_response()
}

pub fn router(st: St) -> Router {
    let api = Router::new()
        .route("/info", get(info))
        .route("/remote", put(set_remote))
        .route("/public-url", put(set_public))
        .route("/setup", post(setup))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me).put(update_me))
        .route("/me/password", put(change_password))
        .route("/users", get(list_users).post(add_user))
        .route("/users/{id}", delete(del_user))
        .route("/library", get(library_info))
        .route("/library/scan", post(scan))
        .route("/tracks", get(tracks))
        .route("/tracks/batch", post(tracks_batch))
        .route("/tracks/{id}", get(track))
        .route("/albums", get(albums))
        .route("/album", get(album))
        .route("/artists", get(artists))
        .route("/artist", get(artist))
        .route("/stream/{id}", get(stream))
        .route("/cover/{id}", get(cover))
        .route("/upload", post(upload).layer(DefaultBodyLimit::disable()))
        .route("/likes", get(likes))
        .route("/likes/{id}", put(like).delete(unlike))
        .route("/playlists", get(playlists).post(create_playlist))
        .route(
            "/playlists/{id}",
            get(get_playlist)
                .put(update_playlist)
                .delete(delete_playlist),
        )
        .route("/playlists/{id}/tracks", post(add_to_playlist))
        .route("/playlists/{id}/members/{uid}", delete(remove_member))
        .route("/events", post(events))
        .route("/history", get(history))
        .route("/recommend/mix", get(rec_mix))
        .route("/recommend/radio/{id}", get(rec_radio))
        .route("/recommend/similar/{id}", get(rec_similar))
        .route("/recommend/shuffle", post(rec_shuffle))
        .route("/home", get(home))
        .merge(crate::ext::routes())
        .merge(crate::offline::routes())
        .merge(crate::update::routes())
        .merge(crate::spotify::routes())
        .fallback(|| async { ApiError::new(404, "not_found") });
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::HEAD,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::RANGE, header::HeaderName::from_static("x-musik-key")])
        .expose_headers([
            header::CONTENT_RANGE,
            header::CONTENT_LENGTH,
            header::ACCEPT_RANGES,
        ])
        .max_age(std::time::Duration::from_secs(86400));
    Router::new()
        .nest("/api", api)
        .fallback(web)
        .layer(cors)
        .layer(axum::middleware::map_response(
            |mut res: Response| async move {
                res.headers_mut().insert(
                    "x-content-type-options",
                    HeaderValue::from_static("nosniff"),
                );
                res
            },
        ))
        .with_state(st)
}
