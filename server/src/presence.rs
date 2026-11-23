// Devices of the same account: each open app reports what it plays, the others can see it and take it over
// (like Spotify Connect). Kept in memory only; a device that stops reporting disappears after a short while.
use crate::api::{body_json, Auth, St, R};
use crate::db::now_ms;
use axum::extract::{Path, Request};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const STALE_MS: i64 = 45_000;

#[derive(Default)]
struct Dev {
    info: Value,
    seen: i64,
    cmds: Vec<Value>,
}

fn map() -> &'static Mutex<HashMap<i64, HashMap<String, Dev>>> {
    static M: OnceLock<Mutex<HashMap<i64, HashMap<String, Dev>>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

pub fn routes() -> Router<St> {
    Router::new().route("/presence", post(report)).route("/presence/{dev}/cmd", post(command))
}

fn clean(s: &str, n: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(n).collect()
}

/// Heartbeat: { device, name, kind, playing, position, duration, track: {...} }.
/// Answers with the other devices of this account and the commands waiting for this one.
async fn report(Auth(u, _): Auth, req: Request) -> R {
    let b: Value = body_json(req).await?;
    let dev = clean(b["device"].as_str().unwrap_or(""), 64);
    let now = now_ms();
    let mut all = map().lock().unwrap();
    let mine = all.entry(u.id).or_default();
    mine.retain(|_, d| now - d.seen < STALE_MS);
    let mut cmds = vec![];
    if !dev.is_empty() {
        let info = json!({
            "name": clean(b["name"].as_str().unwrap_or("?"), 60),
            "kind": clean(b["kind"].as_str().unwrap_or("web"), 16),
            "playing": b["playing"].as_bool().unwrap_or(false),
            "position": b["position"].as_f64().unwrap_or(0.0),
            "duration": b["duration"].as_f64().unwrap_or(0.0),
            "track": if b["track"].is_object() { b["track"].clone() } else { Value::Null },
            "at": now,
        });
        if mine.len() < 20 || mine.contains_key(&dev) {
            let d = mine.entry(dev.clone()).or_default();
            d.info = info;
            d.seen = now;
            cmds = std::mem::take(&mut d.cmds);
        }
    }
    let others: Vec<Value> = mine
        .iter()
        .filter(|(k, d)| **k != dev && d.info.is_object())
        .map(|(k, d)| {
            let mut v = d.info.clone();
            v["device"] = json!(k);
            v
        })
        .collect();
    Ok(Json(json!({ "devices": others, "commands": cmds })))
}

/// Sends a command to another device of the same account: pause, play, next, prev.
async fn command(Auth(u, _): Auth, Path(dev): Path<String>, req: Request) -> R {
    let b: Value = body_json(req).await?;
    let cmd = b["cmd"].as_str().unwrap_or("");
    if !["pause", "play", "next", "prev"].contains(&cmd) {
        return Ok(Json(json!({ "ok": false })));
    }
    let mut all = map().lock().unwrap();
    let ok = match all.get_mut(&u.id).and_then(|m| m.get_mut(&dev)) {
        Some(d) => {
            if d.cmds.len() < 10 {
                d.cmds.push(json!({ "cmd": cmd, "at": now_ms() }));
            }
            true
        }
        None => false,
    };
    Ok(Json(json!({ "ok": ok })))
}
