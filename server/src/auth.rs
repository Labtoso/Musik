use crate::db::now_ms;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use scrypt::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use scrypt::{Params, Scrypt};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub admin: bool,
    pub created: i64,
}

#[derive(Debug)]
pub struct AuthError(pub u16, pub &'static str);

fn hash_password(password: &str) -> String {
    let salt = SaltString::generate(&mut rand::rngs::OsRng);
    // log_n 14 keeps login fast on small servers while staying strong.
    let params = Params::new(14, 8, 1, 32).expect("scrypt params");
    Scrypt
        .hash_password_customized(password.as_bytes(), None, None, params, &salt)
        .expect("hash")
        .to_string()
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| Scrypt.verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

fn valid_name(name: &str) -> bool {
    let n = name.chars().count();
    (2..=32).contains(&n) && name.chars().all(|c| c.is_alphanumeric() || " _.-".contains(c))
}

pub fn needs_setup(db: &Connection) -> bool {
    db.query_row("SELECT COUNT(*) FROM users", [], |r| r.get::<_, i64>(0)).unwrap_or(0) == 0
}

pub fn user(db: &Connection, id: i64) -> Option<User> {
    db.query_row("SELECT id, name, admin, created FROM users WHERE id = ?", [id], |r| {
        Ok(User { id: r.get(0)?, name: r.get(1)?, admin: r.get::<_, i64>(2)? != 0, created: r.get(3)? })
    })
    .optional()
    .ok()
    .flatten()
}

pub fn users(db: &Connection) -> Vec<User> {
    let mut st = db.prepare("SELECT id, name, admin, created FROM users ORDER BY name COLLATE NOCASE").unwrap();
    st.query_map([], |r| Ok(User { id: r.get(0)?, name: r.get(1)?, admin: r.get::<_, i64>(2)? != 0, created: r.get(3)? }))
        .unwrap()
        .filter_map(Result::ok)
        .collect()
}

pub fn create_user(db: &Connection, name: &str, password: &str, admin: bool) -> Result<User, AuthError> {
    let name = name.trim();
    if !valid_name(name) {
        return Err(AuthError(400, "invalid_name"));
    }
    if password.chars().count() < 4 {
        return Err(AuthError(400, "password_short"));
    }
    let exists: Option<i64> = db.query_row("SELECT id FROM users WHERE name = ?", [name], |r| r.get(0)).optional().unwrap_or(None);
    if exists.is_some() {
        return Err(AuthError(409, "name_taken"));
    }
    db.execute(
        "INSERT INTO users (name, pass_hash, admin, created) VALUES (?,?,?,?)",
        params![name, hash_password(password), admin as i64, now_ms()],
    )
    .map_err(|_| AuthError(500, "error"))?;
    Ok(user(db, db.last_insert_rowid()).unwrap())
}

pub fn set_password(db: &Connection, user_id: i64, password: &str) -> Result<(), AuthError> {
    if password.chars().count() < 4 {
        return Err(AuthError(400, "password_short"));
    }
    db.execute("UPDATE users SET pass_hash = ? WHERE id = ?", params![hash_password(password), user_id]).ok();
    db.execute("DELETE FROM tokens WHERE user_id = ?", [user_id]).ok();
    Ok(())
}

pub fn check_login(db: &Connection, name: &str, password: &str) -> Result<User, AuthError> {
    let row: Option<(i64, String)> = db
        .query_row("SELECT id, pass_hash FROM users WHERE name = ?", [name.trim()], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .unwrap_or(None);
    match row {
        Some((id, hash)) if verify_password(password, &hash) => Ok(user(db, id).unwrap()),
        _ => Err(AuthError(401, "wrong_login")),
    }
}

pub fn issue(db: &Connection, user_id: i64, client: &str) -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    let now = now_ms();
    let client: String = client.chars().take(60).collect();
    db.execute(
        "INSERT INTO tokens (token, user_id, created, last_used, client) VALUES (?,?,?,?,?)",
        params![token, user_id, now, now, client],
    )
    .ok();
    token
}

pub fn verify(db: &Connection, token: &str) -> Option<User> {
    if token.len() != 64 {
        return None;
    }
    let (uid, last): (i64, i64) = db
        .query_row("SELECT user_id, last_used FROM tokens WHERE token = ?", [token], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .ok()
        .flatten()?;
    let now = now_ms();
    if now - last > 60_000 {
        db.execute("UPDATE tokens SET last_used = ? WHERE token = ?", params![now, token]).ok();
    }
    user(db, uid)
}

pub fn logout(db: &Connection, token: &str) {
    db.execute("DELETE FROM tokens WHERE token = ?", [token]).ok();
}

pub fn delete_user(db: &Connection, id: i64) {
    db.execute("DELETE FROM users WHERE id = ?", [id]).ok();
}
