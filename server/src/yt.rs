//! YouTube search without a key, through the web API youtube.com itself uses (one request,
//! a few hundred ms). Only finds videos; playback stays the official embedded player.
use serde_json::{json, Value};
use std::time::Duration;

const ENDPOINT: &str = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false";
const VERSION: &str = "2.20251105.01.00";
/// "Videos only" filter
const VIDEOS: &str = "EgIQAQ==";

fn text(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    if let Some(s) = v["simpleText"].as_str() {
        return s.to_string();
    }
    if let Some(runs) = v["runs"].as_array() {
        return runs.iter().filter_map(|r| r["text"].as_str()).collect();
    }
    String::new()
}

pub fn parse_length(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }
    s.split(':').fold(0.0, |acc, n| acc * 60.0 + n.trim().parse::<f64>().unwrap_or(0.0))
}

fn walk<'a>(node: &'a Value, depth: usize, out: &mut Vec<&'a Value>) {
    if depth > 60 {
        return;
    }
    match node {
        Value::Array(a) => a.iter().for_each(|n| walk(n, depth + 1, out)),
        Value::Object(o) => {
            if let Some(v) = o.get("videoRenderer") {
                if v["videoId"].is_string() {
                    out.push(v);
                    return;
                }
            }
            // Shorts are no songs
            if o.contains_key("reelShelfRenderer") || o.contains_key("shortsLockupViewModel") {
                return;
            }
            o.values().for_each(|n| walk(n, depth + 1, out));
        }
        _ => {}
    }
}

/// Videos from a youtubei search answer: { id, title, channel, duration, cover }
pub fn parse_search(json: &Value) -> Vec<Value> {
    let mut found = Vec::new();
    walk(json, 0, &mut found);
    let mut seen = std::collections::HashSet::new();
    found
        .into_iter()
        .filter(|v| seen.insert(v["videoId"].as_str().unwrap_or("").to_string()))
        .filter(|v| !text(&v["lengthText"]).is_empty()) // no live streams
        .map(|v| {
            let id = v["videoId"].as_str().unwrap_or("");
            let channel = [&v["ownerText"], &v["longBylineText"], &v["shortBylineText"]]
                .iter()
                .map(|x| text(x))
                .find(|s| !s.is_empty())
                .unwrap_or_default();
            json!({
                "id": id,
                "title": text(&v["title"]),
                "channel": channel,
                "duration": parse_length(&text(&v["lengthText"])),
                "cover": format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"),
            })
        })
        .collect()
}

pub fn search(query: &str) -> Result<Vec<Value>, String> {
    let body = json!({
        "context": { "client": { "clientName": "WEB", "clientVersion": VERSION, "hl": "de", "gl": "DE" } },
        "query": query,
        "params": VIDEOS,
    });
    let res = ureq::post(ENDPOINT)
        .set("content-type", "application/json")
        .set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
        .set("x-youtube-client-name", "1")
        .set("x-youtube-client-version", VERSION)
        .set("origin", "https://www.youtube.com")
        .timeout(Duration::from_secs(8))
        .send_json(body)
        .map_err(|e| e.to_string())?
        .into_json::<Value>()
        .map_err(|e| e.to_string())?;
    Ok(parse_search(&res))
}

/* ---------- YouTube Music: songs only (the "Topic" audio tracks), like music.youtube.com ---------- */

const MUSIC_ENDPOINT: &str = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false";
const MUSIC_VERSION: &str = "1.20251105.01.00";
/// "Songs" filter of music.youtube.com
const SONGS: &str = "EgWKAQIIAWoMEA4QChADEAQQCRAF";

fn runs(v: &Value) -> Vec<&Value> {
    v["runs"].as_array().map(|a| a.iter().collect()).unwrap_or_default()
}

fn music_walk<'a>(node: &'a Value, depth: usize, out: &mut Vec<&'a Value>) {
    if depth > 60 {
        return;
    }
    match node {
        Value::Array(a) => a.iter().for_each(|n| music_walk(n, depth + 1, out)),
        Value::Object(o) => {
            if let Some(v) = o.get("musicResponsiveListItemRenderer") {
                out.push(v);
                return;
            }
            o.values().for_each(|n| music_walk(n, depth + 1, out));
        }
        _ => {}
    }
}

fn page_type(r: &Value) -> &str {
    r["navigationEndpoint"]["browseEndpoint"]["browseEndpointContextSupportedConfigs"]["browseEndpointContextMusicConfig"]["pageType"]
        .as_str()
        .unwrap_or("")
}

/// Songs from a music.youtube.com search answer: { id, title, artist, album, duration, cover }.
/// Music videos, podcasts, episodes and artist/album rows are left out.
pub fn parse_music(json: &Value) -> Vec<Value> {
    let mut found = Vec::new();
    music_walk(json, 0, &mut found);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for r in found {
        let cols: Vec<&Value> = r["flexColumns"]
            .as_array()
            .map(|a| a.iter().map(|c| &c["musicResponsiveListItemFlexColumnRenderer"]["text"]).collect())
            .unwrap_or_default();
        if cols.is_empty() {
            continue;
        }
        let title_runs = runs(cols[0]);
        let watch = title_runs.first().map(|x| &x["navigationEndpoint"]["watchEndpoint"]);
        let id = r["playlistItemData"]["videoId"]
            .as_str()
            .or_else(|| watch.and_then(|w| w["videoId"].as_str()))
            .unwrap_or("");
        if id.len() != 11 || !seen.insert(id.to_string()) {
            continue;
        }
        // ATV = the plain audio track; OMV/UGC are videos
        let kind = watch
            .and_then(|w| w["watchEndpointMusicSupportedConfigs"]["watchEndpointMusicConfig"]["musicVideoType"].as_str())
            .unwrap_or("MUSIC_VIDEO_TYPE_ATV");
        if kind != "MUSIC_VIDEO_TYPE_ATV" {
            continue;
        }
        let title = text(cols[0]);
        let meta: Vec<&Value> = cols.iter().skip(1).flat_map(|c| runs(c)).collect();
        let mut artists: Vec<String> = meta.iter().filter(|x| page_type(x) == "MUSIC_PAGE_TYPE_ARTIST").filter_map(|x| x["text"].as_str().map(String::from)).collect();
        let album = meta.iter().find(|x| page_type(x) == "MUSIC_PAGE_TYPE_ALBUM").and_then(|x| x["text"].as_str()).unwrap_or("").to_string();
        let parts: Vec<String> = meta.iter().filter_map(|x| x["text"].as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s != "•" && s != "&" && s != ",").collect();
        let duration = parts.iter().rev().find(|s| s.split(':').count() >= 2 && s.split(':').all(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))).map(|s| parse_length(s)).unwrap_or(0.0);
        if artists.is_empty() {
            // without links the first part is the artist (unless it is the word "Song")
            if let Some(a) = parts.iter().find(|s| s.as_str() != "Song" && s.as_str() != "Lied" && parse_length(s) == 0.0) {
                artists.push(a.clone());
            }
        }
        let thumbs = r["thumbnail"]["musicThumbnailRenderer"]["thumbnail"]["thumbnails"].as_array();
        let cover = thumbs
            .and_then(|t| t.last())
            .and_then(|t| t["url"].as_str())
            .map(|u| match u.find("=w") {
                Some(i) if u.contains("googleusercontent") => format!("{}=w544-h544-l90-rj", &u[..i]),
                _ => u.to_string(),
            })
            .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"));
        if title.is_empty() {
            continue;
        }
        out.push(json!({ "id": id, "title": title, "artist": artists.join(", "), "album": album, "duration": duration, "cover": cover }));
    }
    out
}

/// Songs on YouTube Music for a search, no key needed
pub fn music_search(query: &str) -> Result<Vec<Value>, String> {
    let body = json!({
        "context": { "client": { "clientName": "WEB_REMIX", "clientVersion": MUSIC_VERSION, "hl": "en", "gl": "DE" } },
        "query": query,
        "params": SONGS,
    });
    let res = ureq::post(MUSIC_ENDPOINT)
        .set("content-type", "application/json")
        .set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
        .set("x-youtube-client-name", "67")
        .set("x-youtube-client-version", MUSIC_VERSION)
        .set("origin", "https://music.youtube.com")
        .set("referer", "https://music.youtube.com/")
        .timeout(Duration::from_secs(8))
        .send_json(body)
        .map_err(|e| e.to_string())?
        .into_json::<Value>()
        .map_err(|e| e.to_string())?;
    Ok(parse_music(&res))
}

/// Songs as candidates for `best` (artist counts as the channel)
#[allow(dead_code)]
pub fn as_candidates(songs: &[Value]) -> Vec<Value> {
    songs
        .iter()
        .map(|s| json!({ "id": s["id"], "title": s["title"], "channel": format!("{} - Topic", s["artist"].as_str().unwrap_or("")), "duration": s["duration"] }))
        .collect()
}

/// Lower case, letters and digits only (keeps brackets' content, unlike `ext::norm`)
pub fn plain(s: &str) -> String {
    s.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Words that mean "not the original recording" (covers, piano versions, karaoke, ...).
const NOT_ORIGINAL: &[&str] = &[
    "cover", "piano", "klavier", "karaoke", "instrumental", "acoustic", "akustik", "live", "remix", "type beat",
    "8d", "slowed", "sped up", "nightcore", "reaction", "tutorial", "how to play", "lesson", "guitar", "drum",
    "bass cover", "orchestra", "orchestral", "lullaby", "music box", "spieluhr", "chipmunk", "reverb", "bass boosted",
    "mashup", "medley", "parody", "tribute", "kids", "kinder", "8 bit", "8-bit", "midi", "synthesia", "ai cover",
];

/// Like the Msik bot: YouTube's own order for "<artist> - <title>" decides, the first hit wins.
/// On top of the bot, versions that are not the original (piano, cover, live, ...) are left out
/// unless the song itself is one, the artist or title has to show up, and the length has to fit.
#[allow(dead_code)]
pub fn msik_order(videos: &[Value], title: &str, artist: &str, duration: f64) -> Vec<String> {
    let tn = plain(title);
    let an = plain(artist);
    let tw: Vec<String> = plain(&crate::ext::norm(title)).split_whitespace().map(String::from).collect();
    let aw: Vec<String> = plain(artist).split_whitespace().map(String::from).collect();
    videos
        .iter()
        .filter(|v| {
            let vt = plain(v["title"].as_str().unwrap_or(""));
            let ch = plain(v["channel"].as_str().unwrap_or(""));
            let hay = format!(" {vt} {ch} ");
            let has = |w: &str| hay.contains(&format!(" {w} ")) || hay.contains(&format!(" {w}"));
            if NOT_ORIGINAL.iter().any(|b| { let b = plain(b); has(&b) && !tn.contains(&b) && !an.contains(&b) }) {
                return false;
            }
            // most of the title words, and the artist in title or channel
            let tmatch = if tw.is_empty() { 1.0 } else { tw.iter().filter(|w| hay.contains(w.as_str())).count() as f64 / tw.len() as f64 };
            let amatch = aw.is_empty() || aw.iter().any(|w| w.len() > 1 && hay.contains(w.as_str()));
            if tmatch < 0.6 || !amatch {
                return false;
            }
            let d = v["duration"].as_f64().unwrap_or(0.0);
            !(duration > 0.0 && d > 0.0 && ((d - duration).abs() > (duration * 0.35).max(40.0)))
        })
        .filter_map(|v| v["id"].as_str().map(String::from))
        .collect()
}

/// The recording from Spotify among YouTube Music songs: the artist has to be one of the song's
/// artists, the title has to fit, versions that are not the original (live, piano, karaoke, ...)
/// only when the song is one, and of what is left the closest length wins (same recording),
/// YouTube Music's own order breaking ties.
pub fn pick_song(songs: &[Value], title: &str, artist: &str, duration: f64) -> Vec<String> {
    let tn = plain(&crate::ext::norm(title));
    let tfull = plain(title);
    let first = plain(artist.split(',').next().unwrap_or(""));
    let tw: Vec<&str> = tn.split_whitespace().collect();
    let mut ok: Vec<(f64, usize, String)> = Vec::new();
    for (i, s) in songs.iter().enumerate() {
        let st = plain(s["title"].as_str().unwrap_or(""));
        let sa = plain(s["artist"].as_str().unwrap_or(""));
        let sbase = plain(&crate::ext::norm(s["title"].as_str().unwrap_or("")));
        if !first.is_empty() && !sa.contains(&first) {
            continue;
        }
        let words_in = |hay: &str| tw.iter().filter(|w| hay.split_whitespace().any(|h| h == **w)).count() as f64 / tw.len().max(1) as f64;
        if words_in(&sbase) < 0.75 || (sbase.split_whitespace().count() as f64) > (tw.len() as f64 + 3.0) {
            continue;
        }
        let pad = format!(" {st} ");
        if NOT_ORIGINAL.iter().any(|b| { let b = plain(b); pad.contains(&format!(" {b} ")) && !tfull.contains(&b) }) {
            continue;
        }
        let d = s["duration"].as_f64().unwrap_or(0.0);
        let off = if duration > 0.0 && d > 0.0 { (d - duration).abs() } else { 0.0 };
        if duration > 0.0 && d > 0.0 && off > (duration * 0.12).max(15.0) {
            continue;
        }
        // whole seconds count, small differences (rounding, 1-2 s) are the same recording
        ok.push(((off / 3.0).floor(), i, s["id"].as_str().unwrap_or("").to_string()));
    }
    ok.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    ok.into_iter().map(|x| x.2).filter(|x| !x.is_empty()).collect()
}

fn words(s: &str) -> Vec<String> {
    crate::ext::norm(s).split_whitespace().map(String::from).collect()
}

/// The best video for a song: title and artist words in the title or channel, length close
/// to the song, official uploads ("- Topic", VEVO, "official audio") preferred, covers, live
/// versions, remixes and "type beats" pushed down.
#[allow(dead_code)]
pub fn best(videos: &[Value], title: &str, artist: &str, duration: f64) -> Option<String> {
    rank(videos, title, artist, duration).into_iter().next()
}

/// Whether YouTube lets other sites play the video (labels often switch that off). oEmbed answers
/// 401/403 for those; anything unclear counts as playable, the app then asks for the next one.
pub fn embeddable(id: &str) -> bool {
    let url = format!("https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D{id}");
    !matches!(
        ureq::get(&url).timeout(Duration::from_secs(5)).call(),
        Err(ureq::Error::Status(401 | 403 | 404, _))
    )
}

/// All good matches for a song, best first (same scoring as `best`).
pub fn rank(videos: &[Value], title: &str, artist: &str, duration: f64) -> Vec<String> {
    let tw = words(title);
    let aw = words(artist);
    let want_extra = |w: &str| crate::ext::norm(title).contains(w);
    let mut all: Vec<(f64, String)> = Vec::new();
    for (i, v) in videos.iter().take(10).enumerate() {
        let vt = v["title"].as_str().unwrap_or("").to_lowercase();
        let ch = v["channel"].as_str().unwrap_or("").to_lowercase();
        let hay = crate::ext::norm(&format!("{vt} {ch}"));
        let mut s = 0.0;
        if !tw.is_empty() {
            s += 4.0 * tw.iter().filter(|w| hay.contains(w.as_str())).count() as f64 / tw.len() as f64;
        }
        if !aw.is_empty() {
            s += 3.0 * aw.iter().filter(|w| hay.contains(w.as_str())).count() as f64 / aw.len() as f64;
        }
        let d = v["duration"].as_f64().unwrap_or(0.0);
        if duration > 0.0 && d > 0.0 {
            let off = (d - duration).abs();
            s += if off <= 3.0 { 3.0 } else if off <= 10.0 { 2.0 } else if off <= 30.0 { 0.5 } else { -2.0 };
        }
        if ch.ends_with("- topic") || ch.contains("vevo") {
            s += 1.5;
        }
        if vt.contains("official audio") || vt.contains("official video") || vt.contains("official music video") {
            s += 1.0;
        }
        for bad in ["cover", "live", "remix", "karaoke", "instrumental", "type beat", "8d", "slowed", "sped up", "nightcore", "reaction", "lyrics video"] {
            if vt.contains(bad) && !want_extra(bad) {
                s -= 2.0;
            }
        }
        s -= i as f64 * 0.15; // YouTube's own order counts a little
        let id = v["id"].as_str().unwrap_or("").to_string();
        if s > 3.0 && !id.is_empty() {
            all.push((s, id));
        }
    }
    all.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    all.into_iter().map(|x| x.1).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths() {
        assert_eq!(parse_length("3:25"), 205.0);
        assert_eq!(parse_length("1:02:03"), 3723.0);
        assert_eq!(parse_length(""), 0.0);
    }

    #[test]
    fn picks_the_real_song() {
        let v = vec![
            json!({"id":"a","title":"Californication (Cover by Someone)","channel":"Someone","duration":330.0}),
            json!({"id":"b","title":"Red Hot Chili Peppers - Californication [Official Music Video]","channel":"Red Hot Chili Peppers","duration":331.0}),
            json!({"id":"c","title":"Californication","channel":"Red Hot Chili Peppers - Topic","duration":329.0}),
        ];
        let id = best(&v, "Californication", "Red Hot Chili Peppers", 329.0).unwrap();
        assert!(id == "b" || id == "c");
        assert_eq!(best(&v, "Something else entirely", "Nobody", 100.0), None);
    }

    #[test]
    fn parses_a_real_answer() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/yt-search.json");
        if let Ok(t) = std::fs::read_to_string(p) {
            let v = parse_search(&serde_json::from_str(&t).unwrap());
            assert!(v.len() >= 5);
            assert!(v.iter().all(|x| x["id"].as_str().unwrap().len() == 11 && x["duration"].as_f64().unwrap() > 0.0));
        }
    }

    #[test]
    fn parses_music_songs() {
        let run = |t: &str, page: &str| json!({"text": t, "navigationEndpoint": {"browseEndpoint": {"browseEndpointContextSupportedConfigs": {"browseEndpointContextMusicConfig": {"pageType": page}}}}});
        let item = |id: &str, kind: &str| json!({"musicResponsiveListItemRenderer": {
            "playlistItemData": {"videoId": id},
            "thumbnail": {"musicThumbnailRenderer": {"thumbnail": {"thumbnails": [{"url": "https://lh3.googleusercontent.com/abc=w60-h60-l90-rj"}]}}},
            "flexColumns": [
                {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "Handwerker", "navigationEndpoint": {"watchEndpoint": {"videoId": id, "watchEndpointMusicSupportedConfigs": {"watchEndpointMusicConfig": {"musicVideoType": kind}}}}}]}}},
                {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [run("Mickie Krause", "MUSIC_PAGE_TYPE_ARTIST"), {"text": " & "}, run("Julian Sommer", "MUSIC_PAGE_TYPE_ARTIST"), {"text": " • "}, run("Handwerker", "MUSIC_PAGE_TYPE_ALBUM"), {"text": " • "}, {"text": "3:01"}]}}}
            ]}});
        let answer = json!({"contents": {"tabbedSearchResultsRenderer": {"tabs": [{"tabRenderer": {"content": {"sectionListRenderer": {"contents": [{"musicShelfRenderer": {"contents": [item("aaaaaaaaaaa", "MUSIC_VIDEO_TYPE_ATV"), item("bbbbbbbbbbb", "MUSIC_VIDEO_TYPE_OMV")]}}]}}}}]}}});
        let v = parse_music(&answer);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["id"], "aaaaaaaaaaa");
        assert_eq!(v[0]["artist"], "Mickie Krause, Julian Sommer");
        assert_eq!(v[0]["album"], "Handwerker");
        assert_eq!(v[0]["duration"], 181.0);
        assert_eq!(v[0]["cover"], "https://lh3.googleusercontent.com/abc=w544-h544-l90-rj");
        let c = as_candidates(&v);
        assert_eq!(best(&c, "Handwerker", "Mickie Krause", 181.0).as_deref(), Some("aaaaaaaaaaa"));
    }

    #[test]
    fn msik_order_skips_piano_versions() {
        let v = vec![
            json!({"id":"p","title":"When I Come Around - Green Day (Piano Cover)","channel":"Piano Guy","duration":178.0}),
            json!({"id":"k","title":"Green Day - When I Come Around (Karaoke)","channel":"Sing King","duration":180.0}),
            json!({"id":"o","title":"Green Day - When I Come Around [Official Music Video]","channel":"Green Day","duration":186.0}),
            json!({"id":"x","title":"Something else","channel":"Green Day","duration":178.0}),
        ];
        assert_eq!(msik_order(&v, "When I Come Around", "Green Day", 178.0), vec!["o".to_string()]);
        // a live song stays live
        let l = vec![json!({"id":"l","title":"Green Day - Basket Case (Live)","channel":"Green Day","duration":200.0})];
        assert_eq!(msik_order(&l, "Basket Case - Live", "Green Day", 200.0), vec!["l".to_string()]);
    }

    #[test]
    fn other_songs_of_the_artist_never_match() {
        let v = vec![json!({"id":"s","title":"Red Hot Chili Peppers - Scar Tissue [Official Music Video]","channel":"Red Hot Chili Peppers","duration":217.0})];
        assert!(msik_order(&v, "Californication", "Red Hot Chili Peppers", 329.0).is_empty());
        assert_eq!(msik_order(&v, "Scar Tissue", "Red Hot Chili Peppers", 215.0), vec!["s".to_string()]);
    }

    #[test]
    fn picks_the_spotify_recording_on_youtube_music() {
        let s = |id: &str, t: &str, a: &str, d: f64| json!({"id": id, "title": t, "artist": a, "duration": d});
        let songs = vec![
            s("tribute", "Californication", "Rock Tribute Band", 330.0),
            s("live", "Californication (Live)", "Red Hot Chili Peppers", 345.0),
            s("rerec", "Californication", "Red Hot Chili Peppers", 312.0),
            s("orig", "Californication", "Red Hot Chili Peppers", 329.0),
            s("scar", "Scar Tissue", "Red Hot Chili Peppers", 215.0),
            s("piano", "Californication (Piano Version)", "Red Hot Chili Peppers", 329.0),
        ];
        assert_eq!(pick_song(&songs, "Californication", "Red Hot Chili Peppers", 329.0).first().map(String::as_str), Some("orig"));
        assert_eq!(pick_song(&songs, "Scar Tissue", "Red Hot Chili Peppers", 215.0), vec!["scar".to_string()]);
        assert!(pick_song(&songs, "When I Come Around", "Green Day", 178.0).is_empty());
        // Spotify titles with extras still match
        assert_eq!(pick_song(&songs, "Scar Tissue - Remastered", "Red Hot Chili Peppers, Someone", 216.0), vec!["scar".to_string()]);
    }

    #[test]
    fn parses_a_real_music_answer() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ytm-search.json");
        let v = parse_music(&serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap());
        assert!(v.len() >= 5);
        assert_eq!(v[0]["title"], "SICKO MODE");
        assert_eq!(v[0]["artist"], "Travis Scott");
        assert_eq!(v[0]["album"], "ASTROWORLD");
        assert_eq!(v[0]["duration"], 313.0);
        assert_eq!(pick_song(&v, "SICKO MODE", "Travis Scott, Drake", 312.8).first().map(String::as_str), Some("NQbkGDoD7B0"));
    }
}
