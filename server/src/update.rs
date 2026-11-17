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
    Router::new().route("/update", get(status).post(apply)).route("/update/log", get(log_lines))
}

/// What the running update does, line by line, so the apps can show it like a terminal.
static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn log(line: impl Into<String>) {
    let line = line.into();
    println!("Update: {line}");
    let mut l = LOG.lock().unwrap();
    if l.len() > 200 {
        l.remove(0);
    }
    l.push(line);
}

/// GET /api/update/log: the lines of the last update (admin only).
async fn log_lines(Auth(u, _): Auth) -> R {
    if !u.admin {
        return Err(ApiError::new(403, "forbidden"));
    }
    Ok(Json(json!({ "lines": *LOG.lock().unwrap() })))
}

/// Release file with the server for this platform.
fn asset() -> Option<&'static str> {
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("streyn-server-linux-x64")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("streyn-server-linux-arm64")
    } else if cfg!(all(windows, target_arch = "x86_64")) {
        Some("streyn-server-windows-x64.exe")
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
    if std::path::Path::new("/.dockerenv").exists() || crate::brand_env("DOCKER").is_some() {
        return "docker";
    }
    if asset().is_none() {
        return "unsupported";
    }
    let Some(dir) = exe().and_then(|e| e.parent().map(PathBuf::from)) else { return "unsupported" };
    let probe = dir.join(".streyn-update-test");
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
        .set("User-Agent", "Streyn-Server")
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(|_| ApiError::new(502, "update_unreachable"))?
        .into_json()
        .map_err(|_| ApiError::new(502, "update_unreachable"))?;
    let tag = r.get("tag_name").and_then(Value::as_str).unwrap_or_default();
    // the desktop app has its own version: its file stays the same until the app itself changes
    let desktop = desktop_version(&r);
    let v = json!({
        "desktop": desktop,
        "version": tag.trim_start_matches('v'),
        "tag": tag,
        "notes": r.get("body").and_then(Value::as_str).unwrap_or_default(),
        "url": r.get("html_url").and_then(Value::as_str).unwrap_or_default(),
    });
    *CACHE.lock().unwrap() = Some((Instant::now(), v.clone()));
    Ok(v)
}

/// The desktop app's own version, read from the name of its file in the release
/// (streyn-desktop-<version>-<hash>-windows-x64.exe).
fn desktop_version(release: &Value) -> Option<String> {
    release.get("assets").and_then(Value::as_array)?.iter().filter_map(|x| x.get("name").and_then(Value::as_str)).find_map(|n| {
        let v = n.strip_prefix("streyn-desktop-")?.split('-').next()?;
        (!v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.')).then(|| v.to_string())
    })
}

/// GET /api/update?force=1: versions and whether the server can update itself.
async fn status(Auth(u, _): Auth, axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>) -> R {
    let force = q.contains_key("force");
    let l = tokio::task::spawn_blocking(move || latest(force)).await.map_err(|_| ApiError::new(500, "internal"))?;
    let (latest_v, notes, url, desktop) = match &l {
        Ok(v) => (v["version"].as_str().unwrap_or_default().to_string(), v["notes"].clone(), v["url"].clone(), v["desktop"].clone()),
        Err(_) => (String::new(), Value::Null, Value::Null, Value::Null),
    };
    Ok(Json(json!({
        "current": VERSION,
        "latest": if latest_v.is_empty() { Value::Null } else { json!(latest_v) },
        "available": !latest_v.is_empty() && newer(&latest_v, VERSION),
        "desktop": desktop,
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
    LOG.lock().unwrap().clear();
    log(format!("$ streyn-update   (running v{VERSION})"));
    // keep a copy of the database before the new version touches it
    let db = _st.db.clone();
    let to = tokio::task::spawn_blocking(move || -> Result<String, ApiError> {
        log("Looking up the latest release on GitHub ...");
        let l = latest(true).inspect_err(|_| log("GitHub is not reachable."))?;
        let v = l["version"].as_str().unwrap_or_default().to_string();
        if v.is_empty() || !newer(&v, VERSION) {
            log("Already up to date.");
            return Err(ApiError::new(409, "update_none"));
        }
        log(format!("New version: v{v}"));
        log("Backing up the database ...");
        match backup_db(&db.lock().unwrap()) {
            Some(p) => log(format!("Saved {}", p.display())),
            None => log("No backup made (no database file)."),
        }
        install(&v).inspect_err(|e| log(format!("Failed: {}", e.1)))?;
        Ok(v)
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))??;
    log(format!("Restarting: v{VERSION} -> v{to}"));
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
    log(format!("Downloading {name} ..."));
    let res = ureq::get(&url)
        .set("User-Agent", "Streyn-Server")
        .timeout(Duration::from_secs(300))
        .call()
        .map_err(|_| ApiError::new(502, "update_unreachable"))?;
    let new = exe.with_extension("new");
    let mut f = std::fs::File::create(&new).map_err(|_| ApiError::new(500, "update_readonly"))?;
    let n = std::io::copy(&mut res.into_reader(), &mut f).map_err(|_| ApiError::new(502, "update_unreachable"))?;
    f.flush().ok();
    drop(f);
    log(format!("Downloaded {:.1} MB", n as f64 / 1_048_576.0));
    if n < 1_000_000 {
        let _ = std::fs::remove_file(&new);
        return Err(ApiError::new(502, "update_failed"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755));
        std::fs::rename(&new, &exe).map_err(|_| ApiError::new(500, "update_readonly"))?;
        log(format!("Replaced {}", exe.display()));
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

/// Under systemd (Restart=always) exiting is enough; otherwise start the new binary directly.
/// It waits for the port on its own (STREYN_RESTART), so no shell or delay command is needed.
fn restart() {
    let under_service = std::env::var_os("INVOCATION_ID").is_some();
    if !under_service {
        if let Some(exe) = exe() {
            let _ = std::process::Command::new(&exe).args(std::env::args_os().skip(1)).env("STREYN_RESTART", "1").spawn();
        }
    }
    std::process::exit(0);
}

/// Windows keeps the replaced binary next to the new one until the next start.
pub fn remove_leftover() {
    if let Some(exe) = exe() {
        let old = exe.with_extension("old.exe");
        if old.is_file() {
            let _ = std::fs::remove_file(old);
        }
    }
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
    #[test]
    fn desktop_version_from_assets() {
        let r = json!({ "assets": [{ "name": "Streyn.exe" }, { "name": "streyn-desktop-1.27.0-ab12cd34ef-windows-x64.exe" }] });
        assert_eq!(desktop_version(&r).as_deref(), Some("1.27.0"));
        assert_eq!(desktop_version(&json!({ "assets": [{ "name": "Streyn.exe" }] })), None);
    }
    #[test]
    fn backup_copies_database() {
        let dir = std::env::temp_dir().join(format!("streyn-bk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let conn = crate::db::open(Some(&dir)).unwrap();
        let f = backup_db(&conn).expect("backup");
        assert!(f.is_file() && std::fs::metadata(&f).unwrap().len() > 0);
        for _ in 0..7 {
            std::thread::sleep(Duration::from_millis(1100));
            backup_db(&conn);
        }
        assert_eq!(std::fs::read_dir(dir.join("backups")).unwrap().count(), 5);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Copies the database to <data>/backups/<date>_v<version>.db and keeps the last five copies.
pub fn backup_db(conn: &rusqlite::Connection) -> Option<PathBuf> {
    let path = conn.path().filter(|p| !p.is_empty()).map(PathBuf::from)?;
    let dir = path.parent()?.join("backups");
    std::fs::create_dir_all(&dir).ok()?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let file = dir.join(format!("{secs}_v{VERSION}.db"));
    conn.execute("VACUUM INTO ?1", [file.to_string_lossy()]).ok()?;
    let mut old: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "db")).collect())
        .unwrap_or_default();
    old.sort();
    let n = old.len().saturating_sub(5);
    for p in old.into_iter().take(n) {
        let _ = std::fs::remove_file(p);
    }
    Some(file)
}
