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
        "context": { "client": { "clientName": "WEB", "clientVersion": VERSION, "hl": "en", "gl": "DE" } },
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

fn words(s: &str) -> Vec<String> {
    crate::ext::norm(s).split_whitespace().map(String::from).collect()
}

/// The best video for a song: title and artist words in the title or channel, length close
/// to the song, official uploads ("- Topic", VEVO, "official audio") preferred, covers, live
/// versions, remixes and "type beats" pushed down.
pub fn best(videos: &[Value], title: &str, artist: &str, duration: f64) -> Option<String> {
    let tw = words(title);
    let aw = words(artist);
    let want_extra = |w: &str| crate::ext::norm(title).contains(w);
    let mut best: Option<(f64, String)> = None;
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
        if best.as_ref().map(|b| s > b.0).unwrap_or(true) {
            best = Some((s, v["id"].as_str().unwrap_or("").to_string()));
        }
    }
    best.filter(|b| b.0 > 3.0 && !b.1.is_empty()).map(|b| b.1)
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
}
