use crate::db::now_ms;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::PictureType;
use lofty::tag::{Accessor, ItemKey};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

pub const AUDIO_TYPES: &[(&str, &str)] = &[
    ("mp3", "audio/mpeg"),
    ("flac", "audio/flac"),
    ("m4a", "audio/mp4"),
    ("mp4", "audio/mp4"),
    ("aac", "audio/aac"),
    ("ogg", "audio/ogg"),
    ("oga", "audio/ogg"),
    ("opus", "audio/ogg"),
    ("wav", "audio/wav"),
    ("webm", "audio/webm"),
];

const COVER_FILES: &[&str] = &["cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "front.png", "album.jpg", "album.png"];

pub fn audio_type(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    AUDIO_TYPES.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m)
}

#[derive(Debug, Default, Clone)]
pub struct Tags {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub year: Option<i64>,
    pub track_no: Option<i64>,
    pub disc_no: Option<i64>,
    pub duration: f64,
    pub has_cover: bool,
}

fn clean(s: Option<impl AsRef<str>>) -> String {
    s.map(|v| v.as_ref().replace('\0', "").trim().to_string()).unwrap_or_default()
}

fn strip_track_number(s: &str) -> &str {
    let t = s.trim_start();
    let digits = t.len() - t.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 {
        return t;
    }
    let rest = &t[digits..];
    let after = rest.trim_start_matches(|c: char| c == ' ' || c == '.' || c == '-');
    if after.len() < rest.len() && !after.is_empty() {
        after
    } else {
        t
    }
}

/// Reads the tags of a file. Falls back to "Artist - Title" in the file name.
pub fn read_tags(path: &Path) -> Tags {
    let mut t = Tags::default();
    if let Ok(tf) = lofty::read_from_path(path) {
        t.duration = tf.properties().duration().as_secs_f64();
        if let Some(tag) = tf.primary_tag().or_else(|| tf.first_tag()) {
            t.title = clean(tag.title());
            t.artist = clean(tag.artist());
            t.album = clean(tag.album());
            t.genre = clean(tag.genre());
            t.album_artist = clean(tag.get_string(&ItemKey::AlbumArtist));
            t.year = tag.year().map(|y| y as i64).or_else(|| {
                tag.get_string(&ItemKey::RecordingDate).and_then(|d| d.get(..4)).and_then(|y| y.parse().ok())
            });
            t.track_no = tag.track().map(|v| v as i64);
            t.disc_no = tag.disk().map(|v| v as i64);
            t.has_cover = !tag.pictures().is_empty();
        }
        if !t.has_cover {
            t.has_cover = tf.tags().iter().any(|tag| !tag.pictures().is_empty());
        }
    }
    if t.title.is_empty() {
        let base = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let stripped = strip_track_number(&base);
        if let Some((a, b)) = stripped.split_once(" - ") {
            if t.artist.is_empty() {
                t.artist = a.trim().to_string();
            }
            t.title = b.trim().to_string();
        } else {
            t.title = if stripped.trim().is_empty() { base.clone() } else { stripped.trim().to_string() };
        }
    }
    t
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ScanResult {
    pub at: i64,
    pub ms: i64,
    pub added: u64,
    pub updated: u64,
    pub removed: u64,
    pub total: i64,
}

pub struct Library {
    pub music_dirs: Vec<PathBuf>,
    pub upload_dir: Option<PathBuf>,
    pub cache_dir: Option<PathBuf>,
    pub scanning: AtomicBool,
    pub found: AtomicU64,
    pub done: AtomicU64,
    pub last_scan: Mutex<Option<ScanResult>>,
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn path_str(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

impl Library {
    pub fn new(music_dirs: Vec<PathBuf>, upload_dir: Option<PathBuf>, cache_dir: Option<PathBuf>) -> Self {
        Library {
            music_dirs,
            upload_dir,
            cache_dir,
            scanning: AtomicBool::new(false),
            found: AtomicU64::new(0),
            done: AtomicU64::new(0),
            last_scan: Mutex::new(None),
        }
    }

    pub fn roots(&self) -> Vec<PathBuf> {
        let mut r = self.music_dirs.clone();
        if let Some(u) = &self.upload_dir {
            if !r.contains(u) {
                r.push(u.clone());
            }
        }
        r
    }

    /// Full scan; only changed files are read again. Locks the database per batch.
    pub fn scan(&self, db: &Arc<Mutex<Connection>>) -> Option<ScanResult> {
        if self.scanning.swap(true, Ordering::SeqCst) {
            return None;
        }
        let started = now_ms();
        self.found.store(0, Ordering::Relaxed);
        self.done.store(0, Ordering::Relaxed);
        let known: HashMap<String, (i64, i64, i64)> = {
            let c = db.lock().unwrap();
            let mut st = c.prepare("SELECT id, path, mtime, size FROM tracks").unwrap();
            st.query_map([], |r| Ok((r.get::<_, String>(1)?, (r.get(0)?, r.get(2)?, r.get(3)?))))
                .unwrap()
                .filter_map(Result::ok)
                .collect()
        };
        let mut seen = HashSet::new();
        let (mut added, mut updated) = (0u64, 0u64);
        let mut batch: Vec<(PathBuf, i64, i64, Tags)> = Vec::new();
        let flush = |batch: &mut Vec<(PathBuf, i64, i64, Tags)>| {
            if batch.is_empty() {
                return;
            }
            let mut c = db.lock().unwrap();
            let tx = c.transaction().unwrap();
            for (p, size, mtime, tags) in batch.drain(..) {
                upsert(&tx, &p, size, mtime, &tags);
            }
            tx.commit().ok();
        };
        for root in self.roots() {
            if !root.exists() {
                continue;
            }
            for entry in walkdir::WalkDir::new(&root)
                .follow_links(true)
                .into_iter()
                .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
                .filter_map(Result::ok)
            {
                if !entry.file_type().is_file() || audio_type(entry.path()).is_none() {
                    continue;
                }
                self.found.fetch_add(1, Ordering::Relaxed);
                let p = entry.path().to_path_buf();
                let ps = path_str(&p);
                seen.insert(ps.clone());
                let Ok(meta) = entry.metadata() else { continue };
                let (size, mtime) = (meta.len() as i64, mtime_ms(&meta));
                if let Some((_, km, ks)) = known.get(&ps) {
                    if *km == mtime && *ks == size {
                        self.done.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    updated += 1;
                } else {
                    added += 1;
                }
                let tags = read_tags(&p);
                batch.push((p, size, mtime, tags));
                self.done.fetch_add(1, Ordering::Relaxed);
                if batch.len() >= 200 {
                    flush(&mut batch);
                }
            }
        }
        flush(&mut batch);
        // Remove tracks whose files are gone (only inside the scanned roots).
        let roots: Vec<PathBuf> = self.roots();
        let mut removed = 0u64;
        {
            let mut c = db.lock().unwrap();
            let tx = c.transaction().unwrap();
            for (p, (id, _, _)) in &known {
                if seen.contains(p) {
                    continue;
                }
                let pp = Path::new(p);
                if !roots.iter().any(|r| pp.starts_with(r)) || pp.exists() {
                    continue;
                }
                tx.execute("DELETE FROM tracks WHERE id = ?", [id]).ok();
                removed += 1;
            }
            tx.commit().ok();
        }
        let total = db.lock().unwrap().query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0)).unwrap_or(0);
        let res = ScanResult { at: now_ms(), ms: now_ms() - started, added, updated, removed, total };
        *self.last_scan.lock().unwrap() = Some(res.clone());
        self.scanning.store(false, Ordering::SeqCst);
        Some(res)
    }

    /// Indexes a single file right away (after an upload).
    pub fn add_file(&self, db: &Connection, p: &Path) -> Option<i64> {
        let meta = std::fs::metadata(p).ok()?;
        let tags = read_tags(p);
        upsert(db, p, meta.len() as i64, mtime_ms(&meta), &tags);
        db.query_row("SELECT id FROM tracks WHERE path = ?", [path_str(p)], |r| r.get(0)).ok()
    }

    /// Cover image of a track: embedded picture, else cover.jpg/folder.jpg next to the file.
    pub fn cover(&self, id: i64, path: &str, mtime: i64, has_cover: bool) -> Option<(Vec<u8>, &'static str)> {
        if let Some(cache) = &self.cache_dir {
            for (ext, mime) in [("jpg", "image/jpeg"), ("png", "image/png")] {
                let f = cache.join(format!("{id}-{mtime}.{ext}"));
                if let Ok(data) = std::fs::read(&f) {
                    return Some((data, mime));
                }
            }
        }
        let mut result: Option<(Vec<u8>, &'static str)> = None;
        if has_cover {
            if let Ok(tf) = lofty::read_from_path(path) {
                let pics: Vec<_> = tf.tags().iter().flat_map(|t| t.pictures().iter().cloned()).collect();
                let pic = pics.iter().find(|p| p.pic_type() == PictureType::CoverFront).or(pics.first());
                if let Some(p) = pic {
                    let mime = match p.mime_type() {
                        Some(lofty::picture::MimeType::Png) => "image/png",
                        _ => "image/jpeg",
                    };
                    result = Some((p.data().to_vec(), mime));
                }
            }
        }
        if result.is_none() {
            if let Some(dir) = Path::new(path).parent() {
                if let Ok(rd) = std::fs::read_dir(dir) {
                    let names: HashMap<String, PathBuf> =
                        rd.filter_map(Result::ok).map(|e| (e.file_name().to_string_lossy().to_lowercase(), e.path())).collect();
                    for c in COVER_FILES {
                        if let Some(p) = names.get(*c) {
                            if let Ok(data) = std::fs::read(p) {
                                result = Some((data, if c.ends_with(".png") { "image/png" } else { "image/jpeg" }));
                                break;
                            }
                        }
                    }
                }
            }
        }
        if let (Some((data, mime)), Some(cache)) = (&result, &self.cache_dir) {
            std::fs::create_dir_all(cache).ok();
            let ext = if *mime == "image/png" { "png" } else { "jpg" };
            std::fs::write(cache.join(format!("{id}-{mtime}.{ext}")), data).ok();
        }
        result
    }
}

fn upsert(db: &Connection, p: &Path, size: i64, mtime: i64, t: &Tags) {
    db.execute(
        "INSERT INTO tracks (path, title, artist, album, album_artist, genre, year, track_no, disc_no, duration, size, mtime, has_cover, added)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album,
           album_artist=excluded.album_artist, genre=excluded.genre, year=excluded.year, track_no=excluded.track_no,
           disc_no=excluded.disc_no, duration=excluded.duration, size=excluded.size, mtime=excluded.mtime, has_cover=excluded.has_cover",
        params![
            path_str(p),
            t.title,
            t.artist,
            t.album,
            t.album_artist,
            t.genre,
            t.year,
            t.track_no,
            t.disc_no,
            t.duration,
            size,
            mtime,
            t.has_cover as i64,
            now_ms()
        ],
    )
    .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_number_is_stripped() {
        assert_eq!(strip_track_number("01 - Artist - Title"), "Artist - Title");
        assert_eq!(strip_track_number("03. Song"), "Song");
        assert_eq!(strip_track_number("1999"), "1999");
        assert_eq!(strip_track_number("Song"), "Song");
    }
}
