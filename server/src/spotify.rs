//! Spotify sign-in in the system browser. The server runs the PKCE flow and keeps the tokens
//! (including the refresh token) per user, so every app stays connected, also after a reinstall.
//!
//! 1. POST /api/spotify/start  {client_id, origin} -> {url}   (the app opens it in the browser)
//! 2. Spotify asks "connect?" and sends the browser to https://musik.labtoso.de/spotify.html,
//!    which forwards code and state to <origin>/api/spotify/callback
//! 3. The server swaps the code for tokens; the app sees it through GET /api/spotify/status
use crate::api::{body_json, ApiError, Auth, St, R};
use crate::db::now_ms;
use axum::extract::{Query, Request, State};
use axum::http::header;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

pub const REDIRECT: &str = "https://musik.labtoso.de/spotify.html";
const SCOPES: &str = "playlist-read-private playlist-read-collaborative user-library-read streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state";

pub fn routes() -> Router<St> {
    Router::new()
        .route("/spotify/start", post(start))
        .route("/spotify/callback", get(callback))
        .route("/spotify/status", get(status))
        .route("/spotify/token", get(token))
        .route("/spotify/disconnect", post(disconnect))
        .route("/spotify/embed", get(embed))
}

struct Pending {
    user: i64,
    client: String,
    verifier: String,
    at: i64,
}
static PENDING: Mutex<Option<HashMap<String, Pending>>> = Mutex::new(None);

fn b64url(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..=c.len() {
            out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}
fn random(n: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut v = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut v);
    v
}

#[derive(Deserialize, Default)]
struct StartBody {
    client_id: String,
    origin: String,
}

async fn start(Auth(u, _): Auth, req: Request) -> R {
    let b: StartBody = body_json(req).await?;
    let client = b.client_id.trim().to_string();
    if client.len() < 16 || !client.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ApiError::new(400, "spotify_no_client"));
    }
    let origin = b.origin.trim().trim_end_matches('/').to_string();
    if !(origin.starts_with("http://") || origin.starts_with("https://")) {
        return Err(ApiError::new(400, "bad_link"));
    }
    let verifier = b64url(&random(48));
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let nonce = b64url(&random(12));
    // the callback page on the website reads the server address from the state
    let state = b64url(json!({ "s": origin, "n": nonce }).to_string().as_bytes());
    {
        let mut g = PENDING.lock().unwrap();
        let m = g.get_or_insert_with(HashMap::new);
        let now = now_ms();
        m.retain(|_, p| now - p.at < 15 * 60 * 1000);
        m.insert(nonce, Pending { user: u.id, client: client.clone(), verifier, at: now });
    }
    let url = format!(
        "https://accounts.spotify.com/authorize?response_type=code&client_id={}&scope={}&redirect_uri={}&code_challenge_method=S256&code_challenge={}&state={}&show_dialog=true",
        enc(&client), enc(SCOPES), enc(REDIRECT), challenge, state
    );
    Ok(Json(json!({ "url": url, "redirect": REDIRECT })))
}

fn page(ok: bool, msg: &str) -> Response {
    let html = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Musik</title>
<style>html,body{{background:#111214;color:#ececee;font:16px/1.5 system-ui,sans-serif;margin:0;height:100%;display:grid;place-items:center;text-align:center}}div{{padding:24px;max-width:420px}}b{{display:block;font-size:22px;margin-bottom:8px;color:{}}}</style></head>
<body><div><b>{}</b>{}</div></body></html>"#,
        if ok { "#3dbb7a" } else { "#ff6b6b" },
        if ok { "Spotify connected · Spotify verbunden" } else { "Spotify" },
        msg
    );
    ([(header::CACHE_CONTROL, "no-store")], Html(html)).into_response()
}

/// Spotify (through the website) sends the browser here with ?code=&state=
async fn callback(State(st): State<St>, Query(q): Query<HashMap<String, String>>) -> Response {
    if let Some(e) = q.get("error") {
        return page(false, &format!("Not connected ({}). You can close this window. · Nicht verbunden. Du kannst dieses Fenster schließen.", html_escape(e)));
    }
    let (Some(code), Some(state)) = (q.get("code").cloned(), q.get("state").cloned()) else {
        return page(false, "Missing code. · Code fehlt.");
    };
    let nonce = decode_state(&state).and_then(|v| v["n"].as_str().map(str::to_string)).unwrap_or_default();
    let Some(p) = PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&nonce) else {
        return page(false, "This sign-in link has expired. Start again in the app. · Der Link ist abgelaufen, bitte in der App neu starten.");
    };
    let res = tokio::task::spawn_blocking(move || {
        ureq::post("https://accounts.spotify.com/api/token")
            .timeout(Duration::from_secs(15))
            .send_form(&[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", REDIRECT),
                ("client_id", &p.client),
                ("code_verifier", &p.verifier),
            ])
            .ok()
            .and_then(|r| r.into_json::<Value>().ok())
            .map(|v| (p, v))
    })
    .await
    .ok()
    .flatten();
    let Some((p, v)) = res else {
        return page(false, "Spotify did not accept the sign-in. Check the client ID and the redirect address in your Spotify app. · Spotify hat die Anmeldung abgelehnt. Prüf Client-ID und Weiterleitungsadresse.");
    };
    let Some(access) = v["access_token"].as_str() else {
        return page(false, "Spotify did not send a token. · Spotify hat keinen Token geschickt.");
    };
    let exp = now_ms() + (v["expires_in"].as_i64().unwrap_or(3600) - 60) * 1000;
    st.db.lock().unwrap().execute(
        "INSERT INTO spotify_tokens (user_id, client_id, access, refresh, exp) VALUES (?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET client_id = excluded.client_id, access = excluded.access, refresh = excluded.refresh, exp = excluded.exp",
        params![p.user, p.client, access, v["refresh_token"].as_str().unwrap_or(""), exp],
    ).ok();
    page(true, "You can close this window and go back to Musik. · Du kannst dieses Fenster schließen und zurück zu Musik gehen.")
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn decode_state(s: &str) -> Option<Value> {
    let mut bits = 0u32;
    let mut n = 0;
    let mut out = vec![];
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => continue,
        } as u32;
        bits = bits << 6 | v;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n & 0xff) as u8);
        }
    }
    serde_json::from_slice(&out).ok()
}

async fn status(State(st): State<St>, Auth(u, _): Auth) -> R {
    let has: bool = st.db.lock().unwrap().query_row("SELECT 1 FROM spotify_tokens WHERE user_id = ?", [u.id], |_| Ok(())).optional().ok().flatten().is_some();
    Ok(Json(json!({ "connected": has, "redirect": REDIRECT })))
}

/// A valid access token, refreshed with the stored refresh token when needed.
async fn token(State(st): State<St>, Auth(u, _): Auth) -> R {
    let row: Option<(String, String, String, i64)> = st
        .db
        .lock()
        .unwrap()
        .query_row("SELECT client_id, access, refresh, exp FROM spotify_tokens WHERE user_id = ?", [u.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()
        .ok()
        .flatten();
    let Some((client, access, refresh, exp)) = row else { return Err(ApiError::new(404, "spotify_login")) };
    if exp > now_ms() {
        return Ok(Json(json!({ "access": access, "exp": exp })));
    }
    if refresh.is_empty() {
        return Err(ApiError::new(401, "spotify_login"));
    }
    let r2 = refresh.clone();
    let v = tokio::task::spawn_blocking(move || {
        ureq::post("https://accounts.spotify.com/api/token")
            .timeout(Duration::from_secs(15))
            .send_form(&[("grant_type", "refresh_token"), ("refresh_token", &r2), ("client_id", &client)])
            .ok()
            .and_then(|r| r.into_json::<Value>().ok())
    })
    .await
    .ok()
    .flatten();
    let Some(access) = v.as_ref().and_then(|v| v["access_token"].as_str()).map(str::to_string) else {
        return Err(ApiError::new(401, "spotify_login"));
    };
    let v = v.unwrap();
    let exp = now_ms() + (v["expires_in"].as_i64().unwrap_or(3600) - 60) * 1000;
    let refresh = v["refresh_token"].as_str().map(str::to_string).unwrap_or(refresh);
    st.db.lock().unwrap().execute("UPDATE spotify_tokens SET access = ?, refresh = ?, exp = ? WHERE user_id = ?", params![access, refresh, exp, u.id]).ok();
    Ok(Json(json!({ "access": access, "exp": exp })))
}

async fn disconnect(State(st): State<St>, Auth(u, _): Auth) -> R {
    st.db.lock().unwrap().execute("DELETE FROM spotify_tokens WHERE user_id = ?", [u.id]).ok();
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn state_roundtrip() {
        let s = b64url(json!({ "s": "http://192.168.1.5:8484", "n": "abc" }).to_string().as_bytes());
        assert_eq!(decode_state(&s).unwrap()["s"], "http://192.168.1.5:8484");
        // challenge checked against Python hashlib + urlsafe_b64encode
        assert_eq!(b64url(&Sha256::digest(b"dBjftJeZ4CVP-mB92K2uhbUjZOdmqmEWU6XU7O8_9HTr")), "ctfj756xmMF6Drt7ZK833vhgUh5lDGBouHTGenP8aNM");
    }
}

/// The track list from Spotify's public embed page, like the Msik bot reads it: works for every
/// public playlist, album or track, also those the Web API no longer lists (not your own).
pub fn parse_embed(html: &str) -> Option<Value> {
    let start = html.find("<script id=\"__NEXT_DATA__\"")?;
    let body = &html[start..];
    let open = body.find('>')? + 1;
    let close = body[open..].find("</script>")?;
    let data: Value = serde_json::from_str(&body[open..open + close]).ok()?;
    let e = &data["props"]["pageProps"]["state"]["data"]["entity"];
    if !e.is_object() {
        return None;
    }
    let mut imgs: Vec<&Value> = e["visualIdentity"]["image"]
        .as_array()
        .or_else(|| e["coverArt"]["sources"].as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    imgs.sort_by_key(|i| -(i["maxWidth"].as_i64().unwrap_or(0)));
    let cover = imgs.first().and_then(|i| i["url"].as_str()).unwrap_or("").to_string();
    let name = e["name"].as_str().or_else(|| e["title"].as_str()).unwrap_or("").to_string();
    let id_of = |uri: &str| uri.rsplit(':').next().unwrap_or("").to_string();
    let tracks: Vec<Value> = if let Some(list) = e["trackList"].as_array() {
        list.iter()
            .filter(|t| t["uri"].as_str().map(|u| u.starts_with("spotify:track:")).unwrap_or(false))
            .map(|t| json!({ "id": id_of(t["uri"].as_str().unwrap_or("")), "title": t["title"], "artist": t["subtitle"].as_str().unwrap_or("").replace('\u{a0}', " "), "duration": t["duration"].as_f64().unwrap_or(0.0) / 1000.0 }))
            .collect()
    } else {
        let artist = e["artists"].as_array().map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        vec![json!({ "id": id_of(e["uri"].as_str().unwrap_or("")), "title": name, "artist": artist, "duration": e["duration"].as_f64().unwrap_or(0.0) / 1000.0, "cover": cover })]
    };
    Some(json!({ "name": name, "cover": cover, "description": e["description"].as_str().unwrap_or(""), "owner": e["subtitle"].as_str().unwrap_or(""), "tracks": tracks }))
}

/// ?kind=playlist|album|track|artist&id= (an artist gives the songs Spotify lists as popular) → { name, cover, description, owner, tracks:[{id,title,artist,duration}] }
async fn embed(Auth(_, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let kind = q.get("kind").map(String::as_str).unwrap_or("playlist").to_string();
    let id: String = q.get("id").map(|s| s.chars().filter(|c| c.is_ascii_alphanumeric()).take(40).collect()).unwrap_or_default();
    if !["playlist", "album", "track", "artist"].contains(&kind.as_str()) || id.is_empty() {
        return Err(ApiError::new(400, "bad_query"));
    }
    let html = tokio::task::spawn_blocking(move || {
        ureq::get(&format!("https://open.spotify.com/embed/{kind}/{id}"))
            .set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
            .timeout(std::time::Duration::from_secs(10))
            .call()
            .ok()
            .and_then(|r| r.into_string().ok())
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))?
    .ok_or_else(|| ApiError::new(502, "spotify_unreachable"))?;
    parse_embed(&html).map(Json).ok_or_else(|| ApiError::new(404, "notfound"))
}

#[cfg(test)]
mod embed_tests {
    #[test]
    fn reads_the_embed_page() {
        let data = r#"{"props":{"pageProps":{"state":{"data":{"entity":{"name":"Rock","subtitle":"Spotify","coverArt":{"sources":[{"url":"s","maxWidth":60},{"url":"big","maxWidth":640}]},"trackList":[{"uri":"spotify:track:abc","title":"Song","subtitle":"Band A, Band B","duration":200000},{"uri":"spotify:episode:x","title":"Pod","subtitle":"","duration":1}]}}}}}}"#;
        let html = format!("<html><script id=\"__NEXT_DATA__\" type=\"application/json\">{data}</script></html>");
        let v = super::parse_embed(&html).unwrap();
        assert_eq!(v["name"], "Rock");
        assert_eq!(v["cover"], "big");
        assert_eq!(v["tracks"].as_array().unwrap().len(), 1);
        assert_eq!(v["tracks"][0]["id"], "abc");
        assert_eq!(v["tracks"][0]["artist"], "Band A, Band B");
        assert_eq!(v["tracks"][0]["duration"], 200.0);
    }
}
