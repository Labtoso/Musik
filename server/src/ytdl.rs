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
static TMP: OnceLock<PathBuf> = OnceLock::new();

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
    if let Some(d) = to.parent() {
        std::fs::create_dir_all(d).ok();
    }
    // straight to disk, the server may have little memory
    let tmp = to.with_extension("part");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    std::io::copy(&mut res.into_reader().take(400 << 20), &mut f).map_err(|e| e.to_string())?;
    drop(f);
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
    let mut f = std::fs::File::create(to).map_err(|e| e.to_string())?;
    std::io::copy(&mut e, &mut f).map_err(|e| e.to_string())?;
    drop(f);
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
    let tmp = bin.join("tmp");
    std::fs::create_dir_all(&tmp).ok();
    TMP.set(tmp).ok();
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
                Command::new(y).arg("-U").env("TMPDIR", bin.join("tmp")).stdout(Stdio::null()).stderr(Stdio::null()).status().ok();
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

/// The server can stream on its own (the light way needs nothing installed)
pub fn available() -> bool {
    true
}

/// What works right now, for the check in the settings
pub fn diagnose(vid: &str) -> serde_json::Value {
    let t = Instant::now();
    let d = direct(vid);
    let direct_ms = t.elapsed().as_millis() as u64;
    let opens = d.as_ref().ok().map(|s| {
        let mut req = ureq::get(&s.url).set("range", "bytes=0-1023").timeout(Duration::from_secs(10));
        for (k, v) in &s.headers {
            req = req.set(k, v);
        }
        req.call().map(|r| r.status() < 300).unwrap_or(false)
    });
    let b = bins().lock().unwrap();
    serde_json::json!({
        "direct": d.is_ok(), "direct_error": d.err(), "direct_ms": direct_ms, "opens": opens,
        "ytdlp": b.ytdlp.as_ref().map(|p| p.display().to_string()), "js": b.js, "ytdlp_ready": READY.get().is_some(),
    })
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
    if let Some(t) = TMP.get() {
        c.env("TMPDIR", t).env("TEMP", t).env("TMP", t);
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

/// Apps of YouTube whose answers carry ready stream links (no player code to solve, so no yt-dlp,
/// no extra processes and almost no memory). Tried in this order.
const CLIENTS: &[(&str, &str, &str, &str, &str)] = &[
    // name, version, id header, user agent, extra context (JSON object body)
    (
        "ANDROID_VR",
        "1.60.19",
        "28",
        "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
        r#"{"deviceMake":"Oculus","deviceModel":"Quest 3","androidSdkVersion":32,"osName":"Android","osVersion":"12L"}"#,
    ),
    (
        "IOS",
        "20.10.4",
        "5",
        "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
        r#"{"deviceMake":"Apple","deviceModel":"iPhone16,2","osName":"iPhone","osVersion":"18.3.2.22D82"}"#,
    ),
];

/// Picks the audio format every player can play: m4a (itag 140) first, then the best other audio.
pub fn pick_audio(player: &serde_json::Value) -> Option<String> {
    let fmts = player["streamingData"]["adaptiveFormats"].as_array()?;
    let audio: Vec<&serde_json::Value> = fmts
        .iter()
        .filter(|f| f["mimeType"].as_str().map(|m| m.starts_with("audio/")).unwrap_or(false) && f["url"].is_string())
        // dubbed tracks are marked, the original has no track or is the default one
        .filter(|f| f["audioTrack"].is_null() || f["audioTrack"]["audioIsDefault"].as_bool().unwrap_or(true))
        .collect();
    audio
        .iter()
        .filter(|f| f["mimeType"].as_str().unwrap_or("").starts_with("audio/mp4"))
        .max_by_key(|f| f["bitrate"].as_i64().unwrap_or(0))
        .or_else(|| audio.iter().max_by_key(|f| f["bitrate"].as_i64().unwrap_or(0)))
        .and_then(|f| f["url"].as_str().map(String::from))
}

fn direct(vid: &str) -> Result<Stream, String> {
    let mut last = String::new();
    for (name, version, id, ua, extra) in CLIENTS {
        let mut client: serde_json::Value = serde_json::from_str(extra).unwrap_or_else(|_| serde_json::json!({}));
        client["clientName"] = (*name).into();
        client["clientVersion"] = (*version).into();
        client["hl"] = "en".into();
        client["gl"] = "DE".into();
        let body = serde_json::json!({ "context": { "client": client }, "videoId": vid, "contentCheckOk": true, "racyCheckOk": true });
        let res = ureq::post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
            .set("content-type", "application/json")
            .set("user-agent", ua)
            .set("x-youtube-client-name", id)
            .set("x-youtube-client-version", version)
            .set("origin", "https://www.youtube.com")
            .timeout(Duration::from_secs(8))
            .send_json(body);
        let json: serde_json::Value = match res.map_err(|e| e.to_string()).and_then(|r| r.into_json().map_err(|e| e.to_string())) {
            Ok(j) => j,
            Err(e) => {
                last = format!("{last}{name}: {e}; ");
                continue;
            }
        };
        match pick_audio(&json) {
            Some(url) => {
                return Ok(Stream { until: expires(&url), url, headers: vec![("User-Agent".into(), ua.to_string())] });
            }
            None => last = format!("{last}{name}: {}; ", json["playabilityStatus"]["reason"].as_str().or(json["playabilityStatus"]["status"].as_str()).unwrap_or("no audio")),
        }
    }
    Err(last)
}

/// Only one yt-dlp at a time: each run needs a lot of memory on a small server.
static YTDLP_LOCK: Mutex<()> = Mutex::new(());

fn via_ytdlp(vid: &str) -> Result<Stream, String> {
    wait_ready();
    let _one = YTDLP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let url = format!("https://www.youtube.com/watch?v={vid}");
    // m4a first: every player (browser, WebView, Android, Safari) can play it
    let args = ["-j", "--no-playlist", "-f", "bestaudio[ext=m4a]/bestaudio/best", url.as_str()];
    let js = bins().lock().unwrap().js.clone();
    let out = match run(&args, js.as_deref(), Duration::from_secs(40)) {
        Ok(o) => o,
        Err(e) if js.is_some() => run(&args, None, Duration::from_secs(40)).map_err(|_| e)?,
        Err(e) => return Err(e),
    };
    let info: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let u = info["url"].as_str().ok_or("no stream url")?.to_string();
    let headers = info["http_headers"]
        .as_object()
        .map(|h| h.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
        .unwrap_or_default();
    Ok(Stream { until: expires(&u), url: u, headers })
}

/// Lookups of the same video wait for each other instead of running twice.
static BUSY: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

/// The audio stream of a video (cached until the link expires). `deep`: skip the light way and
/// ask yt-dlp (after a link from the light way did not play).
pub fn stream_with(vid: &str, deep: bool) -> Result<Stream, String> {
    let cache = STREAMS.get_or_init(|| Mutex::new(HashMap::new()));
    let busy = BUSY.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
    let t = Instant::now();
    loop {
        if !deep {
            if let Some(s) = cache.lock().unwrap().get(vid) {
                if s.until > Instant::now() {
                    return Ok(s.clone());
                }
            }
        }
        if busy.lock().unwrap().insert(vid.to_string()) || t.elapsed() > Duration::from_secs(60) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let r = if deep { via_ytdlp(vid) } else { direct(vid).or_else(|e| via_ytdlp(vid).map_err(|e2| format!("{e}; yt-dlp: {e2}"))) };
    busy.lock().unwrap().remove(vid);
    let s = r?;
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

/// The first part of a song that comes next, already fetched: a skip starts playing at once.
pub struct Head {
    pub total: u64,
    pub ctype: String,
    pub bytes: Vec<u8>,
    at: Instant,
}
static HEADS: OnceLock<Mutex<HashMap<String, std::sync::Arc<Head>>>> = OnceLock::new();
const HEAD_LEN: u64 = 512 * 1024;

pub fn head(vid: &str) -> Option<std::sync::Arc<Head>> {
    let h = HEADS.get()?.lock().unwrap().get(vid).cloned()?;
    (h.at.elapsed() < Duration::from_secs(20 * 60)).then_some(h)
}

fn warm_head(vid: &str, s: &Stream) {
    if head(vid).is_some() {
        return;
    }
    let mut req = ureq::get(&s.url).timeout(Duration::from_secs(15));
    for (k, v) in &s.headers {
        req = req.set(k, v);
    }
    let Ok(r) = req.set("range", &format!("bytes=0-{}", HEAD_LEN - 1)).call() else { return };
    // "bytes 0-524287/3401234": the size of the whole song
    let total = r
        .header("content-range")
        .and_then(|c| c.rsplit('/').next())
        .and_then(|n| n.trim().parse::<u64>().ok())
        .or_else(|| r.header("content-length").and_then(|n| n.parse().ok()));
    let ctype = r.header("content-type").unwrap_or("audio/webm").to_string();
    let Some(total) = total else { return };
    let mut bytes = Vec::with_capacity(HEAD_LEN as usize);
    if r.into_reader().take(HEAD_LEN).read_to_end(&mut bytes).is_err() || bytes.is_empty() {
        return;
    }
    let heads = HEADS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut m = heads.lock().unwrap();
    if m.len() >= 16 {
        if let Some(old) = m.iter().min_by_key(|(_, h)| h.at).map(|(k, _)| k.clone()) {
            m.remove(&old);
        }
    }
    m.insert(vid.to_string(), std::sync::Arc::new(Head { total, ctype, bytes, at: Instant::now() }));
}

/// Looks up the stream ahead of time (next songs) and fetches its beginning, errors are ignored.
pub fn prefetch(vid: String) {
    std::thread::spawn(move || {
        // only the light way ahead of time, yt-dlp is kept for the song that is really played
        let cache = STREAMS.get_or_init(|| Mutex::new(HashMap::new()));
        let known = cache.lock().unwrap().get(&vid).filter(|s| s.until > Instant::now()).cloned();
        let s = match known {
            Some(s) => s,
            None => match direct(&vid) {
                Ok(s) => {
                    cache.lock().unwrap().insert(vid.clone(), s.clone());
                    s
                }
                Err(_) => return,
            },
        };
        warm_head(&vid, &s);
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

    /// Against the real YouTube (not in the normal test run): `cargo test live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_songs_resolve_and_stream() {
        let songs = [
            ("Californication", "Red Hot Chili Peppers", 329.0),
            ("Scar Tissue", "Red Hot Chili Peppers", 215.0),
            ("When I Come Around", "Green Day", 178.0),
            ("Under the Bridge", "Red Hot Chili Peppers", 264.0),
            ("In the End", "Linkin Park", 216.0),
            ("Handwerker", "Mickie Krause, Julian Sommer", 0.0),
        ];
        let mut bad = 0;
        for (title, artist, dur) in songs {
            let first = artist.split(',').next().unwrap().trim();
            let found = crate::yt::music_search(&format!("{first} {title}"));
            let list = match found {
                Ok(l) => l,
                Err(e) => {
                    println!("SEARCH FAILED {title}: {e}");
                    bad += 1;
                    continue;
                }
            };
            println!("{title}: {} songs on YouTube Music", list.len());
            for s in list.iter().take(5) {
                println!("    {} | {} | {} | {}s | {}", s["id"], s["title"], s["artist"], s["duration"], s["album"]);
            }
            let pick = crate::yt::pick_song(&list, title, artist, dur);
            let Some(id) = pick.first() else {
                println!("  NO PICK");
                bad += 1;
                continue;
            };
            let chosen = list.iter().find(|s| s["id"] == id.as_str()).unwrap();
            println!("  PICK {id}: {} by {} ({}s, want {dur}s)", chosen["title"], chosen["artist"], chosen["duration"]);
            match super::direct(id) {
                Ok(s) => {
                    let mut req = ureq::get(&s.url).set("range", "bytes=0-65535");
                    for (k, v) in &s.headers {
                        req = req.set(k, v);
                    }
                    match req.call() {
                        Ok(r) => println!("  STREAM ok: {} {} {:?}", r.status(), r.header("content-type").unwrap_or(""), r.header("content-range")),
                        Err(e) => {
                            println!("  STREAM link refused: {e}");
                            bad += 1;
                        }
                    }
                }
                // data centre addresses (like the test machines) get the robot check: says nothing about a home server
                Err(e) if e.contains("not a bot") => println!("  DIRECT skipped here (robot check for this address): {e}"),
                Err(e) => {
                    println!("  DIRECT failed: {e}");
                    bad += 1;
                }
            }
        }
        assert_eq!(bad, 0, "{bad} problems, see output");
    }
}
