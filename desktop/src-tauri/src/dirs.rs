//! Where the desktop app keeps its files.
//!
//! Windows, laid out like Spotify:
//!   %APPDATA%\Streyn\                 Streyn.exe, streyn-server.exe (written by the setup) and `prefs`
//!   %LOCALAPPDATA%\Streyn\Browser\    the web view's data (sign-in, language, theme of the web app)
//!   %LOCALAPPDATA%\Streyn\Storage\    offline downloads (songs and their database)
//!   %LOCALAPPDATA%\Streyn\Data\       cache (downloaded updates)
//!
//! Versions up to 1.33 used %APPDATA%\de.labtoso.streyn (config.json, offline\) and
//! %LOCALAPPDATA%\de.labtoso.streyn (EBWebView\, updates\), and installed the program into
//! %LOCALAPPDATA%\Streyn. Everything is moved over once, by renaming, so nothing is copied twice and
//! nothing is lost: whatever cannot be moved yet (still in use) is simply used where it is and moved
//! on a later start.
//!
//! Linux keeps the usual places (~/.config, ~/.local/share).
#![cfg_attr(not(windows), allow(dead_code))]
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

pub struct Dirs {
    /// settings file of the desktop app
    pub prefs: PathBuf,
    /// offline downloads: `data/` (database) and `music/` (songs)
    pub storage: PathBuf,
    /// data folder for the web view (None: the system default)
    pub browser: Option<PathBuf>,
    /// cache, e.g. `updates/`
    pub data: PathBuf,
}

static DIRS: OnceLock<Dirs> = OnceLock::new();

pub fn get() -> &'static Dirs {
    DIRS.get().expect("dirs::init runs first")
}

/// Works out the folders (and on Windows moves the files of earlier versions). Runs once at start,
/// before the window and the web view exist.
pub fn init(app: &AppHandle) {
    let _ = DIRS.set(resolve(app));
}

#[cfg(not(windows))]
fn resolve(app: &AppHandle) -> Dirs {
    let p = app.path();
    let cfg = p.app_config_dir().unwrap_or_default();
    let data = p.app_data_dir().unwrap_or_default();
    Dirs { prefs: cfg.join("config.json"), storage: data.join("offline"), browser: None, data: p.app_local_data_dir().unwrap_or(data) }
}

#[cfg(windows)]
fn resolve(app: &AppHandle) -> Dirs {
    let p = app.path();
    let roaming = p.data_dir().unwrap_or_default();
    let local = p.local_data_dir().unwrap_or_default();
    let ident = app.config().identifier.clone();
    windows_layout(&roaming, &local, &ident, std::env::current_exe().ok().as_deref())
}

/// The Spotify-like layout plus the one-time move from the earlier folders.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn windows_layout(roaming: &Path, local: &Path, ident: &str, exe: Option<&Path>) -> Dirs {
    let home = roaming.join("Streyn");
    let base = local.join("Streyn");
    let old_roaming = roaming.join(ident);
    let old_local = local.join(ident);
    let _ = std::fs::create_dir_all(&home);
    let _ = std::fs::create_dir_all(&base);

    // settings: a small file, copied when it cannot be renamed
    let prefs = home.join("prefs");
    let old_cfg = old_roaming.join("config.json");
    if !prefs.exists() && old_cfg.is_file() {
        if std::fs::rename(&old_cfg, &prefs).is_err() && std::fs::copy(&old_cfg, &prefs).is_ok() {
            let _ = std::fs::remove_file(&old_cfg);
        }
    }

    // offline downloads and the web view's data: renamed as a whole, retried for a moment because the
    // previous version may still be closing right after an update
    let storage = moved(&old_roaming.join("offline"), &base.join("Storage"));
    let _ = std::fs::create_dir_all(base.join("Browser"));
    let web = moved(&old_local.join("EBWebView"), &base.join("Browser").join("EBWebView"));
    let browser = web.parent().map(Path::to_path_buf);

    // downloaded setups of earlier updates are not needed any more
    let _ = std::fs::remove_dir_all(old_local.join("updates"));
    let data = base.join("Data");
    let _ = std::fs::create_dir_all(&data);

    // the program files of the earlier installation in %LOCALAPPDATA%\Streyn
    if exe.and_then(Path::parent).map(|d| !same_dir(d, &base)).unwrap_or(false) {
        retire_old_program(&base);
    }
    // the earlier folders go once they are empty; anything else in them is left alone
    for d in [&old_roaming, &old_local] {
        let _ = std::fs::remove_dir(d);
    }
    Dirs { prefs, storage, browser, data }
}

/// Moves `old` to `new` if only the old one exists. Returns the folder to use: the new one, or the
/// old one while it cannot be moved yet.
fn moved(old: &Path, new: &Path) -> PathBuf {
    if new.exists() || !old.exists() {
        return new.to_path_buf();
    }
    for _ in 0..20 {
        match std::fs::rename(old, new) {
            Ok(()) => return new.to_path_buf(),
            // in use (access denied / sharing violation): wait a moment, the old version is closing
            Err(e) if matches!(e.raw_os_error(), Some(5 | 32 | 33)) => std::thread::sleep(std::time::Duration::from_millis(250)),
            // e.g. a different drive: keep using the old folder
            Err(_) => break,
        }
    }
    old.to_path_buf()
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().trim_end_matches(['\\', '/']).to_ascii_lowercase();
    norm(a) == norm(b)
}

/// Program file names the earlier installation left in %LOCALAPPDATA%\Streyn.
pub fn is_old_program(lower_name: &str) -> bool {
    let known = lower_name.starts_with("streyn.exe.") || lower_name.starts_with("streyn-server.exe.");
    matches!(lower_name, "streyn.exe" | "streyn-server.exe" | "uninstall.exe") || (known && (lower_name.contains(".old-") || lower_name.ends_with(".new")))
}

/// Removes the earlier program files from `dir` (only those names). A file still in use is renamed
/// to `*.old-<pid>` and removed on a later start.
pub fn retire_old_program(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().to_ascii_lowercase();
        if !e.path().is_file() || !is_old_program(&n) {
            continue;
        }
        if std::fs::remove_file(e.path()).is_err() && !n.contains(".old-") {
            let _ = std::fs::rename(e.path(), dir.join(format!("{n}.old-{}", std::process::id())));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("streyn-dirs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn moves_everything_from_the_old_layout() {
        let t = tmp("move");
        let (roaming, local) = (t.join("Roaming"), t.join("Local"));
        let id = "de.labtoso.streyn";
        std::fs::create_dir_all(roaming.join(id).join("offline/data")).unwrap();
        std::fs::create_dir_all(roaming.join(id).join("offline/music/songs")).unwrap();
        std::fs::write(roaming.join(id).join("config.json"), b"{\"server\":\"http://x:8484\"}").unwrap();
        std::fs::write(roaming.join(id).join("offline/data/streyn.db"), b"db").unwrap();
        std::fs::write(roaming.join(id).join("offline/music/songs/a.opus"), b"song").unwrap();
        std::fs::create_dir_all(local.join(id).join("EBWebView/Default")).unwrap();
        std::fs::write(local.join(id).join("EBWebView/Default/Local Storage"), b"ls").unwrap();
        std::fs::create_dir_all(local.join(id).join("updates")).unwrap();
        std::fs::write(local.join(id).join("updates/Streyn-setup.exe"), b"x").unwrap();
        // the earlier installation
        std::fs::create_dir_all(local.join("Streyn")).unwrap();
        std::fs::write(local.join("Streyn/Streyn.exe"), b"old").unwrap();
        std::fs::write(local.join("Streyn/streyn-server.exe"), b"old").unwrap();
        std::fs::write(local.join("Streyn/notes.txt"), b"keep").unwrap();

        let exe = roaming.join("Streyn/Streyn.exe");
        let d = windows_layout(&roaming, &local, id, Some(&exe));
        assert_eq!(d.prefs, roaming.join("Streyn/prefs"));
        assert_eq!(std::fs::read(&d.prefs).unwrap(), b"{\"server\":\"http://x:8484\"}");
        assert_eq!(d.storage, local.join("Streyn/Storage"));
        assert_eq!(std::fs::read(d.storage.join("data/streyn.db")).unwrap(), b"db");
        assert_eq!(std::fs::read(d.storage.join("music/songs/a.opus")).unwrap(), b"song");
        assert_eq!(d.browser.as_deref(), Some(local.join("Streyn/Browser").as_path()));
        assert!(local.join("Streyn/Browser/EBWebView/Default/Local Storage").is_file());
        assert_eq!(d.data, local.join("Streyn/Data"));
        assert!(d.data.is_dir());
        // old folders are gone, old program files too, other files stay
        assert!(!roaming.join(id).exists());
        assert!(!local.join(id).exists());
        assert!(!local.join("Streyn/Streyn.exe").exists());
        assert!(!local.join("Streyn/streyn-server.exe").exists());
        assert!(local.join("Streyn/notes.txt").exists());

        // a second start changes nothing
        let d2 = windows_layout(&roaming, &local, id, Some(&exe));
        assert_eq!(d2.storage, d.storage);
        assert!(d2.storage.join("music/songs/a.opus").is_file());
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn fresh_install_and_existing_new_layout_win() {
        let t = tmp("fresh");
        let (roaming, local) = (t.join("Roaming"), t.join("Local"));
        let d = windows_layout(&roaming, &local, "id", None);
        assert!(!d.prefs.exists());
        assert_eq!(d.storage, local.join("Streyn/Storage"));
        // both exist: the new one is used and the old one is left untouched
        std::fs::create_dir_all(roaming.join("id/offline")).unwrap();
        std::fs::create_dir_all(local.join("Streyn/Storage")).unwrap();
        let d = windows_layout(&roaming, &local, "id", None);
        assert_eq!(d.storage, local.join("Streyn/Storage"));
        assert!(roaming.join("id/offline").exists());
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn program_running_from_local_is_not_removed() {
        let t = tmp("portable");
        let (roaming, local) = (t.join("Roaming"), t.join("Local"));
        std::fs::create_dir_all(local.join("Streyn")).unwrap();
        std::fs::write(local.join("Streyn/Streyn.exe"), b"me").unwrap();
        let exe = local.join("Streyn/Streyn.exe");
        windows_layout(&roaming, &local, "id", Some(&exe));
        assert!(exe.exists());
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn only_program_names() {
        for n in ["streyn.exe", "streyn-server.exe", "uninstall.exe", "streyn.exe.old-3", "streyn-server.exe.new"] {
            assert!(is_old_program(n), "{n}");
        }
        for n in ["prefs", "notes.txt", "other.exe", "storage"] {
            assert!(!is_old_program(n), "{n}");
        }
    }
}
