//! Update check and self-update: the server looks up the latest release on GitHub and can
//! replace its own binary with the one for this platform, then restarts.
use crate::api::{ApiError, Auth, St, R, VERSION};
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const REPO: &str = "Labtoso/Musik";

pub fn routes() -> Router<St> {
    Router::new().route("/update", get(status).post(apply))
}

/// Release file with the server for this platform.
fn asset() -> Option<&'static str> {
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("musik-server-linux-x64")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("musik-server-linux-arm64")
    } else if cfg!(all(windows, target_arch = "x86_64")) {
        Some("musik-server-windows-x64.exe")
    } else {
        None
    }
}

/// "1.10.2" -> [1, 10, 2]
pub fn parse(v: &str) -> Vec<u32> {
    v.trim().trim_start_matches('v').split('.').map(|p| p.trim().parse().unwrap_or(0)).collect()
}

pub fn newer(latest: &str, current: &str) -> bool {
    parse(latest) > parse(current)
}

/// How this server can be updated: self, docker, readonly or unsupported.
fn how() -> &'static str {
    if std::path::Path::new("/.dockerenv").exists() || std::env::var_os("MUSIK_DOCKER").is_some() {
        return "docker";
    }
    if asset().is_none() {
        return "unsupported";
    }
    let Some(dir) = exe().and_then(|e| e.parent().map(PathBuf::from)) else { return "unsupported" };
    let probe = dir.join(".musik-update-test");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(probe);
            "self"
        }
        Err(_) => "readonly",
    }
}

fn exe() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.canonicalize().ok().or(Some(p)))
}

static CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

/// Latest release, cached for ten minutes.
fn latest(force: bool) -> Result<Value, ApiError> {
    if !force {
        if let Some((at, v)) = CACHE.lock().unwrap().as_ref() {
            if at.elapsed() < Duration::from_secs(600) {
                return Ok(v.clone());
            }
        }
    }
    let r: Value = ureq::get(&format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .set("User-Agent", "Musik-Server")
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(|_| ApiError::new(502, "update_unreachable"))?
        .into_json()
        .map_err(|_| ApiError::new(502, "update_unreachable"))?;
    let tag = r.get("tag_name").and_then(Value::as_str).unwrap_or_default();
    let v = json!({
        "version": tag.trim_start_matches('v'),
        "tag": tag,
        "notes": r.get("body").and_then(Value::as_str).unwrap_or_default(),
        "url": r.get("html_url").and_then(Value::as_str).unwrap_or_default(),
    });
    *CACHE.lock().unwrap() = Some((Instant::now(), v.clone()));
    Ok(v)
}

/// GET /api/update?force=1: versions and whether the server can update itself.
async fn status(Auth(u, _): Auth, axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>) -> R {
    let force = q.contains_key("force");
    let l = tokio::task::spawn_blocking(move || latest(force)).await.map_err(|_| ApiError::new(500, "internal"))?;
    let (latest_v, notes, url) = match &l {
        Ok(v) => (v["version"].as_str().unwrap_or_default().to_string(), v["notes"].clone(), v["url"].clone()),
        Err(_) => (String::new(), Value::Null, Value::Null),
    };
    Ok(Json(json!({
        "current": VERSION,
        "latest": if latest_v.is_empty() { Value::Null } else { json!(latest_v) },
        "available": !latest_v.is_empty() && newer(&latest_v, VERSION),
        "how": how(),
        "admin": u.admin,
        "notes": notes,
        "url": url,
        "error": l.err().map(|e| e.1),
    })))
}

/// POST /api/update: download the latest server, swap it in and restart (admin only).
async fn apply(State(_st): State<St>, Auth(u, _): Auth) -> R {
    if !u.admin {
        return Err(ApiError::new(403, "forbidden"));
    }
    match how() {
        "self" => {}
        "docker" => return Err(ApiError::new(409, "update_docker")),
        "readonly" => return Err(ApiError::new(409, "update_readonly")),
        _ => return Err(ApiError::new(409, "update_unsupported")),
    }
    let to = tokio::task::spawn_blocking(|| -> Result<String, ApiError> {
        let l = latest(true)?;
        let v = l["version"].as_str().unwrap_or_default().to_string();
        if v.is_empty() || !newer(&v, VERSION) {
            return Err(ApiError::new(409, "update_none"));
        }
        install(&v)?;
        Ok(v)
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))??;
    println!("Update: {VERSION} -> {to}, restarting");
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(800));
        restart();
    });
    Ok(Json(json!({ "ok": true, "from": VERSION, "to": to })))
}

fn install(version: &str) -> Result<(), ApiError> {
    let name = asset().ok_or(ApiError::new(409, "update_unsupported"))?;
    let exe = exe().ok_or(ApiError::new(500, "update_failed"))?;
    let url = format!("https://github.com/{REPO}/releases/download/v{version}/{name}");
    let res = ureq::get(&url)
        .set("User-Agent", "Musik-Server")
        .timeout(Duration::from_secs(300))
        .call()
        .map_err(|_| ApiError::new(502, "update_unreachable"))?;
    let new = exe.with_extension("new");
    let mut f = std::fs::File::create(&new).map_err(|_| ApiError::new(500, "update_readonly"))?;
    let n = std::io::copy(&mut res.into_reader(), &mut f).map_err(|_| ApiError::new(502, "update_unreachable"))?;
    f.flush().ok();
    drop(f);
    if n < 1_000_000 {
        let _ = std::fs::remove_file(&new);
        return Err(ApiError::new(502, "update_failed"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755));
        std::fs::rename(&new, &exe).map_err(|_| ApiError::new(500, "update_readonly"))?;
    }
    #[cfg(windows)]
    {
        // a running exe can be renamed but not overwritten
        let old = exe.with_extension("old.exe");
        let _ = std::fs::remove_file(&old);
        std::fs::rename(&exe, &old).map_err(|_| ApiError::new(500, "update_readonly"))?;
        std::fs::rename(&new, &exe).map_err(|_| ApiError::new(500, "update_readonly"))?;
    }
    Ok(())
}

/// Under systemd (Restart=always) exiting is enough; otherwise start the new binary after we are gone.
fn restart() {
    let under_service = std::env::var_os("INVOCATION_ID").is_some();
    if !under_service {
        if let Some(exe) = exe() {
            let args: Vec<String> = std::env::args().skip(1).collect();
            #[cfg(unix)]
            {
                let mut cmd = format!("sleep 2; exec '{}'", exe.display().to_string().replace('\'', "'\\''"));
                for a in &args {
                    cmd.push_str(&format!(" '{}'", a.replace('\'', "'\\''")));
                }
                let _ = std::process::Command::new("sh").arg("-c").arg(cmd).spawn();
            }
            #[cfg(windows)]
            {
                let mut c = std::process::Command::new("cmd");
                c.args(["/C", "ping -n 3 127.0.0.1 >nul & start \"\" "]).arg(&exe).args(&args);
                let _ = c.spawn();
            }
        }
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions() {
        assert!(newer("1.4.0", "1.3.9"));
        assert!(newer("v1.10.0", "1.9.3"));
        assert!(!newer("1.4.0", "1.4.0"));
        assert!(!newer("1.3.0", "1.4.0"));
    }
}
