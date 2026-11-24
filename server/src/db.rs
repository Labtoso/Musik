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
            // the file was called musik.db before the app was renamed
            let mut db = d.join("streyn.db");
            if !db.exists() && d.join("musik.db").exists() && d.join("streyn.db-wal").exists() {
                // a WAL left over from a move that could not be undone: musik.db must not be
                // opened without it, so stop until the files are put back by hand
                let wal = d.join("streyn.db-wal");
                eprintln!("{} exists without streyn.db; move it back to musik.db-wal before starting", wal.display());
                return Err(rusqlite::Error::InvalidPath(wal));
            }
            if !db.exists() && d.join("musik.db").exists() {
                // side files first, the main file last; on any failure undo and keep using musik.db,
                // so a half-moved database (main file without its WAL) is never opened
                let mut moved: Vec<&str> = Vec::new();
                let mut ok = true;
                for ext in ["-wal", "-shm", ""] {
                    let (from, to) = (d.join(format!("musik.db{ext}")), d.join(format!("streyn.db{ext}")));
                    if !from.exists() {
                        continue;
                    }
                    match std::fs::rename(&from, &to) {
                        Ok(()) => moved.push(ext),
                        Err(e) => {
                            eprintln!("could not rename {} to {}: {e}", from.display(), to.display());
                            ok = false;
                            break;
                        }
                    }
                }
                if !ok {
                    for ext in moved {
                        let (from, to) = (d.join(format!("streyn.db{ext}")), d.join(format!("musik.db{ext}")));
                        if let Err(e) = std::fs::rename(&from, &to) {
                            // musik.db without its WAL must not be opened: stop instead.
                            eprintln!("could not move {} back to {}: {e}", from.display(), to.display());
                            return Err(rusqlite::Error::InvalidPath(to));
                        }
                    }
                    db = d.join("musik.db");
                }
            }
            Connection::open(db)?
        }
        None => Connection::open_in_memory()?,
    };
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    )?;
    conn.execute_batch(SCHEMA)?;
    conn.execute_batch(crate::ext::SCHEMA)?;
    conn.execute_batch(crate::offline::SCHEMA)?;
    // copies that were running when the process ended will not finish any more
    conn.execute("UPDATE offline_sets SET state = 'error' WHERE state = 'loading'", [])?;
    conn.execute_batch(crate::taste::SCHEMA)?;
    conn.execute_batch(crate::invite::SCHEMA)?;
    conn.execute_batch(crate::podcast::SCHEMA)?;
    // columns added later (fails harmlessly when they exist)
    let _ = conn.execute("ALTER TABLE imports ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'", []);
    let _ = conn.execute("ALTER TABLE imports ADD COLUMN kept INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE playlists ADD COLUMN description TEXT NOT NULL DEFAULT ''", []);
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS playlist_members (
           playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
           user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           added INTEGER NOT NULL,
           PRIMARY KEY (playlist_id, user_id));",
    )?;
    // 'edit' = contributor (adds and removes songs), 'listen' = listener (only listens)
    let _ = conn.execute("ALTER TABLE playlist_members ADD COLUMN role TEXT NOT NULL DEFAULT 'edit'", []);
    // after every update the remembered YouTube matches are looked up again (better matching each time)
    conn.execute_batch("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);")?;
    let seen: Option<String> = conn.query_row("SELECT v FROM kv WHERE k = 'version'", [], |r| r.get(0)).ok();
    if seen.as_deref() != Some(crate::api::VERSION) {
        conn.execute("DELETE FROM yt_find", [])?;
        conn.execute("INSERT INTO kv (k, v) VALUES ('version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [crate::api::VERSION])?;
    }
    Ok(conn)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
