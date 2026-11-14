//! Discord Rich Presence over Discord's local IPC (named pipe on Windows, unix socket on Linux).
//! Shows the song that plays ("Listening to Musik") with a button to the download page.
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::Mutex;

#[cfg(windows)]
type Pipe = std::fs::File;
#[cfg(unix)]
type Pipe = std::os::unix::net::UnixStream;

struct Conn {
    pipe: Pipe,
    client: String,
}

static CONN: Mutex<Option<Conn>> = Mutex::new(None);

#[cfg(windows)]
fn open_pipe() -> Option<Pipe> {
    (0..10).find_map(|i| std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\discord-ipc-{i}")).ok())
}
#[cfg(unix)]
fn open_pipe() -> Option<Pipe> {
    let mut bases = vec![];
    for k in ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"] {
        if let Ok(v) = std::env::var(k) {
            bases.push(v);
        }
    }
    bases.push("/tmp".into());
    for b in bases {
        for sub in ["", "app/com.discordapp.Discord/", "snap.discord/", ".flatpak/dev.vencord.Vesktop/xdg-run/"] {
            for i in 0..10 {
                if let Ok(s) = std::os::unix::net::UnixStream::connect(format!("{b}/{sub}discord-ipc-{i}")) {
                    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(3)));
                    return Some(s);
                }
            }
        }
    }
    None
}

fn send(p: &mut Pipe, op: u32, body: &Value) -> std::io::Result<Value> {
    let data = body.to_string().into_bytes();
    let mut frame = Vec::with_capacity(8 + data.len());
    frame.extend_from_slice(&op.to_le_bytes());
    frame.extend_from_slice(&(data.len() as u32).to_le_bytes());
    frame.extend_from_slice(&data);
    p.write_all(&frame)?;
    p.flush()?;
    let mut head = [0u8; 8];
    p.read_exact(&mut head)?;
    let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
    let mut buf = vec![0u8; len.min(1 << 20)];
    p.read_exact(&mut buf)?;
    Ok(serde_json::from_slice(&buf).unwrap_or(Value::Null))
}

fn connect(client: &str) -> Option<Conn> {
    let mut pipe = open_pipe()?;
    let r = send(&mut pipe, 0, &json!({ "v": 1, "client_id": client })).ok()?;
    if r["evt"] != "READY" {
        return None;
    }
    Some(Conn { pipe, client: client.to_string() })
}

/// `msg`: { client, clear } or { client, title, artist, album, cover, start, end, url, label }.
pub fn update(msg: &str) {
    let m: Value = serde_json::from_str(msg).unwrap_or(Value::Null);
    let client = m["client"].as_str().unwrap_or("").trim().to_string();
    let mut g = CONN.lock().unwrap();
    if client.is_empty() || !client.chars().all(|c| c.is_ascii_digit()) {
        *g = None;
        return;
    }
    if g.as_ref().map(|c| c.client != client).unwrap_or(true) {
        *g = connect(&client);
    }
    let activity = if m["clear"].as_bool().unwrap_or(false) {
        Value::Null
    } else {
        let cut = |s: &str, n: usize| -> String {
            let t: String = s.chars().take(n).collect();
            if t.chars().count() < 2 { format!("{t}  ") } else { t }
        };
        let mut a = json!({
            "type": 2,
            "details": cut(m["title"].as_str().unwrap_or("Musik"), 128),
            "state": cut(m["artist"].as_str().unwrap_or(""), 128),
            "assets": { "large_image": m["cover"].as_str().filter(|u| u.starts_with("https://")).unwrap_or("musik"), "large_text": cut(m["album"].as_str().unwrap_or("Musik"), 128) },
            "buttons": [{ "label": cut(m["label"].as_str().unwrap_or("Download Musik"), 32), "url": m["url"].as_str().unwrap_or("https://musik.labtoso.de") }]
        });
        if let (Some(s), Some(e)) = (m["start"].as_i64(), m["end"].as_i64()) {
            a["timestamps"] = json!({ "start": s, "end": e });
        }
        a
    };
    let body = json!({ "cmd": "SET_ACTIVITY", "args": { "pid": std::process::id(), "activity": activity }, "nonce": format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)) });
    let ok = match g.as_mut() {
        Some(c) => send(&mut c.pipe, 1, &body).is_ok(),
        None => false,
    };
    if !ok {
        // Discord was restarted: connect again once
        *g = connect(&client);
        if let Some(c) = g.as_mut() {
            if send(&mut c.pipe, 1, &body).is_err() {
                *g = None;
            }
        }
    }
}
