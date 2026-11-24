//! Podcasts like on Spotify: search, charts and categories from the public Apple Podcasts
//! directory, the episodes from the show's own public RSS feed, the sound streamed through this
//! server (so seeking, the equalizer and the Android player work like with songs). Followed
//! shows and where every episode was left off are kept per user.
use crate::api::{body_json, ApiError, Auth, AuthQ, St, R};
use crate::db::now_ms;
use axum::extract::{Path, Query, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use quick_xml::events::Event;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS pod_shows (
  id INTEGER PRIMARY KEY,
  feed TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pod_subs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id INTEGER NOT NULL,
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, show_id)
);
CREATE TABLE IF NOT EXISTS pod_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id INTEGER NOT NULL,
  ep TEXT NOT NULL,
  pos REAL NOT NULL DEFAULT 0,
  dur REAL NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  updated INTEGER NOT NULL,
  PRIMARY KEY (user_id, show_id, ep)
);
"#;

pub fn routes() -> Router<St> {
    Router::new()
        .route("/podcasts/search", get(search))
        .route("/podcasts/top", get(top))
        .route("/podcasts/show/{id}", get(show))
        .route("/podcasts/episode/{id}/{ep}", get(episode))
        .route("/podcasts/audio/{id}/{ep}", get(audio))
        .route("/podcasts/subs", get(subs))
        .route("/podcasts/subs/{id}", put(subscribe).delete(unsubscribe))
        .route("/podcasts/progress", put(save_progress))
        .route("/podcasts/new", get(new_episodes))
        .route("/podcasts/continue", get(continue_list))
        .route("/podcasts/pulse", get(pulse))
        .route("/podcasts/match", axum::routing::post(match_episodes))
}

// ---------- the feed ----------
#[derive(Clone, Default, Debug)]
pub struct Episode {
    pub id: String,
    pub title: String,
    pub desc: String,
    pub date: i64,
    pub duration: f64,
    pub url: String,
    pub cover: String,
    pub season: i64,
    pub number: i64,
    pub explicit: bool,
    pub kind: String,
    url_id: String,
}
#[derive(Clone, Default, Debug)]
pub struct Show {
    pub title: String,
    pub author: String,
    pub desc: String,
    pub cover: String,
    pub link: String,
    pub genre: String,
    pub episodes: Vec<Episode>,
}

/// Short stable id of an episode: from its guid, else its audio link.
pub fn ep_id(key: &str) -> String {
    let h = Sha256::digest(key.trim().as_bytes());
    hex::encode(&h[..8])
}

fn local(name: &[u8]) -> &[u8] {
    name
}

/// Reads an RSS podcast feed. Lenient: unknown tags are skipped, broken bits are left empty.
#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_feed(xml: &str) -> Show {
    parse_feed_checked(xml).0
}
/// The show and whether the whole document could be read (false: the XML broke off part way).
fn parse_feed_checked(xml: &str) -> (Show, bool) {
    let mut complete = true;
    let mut rd = quick_xml::Reader::from_str(xml);
    rd.config_mut().trim_text(false);
    rd.config_mut().check_end_names = false;
    let mut show = Show::default();
    let mut path: Vec<Vec<u8>> = Vec::new();
    let mut text = String::new();
    let mut ep: Option<Episode> = None;
    let mut guid = String::new();
    let mut summary = String::new();
    let mut ch_summary = String::new();
    let mut img_url = String::new();
    let attr = |e: &quick_xml::events::BytesStart, key: &[u8]| -> String {
        e.attributes()
            .flatten()
            .find(|a| a.key.as_ref() == key)
            .and_then(|a| a.unescape_value().ok().map(|v| v.trim().to_string()))
            .unwrap_or_default()
    };
    loop {
        let ev = match rd.read_event() {
            Ok(e) => e,
            Err(_) => {
                complete = false;
                break;
            }
        };
        match ev {
            Event::Eof => break,
            Event::Start(e) => {
                let name = e.name().as_ref().to_ascii_lowercase();
                handle_attrs(&name, &e, &mut ep, &mut show, &path, &attr);
                if name == b"item" {
                    ep = Some(Episode::default());
                    guid.clear();
                    summary.clear();
                }
                path.push(name);
                text.clear();
            }
            Event::Empty(e) => {
                let name = e.name().as_ref().to_ascii_lowercase();
                handle_attrs(&name, &e, &mut ep, &mut show, &path, &attr);
            }
            Event::Text(t) => {
                if let Ok(s) = t.unescape() {
                    text.push_str(&s);
                } else {
                    text.push_str(&String::from_utf8_lossy(t.as_ref()));
                }
            }
            Event::CData(t) => text.push_str(&String::from_utf8_lossy(t.as_ref())),
            Event::End(_) => {
                let Some(name) = path.pop() else { continue };
                let parent = path.last().map(|p| p.as_slice()).unwrap_or(b"");
                let v = text.trim().to_string();
                text.clear();
                if name == b"item" {
                    if let Some(mut e) = ep.take() {
                        if !e.url.is_empty() {
                            e.url_id = ep_id(&e.url);
                            e.id = if guid.is_empty() { e.url_id.clone() } else { ep_id(&guid) };
                            if e.desc.is_empty() {
                                e.desc = summary.clone();
                            }
                            show.episodes.push(e);
                        }
                    }
                    continue;
                }
                if let Some(e) = ep.as_mut() {
                    if parent != b"item" {
                        continue;
                    }
                    match local(&name) {
                        b"title" if e.title.is_empty() => e.title = v,
                        b"itunes:title" => e.title = v,
                        b"guid" => guid = v,
                        b"pubdate" => e.date = parse_date(&v),
                        b"itunes:duration" => e.duration = parse_duration(&v),
                        b"description" if e.desc.is_empty() || e.desc.len() < v.len() => e.desc = v,
                        b"content:encoded" if v.len() > e.desc.len() => e.desc = v,
                        b"itunes:summary" => summary = v,
                        b"itunes:season" => e.season = v.parse().unwrap_or(0),
                        b"itunes:episode" => e.number = v.parse().unwrap_or(0),
                        b"itunes:explicit" => e.explicit = matches!(v.to_ascii_lowercase().as_str(), "yes" | "true" | "explicit"),
                        b"itunes:episodetype" => e.kind = v.to_ascii_lowercase(),
                        _ => {}
                    }
                } else if parent == b"channel" {
                    match local(&name) {
                        b"title" if show.title.is_empty() => show.title = v,
                        b"itunes:author" => show.author = v,
                        b"description" => show.desc = v,
                        b"itunes:summary" => ch_summary = v,
                        b"link" if show.link.is_empty() => show.link = v,
                        _ => {}
                    }
                } else if parent == b"image" && name == b"url" && path.len() >= 2 {
                    img_url = v;
                }
            }
            _ => {}
        }
    }
    if show.desc.is_empty() {
        show.desc = ch_summary;
    }
    if show.cover.is_empty() {
        show.cover = img_url;
    }
    show.desc = html_to_text(&show.desc);
    show.title = html_to_text(&show.title);
    show.author = html_to_text(&show.author);
    for e in &mut show.episodes {
        e.desc = html_to_text(&e.desc);
        e.title = html_to_text(&e.title);
        if e.cover.is_empty() {
            e.cover = show.cover.clone();
        }
    }
    // newest first, like Spotify
    show.episodes.sort_by(|a, b| b.date.cmp(&a.date));
    (show, complete)
}

fn handle_attrs(
    name: &[u8],
    e: &quick_xml::events::BytesStart,
    ep: &mut Option<Episode>,
    show: &mut Show,
    path: &[Vec<u8>],
    attr: &dyn Fn(&quick_xml::events::BytesStart, &[u8]) -> String,
) {
    let parent = path.last().map(|p| p.as_slice()).unwrap_or(b"");
    if let Some(ep) = ep.as_mut() {
        if parent != b"item" {
            return;
        }
        match name {
            b"enclosure" => {
                let u = attr(e, b"url");
                let ty = attr(e, b"type").to_ascii_lowercase();
                // the sound, not a picture or a PDF that some feeds attach as well
                if ep.url.is_empty() && (ty.is_empty() || ty.starts_with("audio") || ty.starts_with("video")) && (u.starts_with("http://") || u.starts_with("https://")) {
                    ep.url = u;
                }
            }
            b"itunes:image" => ep.cover = attr(e, b"href"),
            _ => {}
        }
    } else if parent == b"channel" {
        match name {
            b"itunes:image" => show.cover = attr(e, b"href"),
            b"itunes:category" if show.genre.is_empty() => show.genre = attr(e, b"text"),
            _ => {}
        }
    }
}

/// "Tue, 18 Nov 2026 10:00:00 +0000" (RFC 2822, as RSS has it) → ms since 1970. 0 when unreadable.
pub fn parse_date(s: &str) -> i64 {
    let s = s.trim();
    let s = s.split_once(',').map(|x| x.1).unwrap_or(s).trim();
    let p: Vec<&str> = s.split_whitespace().collect();
    if p.len() < 3 {
        // ISO dates appear in some feeds too
        return parse_iso(s);
    }
    let day: i64 = p[0].parse().unwrap_or(0);
    let mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        .iter()
        .position(|m| p[1].to_ascii_lowercase().starts_with(m))
        .map(|i| i as i64 + 1);
    let Some(mon) = mon else { return parse_iso(s) };
    let mut year: i64 = p[2].parse().unwrap_or(0);
    if year < 100 {
        year += 2000;
    }
    let (mut h, mut mi, mut se) = (0, 0, 0);
    if let Some(t) = p.get(3) {
        let v: Vec<i64> = t.split(':').map(|x| x.parse().unwrap_or(0)).collect();
        h = *v.first().unwrap_or(&0);
        mi = *v.get(1).unwrap_or(&0);
        se = *v.get(2).unwrap_or(&0);
    }
    let off = p.get(4).map(|z| zone_minutes(z)).unwrap_or(0);
    if day == 0 || year == 0 {
        return 0;
    }
    (days_from_civil(year, mon, day) * 86400 + h * 3600 + mi * 60 + se - off * 60) * 1000
}
fn zone_minutes(z: &str) -> i64 {
    let z = z.trim();
    if let Some(sign) = z.chars().next().filter(|c| *c == '+' || *c == '-') {
        let d: String = z[1..].chars().filter(|c| c.is_ascii_digit()).collect();
        if d.len() >= 4 {
            let v = d[..2].parse::<i64>().unwrap_or(0) * 60 + d[2..4].parse::<i64>().unwrap_or(0);
            return if sign == '-' { -v } else { v };
        }
        return 0;
    }
    match z.to_ascii_uppercase().as_str() {
        "EST" => -300,
        "EDT" => -240,
        "CST" => -360,
        "CDT" => -300,
        "MST" => -420,
        "MDT" => -360,
        "PST" => -480,
        "PDT" => -420,
        "CET" => 60,
        "CEST" => 120,
        _ => 0,
    }
}
/// "2026-11-18T10:00:00Z" → ms
pub fn parse_iso(s: &str) -> i64 {
    let s = s.trim();
    if s.len() < 10 {
        return 0;
    }
    let y: i64 = s.get(0..4).and_then(|x| x.parse().ok()).unwrap_or(0);
    let m: i64 = s.get(5..7).and_then(|x| x.parse().ok()).unwrap_or(0);
    let d: i64 = s.get(8..10).and_then(|x| x.parse().ok()).unwrap_or(0);
    if y == 0 || m == 0 || d == 0 {
        return 0;
    }
    let t = s.get(11..19).unwrap_or("00:00:00");
    let v: Vec<i64> = t.split(':').map(|x| x.parse().unwrap_or(0)).collect();
    // UTC offset after the time ("+02:00", "-0500"; "Z" or none = UTC), fractions skipped
    let offset_min = s
        .get(19..)
        .map(|rest| rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit()))
        .and_then(|z| {
            let sign = match z.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits: String = z[1..].chars().filter(|c| c.is_ascii_digit()).take(4).collect();
            let h: i64 = digits.get(0..2)?.parse().ok()?;
            let m: i64 = digits.get(2..4).and_then(|x| x.parse().ok()).unwrap_or(0);
            Some(sign * (h * 60 + m))
        })
        .unwrap_or(0);
    (days_from_civil(y, m, d) * 86400 + v.first().unwrap_or(&0) * 3600 + v.get(1).unwrap_or(&0) * 60 + v.get(2).unwrap_or(&0) - offset_min * 60) * 1000
}
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
/// "1:02:03", "62:03", "3723" or "3723.4" → seconds
pub fn parse_duration(s: &str) -> f64 {
    let s = s.trim();
    if s.is_empty() {
        return 0.0;
    }
    s.split(':').fold(0.0, |acc, p| acc * 60.0 + p.trim().parse::<f64>().unwrap_or(0.0))
}

/// Descriptions come as HTML: plain text with the paragraphs kept, never markup for the page.
pub fn html_to_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '<' {
            let rest = &s[i..];
            // a "<" that is never closed is plain text, and so is everything after it
            // (searching again for every following "<" would take quadratic time)
            let Some(end) = rest.find('>') else {
                out.push_str(rest);
                break;
            };
            let tag = rest[1..end].trim().to_ascii_lowercase();
            let tname: String = tag.trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            if matches!(tname.as_str(), "br" | "p" | "div" | "li" | "h1" | "h2" | "h3" | "h4" | "tr" | "ul" | "ol") {
                out.push('\n');
                if tname == "li" && !tag.starts_with('/') {
                    out.push_str("• ");
                }
            }
            // skip the tag
            let stop = i + end;
            while let Some(&(j, _)) = chars.peek() {
                if j > stop {
                    break;
                }
                chars.next();
            }
            continue;
        }
        out.push(c);
    }
    let out = decode_entities(&out);
    // no more than one empty line, no spaces at line ends
    let mut clean = String::new();
    let mut blank = 0;
    for line in out.lines() {
        let l = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if l.is_empty() {
            blank += 1;
            if blank == 1 && !clean.is_empty() {
                clean.push('\n');
            }
            continue;
        }
        if !clean.is_empty() && blank == 0 {
            clean.push('\n');
        } else if !clean.is_empty() && !clean.ends_with("\n\n") {
            clean.push('\n');
        }
        blank = 0;
        clean.push_str(&l);
    }
    clean.trim().to_string()
}
pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        // look for ";" in the first bytes only; it is ASCII, so slicing there is safe
        if let Some(j) = tail.as_bytes().iter().take(12).position(|&b| b == b';') {
            let ent = &tail[1..j];
            let rep = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                "ndash" => Some('–'),
                "mdash" => Some('—'),
                "hellip" => Some('…'),
                "rsquo" | "lsquo" => Some('\''),
                "rdquo" | "ldquo" | "bdquo" => Some('"'),
                "auml" => Some('ä'),
                "ouml" => Some('ö'),
                "uuml" => Some('ü'),
                "Auml" => Some('Ä'),
                "Ouml" => Some('Ö'),
                "Uuml" => Some('Ü'),
                "szlig" => Some('ß'),
                "euro" => Some('€'),
                "copy" => Some('©'),
                _ if ent.starts_with("#x") || ent.starts_with("#X") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
                _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32),
                _ => None,
            };
            if let Some(c) = rep {
                out.push(c);
                rest = &tail[j + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &tail[1..];
    }
    out.push_str(rest);
    out
}

// ---------- fetching ----------
const UA: &str = "Mozilla/5.0 (compatible; Streyn podcast player)";

/// True for addresses on the open internet; loopback, private, link-local, CGNAT, multicast and
/// similar ranges are refused, so a feed or enclosure link can't make the server reach into its own network.
fn is_public_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || v.is_documentation()
                || v.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
                || (o[0] == 198 && (o[1] & 0xfe) == 18)
                || o[0] >= 240)
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(v4));
            }
            let seg = v.segments();
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00
                || (seg[0] & 0xffc0) == 0xfe80
                || (seg[0] == 0x2001 && seg[1] == 0x0db8))
        }
    }
}
/// HTTP agent for links taken from feeds: every connection, also after a redirect, goes only to
/// public addresses. `read` limits how long a single read may wait for data.
fn public_agent(read: Duration) -> ureq::Agent {
    use std::net::ToSocketAddrs;
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(read)
        .resolver(|addr: &str| -> std::io::Result<Vec<std::net::SocketAddr>> {
            let list: Vec<std::net::SocketAddr> = addr.to_socket_addrs()?.filter(|a| is_public_ip(a.ip())).collect();
            if list.is_empty() {
                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "address not allowed"));
            }
            Ok(list)
        })
        .build()
}

fn http_text(url: &str, max: u64) -> Result<String, ApiError> {
    let r = ureq::get(url)
        .set("user-agent", UA)
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| {
            eprintln!("podcast fetch {url}: {e}");
            ApiError::new(502, "podcast_unreachable")
        })?;
    let mut v = Vec::new();
    r.into_reader().take(max).read_to_end(&mut v).map_err(|_| ApiError::new(502, "podcast_unreachable"))?;
    Ok(String::from_utf8_lossy(&v).into_owned())
}
/// ETag and Last-Modified of every feed: asking again costs the host (and us) almost nothing when nothing changed.
static VALIDATORS: OnceLock<Mutex<HashMap<i64, (String, String)>>> = OnceLock::new();
const FEED_MAX: u64 = 40 << 20;
/// The feed text with its ETag and Last-Modified, or None when the host says it did not change.
/// The validators are only kept once the feed proved good (see load_show).
/// Feed text with its (ETag, Last-Modified).
type FeedText = (String, (String, String));
fn fetch_feed(id: i64, url: &str) -> Result<Option<FeedText>, ApiError> {
    let (etag, lm) = VALIDATORS.get_or_init(Default::default).lock().unwrap().get(&id).cloned().unwrap_or_default();
    let mut req = public_agent(Duration::from_secs(20)).get(url).set("user-agent", UA).timeout(Duration::from_secs(20));
    if !etag.is_empty() {
        req = req.set("if-none-match", &etag);
    }
    if !lm.is_empty() {
        req = req.set("if-modified-since", &lm);
    }
    let r = match req.call() {
        Ok(r) if r.status() == 304 => return Ok(None),
        Ok(r) => r,
        Err(ureq::Error::Status(304, _)) => return Ok(None),
        Err(e) => {
            eprintln!("podcast feed {url}: {e}");
            return Err(ApiError::new(502, "podcast_unreachable"));
        }
    };
    let v = (r.header("etag").unwrap_or("").to_string(), r.header("last-modified").unwrap_or("").to_string());
    let mut buf = Vec::new();
    // one byte more than allowed tells a too large feed from one that just fits
    r.into_reader().take(FEED_MAX + 1).read_to_end(&mut buf).map_err(|_| ApiError::new(502, "podcast_unreachable"))?;
    if buf.len() as u64 > FEED_MAX {
        eprintln!("podcast feed {url}: larger than {FEED_MAX} bytes");
        return Err(ApiError::new(502, "podcast_bad_feed"));
    }
    Ok(Some((String::from_utf8_lossy(&buf).into_owned(), v)))
}

/// Keeps every followed show current on its own: each feed is looked at every few minutes, so a new
/// episode shows up in Streyn as soon as the show publishes it (Spotify reads the same feed).
pub fn start_refresher(st: St) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        loop {
            let ids: Vec<i64> = {
                let db = st.db.lock().unwrap();
                // an error is logged and tried again on the next round
                db.prepare("SELECT DISTINCT show_id FROM pod_subs")
                    .and_then(|mut s| Ok(s.query_map([], |r| r.get(0))?.filter_map(Result::ok).collect()))
                    .unwrap_or_else(|e| {
                        eprintln!("podcast refresh: {e}");
                        Vec::new()
                    })
            };
            for id in ids {
                let before = FEEDS.get_or_init(Default::default).lock().unwrap().get(&id).and_then(|(_, s)| s.episodes.first().map(|e| e.date));
                if let Ok(s) = load_show(&st, id, true) {
                    let now = s.episodes.first().map(|e| e.date);
                    if before.is_some() && now > before {
                        // a new episode: remember when, the apps ask for that
                        LAST_NEW.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
                    }
                }
                std::thread::sleep(Duration::from_millis(400));
            }
            std::thread::sleep(REFRESH_EVERY);
        }
    });
}
const REFRESH_EVERY: Duration = Duration::from_secs(3 * 60);
static LAST_NEW: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

fn http_json(url: &str) -> Result<Value, ApiError> {
    serde_json::from_str(&http_text(url, 8 << 20)?).map_err(|_| ApiError::new(502, "podcast_unreachable"))
}

type FeedCache = Mutex<HashMap<i64, (Instant, Arc<Show>)>>;
static FEEDS: OnceLock<FeedCache> = OnceLock::new();
static LISTS: OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();
const FEED_TTL: Duration = Duration::from_secs(5 * 60);

fn cached_list(key: &str, ttl: Duration) -> Option<Value> {
    let m = LISTS.get_or_init(Default::default).lock().unwrap();
    m.get(key).filter(|(at, _)| at.elapsed() < ttl).map(|(_, v)| v.clone())
}
fn keep_list(key: &str, v: &Value) {
    let mut m = LISTS.get_or_init(Default::default).lock().unwrap();
    if m.len() > 300 {
        m.clear();
    }
    m.insert(key.to_string(), (Instant::now(), v.clone()));
}

/// The feed link of a show: from what was looked up before, else from the Apple directory.
fn feed_of(st: &St, id: i64) -> Result<String, ApiError> {
    let saved: Option<String> = st
        .db
        .lock()
        .unwrap()
        .query_row("SELECT feed FROM pod_shows WHERE id = ?", [id], |r| r.get(0))
        .optional()
        .unwrap_or(None);
    if let Some(f) = saved.filter(|f| !f.is_empty()) {
        return Ok(f);
    }
    let j = http_json(&format!("https://itunes.apple.com/lookup?id={id}&entity=podcast"))?;
    let r = &j["results"][0];
    let feed = r["feedUrl"].as_str().unwrap_or("").to_string();
    if !(feed.starts_with("http://") || feed.starts_with("https://")) {
        return Err(ApiError::new(404, "podcast_no_feed"));
    }
    st.db.lock().unwrap().execute(
        "INSERT INTO pod_shows (id, feed, title, author, cover, updated) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET feed = excluded.feed, title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END, author = CASE WHEN excluded.author <> '' THEN excluded.author ELSE author END, cover = CASE WHEN excluded.cover <> '' THEN excluded.cover ELSE cover END, updated = excluded.updated",
        params![id, feed, r["collectionName"].as_str().unwrap_or(""), r["artistName"].as_str().unwrap_or(""), big_art(r), now_ms()],
    ).ok();
    Ok(feed)
}

/// The show with all its episodes, from the cache for a quarter of an hour.
fn load_show(st: &St, id: i64, fresh: bool) -> Result<Arc<Show>, ApiError> {
    if !fresh {
        let m = FEEDS.get_or_init(Default::default).lock().unwrap();
        if let Some((at, s)) = m.get(&id) {
            if at.elapsed() < FEED_TTL {
                return Ok(s.clone());
            }
        }
    }
    let feed = feed_of(st, id)?;
    let (xml, validators) = match fetch_feed(id, &feed) {
        Ok(Some(x)) => x,
        // the feed did not change since the last look: the copy we have is current again
        Ok(None) => {
            let mut m = FEEDS.get_or_init(Default::default).lock().unwrap();
            if let Some(e) = m.get_mut(&id) {
                e.0 = Instant::now();
                return Ok(e.1.clone());
            }
            drop(m);
            VALIDATORS.get_or_init(Default::default).lock().unwrap().remove(&id);
            fetch_feed(id, &feed)?.ok_or(ApiError::new(502, "podcast_unreachable"))?
        }
        Err(e) => {
            // an old copy is better than nothing while the feed is down
            let m = FEEDS.get_or_init(Default::default).lock().unwrap();
            return m.get(&id).map(|(_, s)| s.clone()).ok_or(e);
        }
    };
    let (show, complete) = parse_feed_checked(&xml);
    if !complete || (show.title.is_empty() && show.episodes.is_empty()) {
        // a broken feed never replaces the last good copy
        let m = FEEDS.get_or_init(Default::default).lock().unwrap();
        return m.get(&id).map(|(_, s)| s.clone()).ok_or(ApiError::new(502, "podcast_bad_feed"));
    }
    let show = Arc::new(show);
    st.db.lock().unwrap().execute(
        "UPDATE pod_shows SET title = ?, author = CASE WHEN ? <> '' THEN ? ELSE author END, cover = CASE WHEN cover = '' THEN ? ELSE cover END, updated = ? WHERE id = ?",
        params![show.title, show.author, show.author, show.cover, now_ms(), id],
    ).ok();
    let mut m = FEEDS.get_or_init(Default::default).lock().unwrap();
    let mut vals = VALIDATORS.get_or_init(Default::default).lock().unwrap();
    if m.len() >= 200 {
        m.retain(|_, (at, _)| at.elapsed() < FEED_TTL);
        // still full of fresh feeds: drop the oldest ones
        while m.len() >= 200 {
            let Some(oldest) = m.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| *k) else { break };
            m.remove(&oldest);
        }
        vals.retain(|k, _| m.contains_key(k) || *k == id);
    }
    // feed and validators change together, so a later 304 always refers to this copy
    m.insert(id, (Instant::now(), show.clone()));
    vals.insert(id, validators);
    Ok(show)
}
async fn load_show_async(st: &St, id: i64, fresh: bool) -> Result<Arc<Show>, ApiError> {
    let st = st.clone();
    tokio::task::spawn_blocking(move || load_show(&st, id, fresh))
        .await
        .map_err(|_| ApiError::new(500, "internal"))?
}

/// Apple's pictures come in any size: ask for a sharp square one.
fn big_art(r: &Value) -> String {
    let u = ["artworkUrl600", "artworkUrl160", "artworkUrl100", "artworkUrl60"]
        .iter()
        .find_map(|k| r[*k].as_str())
        .unwrap_or("");
    upsize(u)
}
fn upsize(u: &str) -> String {
    // .../100x100bb.jpg → .../600x600bb.jpg
    if let Some(i) = u.rfind('/') {
        let (head, tail) = u.split_at(i + 1);
        if let Some(x) = tail.find('x') {
            if tail[..x].chars().all(|c| c.is_ascii_digit()) && x > 0 {
                let rest = tail[x + 1..].trim_start_matches(|c: char| c.is_ascii_digit());
                return format!("{head}600x600{rest}");
            }
        }
    }
    u.to_string()
}

fn show_card(r: &Value) -> Value {
    json!({
        "id": r["collectionId"].as_i64().or_else(|| r["id"].as_str().and_then(|s| s.parse().ok())).unwrap_or(0),
        "title": r["collectionName"].as_str().or(r["name"].as_str()).unwrap_or(""),
        "author": r["artistName"].as_str().unwrap_or(""),
        "cover": big_art(r),
        "genre": r["primaryGenreName"].as_str().or(r["genres"][0]["name"].as_str()).unwrap_or(""),
        "count": r["trackCount"].as_i64().unwrap_or(0),
    })
}
fn cc_of(q: &HashMap<String, String>) -> String {
    let cc = q.get("cc").map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    if cc.len() == 2 && cc.chars().all(|c| c.is_ascii_lowercase()) {
        cc
    } else {
        "us".into()
    }
}
fn enc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

/// Lower case without accents: "Äffchen mit Kâffchen" → "affchen mit kaffchen" (ß → ss).
pub fn fold(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.to_lowercase().chars() {
        let r = match c {
            'ä' | 'à' | 'á' | 'â' | 'ã' | 'å' | 'ā' => "a",
            'ö' | 'ò' | 'ó' | 'ô' | 'õ' | 'ø' | 'ō' => "o",
            'ü' | 'ù' | 'ú' | 'û' | 'ū' => "u",
            'é' | 'è' | 'ê' | 'ë' | 'ē' => "e",
            'í' | 'ì' | 'î' | 'ï' => "i",
            'ñ' => "n",
            'ç' => "c",
            'ß' => "ss",
            'æ' => "ae",
            'œ' => "oe",
            c if c.is_alphanumeric() => {
                o.push(c);
                continue;
            }
            _ => " ",
        };
        o.push_str(r);
    }
    o.split_whitespace().collect::<Vec<_>>().join(" ")
}
/// The ways a search may have meant its words: as typed, the accents as German umlauts
/// (â → ä), ae/oe/ue as umlauts, and without any accents.
pub fn spellings(term: &str) -> Vec<String> {
    let t = term.trim().to_lowercase();
    let uml: String = t
        .chars()
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ã' | 'å' => 'ä',
            'ò' | 'ó' | 'ô' | 'õ' => 'ö',
            'ù' | 'ú' | 'û' => 'ü',
            c => c,
        })
        .collect();
    let ae = uml.replace("ae", "ä").replace("oe", "ö").replace("ue", "ü");
    let mut out: Vec<String> = Vec::new();
    for v in [t.clone(), uml, ae, fold(&t)] {
        if !v.is_empty() && !out.contains(&v) {
            out.push(v);
        }
    }
    out.truncate(4);
    out
}
/// How alike two folded names are, 0 to 1: shared letter triples (forgives typos) and whole words.
pub fn similarity(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let tri = |s: &str| -> Vec<String> {
        let p: Vec<char> = format!("  {s} ").chars().collect();
        p.windows(3).map(|w| w.iter().collect()).collect()
    };
    let (ta, tb) = (tri(a), tri(b));
    let mut rest = tb.clone();
    let mut common = 0;
    for x in &ta {
        if let Some(i) = rest.iter().position(|y| y == x) {
            rest.swap_remove(i);
            common += 1;
        }
    }
    let dice = 2.0 * common as f64 / (ta.len() + tb.len()) as f64;
    // all typed words inside the name ("kaffchen" in "affchen mit kaffchen podcast")
    let inside = if a.split(' ').all(|w| b.split(' ').any(|x| x.starts_with(w))) { 0.9 } else { 0.0 };
    dice.max(inside)
}

// ---------- handlers ----------
/// Shows and episodes that match the words.
async fn search(Auth(_u, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let term = q.get("q").map(|s| s.trim().to_string()).unwrap_or_default();
    if term.is_empty() || term.len() > 200 {
        return Ok(Json(json!({ "shows": [], "episodes": [] })));
    }
    let cc = cc_of(&q);
    let key = format!("s:{cc}:{}", term.to_lowercase());
    if let Some(v) = cached_list(&key, Duration::from_secs(1800)) {
        return Ok(Json(v));
    }
    let v = tokio::task::spawn_blocking(move || -> Result<(Value, bool), ApiError> {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (asked_ok, asked_bad) = (AtomicUsize::new(0), AtomicUsize::new(0));
        // like Spotify, typing does not have to be exact: other spellings of the words are asked too
        // (â → ä, ae → ä, no accents at all), then the single words, and the best matches come first
        let ask = |entity: &str, words: &str, limit: u32| -> Vec<Value> {
            match http_json(&format!("https://itunes.apple.com/search?media=podcast&entity={entity}&limit={limit}&country={cc}&term={}", enc(words))) {
                Ok(j) => {
                    asked_ok.fetch_add(1, Ordering::Relaxed);
                    j["results"].as_array().cloned().unwrap_or_default()
                }
                Err(_) => {
                    asked_bad.fetch_add(1, Ordering::Relaxed);
                    Vec::new()
                }
            }
        };
        let variants = spellings(&term);
        let mut found: Vec<Vec<Value>> = std::thread::scope(|sc| {
            let hs: Vec<_> = variants.iter().map(|v| sc.spawn(|| ask("podcast", v, 24))).collect();
            hs.into_iter().map(|h| h.join().unwrap_or_default()).collect()
        });
        let want = fold(&term);
        let close = |r: &Value| similarity(&want, &fold(r["collectionName"].as_str().unwrap_or(""))) >= 0.55;
        if !found.iter().flatten().any(close) {
            // a typo: look for the longer words one by one and keep what resembles the whole
            let words: Vec<String> = want.split(' ').filter(|w| w.chars().count() >= 4).take(3).map(String::from).collect();
            let more: Vec<Vec<Value>> = std::thread::scope(|sc| {
                let hs: Vec<_> = words.iter().map(|w| sc.spawn(|| ask("podcast", w, 50))).collect();
                hs.into_iter().map(|h| h.join().unwrap_or_default()).collect()
            });
            found.extend(more);
        }
        let mut seen = std::collections::HashSet::new();
        let mut shows: Vec<(f64, usize, Value)> = Vec::new();
        for (i, r) in found.iter().flatten().enumerate() {
            let id = r["collectionId"].as_i64().unwrap_or(0);
            if id == 0 || !r["feedUrl"].is_string() || !seen.insert(id) {
                continue;
            }
            let score = similarity(&want, &fold(r["collectionName"].as_str().unwrap_or(""))).max(similarity(&want, &fold(r["artistName"].as_str().unwrap_or(""))) * 0.8);
            shows.push((score, i, show_card(r)));
        }
        // the ones that look like the words first, Apple's own order after that
        shows.sort_by(|a, b| {
            let (sa, sb) = (if a.0 >= 0.5 { a.0 } else { 0.0 }, if b.0 >= 0.5 { b.0 } else { 0.0 });
            sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1))
        });
        let shows: Vec<Value> = shows.into_iter().filter(|x| x.0 >= 0.3 || x.1 < 24).take(30).map(|x| x.2).collect();
        let eps = json!({ "results": variants.iter().map(|v| ask("podcastEpisode", v, 20)).find(|l| !l.is_empty()).unwrap_or_default() });
        let episodes: Vec<Value> = eps["results"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|r| r["episodeUrl"].is_string() && r["collectionId"].is_i64())
                    .map(|r| {
                        let guid = r["episodeGuid"].as_str().unwrap_or("");
                        let url = r["episodeUrl"].as_str().unwrap_or("");
                        json!({
                            "id": ep_id(if guid.is_empty() { url } else { guid }),
                            "show": r["collectionId"],
                            "showTitle": r["collectionName"].as_str().unwrap_or(""),
                            "title": r["trackName"].as_str().unwrap_or(""),
                            "desc": html_to_text(r["description"].as_str().or(r["shortDescription"].as_str()).unwrap_or("")).chars().take(400).collect::<String>(),
                            "date": parse_iso(r["releaseDate"].as_str().unwrap_or("")),
                            "duration": r["trackTimeMillis"].as_f64().unwrap_or(0.0) / 1000.0,
                            "cover": big_art(r),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        // the directory did not answer at all: an error, not "nothing found"
        if asked_ok.load(Ordering::Relaxed) == 0 {
            return Err(ApiError::new(502, "podcast_unreachable"));
        }
        let complete = asked_bad.load(Ordering::Relaxed) == 0;
        Ok((json!({ "shows": shows, "episodes": episodes }), complete))
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))??;
    let (v, complete) = v;
    // only complete answers are kept, a half failed one is asked again next time
    if complete {
        keep_list(&key, &v);
    }
    Ok(Json(v))
}

/// The most listened shows of a country, all or of one category (Apple's charts).
async fn top(Auth(_u, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let cc = cc_of(&q);
    let genre: i64 = q.get("genre").and_then(|g| g.parse().ok()).filter(|g| (1300..2000).contains(g)).unwrap_or(0);
    let key = format!("t:{cc}:{genre}");
    if let Some(v) = cached_list(&key, Duration::from_secs(6 * 3600)) {
        return Ok(Json(v));
    }
    let v = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let g = if genre > 0 { format!("/genre={genre}") } else { String::new() };
        let j = http_json(&format!("https://itunes.apple.com/{cc}/rss/toppodcasts/limit=50{g}/json"))?;
        let list: Vec<Value> = j["feed"]["entry"]
            .as_array()
            .cloned()
            .or_else(|| j["feed"]["entry"].as_object().map(|o| vec![Value::Object(o.clone())]))
            .unwrap_or_default()
            .iter()
            .filter_map(|e| {
                let id: i64 = e["id"]["attributes"]["im:id"].as_str()?.parse().ok()?;
                let img = e["im:image"].as_array().and_then(|a| a.last()).and_then(|x| x["label"].as_str()).unwrap_or("");
                Some(json!({
                    "id": id,
                    "title": e["im:name"]["label"].as_str().unwrap_or(""),
                    "author": e["im:artist"]["label"].as_str().unwrap_or(""),
                    "cover": upsize(img),
                    "genre": e["category"]["attributes"]["label"].as_str().unwrap_or(""),
                    "count": 0,
                }))
            })
            .collect();
        Ok(json!(list))
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))??;
    if v.as_array().is_some_and(|a| !a.is_empty()) {
        keep_list(&key, &v);
    }
    Ok(Json(v))
}

fn progress_map(st: &St, user: i64, show: i64) -> HashMap<String, (f64, f64, bool)> {
    let db = st.db.lock().unwrap();
    db.prepare("SELECT ep, pos, dur, done FROM pod_progress WHERE user_id = ? AND show_id = ?")
        .and_then(|mut s| {
            Ok(s.query_map(params![user, show], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, f64>(1)?, r.get::<_, f64>(2)?, r.get::<_, i64>(3)? != 0))))?
                .filter_map(Result::ok)
                .collect())
        })
        .unwrap_or_else(|e| {
            eprintln!("podcast progress: {e}");
            HashMap::new()
        })
}
fn ep_json(e: &Episode, show_id: i64, show: &Show, prog: &HashMap<String, (f64, f64, bool)>, desc_len: usize) -> Value {
    let p = prog.get(&e.id).copied().unwrap_or((0.0, 0.0, false));
    json!({
        "id": e.id,
        "show": show_id,
        "showTitle": show.title,
        "author": show.author,
        "title": e.title,
        "desc": if desc_len == 0 { e.desc.clone() } else { e.desc.chars().take(desc_len).collect::<String>() },
        "date": e.date,
        "duration": if e.duration > 0.0 { e.duration } else { p.1 },
        "cover": e.cover,
        "season": e.season,
        "number": e.number,
        "explicit": e.explicit,
        "kind": e.kind,
        "pos": p.0,
        "done": p.2,
    })
}

async fn show(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>, Query(q): Query<HashMap<String, String>>) -> R {
    let s = load_show_async(&st, id, q.contains_key("fresh")).await?;
    let prog = progress_map(&st, u.id, id);
    let followed = st.db.lock().unwrap().query_row("SELECT 1 FROM pod_subs WHERE user_id = ? AND show_id = ?", params![u.id, id], |_| Ok(())).is_ok();
    // opened: the episodes shown count as seen (the dot in the library goes away); an older
    // cached copy never moves the mark back
    if followed {
        let newest = s.episodes.first().map(|e| e.date).unwrap_or(0).min(now_ms());
        st.db.lock().unwrap().execute("UPDATE pod_subs SET seen = MAX(seen, ?) WHERE user_id = ? AND show_id = ?", params![newest, u.id, id]).ok();
    }
    let cover: String = st.db.lock().unwrap().query_row("SELECT cover FROM pod_shows WHERE id = ?", [id], |r| r.get(0)).unwrap_or_default();
    let eps: Vec<Value> = s.episodes.iter().take(1500).map(|e| ep_json(e, id, &s, &prog, 320)).collect();
    Ok(Json(json!({
        "id": id,
        "title": s.title,
        "author": s.author,
        "desc": s.desc,
        "cover": if s.cover.is_empty() { cover } else { s.cover.clone() },
        "link": s.link,
        "genre": s.genre,
        "followed": followed,
        "total": s.episodes.len(),
        "episodes": eps,
    })))
}

/// The Apple id of a show from its name, the closest one Apple knows (kept for a day).
fn show_by_name(name: &str, cc: &str) -> Option<i64> {
    let want = fold(name);
    if want.is_empty() {
        return None;
    }
    let key = format!("n:{cc}:{want}");
    if let Some(v) = cached_list(&key, Duration::from_secs(86400)) {
        return v.as_i64();
    }
    let mut best: Option<(f64, i64)> = None;
    let mut failed = false;
    for v in spellings(name) {
        let j = http_json(&format!("https://itunes.apple.com/search?media=podcast&entity=podcast&limit=15&country={cc}&term={}", enc(&v))).ok();
        failed |= j.is_none();
        for r in j.as_ref().and_then(|j| j["results"].as_array()).into_iter().flatten() {
            let id = r["collectionId"].as_i64().unwrap_or(0);
            if id == 0 || !r["feedUrl"].is_string() {
                continue;
            }
            let sc = similarity(&want, &fold(r["collectionName"].as_str().unwrap_or("")));
            if best.map(|b| sc > b.0).unwrap_or(true) {
                best = Some((sc, id));
            }
        }
        if best.map(|b| b.0 >= 0.95).unwrap_or(false) {
            break;
        }
    }
    let id = best.filter(|b| b.0 >= 0.6).map(|b| b.1);
    // "not found" is only remembered when every lookup answered
    if id.is_some() || !failed {
        keep_list(&key, &json!(id));
    }
    id
}
/// The episode of a show with this title (and about this length).
fn episode_by_title<'a>(s: &'a Show, title: &str, duration: f64) -> Option<&'a Episode> {
    let want = fold(title);
    let mut best: Option<(f64, &Episode)> = None;
    for e in &s.episodes {
        let mut sc = similarity(&want, &fold(&e.title));
        if duration > 0.0 && e.duration > 0.0 && (e.duration - duration).abs() < 90.0 {
            sc += 0.1;
        }
        if best.map(|b| sc > b.0).unwrap_or(true) {
            best = Some((sc, e));
        }
    }
    best.filter(|b| b.0 >= 0.7).map(|b| b.1)
}

/// [{ show, title, duration }] (episodes of a Spotify playlist) → the same episodes from the
/// shows' own public feeds, playable here without Spotify; null where a show has no public feed.
async fn match_episodes(State(st): State<St>, Auth(u, _): Auth, Query(q): Query<HashMap<String, String>>, req: Request) -> R {
    let v: Value = body_json(req).await?;
    let list: Vec<(String, String, f64)> = v
        .as_array()
        .ok_or(ApiError::new(400, "bad_json"))?
        .iter()
        .take(300)
        .map(|x| (x["show"].as_str().unwrap_or("").to_string(), x["title"].as_str().unwrap_or("").to_string(), x["duration"].as_f64().unwrap_or(0.0)))
        .collect();
    let cc = cc_of(&q);
    let uid = u.id;
    let out = tokio::task::spawn_blocking(move || {
        // each show is looked up once, however many of its episodes are in the list
        let mut names: Vec<String> = list.iter().map(|x| x.0.clone()).collect();
        names.sort();
        names.dedup();
        let shows: HashMap<String, Option<(i64, Arc<Show>)>> = std::thread::scope(|sc| {
            let hs: Vec<_> = names
                .iter()
                .take(40)
                .map(|n| {
                    let (st, cc) = (&st, &cc);
                    sc.spawn(move || (n.clone(), show_by_name(n, cc).and_then(|id| load_show(st, id, false).ok().map(|s| (id, s)))))
                })
                .collect();
            hs.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        let mut prog: HashMap<i64, HashMap<String, (f64, f64, bool)>> = HashMap::new();
        list.iter()
            .map(|(name, title, dur)| {
                let Some(Some((id, s))) = shows.get(name) else { return Value::Null };
                let Some(e) = episode_by_title(s, title, *dur) else { return Value::Null };
                let p = prog.entry(*id).or_insert_with(|| progress_map(&st, uid, *id));
                ep_json(e, *id, s, p, 320)
            })
            .collect::<Vec<Value>>()
    })
    .await
    .map_err(|_| ApiError::new(500, "internal"))?;
    Ok(Json(json!(out)))
}

fn find<'a>(s: &'a Show, ep: &str) -> Option<&'a Episode> {
    s.episodes.iter().find(|e| e.id == ep).or_else(|| s.episodes.iter().find(|e| e.url_id == ep))
}

async fn episode(State(st): State<St>, Auth(u, _): Auth, Path((id, ep)): Path<(i64, String)>) -> R {
    let s = load_show_async(&st, id, false).await?;
    let s = match find(&s, &ep) {
        Some(_) => s,
        // a new episode the cached feed does not know yet
        None => load_show_async(&st, id, true).await?,
    };
    let e = find(&s, &ep).ok_or(ApiError::new(404, "not_found"))?;
    let prog = progress_map(&st, u.id, id);
    let mut v = ep_json(e, id, &s, &prog, 0);
    v["showCover"] = json!(s.cover);
    Ok(Json(v))
}

/// The sound of an episode, passed on with Range so seeking works everywhere.
async fn audio(State(st): State<St>, AuthQ(_u): AuthQ, Path((id, ep)): Path<(i64, String)>, headers: axum::http::HeaderMap) -> Response {
    use axum::body::Body;
    use axum::http::{header, StatusCode};
    let url = match load_show_async(&st, id, false).await {
        Ok(s) => match find(&s, &ep) {
            Some(e) => Some(e.url.clone()),
            // a refresh that fails is reported as such; 404 only when the fresh feed lacks the episode
            None => match load_show_async(&st, id, true).await {
                Ok(s) => find(&s, &ep).map(|e| e.url.clone()),
                Err(e) => return e.into_response(),
            },
        },
        Err(e) => return e.into_response(),
    };
    let Some(url) = url else { return ApiError::new(404, "not_found").into_response() };
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from);
    let res = tokio::task::spawn_blocking(move || {
        // public addresses only (also after redirects); a host that stops sending ends the
        // stream after a minute instead of holding the reader thread forever
        let mut req = public_agent(Duration::from_secs(60)).get(&url).set("user-agent", UA);
        if let Some(r) = &range {
            req = req.set("range", r);
        }
        match req.call() {
            Ok(r) => Ok(r),
            Err(ureq::Error::Status(416, r)) => Ok(r),
            Err(e) => {
                eprintln!("podcast audio {url}: {e}");
                Err(ApiError::new(502, "podcast_unreachable"))
            }
        }
    })
    .await;
    let r = match res {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return e.into_response(),
        Err(_) => return ApiError::new(500, "internal").into_response(),
    };
    let status = StatusCode::from_u16(r.status()).unwrap_or(StatusCode::OK);
    let mut out = axum::http::HeaderMap::new();
    for h in ["content-type", "content-length", "content-range", "accept-ranges"] {
        if let Some(v) = r.header(h).and_then(|v| v.parse().ok()) {
            out.insert(h, v);
        }
    }
    // some hosts call MP3 "application/octet-stream": the players want to know it is sound
    let ct = r.header("content-type").unwrap_or("").to_ascii_lowercase();
    if !(ct.starts_with("audio") || ct.starts_with("video")) {
        out.insert(header::CONTENT_TYPE, "audio/mpeg".parse().unwrap());
    }
    if !out.contains_key("accept-ranges") {
        out.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    }
    out.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(8);
    std::thread::spawn(move || {
        let mut rd = r.into_reader();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match rd.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.blocking_send(Err(e));
                    break;
                }
            }
        }
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|x| (x, rx)) });
    (status, out, Body::from_stream(stream)).into_response()
}

/// Cheap question the apps ask every minute: did any followed show get a new episode, and which is newest.
async fn pulse(State(st): State<St>, Auth(u, _): Auth) -> R {
    let ids: Vec<i64> = {
        let db = st.db.lock().unwrap();
        db.prepare("SELECT show_id FROM pod_subs WHERE user_id = ?")
            .and_then(|mut s| Ok(s.query_map([u.id], |r| r.get(0))?.filter_map(Result::ok).collect()))
            .map_err(crate::api::db_err)?
    };
    let m = FEEDS.get_or_init(Default::default).lock().unwrap();
    let newest = ids
        .iter()
        .filter_map(|id| m.get(id).and_then(|(_, s)| s.episodes.first().map(|e| (*id, e, s.title.clone()))))
        .max_by_key(|(_, e, _)| e.date);
    Ok(Json(match newest {
        Some((id, e, title)) => json!({ "date": e.date, "show": id, "ep": e.id, "title": e.title, "showTitle": title, "changed": LAST_NEW.load(std::sync::atomic::Ordering::Relaxed) }),
        None => json!({ "date": 0, "changed": 0 }),
    }))
}

/// Followed shows, the newest episode date with each (for sorting like Spotify's library).
async fn subs(State(st): State<St>, Auth(u, _): Auth) -> R {
    let rows: Vec<(i64, String, String, String, i64, i64)> = {
        let db = st.db.lock().unwrap();
        db.prepare("SELECT s.show_id, COALESCE(p.title,''), COALESCE(p.author,''), COALESCE(p.cover,''), s.created, s.seen FROM pod_subs s LEFT JOIN pod_shows p ON p.id = s.show_id WHERE s.user_id = ? ORDER BY s.created DESC")
            .and_then(|mut s| Ok(s.query_map([u.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?.filter_map(Result::ok).collect()))
            .map_err(crate::api::db_err)?
    };
    let list: Vec<Value> = rows
        .into_iter()
        .map(|(id, title, author, cover, created, seen)| {
            let last = FEEDS.get_or_init(Default::default).lock().unwrap().get(&id).and_then(|(_, s)| s.episodes.first().map(|e| e.date)).unwrap_or(0);
            json!({ "id": id, "title": title, "author": author, "cover": cover, "created": created, "last": last, "fresh": last > seen.max(created) })
        })
        .collect();
    Ok(Json(json!(list)))
}
async fn subscribe(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>, req: Request) -> R {
    let v: Value = body_json(req).await?;
    let text = |k: &str| v[k].as_str().unwrap_or("").chars().take(1000).collect::<String>();
    {
        let mut db = st.db.lock().unwrap();
        let tx = db.transaction().map_err(crate::api::db_err)?;
        // what the app already knows of the show, so the library shows it before the feed was read;
        // it only fills empty fields and never overwrites what the directory or the feed said
        tx.execute(
            "INSERT INTO pod_shows (id, feed, title, author, cover, updated) VALUES (?, '', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = CASE WHEN title = '' THEN excluded.title ELSE title END, author = CASE WHEN author = '' THEN excluded.author ELSE author END, cover = CASE WHEN cover = '' THEN excluded.cover ELSE cover END",
            params![id, text("title"), text("author"), text("cover"), now_ms()],
        )
        .map_err(crate::api::db_err)?;
        tx.execute("INSERT OR IGNORE INTO pod_subs (user_id, show_id, created) VALUES (?,?,?)", params![u.id, id, now_ms()])
            .map_err(crate::api::db_err)?;
        tx.commit().map_err(crate::api::db_err)?;
    }
    Ok(Json(json!({ "following": true })))
}
async fn unsubscribe(State(st): State<St>, Auth(u, _): Auth, Path(id): Path<i64>) -> R {
    st.db.lock().unwrap().execute("DELETE FROM pod_subs WHERE user_id = ? AND show_id = ?", params![u.id, id]).map_err(crate::api::db_err)?;
    Ok(Json(json!({ "following": false })))
}

/// Where an episode was left off. `done` once it ran to (almost) the end, or when set by hand.
async fn save_progress(State(st): State<St>, Auth(u, _): Auth, req: Request) -> R {
    let v: Value = body_json(req).await?;
    let show = v["show"].as_i64().ok_or(ApiError::new(400, "bad_json"))?;
    let ep = v["ep"].as_str().unwrap_or("").to_string();
    if ep.is_empty() || ep.len() > 64 {
        return Err(ApiError::new(400, "bad_json"));
    }
    let pos = v["pos"].as_f64().unwrap_or(0.0).max(0.0);
    let dur = v["dur"].as_f64().unwrap_or(0.0).max(0.0);
    // the last 30 seconds count as the end, but never more than 5% of a (short) episode
    let done = v["done"].as_bool().unwrap_or(dur > 0.0 && pos >= dur - (dur * 0.05).min(30.0));
    let pos = if done && !v["keep"].as_bool().unwrap_or(false) { 0.0 } else { pos };
    let data = v.get("meta").map(|m| m.to_string()).filter(|s| s.len() < 4000).unwrap_or_else(|| "{}".into());
    st.db.lock().unwrap().execute(
        "INSERT INTO pod_progress (user_id, show_id, ep, pos, dur, done, data, updated) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id, show_id, ep) DO UPDATE SET pos = excluded.pos, dur = CASE WHEN excluded.dur > 0 THEN excluded.dur ELSE dur END, done = excluded.done, data = CASE WHEN excluded.data <> '{}' THEN excluded.data ELSE data END, updated = excluded.updated",
        params![u.id, show, ep, pos, dur, done as i64, data, now_ms()],
    ).map_err(crate::api::db_err)?;
    Ok(Json(json!({ "ok": true, "done": done })))
}

/// Episodes started and not finished, last listened first ("Continue listening").
async fn continue_list(State(st): State<St>, Auth(u, _): Auth) -> R {
    let db = st.db.lock().unwrap();
    let mut s = db
        .prepare("SELECT show_id, ep, pos, dur, data FROM pod_progress WHERE user_id = ? AND done = 0 AND pos > 5 ORDER BY updated DESC LIMIT 20")
        .map_err(crate::api::db_err)?;
    let list: Vec<Value> = s
        .query_map([u.id], |r| {
            let meta: Value = serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(json!({}));
            let mut v = json!({ "show": r.get::<_, i64>(0)?, "id": r.get::<_, String>(1)?, "pos": r.get::<_, f64>(2)?, "duration": r.get::<_, f64>(3)?, "done": false });
            for k in ["title", "showTitle", "cover", "date", "author", "desc"] {
                if !meta[k].is_null() {
                    v[k] = meta[k].clone();
                }
            }
            Ok(v)
        })
        .map_err(crate::api::db_err)?
        .filter_map(Result::ok)
        .collect();
    Ok(Json(json!(list)))
}

/// The newest episodes of every followed show, newest first (Spotify's "New episodes").
async fn new_episodes(State(st): State<St>, Auth(u, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let ids: Vec<i64> = {
        let db = st.db.lock().unwrap();
        db.prepare("SELECT show_id FROM pod_subs WHERE user_id = ? ORDER BY created DESC LIMIT 60")
            .and_then(|mut s| Ok(s.query_map([u.id], |r| r.get(0))?.filter_map(Result::ok).collect()))
            .map_err(crate::api::db_err)?
    };
    let limit: usize = q.get("limit").and_then(|l| l.parse().ok()).unwrap_or(30).min(100);
    // a few feeds at once, each one from the cache when it is fresh
    let mut all: Vec<Value> = Vec::new();
    for chunk in ids.chunks(6) {
        let tasks: Vec<_> = chunk.iter().map(|&id| { let st = st.clone(); tokio::task::spawn_blocking(move || (id, load_show(&st, id, false))) }).collect();
        for t in tasks {
            if let Ok((id, Ok(s))) = t.await {
                let prog = progress_map(&st, u.id, id);
                // up to `limit` per show: one show may hold all of the newest episodes
                all.extend(s.episodes.iter().take(limit).map(|e| ep_json(e, id, &s, &prog, 220)));
            }
        }
    }
    all.sort_by(|a, b| b["date"].as_i64().cmp(&a["date"].as_i64()));
    all.truncate(limit);
    Ok(Json(json!(all)))
}

#[cfg(test)]
mod tests {
    use super::*;
    const FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Test &amp; Talk</title>
  <link>https://example.com</link>
  <itunes:author>Max Muster</itunes:author>
  <description><![CDATA[<p>Ein <b>Podcast</b> über alles.</p><p>Zweiter Absatz &amp; mehr</p>]]></description>
  <itunes:image href="https://example.com/cover.jpg"/>
  <itunes:category text="Comedy"><itunes:category text="Improv"/></itunes:category>
  <image><url>https://example.com/small.jpg</url><title>x</title></image>
  <item>
    <title>Folge 1: Anfang</title>
    <guid isPermaLink="false">abc-1</guid>
    <pubDate>Mon, 16 Nov 2026 06:00:00 +0100</pubDate>
    <enclosure url="https://cdn.example.com/1.mp3" length="123" type="audio/mpeg"/>
    <itunes:duration>1:02:03</itunes:duration>
    <description>Short</description>
    <content:encoded><![CDATA[<p>Long text with <a href="x">link</a></p><ul><li>one</li><li>two</li></ul>]]></content:encoded>
    <itunes:episode>1</itunes:episode>
  </item>
  <item>
    <title>Folge 2</title>
    <pubDate>Wed, 18 Nov 2026 10:00:00 GMT</pubDate>
    <enclosure url="https://cdn.example.com/2.mp3" type="audio/mpeg"/>
    <itunes:duration>754</itunes:duration>
    <itunes:image href="https://example.com/ep2.jpg"/>
    <itunes:explicit>yes</itunes:explicit>
  </item>
  <item><title>No sound</title></item>
</channel></rss>"#;

    #[test]
    fn reads_a_feed() {
        let s = parse_feed(FEED);
        assert_eq!(s.title, "Test & Talk");
        assert_eq!(s.author, "Max Muster");
        assert_eq!(s.cover, "https://example.com/cover.jpg");
        assert_eq!(s.genre, "Comedy");
        assert_eq!(s.desc, "Ein Podcast über alles.\n\nZweiter Absatz & mehr");
        assert_eq!(s.episodes.len(), 2);
        let (a, b) = (&s.episodes[0], &s.episodes[1]);
        assert_eq!(a.title, "Folge 2");
        assert_eq!(a.duration, 754.0);
        assert_eq!(a.cover, "https://example.com/ep2.jpg");
        assert!(a.explicit);
        assert_eq!(a.id, ep_id("https://cdn.example.com/2.mp3"));
        assert_eq!(b.id, ep_id("abc-1"));
        assert_eq!(b.duration, 3723.0);
        assert_eq!(b.cover, "https://example.com/cover.jpg");
        assert_eq!(b.number, 1);
        assert!(b.desc.starts_with("Long text with link"), "{}", b.desc);
        assert!(b.desc.contains("• one"));
        assert_eq!(a.date, parse_iso("2026-11-18T10:00:00Z"));
        assert_eq!(b.date, parse_iso("2026-11-16T05:00:00Z"));
    }
    #[test]
    fn spotify_episode_to_feed() {
        let s = parse_feed(FEED);
        // Spotify's title of the same episode, written a little differently
        assert_eq!(episode_by_title(&s, "Folge 2!", 750.0).map(|e| e.title.as_str()), Some("Folge 2"));
        assert_eq!(episode_by_title(&s, "folge 1", 0.0).map(|e| e.id.clone()), Some(ep_id("abc-1")));
        assert!(episode_by_title(&s, "Etwas ganz anderes", 0.0).is_none());
    }
    #[test]
    fn forgiving_search() {
        assert_eq!(fold("Äffchen mit Kâffchen!"), "affchen mit kaffchen");
        let v = spellings("äffchen mit kâffchen");
        assert!(v.contains(&"äffchen mit käffchen".to_string()), "{v:?}");
        assert!(v.contains(&"affchen mit kaffchen".to_string()));
        assert!(spellings("aeffchen").contains(&"äffchen".to_string()));
        assert!(similarity("affchen mit kaffchen", "affchen mit kaffchen") > 0.99);
        assert!(similarity("afchen mit kaffchen", "affchen mit kaffchen") > 0.7);
        assert!(similarity("affchen mit kafen", "affchen mit kaffchen") > 0.55);
        assert!(similarity("affchen mit kaffchen", "die nachrichten") < 0.3);
    }
    #[test]
    fn dates_and_lengths() {
        assert_eq!(parse_iso("1970-01-02T00:00:00Z"), 86_400_000);
        assert_eq!(parse_date("Fri, 02 Jan 1970 00:00:00 +0000"), 86_400_000);
        assert_eq!(parse_date("2 Jan 1970 01:00:00 +0100"), 86_400_000);
        assert_eq!(parse_date("Fri, 02 Jan 1970 00:00:00 EST"), 86_400_000 + 5 * 3_600_000);
        assert_eq!(parse_duration("62:03"), 3723.0);
        assert_eq!(parse_duration(""), 0.0);
        assert_eq!(upsize("https://is1.mzstatic.com/a/b/100x100bb.jpg"), "https://is1.mzstatic.com/a/b/600x600bb.jpg");
        assert_eq!(html_to_text("a &lt;b&gt; &#8211; &#x41;<br>c"), "a <b> – A\nc");
    }
}
