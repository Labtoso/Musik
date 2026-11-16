//! Invitation links for new people: an admin makes a link, the person opens it, picks a name
//! and a password and gets a normal account. Each link works once and for seven days.
use crate::api::{body_json, ApiError, Auth, St, R};
use crate::db::now_ms;
use axum::extract::{Path, Request, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::RngCore;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::json;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  used_by INTEGER
);";

const DAYS: i64 = 7;

pub fn routes() -> Router<St> {
    Router::new()
        .route("/invites", post(create))
        .route("/invite/{token}", get(check))
        .route("/invite/{token}/signup", post(signup))
}

/// POST /api/invites (admin): a new link token.
async fn create(State(st): State<St>, Auth(u, _): Auth) -> R {
    if !u.admin {
        return Err(ApiError::new(403, "forbidden"));
    }
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    let token: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let now = now_ms();
    let expires = now + DAYS * 86_400_000;
    let db = st.db.lock().unwrap();
    db.execute("DELETE FROM invites WHERE expires < ?", [now]).ok();
    db.execute("INSERT INTO invites (token, created_by, created, expires) VALUES (?,?,?,?)", params![token, u.id, now, expires])
        .map_err(|_| ApiError::new(500, "internal"))?;
    Ok(Json(json!({ "token": token, "expires": expires })))
}

fn open_invite(db: &rusqlite::Connection, token: &str) -> Result<(), ApiError> {
    let row: Option<(i64, Option<i64>)> = db
        .query_row("SELECT expires, used_by FROM invites WHERE token = ?", [token], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .unwrap_or(None);
    match row {
        None => Err(ApiError::new(404, "invite_invalid")),
        Some((_, Some(_))) => Err(ApiError::new(410, "invite_used")),
        Some((exp, None)) if exp < now_ms() => Err(ApiError::new(410, "invite_expired")),
        _ => Ok(()),
    }
}

/// GET /api/invite/<token>: whether the link still works, and the server's name.
async fn check(State(st): State<St>, Path(token): Path<String>) -> R {
    open_invite(&st.db.lock().unwrap(), &token)?;
    Ok(Json(json!({ "ok": true, "server": st.name })))
}

#[derive(Deserialize, Default)]
struct SignupIn {
    name: String,
    password: String,
    #[serde(default)]
    client: String,
}

/// POST /api/invite/<token>/signup: makes the account and signs the person in.
async fn signup(State(st): State<St>, Path(token): Path<String>, req: Request) -> R {
    let b: SignupIn = body_json(req).await?;
    let st2 = st.clone();
    tokio::task::spawn_blocking(move || -> R {
        let db = st2.db.lock().unwrap();
        open_invite(&db, &token)?;
        let u = crate::auth::create_user(&db, &b.name, &b.password, false)?;
        db.execute("UPDATE invites SET used_by = ? WHERE token = ?", params![u.id, token]).ok();
        let session = crate::auth::issue(&db, u.id, if b.client.is_empty() { "Invite" } else { &b.client });
        Ok(Json(json!({ "token": session, "user": u })))
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))?
}
