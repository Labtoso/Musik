//! "Your Top Songs <year>": one playlist per year, made from what someone really played that year,
//! like the yearly lists on Spotify. A play counts once it ran 30 seconds or to the end. Songs from
//! the own library and from the catalog (Spotify / Deezer / YouTube) are counted together, the same
//! song from both sides only once (the own file wins, it plays without the internet).
//!
//! `GET /api/topsongs?tz=<minutes east of UTC>` → `[{ year, plays, songs, tracks: [{track} | {ext}] }]`,
//! newest year first. The current year is there too and grows while it runs.

use crate::api::{Auth, St, R, TRACK_COLS};
use crate::taste::{excluded_keys, song_key};
use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Up to this many songs per year, like Spotify.
pub const PER_YEAR: usize = 100;
/// A year needs at least this many different songs to get its own list.
pub const MIN_SONGS: usize = 5;

/// The year of a moment (ms since 1970, shifted to local time), without a date library.
pub fn year_of(ms: i64) -> i32 {
    let days = ms.div_euclid(86_400_000);
    // days → civil date (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2)) as i32
}

struct Count {
    n: u32,
    last: i64,
    item: Value,
}

/// Counts plays per year and song. `tz` = minutes east of UTC.
pub fn top_songs(db: &Connection, user_id: i64, tz: i64) -> Vec<Value> {
    let shift = tz * 60_000;
    let left_out = excluded_keys(db, user_id);
    // year → song key → count
    let mut years: HashMap<i32, HashMap<String, Count>> = HashMap::new();
    let mut bump = |year: i32, key: String, ts: i64, item: &dyn Fn() -> Value| {
        let e = years.entry(year).or_default().entry(key).or_insert_with(|| Count { n: 0, last: 0, item: item() });
        e.n += 1;
        e.last = e.last.max(ts);
    };

    // own files
    let mut local: HashMap<i64, Value> = HashMap::new();
    {
        let sql = format!(
            "SELECT p.ts, {} FROM plays p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = ? AND (p.kind = 'complete' OR p.played >= 30)",
            TRACK_COLS.split(", ").map(|c| format!("t.{c}")).collect::<Vec<_>>().join(", ")
        );
        let mut s = db.prepare(&sql).unwrap();
        let rows: Vec<(i64, Value)> = s
            .query_map([user_id], |r| {
                let ts: i64 = r.get(0)?;
                // the same fields as api::track_json, one column further on
                let v = json!({
                    "id": r.get::<_, i64>(1)?, "title": r.get::<_, String>(2)?, "artist": r.get::<_, String>(3)?,
                    "album": r.get::<_, String>(4)?, "album_artist": r.get::<_, String>(5)?, "genre": r.get::<_, String>(6)?,
                    "year": r.get::<_, Option<i64>>(7)?, "track_no": r.get::<_, Option<i64>>(8)?, "disc_no": r.get::<_, Option<i64>>(9)?,
                    "duration": r.get::<_, f64>(10)?, "has_cover": r.get::<_, i64>(11)? != 0, "added": r.get::<_, i64>(12)?,
                });
                Ok((ts, v))
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        for (ts, v) in rows {
            let key = song_key(v["artist"].as_str().unwrap_or(""), v["title"].as_str().unwrap_or(""));
            if left_out.contains(&key) {
                continue;
            }
            let id = v["id"].as_i64().unwrap_or(0);
            local.entry(id).or_insert_with(|| v.clone());
            bump(year_of(ts + shift), key, ts, &|| json!({ "track": id }));
        }
    }
    // catalog songs
    {
        let mut s = db
            .prepare("SELECT key, ts, data FROM ext_plays WHERE user_id = ? AND kind != 'skip' AND (kind = 'complete' OR played >= 30)")
            .unwrap();
        let rows: Vec<(String, i64, String)> =
            s.query_map([user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().filter_map(Result::ok).collect();
        for (key, ts, data) in rows {
            if left_out.contains(&key) {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&data) else { continue };
            bump(year_of(ts + shift), key, ts, &|| json!({ "ext": crate::taste::as_catalog(&v) }));
        }
    }

    let likes: std::collections::HashSet<i64> = db
        .prepare("SELECT track_id FROM likes WHERE user_id = ?")
        .unwrap()
        .query_map([user_id], |r| r.get(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    let liked: HashMap<i64, Value> = local
        .into_iter()
        .map(|(id, mut v)| {
            v["liked"] = json!(likes.contains(&id));
            (id, v)
        })
        .collect();
    let mut out: Vec<Value> = years
        .into_iter()
        .filter(|(_, m)| m.len() >= MIN_SONGS)
        .map(|(year, m)| {
            let plays: u32 = m.values().map(|c| c.n).sum();
            let songs = m.len();
            let mut v: Vec<Count> = m.into_values().collect();
            v.sort_by(|a, b| b.n.cmp(&a.n).then(b.last.cmp(&a.last)));
            let tracks: Vec<Value> = v
                .into_iter()
                .take(PER_YEAR)
                .filter_map(|c| match c.item["track"].as_i64() {
                    Some(id) => liked.get(&id).map(|t| json!({ "track": t, "plays": c.n })),
                    None => Some(json!({ "ext": c.item["ext"], "plays": c.n })),
                })
                .collect();
            json!({ "year": year, "plays": plays, "songs": songs, "tracks": tracks })
        })
        .collect();
    out.sort_by(|a, b| b["year"].as_i64().cmp(&a["year"].as_i64()));
    out
}

pub fn routes() -> Router<St> {
    Router::new().route("/topsongs", get(topsongs_route))
}

async fn topsongs_route(State(st): State<St>, Auth(u, _): Auth, Query(q): Query<HashMap<String, String>>) -> R {
    let tz = q.get("tz").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0).clamp(-14 * 60, 14 * 60);
    let db = st.db.lock().unwrap();
    Ok(Json(json!(top_songs(&db, u.id, tz))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn years_from_ms() {
        assert_eq!(year_of(0), 1970);
        assert_eq!(year_of(1_704_067_199_000), 2023); // 2023-12-31 23:59:59 UTC
        assert_eq!(year_of(1_704_067_200_000), 2024); // 2024-01-01 00:00:00 UTC
        assert_eq!(year_of(1_735_689_599_000), 2024);
        assert_eq!(year_of(1_798_761_600_000), 2027);
    }

    #[test]
    fn counts_per_year_and_merges_both_sides() {
        let db = crate::db::open(None).unwrap();
        db.execute("INSERT INTO users (id, name, pass_hash, admin, created) VALUES (1, 'a', 'x', 1, 0)", []).ok();
        let y24 = 1_710_000_000_000i64; // March 2024
        let y25 = 1_740_000_000_000i64; // Feb 2025
        for i in 0..6 {
            db.execute(
                "INSERT INTO tracks (id, path, title, artist, duration, added) VALUES (?, ?, ?, 'Band', 200, 0)",
                rusqlite::params![i + 1, format!("/m/{i}.mp3"), format!("Song {i}")],
            )
            .unwrap();
        }
        let play = |id: i64, ts: i64, kind: &str, played: f64| {
            db.execute("INSERT INTO plays (user_id, track_id, ts, played, duration, kind) VALUES (1,?,?,?,200,?)", rusqlite::params![id, ts, played, kind]).unwrap();
        };
        // 2024: track 3 ("Song 2") three times, the rest once; an early skip does not count
        for i in 1..=5 {
            play(i, y24 + i * 1000, "complete", 200.0);
        }
        play(3, y24 + 9000, "complete", 200.0);
        play(3, y24 + 9500, "partial", 40.0);
        play(1, y24 + 9900, "skip", 5.0);
        // the same song from the catalog adds to the own file
        let song = json!({ "source": "spotify", "ext_id": "x", "title": "Song 0", "artist": "Band", "cover": "" });
        crate::taste::record(&db, 1, &song, "complete", 200.0, 200.0, y24 + 20_000);
        crate::taste::record(&db, 1, &song, "complete", 200.0, 200.0, y24 + 21_000);
        // 2025: too few songs for a list
        play(6, y25, "complete", 200.0);
        let v = top_songs(&db, 1, 0);
        assert_eq!(v.len(), 1, "{v:?}");
        assert_eq!(v[0]["year"], 2024);
        let tr = v[0]["tracks"].as_array().unwrap();
        // "Song 0": 1 own + 2 catalog plays (the skip does not count), played last → first
        assert_eq!(tr[0]["track"]["title"], "Song 0");
        assert_eq!(tr[0]["plays"], 3);
        assert_eq!(tr[1]["track"]["title"], "Song 2");
        assert_eq!(tr[1]["plays"], 3);
        assert_eq!(tr.len(), 5);
        assert_eq!(v[0]["songs"], 5);
    }
}
