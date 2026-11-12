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

fn home_url() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![connect, saved_server])
        .setup(|app| {
            let handle = app.handle().clone();
            // Available on every page, also on the server's web app: switch back to the connect page.
            let init = format!(
                "window.musikDesktop = {{ changeServer: function () {{ location.href = {:?} + '?change=1'; }} }};",
                home_url()
            );
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Musik")
                .inner_size(1280.0, 820.0)
                .min_inner_size(380.0, 560.0)
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
