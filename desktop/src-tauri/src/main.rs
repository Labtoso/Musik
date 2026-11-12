// Musik desktop: asks once for the server address, then shows the web app served by the server.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
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
        save_config(&app, &Config { server: Some(origin.clone()), remote });
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
    let res = ureq::get(url).set("User-Agent", "Musik-Desktop").timeout(Duration::from_secs(600)).call().map_err(|_| "offline".to_string())?;
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
        use std::os::windows::process::CommandExt;
        let installer = std::env::temp_dir().join("Musik-update.exe");
        download("https://github.com/Labtoso/Musik/releases/latest/download/Musik.exe", &installer, win)?;
        let exe = std::env::current_exe().map_err(|_| "write".to_string())?;
        // wait until this app has closed, install silently, start the new version
        let cmd = format!(
            "ping -n 3 127.0.0.1 >nul & start \"\" /wait \"{}\" /S & start \"\" \"{}\"",
            installer.display(),
            exe.display()
        );
        std::process::Command::new("cmd").arg("/C").raw_arg(cmd).creation_flags(0x0800_0000).spawn().map_err(|_| "write".to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let target = std::env::var_os("APPIMAGE").map(PathBuf::from).ok_or_else(|| "unsupported".to_string())?;
        let new = target.with_extension("new");
        download("https://github.com/Labtoso/Musik/releases/latest/download/Musik.AppImage", &new, win)?;
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd").arg("/C").raw_arg(format!("start \"\" \"{}\"", url.replace('"', "%22"))).creation_flags(0x0800_0000).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
}

fn home_url() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![connect, saved_server, self_update, open_saved])
        .setup(|app| {
            let handle = app.handle().clone();
            // Available on every page, also on the server's web app: switch back to the connect page.
            let init = format!(
                "window.musikDesktop = {{ version: {:?}, frameless: true, changeServer: function () {{ location.href = {:?} + '?change=1'; }}, update: function () {{ location.href = {:?} + '?update=1'; }}, win: function (a) {{ location.href = 'musik-win://' + a; }} }};",
                app.package_info().version.to_string(),
                home_url(),
                home_url()
            );
            let wh = app.handle().clone();
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Musik")
                .inner_size(1280.0, 820.0)
                .min_inner_size(380.0, 560.0)
                // dark from the first frame, no white flash before the page has loaded
                .theme(Some(tauri::Theme::Dark))
                .background_color(tauri::window::Color(17, 18, 20, 255))
                // own dark title bar like Spotify, drawn by the web app (window.musikDesktop.win)
                .decorations(false)
                // the Spotify sign-in belongs in the real browser, Musik waits for it
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
            let cfg = load_config(&handle);
            if let Some(server) = cfg.server.clone() {
                std::thread::spawn(move || {
                    // at home: the normal address; on the go: the Tailscale address
                    let (state, remote) = probe(&server, 3);
                    if state == "ok" {
                        if remote.is_some() && remote != cfg.remote {
                            save_config(&handle, &Config { server: Some(server.clone()), remote });
                        }
                        open_server(&win, &server);
                    } else if let Some(r) = cfg.remote.as_deref().filter(|r| check(r) == "ok") {
                        open_server(&win, r);
                    } else {
                        let _ = win.eval("window.showError && window.showError('offline')");
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Musik");
}
