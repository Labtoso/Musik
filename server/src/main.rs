mod api;
mod auth;
mod db;
mod ext;
mod library;
mod recommend;
mod spotify;
mod update;

use api::{AppState, VERSION};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Minimal .env loader (KEY=VALUE per line). Real environment variables win.
fn load_env_file(file: &Path) {
    let Ok(text) = std::fs::read_to_string(file) else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            if k.is_empty()
                || !k
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            {
                continue;
            }
            let v = v.trim().trim_matches('"').trim_matches('\'');
            if std::env::var_os(k).is_none() {
                std::env::set_var(k, v);
            }
        }
    }
}

fn main() {
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("musik-server {VERSION}");
        return;
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let base = std::env::current_dir().unwrap_or_else(|_| exe_dir.clone());
    load_env_file(&base.join(".env"));
    load_env_file(&exe_dir.join(".env"));
    if let Ok(f) = std::env::var("MUSIK_ENV") {
        load_env_file(Path::new(&f));
    }
    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let resolve = |p: &str| {
        let p = PathBuf::from(p.trim());
        if p.is_absolute() {
            p
        } else {
            base.join(p)
        }
    };
    let port: u16 = var("PORT").and_then(|p| p.parse().ok()).unwrap_or(8484);
    let host = var("HOST").unwrap_or_else(|| "0.0.0.0".into());
    let data_dir = resolve(&var("DATA_DIR").unwrap_or_else(|| "data".into()));
    let sep: &[char] = if cfg!(windows) {
        &[';', '|']
    } else {
        &[':', '|']
    };
    let music_dirs: Vec<PathBuf> = var("MUSIC_DIRS")
        .map(|s| {
            s.split(sep)
                .filter(|d| !d.trim().is_empty())
                .map(resolve)
                .collect()
        })
        .unwrap_or_else(|| {
            // Default: the user's Music folder if there is one, else data/music.
            let home = std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from);
            match home.map(|h| h.join("Music")).filter(|m| m.is_dir()) {
                Some(m) => vec![m],
                None => vec![data_dir.join("music")],
            }
        });
    let web_dir = var("WEB_DIR")
        .map(|d| resolve(&d))
        .filter(|d| d.join("index.html").is_file());
    let scan_minutes: u64 = var("SCAN_INTERVAL")
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);
    let name = var("SERVER_NAME").unwrap_or_else(|| "Musik".into());
    let remote = var("REMOTE_URL")
        .map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| u.starts_with("http"));

    for d in &music_dirs {
        std::fs::create_dir_all(d).ok();
    }
    let conn = db::open(Some(&data_dir)).expect("cannot open database");
    let state = Arc::new(AppState {
        db: Arc::new(Mutex::new(conn)),
        library: library::Library::new(
            music_dirs,
            Some(data_dir.join("uploads")),
            Some(data_dir.join("covers")),
        ),
        rec: recommend::Recommender::new(None, None),
        web_dir,
        name,
        remote,
    });

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async move {
        let listener = match tokio::net::TcpListener::bind((host.as_str(), port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Cannot listen on {host}:{port}: {e}");
                std::process::exit(1);
            }
        };
        println!("Musik server {VERSION}");
        println!(
            "Music folders: {}",
            state
                .library
                .roots()
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
        println!("Data: {}", data_dir.display());
        let mut addrs = vec![format!("http://localhost:{port}")];
        if let Ok(list) = local_ip_address::list_afinet_netifas() {
            for (_, ip) in list {
                if ip.is_ipv4() && !ip.is_loopback() {
                    addrs.push(format!("http://{ip}:{port}"));
                }
            }
        }
        println!("Open: {}", addrs.join("  "));

        api::start_scan(&state);
        if scan_minutes > 0 {
            let st = state.clone();
            tokio::spawn(async move {
                let mut iv =
                    tokio::time::interval(std::time::Duration::from_secs(scan_minutes * 60));
                iv.tick().await;
                loop {
                    iv.tick().await;
                    api::start_scan(&st);
                }
            });
        }
        let app = api::router(state);
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let ctrl_c = tokio::signal::ctrl_c();
                #[cfg(unix)]
                {
                    let mut term =
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                            .unwrap();
                    tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
                }
                #[cfg(not(unix))]
                ctrl_c.await.ok();
            })
            .await
            .ok();
    });
}
