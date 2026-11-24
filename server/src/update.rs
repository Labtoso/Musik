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
    // how() probes the file system: run it off the async workers together with the lookup
    let (l, how) = tokio::task::spawn_blocking(move || (latest(force), how())).await.map_err(|_| ApiError::new(500, "internal"))?;
    let (latest_v, notes, url, desktop) = match &l {
        Ok(v) => (v["version"].as_str().unwrap_or_default().to_string(), v["notes"].clone(), v["url"].clone(), v["desktop"].clone()),
        Err(_) => (String::new(), Value::Null, Value::Null, Value::Null),
    };
    Ok(Json(json!({
        "current": VERSION,
        "latest": if latest_v.is_empty() { Value::Null } else { json!(latest_v) },
        "available": !latest_v.is_empty() && newer(&latest_v, VERSION),
        "desktop": desktop,
        "how": how,
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
    let mode = tokio::task::spawn_blocking(how).await.map_err(|_| ApiError::new(500, "internal"))?;
    match mode {
        "self" => {}
        "docker" => return Err(ApiError::new(409, "update_docker")),
        "readonly" => return Err(ApiError::new(409, "update_readonly")),
        _ => return Err(ApiError::new(409, "update_unsupported")),
    }
    // one update at a time: two runs would write the same .new file
    static UPDATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    struct Permit;
    impl Drop for Permit {
        fn drop(&mut self) {
            UPDATING.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    if UPDATING.compare_exchange(false, true, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst).is_err() {
        return Err(ApiError::new(409, "update_busy"));
    }
    let permit = Permit;
    LOG.lock().unwrap().clear();
    log(format!("$ streyn-update   (running v{VERSION})"));
    // keep a copy of the database before the new version touches it
    let db = _st.db.clone();
    let (to, exe) = tokio::task::spawn_blocking(move || -> Result<(String, PathBuf), ApiError> {
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
            Ok(Some(p)) => log(format!("Saved {}", p.display())),
            Ok(None) => log("No backup made (no database file)."),
            Err(e) => {
                log(format!("Backup failed: {e}. Update cancelled."));
                return Err(ApiError::new(500, "update_backup"));
            }
        }
        let exe = install(&v).inspect_err(|e| log(format!("Failed: {}", e.1)))?;
        Ok((v, exe))
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))??;
    log(format!("Restarting: v{VERSION} -> v{to}"));
    // the permit stays taken until the process restarts
    std::mem::forget(permit);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        restart(&exe);
    });
    Ok(Json(json!({ "ok": true, "from": VERSION, "to": to })))
}

/// Downloads and swaps in the new binary; gives back the install path (read before the swap,
/// afterwards /proc/self/exe points to a deleted file).
fn install(version: &str) -> Result<PathBuf, ApiError> {
    let name = asset().ok_or(ApiError::new(409, "update_unsupported"))?;
    let exe = exe().ok_or(ApiError::new(500, "update_failed"))?;
    let url = format!("https://github.com/{REPO}/releases/download/v{version}/{name}");
    log(format!("Downloading {name} ..."));
    let res = ureq::get(&url)
        .set("User-Agent", "Streyn-Server")
        .timeout(Duration::from_secs(300))
        .call()
        .map_err(|_| ApiError::new(502, "update_unreachable"))?;
    let expected: Option<u64> = res.header("Content-Length").and_then(|v| v.trim().parse().ok());
    let new = exe.with_extension("new");
    let mut f = std::fs::File::create(&new).map_err(|_| ApiError::new(500, "update_readonly"))?;
    let copied = std::io::copy(&mut res.into_reader(), &mut f);
    let flushed = f.flush().and_then(|_| f.sync_all());
    drop(f);
    let n = match (copied, flushed) {
        (Ok(n), Ok(())) => n,
        _ => {
            let _ = std::fs::remove_file(&new);
            return Err(ApiError::new(502, "update_unreachable"));
        }
    };
    log(format!("Downloaded {:.1} MB", n as f64 / 1_048_576.0));
    // a cut-off download must never replace the working binary
    if n < 1_000_000 || expected.is_some_and(|e| e != n) {
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
        if let Err(e) = std::fs::rename(&new, &exe) {
            // put the old binary back, so the next start still finds it
            if let Err(e2) = std::fs::rename(&old, &exe) {
                log(format!("Could not swap in the new binary ({e}) nor restore the old one ({e2}); it is kept as {}", old.display()));
            }
            let _ = std::fs::remove_file(&new);
            return Err(ApiError::new(500, "update_readonly"));
        }
    }
    Ok(exe)
}

/// Under systemd (Restart=always) exiting is enough; otherwise start the new binary directly.
/// It waits for the port on its own (STREYN_RESTART), so no shell or delay command is needed.
fn restart(exe: &std::path::Path) {
    let under_service = std::env::var_os("INVOCATION_ID").is_some();
    if !under_service {
        if let Err(e) = std::process::Command::new(exe).args(std::env::args_os().skip(1)).env("STREYN_RESTART", "1").spawn() {
            // keep this process serving rather than leaving nothing running
            log(format!("Could not start {}: {e}. Restart the server by hand.", exe.display()));
            return;
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
        let f = backup_db(&conn).expect("backup").expect("file");
        assert!(f.is_file() && std::fs::metadata(&f).unwrap().len() > 0);
        for _ in 0..7 {
            std::thread::sleep(Duration::from_millis(1100));
            backup_db(&conn).unwrap();
        }
        assert_eq!(std::fs::read_dir(dir.join("backups")).unwrap().count(), 5);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Copies the database to <data>/backups/<date>_v<version>.db and keeps the last five copies.
/// Ok(None): the database has no file (in memory).
pub fn backup_db(conn: &rusqlite::Connection) -> Result<Option<PathBuf>, String> {
    let Some(path) = conn.path().filter(|p| !p.is_empty()).map(PathBuf::from) else { return Ok(None) };
    let dir = path.parent().ok_or_else(|| format!("no folder for {}", path.display()))?.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let file = dir.join(format!("{secs}_v{VERSION}.db"));
    conn.execute("VACUUM INTO ?1", [file.to_string_lossy()]).map_err(|e| format!("writing {}: {e}", file.display()))?;
    let mut old: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "db")).collect())
        .unwrap_or_default();
    old.sort();
    let n = old.len().saturating_sub(5);
    for p in old.into_iter().take(n) {
        let _ = std::fs::remove_file(p);
    }
    Ok(Some(file))
}
