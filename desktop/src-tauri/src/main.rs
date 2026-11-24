// Streyn desktop: asks once for the server address, then shows the web app served by the server.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dirs;
mod discord;
#[cfg(windows)]
mod win;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Default, Serialize, Deserialize, Clone)]
struct Config {
    server: Option<String>,
    /// Address for on the go (e.g. Tailscale), reported by the server.
    #[serde(default)]
    remote: Option<String>,
    /// key for the server this app starts for offline mode
    #[serde(default)]
    off_key: Option<String>,
}

fn config_path(_app: &AppHandle) -> Option<PathBuf> {
    Some(dirs::get().prefs.clone())
}

fn load_config(app: &AppHandle) -> Config {
    config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &Config) {
    if let Some(p) = config_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, serde_json::to_string_pretty(cfg).unwrap_or_default());
    }
}

/// "192.168.1.50" -> "http://192.168.1.50:8484"
fn normalize(input: &str) -> Option<String> {
    let mut s = input.trim().to_string();
    if s.is_empty() {
        return None;
    }
    if !s.to_lowercase().starts_with("http://") && !s.to_lowercase().starts_with("https://") {
        s = format!("http://{s}");
    }
    let mut u = Url::parse(&s).ok()?;
    let host = u.host_str()?.to_string();
    let has_tld = host.rsplit('.').next().map(|t| t.len() >= 2 && t.chars().all(|c| c.is_ascii_alphabetic())).unwrap_or(false)
        && host.contains('.');
    if u.port().is_none() && u.scheme() == "http" && !has_tld {
        u.set_port(Some(8484)).ok()?;
    }
    Some(u.origin().ascii_serialization())
}

fn check(origin: &str) -> &'static str {
    probe(origin, 6).0
}

/// State of a server plus the address for on the go it reports.
fn probe(origin: &str, secs: u64) -> (&'static str, Option<String>) {
    let res = ureq::get(&format!("{origin}/api/info")).timeout(Duration::from_secs(secs)).call();
    match res {
        Ok(r) => match r.into_json::<serde_json::Value>() {
            Ok(v) if v.get("app").and_then(|a| a.as_str()) == Some("musik") => {
                let remote = v.get("remote").and_then(|r| r.as_str()).map(|r| r.trim_end_matches('/').to_string()).filter(|r| r.starts_with("http"));
                ("ok", remote)
            }
            _ => ("notmusik", None),
        },
        Err(_) => ("offline", None),
    }
}

fn open_server(win: &WebviewWindow, origin: &str) {
    if let Ok(url) = Url::parse(&format!("{origin}/")) {
        let _ = win.navigate(url);
    }
}

#[tauri::command]
async fn connect(app: AppHandle, window: WebviewWindow, server: String) -> String {
    let Some(origin) = normalize(&server) else { return "offline".into() };
    let o = origin.clone();
    let (state, remote) = tauri::async_runtime::spawn_blocking(move || probe(&o, 6)).await.unwrap_or(("offline", None));
    if state == "ok" {
        save_config(&app, &Config { server: Some(origin.clone()), remote, ..load_config(&app) });
        open_server(&window, &origin);
    }
    state.into()
}

#[tauri::command]
fn saved_server(app: AppHandle) -> String {
    load_config(&app).server.unwrap_or_default()
}

// ---- self-update: download the latest build from the release page and swap it in
fn download(url: &str, dest: &std::path::Path, win: &WebviewWindow) -> Result<(), String> {
    use std::io::{Read, Write};
    let res = ureq::get(url).set("User-Agent", "Streyn-Desktop").timeout(Duration::from_secs(600)).call().map_err(|_| "offline".to_string())?;
    let total: u64 = res.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut r = res.into_reader();
    let mut f = std::fs::File::create(dest).map_err(|_| "write".to_string())?;
    let (mut done, mut last, mut buf) = (0u64, -1i64, vec![0u8; 64 * 1024]);
    loop {
        let n = r.read(&mut buf).map_err(|_| "offline".to_string())?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n]).map_err(|_| "write".to_string())?;
        done += n as u64;
        if total > 0 {
            let p = (done * 100 / total) as i64;
            if p != last {
                last = p;
                let _ = win.eval(&format!("window.updProgress && window.updProgress({p})"));
            }
        }
    }
    if done < 1_000_000 {
        return Err("offline".into());
    }
    Ok(())
}

fn do_update(app: &AppHandle, win: &WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        // the official installer from the release page, kept in the app's own folder (not in temp)
        let dir = dirs::get().data.join("updates");
        std::fs::create_dir_all(&dir).map_err(|_| "write".to_string())?;
        let installer = dir.join("Streyn-setup.exe");
        download("https://github.com/Labtoso/Musik/releases/latest/download/Streyn.exe", &installer, win)?;
        // /S works without questions, /R opens Streyn again when it is done. The setup does not
        // touch this running app: it renames the in-use file and this app closes itself below.
        std::process::Command::new(&installer).args(["/S", "/R"]).spawn().map_err(|_| "write".to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let target = std::env::var_os("APPIMAGE").map(PathBuf::from).ok_or_else(|| "unsupported".to_string())?;
        let new = target.with_extension("new");
        download("https://github.com/Labtoso/Musik/releases/latest/download/Streyn.AppImage", &new, win)?;
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755)).map_err(|_| "write".to_string())?;
        std::fs::rename(&new, &target).map_err(|_| "write".to_string())?;
        std::process::Command::new("sh").arg("-c").arg("sleep 1; exec \"$0\"").arg(&target).spawn().map_err(|_| "write".to_string())?;
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = win;
        return Err("unsupported".into());
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        app.exit(0);
    });
    Ok(())
}

#[tauri::command]
async fn self_update(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || do_update(&app, &window)).await.map_err(|_| "write".to_string())?
}

/// Back from the update page to the server.
#[tauri::command]
fn open_saved(app: AppHandle, window: WebviewWindow) {
    if let Some(s) = load_config(&app).server {
        open_server(&window, &s);
    }
}

/// Open a page in the system browser (Spotify sign-in and other outside links).
fn open_browser(url: &str) {
    if url.starts_with("https://") || url.starts_with("http://") {
        let _ = open::that_detached(url);
    }
}

// ---- offline mode: the Streyn server runs on this computer (sidecar "streyn-server") and keeps copies of playlists
const LOCAL: &str = "http://127.0.0.1:8485";
static LOCAL_PROC: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

fn off_dir(_app: &AppHandle) -> Option<PathBuf> {
    Some(dirs::get().storage.clone())
}
fn off_key(app: &AppHandle) -> String {
    let mut cfg = load_config(app);
    if let Some(k) = cfg.off_key.clone().filter(|k| k.len() >= 32) {
        return k;
    }
    use std::hash::{BuildHasher, Hasher};
    let mut k = String::new();
    for i in 0..4u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i ^ std::process::id() as u64);
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        k.push_str(&format!("{:016x}", h.finish()));
    }
    cfg.off_key = Some(k.clone());
    save_config(app, &cfg);
    k
}
/// Settings → Offline → folder button: shows the downloaded songs in Explorer / the file manager.
fn open_off_folder(app: &AppHandle) {
    let Some(dir) = off_dir(app) else { return };
    let songs = dir.join("music").join("songs");
    let target = if songs.is_dir() {
        songs
    } else {
        let _ = std::fs::create_dir_all(&dir);
        dir
    };
    // the file manager itself, no shell in between
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer.exe").arg(&target).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&target).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(&target).spawn();
}
fn has_offline(app: &AppHandle) -> bool {
    off_dir(app).map(|d| ["streyn.db", "musik.db"].iter().any(|f| d.join("data").join(f).exists())).unwrap_or(false) && server_bin().is_file()
}
fn server_bin() -> PathBuf {
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)).unwrap_or_default();
    dir.join(if cfg!(windows) { "streyn-server.exe" } else { "streyn-server" })
}
fn local_up() -> bool {
    ureq::get(&format!("{LOCAL}/api/info"))
        .timeout(Duration::from_millis(800))
        .call()
        .ok()
        .and_then(|r| r.into_json::<serde_json::Value>().ok())
        .map(|v| v.get("offline").and_then(|o| o.as_bool()) == Some(true))
        .unwrap_or(false)
}
fn ensure_local(app: &AppHandle) -> bool {
    let mut guard = LOCAL_PROC.lock().unwrap();
    if local_up() {
        return true;
    }
    let (Some(dir), bin) = (off_dir(app), server_bin()) else { return false };
    if !bin.is_file() {
        return false;
    }
    let _ = std::fs::create_dir_all(&dir);
    if let Some(mut c) = guard.take() {
        let _ = c.kill();
    }
    let mut cmd = std::process::Command::new(&bin);
    cmd.current_dir(&dir)
        .env("STREYN_OFFLINE", "1")
        .env("STREYN_KEY", off_key(app))
        .env("HOST", "127.0.0.1")
        .env("PORT", "8485")
        .env("DATA_DIR", dir.join("data"))
        .env("MUSIC_DIRS", dir.join("music"))
        .env("SCAN_INTERVAL", "0")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(child) = cmd.spawn() else { return false };
    // the server ends together with this app, even after a crash
    #[cfg(windows)]
    win::tie_to_app(&child);
    *guard = Some(child);
    for _ in 0..40 {
        if local_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}
fn local_call(app: &AppHandle, method: &str, path: &str, body: &str) -> String {
    if !path.starts_with("/api/offline/") {
        return String::new();
    }
    // Nothing downloaded yet: answer without starting the offline server. Only a download
    // (POST /api/offline/add) starts it.
    if !has_offline(app) && !(method == "POST" && path == "/api/offline/add") {
        return if path == "/api/offline/status" { r#"{"sets":[]}"#.into() } else { String::new() };
    }
    if !ensure_local(app) {
        return String::new();
    }
    let req = ureq::request(method, &format!("{LOCAL}{path}")).set("x-musik-key", &off_key(app)).timeout(Duration::from_secs(15));
    let res = if body.is_empty() { req.call() } else { req.set("Content-Type", "application/json").send_string(body) };
    match res {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r.into_string().unwrap_or_default(),
        Err(_) => String::new(),
    }
}
fn open_local(app: AppHandle, win: WebviewWindow) {
    std::thread::spawn(move || {
        if ensure_local(&app) {
            open_server(&win, LOCAL);
        } else {
            let _ = win.eval("window.showError && window.showError('offline')");
        }
    });
}
/// Home address, then the address for on the go, then the playlists kept on this computer.
fn open_best(app: AppHandle, win: WebviewWindow) {
    let cfg = load_config(&app);
    let Some(server) = cfg.server.clone() else {
        if has_offline(&app) {
            return open_local(app, win);
        }
        return;
    };
    std::thread::spawn(move || {
        let (state, remote) = probe(&server, 3);
        if state == "ok" {
            if remote.is_some() && remote != cfg.remote {
                save_config(&app, &Config { server: Some(server.clone()), remote, ..load_config(&app) });
            }
            open_server(&win, &server);
        } else if let Some(r) = cfg.remote.as_deref().filter(|r| check(r) == "ok") {
            open_server(&win, r);
        } else if has_offline(&app) {
            open_local(app, win);
        } else {
            let _ = win.eval("window.showError && window.showError('offline')");
        }
    });
}

#[tauri::command]
fn use_offline(app: AppHandle, window: WebviewWindow) {
    open_local(app, window);
}

/// The "Offline" button on the connect page only shows when something was downloaded.
#[tauri::command]
fn can_offline(app: AppHandle) -> bool {
    has_offline(&app)
}

fn query_param(url: &Url, key: &str) -> String {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.to_string()).unwrap_or_default()
}

fn home_url() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    }
}

fn main() {
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.iter().any(|a| a == "--uninstall") {
            win::uninstall(args.iter().any(|a| a.eq_ignore_ascii_case("/S")));
            return;
        }
        win::clean_leftovers();
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![connect, saved_server, self_update, open_saved, use_offline, can_offline])
        .setup(|app| {
            // folders like Spotify's, files of earlier versions moved over before anything reads them
            dirs::init(app.handle());
            let handle = app.handle().clone();
            // Available on every page, also on the server's web app: switch back to the connect page.
            let init = format!(
                "window.musikDesktop = {{ version: {:?}, frameless: true, changeServer: function () {{ location.href = {:?} + '?change=1'; }}, update: function () {{ location.href = {:?} + '?update=1'; }}, win: function (a) {{ location.href = 'musik-win://' + a; }}, offlineCall: {}, openFolder: function () {{ location.href = 'musik-win://folder'; return true; }}, goOnline: function () {{ location.href = 'musik-win://goonline'; }}, discord: function (j) {{ location.href = 'musik-win://discord?d=' + encodeURIComponent(j); }} }};",
                app.package_info().version.to_string(),
                home_url(),
                home_url(),
                if server_bin().is_file() {
                    "function (m, p, b, id) { location.href = 'musik-win://offline?m=' + encodeURIComponent(m) + '&p=' + encodeURIComponent(p) + '&b=' + encodeURIComponent(b || '') + '&cb=' + id; }"
                } else {
                    "null"
                }
            );
            let wh = app.handle().clone();
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
            if let Some(b) = dirs::get().browser.clone() {
                // %LOCALAPPDATA%\Streyn\Browser, like Spotify's Browser folder
                builder = builder.data_directory(b);
            }
            let win = builder
                .title("Streyn")
                .inner_size(1280.0, 820.0)
                .min_inner_size(380.0, 560.0)
                // dark from the first frame, no white flash before the page has loaded
                .theme(Some(tauri::Theme::Dark))
                .background_color(tauri::window::Color(17, 18, 20, 255))
                // own dark title bar like Spotify, drawn by the web app (window.musikDesktop.win)
                .decorations(false)
                // the Spotify sign-in belongs in the real browser, Streyn waits for it
                .on_navigation(move |url| {
                    // window buttons of the web app's own title bar
                    if url.scheme() == "musik-win" {
                        if let Some(w) = wh.get_webview_window("main") {
                            match url.host_str().unwrap_or("") {
                                "min" => { let _ = w.minimize(); }
                                "max" => {
                                    if w.is_maximized().unwrap_or(false) { let _ = w.unmaximize(); } else { let _ = w.maximize(); }
                                }
                                "close" => { let _ = w.close(); }
                                "drag" => { let _ = w.start_dragging(); }
                                "offline" => {
                                    let (m, p, b, cb) = (query_param(url, "m"), query_param(url, "p"), query_param(url, "b"), query_param(url, "cb"));
                                    let cb: u64 = cb.parse().unwrap_or(0);
                                    let app = wh.clone();
                                    std::thread::spawn(move || {
                                        let out = local_call(&app, &m, &p, &b);
                                        if let Some(w) = app.get_webview_window("main") {
                                            let _ = w.eval(&format!("window.__musikOff && window.__musikOff({cb}, {})", serde_json::to_string(&out).unwrap_or_else(|_| "\"\"".into())));
                                        }
                                    });
                                }
                                "folder" => open_off_folder(&wh),
                                "goonline" => open_best(wh.clone(), w.clone()),
                                "discord" => {
                                    let d = query_param(url, "d");
                                    std::thread::spawn(move || discord::update(&d));
                                }
                                _ => {}
                            }
                        }
                        return false;
                    }
                    if url.host_str() == Some("accounts.spotify.com") {
                        open_browser(url.as_str());
                        return false;
                    }
                    true
                })
                .initialization_script(&init)
                .build()?;
            if load_config(&handle).server.is_some() || has_offline(&handle) {
                open_best(handle, win);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Streyn")
        .run(|_, ev| {
            // the offline server ends with the app
            if let tauri::RunEvent::Exit = ev {
                if let Some(mut c) = LOCAL_PROC.lock().unwrap().take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        });
}
