//! Plays YouTube songs the way the Msik bot does: yt-dlp finds the audio stream of the video and
//! the server passes it on to the app (with seeking). Nothing is stored, every play streams.
//!
//! yt-dlp is looked for in YTDLP_PATH, <data>/bin and the PATH, and downloaded from its GitHub
//! releases when missing. YouTube needs a JavaScript runtime for its player code: deno, node or bun
//! from the PATH, otherwise deno is downloaded next to yt-dlp. Both are kept up to date.
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

struct Bins {
    ytdlp: Option<PathBuf>,
    js: Option<String>,
}
static BINS: OnceLock<Mutex<Bins>> = OnceLock::new();
static READY: OnceLock<()> = OnceLock::new();

#[derive(Clone)]
pub struct Stream {
    pub url: String,
    pub headers: Vec<(String, String)>,
    until: Instant,
}
static STREAMS: OnceLock<Mutex<HashMap<String, Stream>>> = OnceLock::new();

fn bins() -> &'static Mutex<Bins> {
    BINS.get_or_init(|| Mutex::new(Bins { ytdlp: None, js: None }))
}

fn on_path(cmd: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ""] } else { &[""] };
    std::env::var_os("PATH").and_then(|p| {
        std::env::split_paths(&p).find_map(|d| exts.iter().map(|e| d.join(format!("{cmd}{e}"))).find(|f| f.is_file()))
    })
}

fn download(url: &str, to: &Path) -> Result<(), String> {
    let res = ureq::get(url).timeout(Duration::from_secs(300)).call().map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    res.into_reader().take(400 << 20).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if let Some(d) = to.parent() {
        std::fs::create_dir_all(d).ok();
    }
    let tmp = to.with_extension("part");
    std::fs::write(&tmp, &buf).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, to).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(to, std::fs::Permissions::from_mode(0o755)).ok();
    }
    Ok(())
}

fn ytdlp_asset() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else if cfg!(target_arch = "aarch64") {
        "yt-dlp_linux_aarch64"
    } else {
        "yt-dlp_linux"
    }
}

fn deno_asset() -> Option<&'static str> {
    if cfg!(windows) {
        Some("deno-x86_64-pc-windows-msvc.zip")
    } else if cfg!(target_os = "macos") {
        Some(if cfg!(target_arch = "aarch64") { "deno-aarch64-apple-darwin.zip" } else { "deno-x86_64-apple-darwin.zip" })
    } else if cfg!(target_arch = "aarch64") {
        Some("deno-aarch64-unknown-linux-gnu.zip")
    } else if cfg!(target_arch = "x86_64") {
        Some("deno-x86_64-unknown-linux-gnu.zip")
    } else {
        None
    }
}

fn unzip_one(zip: &Path, name: &str, to: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip).map_err(|e| e.to_string())?;
    let mut a = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    let mut e = a.by_name(name).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    e.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    std::fs::write(to, buf).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(to, std::fs::Permissions::from_mode(0o755)).ok();
    }
    Ok(())
}

/// Finds or fetches yt-dlp and a JavaScript runtime in the background; playback waits for it.
pub fn init(data_dir: &Path) {
    let bin = data_dir.join("bin");
    std::thread::spawn(move || {
        let exe = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
        let local = bin.join(exe);
        let ytdlp = std::env::var_os("YTDLP_PATH")
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .or_else(|| local.is_file().then(|| local.clone()))
            .or_else(|| on_path("yt-dlp"))
            .or_else(|| {
                println!("Downloading yt-dlp ...");
                let url = format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}", ytdlp_asset());
                match download(&url, &local) {
                    Ok(()) => Some(local.clone()),
                    Err(e) => {
                        eprintln!("yt-dlp download failed: {e}");
                        None
                    }
                }
            });
        // keep it current, YouTube changes often (only our own copy, a system one is the system's)
        if let Some(y) = &ytdlp {
            if *y == local {
                Command::new(y).arg("-U").stdout(Stdio::null()).stderr(Stdio::null()).status().ok();
            }
        }
        let deno_local = bin.join(if cfg!(windows) { "deno.exe" } else { "deno" });
        let js = if deno_local.is_file() {
            Some(format!("deno:{}", deno_local.display()))
        } else if let Some(p) = on_path("deno") {
            Some(format!("deno:{}", p.display()))
        } else if let Some(p) = on_path("node") {
            Some(format!("node:{}", p.display()))
        } else if let Some(p) = on_path("bun") {
            Some(format!("bun:{}", p.display()))
        } else if let Some(asset) = deno_asset() {
            println!("Downloading deno for yt-dlp ...");
            let zip = bin.join("deno.zip");
            let ok = download(&format!("https://github.com/denoland/deno/releases/latest/download/{asset}"), &zip)
                .and_then(|_| unzip_one(&zip, if cfg!(windows) { "deno.exe" } else { "deno" }, &deno_local));
            std::fs::remove_file(&zip).ok();
            match ok {
                Ok(()) => Some(format!("deno:{}", deno_local.display())),
                Err(e) => {
                    eprintln!("deno download failed: {e}");
                    None
                }
            }
        } else {
            None
        };
        if let Some(y) = &ytdlp {
            println!("yt-dlp: {}{}", y.display(), js.as_ref().map(|j| format!(" (with {j})")).unwrap_or_default());
        }
        let mut b = bins().lock().unwrap();
        b.ytdlp = ytdlp;
        b.js = js;
        drop(b);
        READY.set(()).ok();
    });
}

pub fn available() -> bool {
    bins().lock().unwrap().ytdlp.is_some() || READY.get().is_none()
}

fn wait_ready() {
    let t = Instant::now();
    while READY.get().is_none() && t.elapsed() < Duration::from_secs(240) {
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn run(args: &[&str], js: Option<&str>, timeout: Duration) -> Result<String, String> {
    let ytdlp = bins().lock().unwrap().ytdlp.clone().ok_or("no_ytdlp")?;
    let mut c = Command::new(ytdlp);
    c.args(["--no-warnings", "--ignore-config"]);
    if let Some(j) = js {
        c.args(["--js-runtimes", j]);
    }
    c.args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let ro = std::thread::spawn(move || {
        let mut s = String::new();
        out.read_to_string(&mut s).ok();
        s
    });
    let re = std::thread::spawn(move || {
        let mut s = String::new();
        err.read_to_string(&mut s).ok();
        s
    });
    let start = Instant::now();
    loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            let o = ro.join().unwrap_or_default();
            let e = re.join().unwrap_or_default();
            return if st.success() { Ok(o) } else { Err(e.lines().find(|l| l.contains("ERROR")).unwrap_or("yt-dlp failed").to_string()) };
        }
        if start.elapsed() > timeout {
            child.kill().ok();
            return Err("yt-dlp timeout".into());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// When a googlevideo link stops working (from its "expire" value, at most 5 hours)
fn expires(url: &str) -> Instant {
    let hard = url
        .split(['?', '&', '/'])
        .find_map(|p| p.strip_prefix("expire=").or_else(|| p.strip_prefix("expire/")))
        .and_then(|v| v.parse::<u64>().ok())
        .and_then(|e| {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            Some(Duration::from_secs(e.saturating_sub(now).saturating_sub(300)))
        })
        .unwrap_or(Duration::from_secs(3600));
    Instant::now() + hard.min(Duration::from_secs(5 * 3600))
}

/// The audio stream of a video (cached until the link expires).
pub fn stream(vid: &str) -> Result<Stream, String> {
    let cache = STREAMS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(s) = cache.lock().unwrap().get(vid) {
        if s.until > Instant::now() {
            return Ok(s.clone());
        }
    }
    wait_ready();
    let url = format!("https://www.youtube.com/watch?v={vid}");
    // m4a first: every player (browser, WebView, Android, Safari) can play it
    let args = ["-j", "--no-playlist", "-f", "bestaudio[ext=m4a]/bestaudio/best", url.as_str()];
    let js = bins().lock().unwrap().js.clone();
    let out = match run(&args, js.as_deref(), Duration::from_secs(30)) {
        Ok(o) => o,
        // like the bot: the other way round if the first way fails
        Err(e) if js.is_some() => run(&args, None, Duration::from_secs(30)).map_err(|_| e)?,
        Err(e) => return Err(e),
    };
    let info: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let u = info["url"].as_str().ok_or("no stream url")?.to_string();
    let headers = info["http_headers"]
        .as_object()
        .map(|h| h.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
        .unwrap_or_default();
    let s = Stream { until: expires(&u), url: u, headers };
    let mut c = cache.lock().unwrap();
    if c.len() > 300 {
        let now = Instant::now();
        c.retain(|_, v| v.until > now);
    }
    c.insert(vid.to_string(), s.clone());
    Ok(s)
}

pub fn forget(vid: &str) {
    if let Some(c) = STREAMS.get() {
        c.lock().unwrap().remove(vid);
    }
}

/// Looks up the stream ahead of time (next songs), errors are ignored.
pub fn prefetch(vid: String) {
    std::thread::spawn(move || {
        stream(&vid).ok();
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_expiry() {
        let soon = super::expires("https://r1.googlevideo.com/videoplayback?expire=1&x=1");
        assert!(soon <= std::time::Instant::now() + std::time::Duration::from_secs(1));
        let later = super::expires("https://r1.googlevideo.com/videoplayback?x=1");
        assert!(later > std::time::Instant::now() + std::time::Duration::from_secs(3000));
    }
}
