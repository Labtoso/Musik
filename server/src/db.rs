use rusqlite::Connection;
use std::path::Path;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  client TEXT
);
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  album_artist TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '',
  year INTEGER,
  track_no INTEGER,
  disc_no INTEGER,
  duration REAL NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  has_cover INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tracks_artist ON tracks(artist COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  played REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_user_ts ON plays(user_id, ts);
CREATE INDEX IF NOT EXISTS plays_track ON plays(track_id);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  PRIMARY KEY (playlist_id, pos)
);
"#;

pub fn open(data_dir: Option<&Path>) -> rusqlite::Result<Connection> {
    let conn = match data_dir {
        Some(d) => {
            std::fs::create_dir_all(d).ok();
            Connection::open(d.join("musik.db"))?
        }
        None => Connection::open_in_memory()?,
    };
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    )?;
    conn.execute_batch(SCHEMA)?;
    conn.execute_batch(crate::ext::SCHEMA)?;
    // columns added later (fails harmlessly when they exist)
    let _ = conn.execute("ALTER TABLE imports ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'", []);
    Ok(conn)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
