//! Streyn Setup: installs Streyn for the current user, the way Spotify does it.
//!
//! - one plain Rust program, no installer framework, no plug-in DLLs unpacked to %TEMP%
//! - no administrator rights (manifest: asInvoker), no services, no autostart, no scheduled tasks
//! - writes exactly: %APPDATA%\Streyn\Streyn.exe and streyn-server.exe (where Spotify keeps
//!   Spotify.exe), the Start menu shortcut (plus a Desktop shortcut on the first install) and its
//!   own entry under HKCU\...\Uninstall\Streyn so it shows up in "Installed apps"
//! - the app keeps its data like Spotify: %APPDATA%\Streyn\prefs and %LOCALAPPDATA%\Streyn\
//!   Browser, Storage (offline downloads) and Data; the app moves the files of earlier versions
//! - removes the program files of earlier versions from %LOCALAPPDATA%\Streyn (only those names)
//! - never looks at other processes: a running Streyn keeps running from its renamed old file
//!   (Windows allows renaming a running program), the new files are used on the next start
//!
//! Arguments: /S silent (no message boxes, no start afterwards), /R start Streyn afterwards
//! (also without /S; kept for the updater of older versions), /P accepted and ignored.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use sha2::{Digest, Sha256};
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

const VERSION: &str = env!("STREYN_VERSION");
const APP_EXE: &str = "Streyn.exe";
const SERVER_EXE: &str = "streyn-server.exe";

static APP_BIN: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/app.bin"));
static SERVER_BIN: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/server.bin"));

struct Payload {
    name: &'static str,
    packed: &'static [u8],
    sha256: &'static str,
}

fn payloads() -> [Payload; 2] {
    [
        Payload { name: APP_EXE, packed: APP_BIN, sha256: env!("STREYN_APP_SHA256") },
        Payload { name: SERVER_EXE, packed: SERVER_BIN, sha256: env!("STREYN_SERVER_SHA256") },
    ]
}

/// Checks one embedded program file against the hash taken at build time. The files are stored
/// uncompressed, exactly as they are installed.
fn unpack(p: &Payload) -> Result<&'static [u8], String> {
    if p.packed.is_empty() {
        return Err(format!("{} is missing in this setup", p.name));
    }
    let got = format!("{:x}", Sha256::digest(p.packed));
    if got != p.sha256 {
        return Err(format!("{} is damaged (checksum)", p.name));
    }
    Ok(p.packed)
}

#[derive(Debug, Default, PartialEq)]
struct Args {
    silent: bool,
    launch: bool,
}

fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Args {
    let mut a = Args { silent: false, launch: true };
    let mut restart = false;
    for s in args {
        match s.to_ascii_uppercase().as_str() {
            "/S" | "--SILENT" => a.silent = true,
            "/R" => restart = true,
            _ => {}
        }
    }
    if a.silent {
        a.launch = restart;
    }
    a
}

/// Writes `data` to `dir/name`. The file is first written next to the target and then moved into
/// place. If the old file is in use (Streyn still running), it is renamed out of the way: Windows
/// allows that for a running program, and the leftover is removed by the next setup or start.
fn place(dir: &Path, name: &str, data: &[u8]) -> Result<(), String> {
    let target = dir.join(name);
    let tmp = dir.join(format!("{name}.new"));
    std::fs::write(&tmp, data).map_err(|e| format!("{}: {e}", tmp.display()))?;
    if target.exists() && std::fs::remove_file(&target).is_err() {
        let old = dir.join(format!("{name}.old-{}", std::process::id()));
        std::fs::rename(&target, &old).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", target.display())
    })
}

/// Removes leftovers of earlier versions in the install folder: renamed old program files
/// (`*.old-*`, `*.new`) and the uninstaller of the former NSIS setup. Only these names are touched.
fn clean_leftovers(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().to_ascii_lowercase();
        if is_leftover(&n) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn is_leftover(lower_name: &str) -> bool {
    let known = lower_name.starts_with("streyn.exe.") || lower_name.starts_with("streyn-server.exe.");
    (known && (lower_name.contains(".old-") || lower_name.ends_with(".new"))) || lower_name == "uninstall.exe"
}

/// The program folder up to 1.33 (%LOCALAPPDATA%\Streyn) is the app's data folder now. Only the old
/// program files go; a file still in use (the old Streyn that started this update) is renamed and
/// removed by the app on its next start. Browser, Storage and Data are not touched.
fn retire_old_install(old: &Path, new: &Path) {
    if old == new {
        return;
    }
    let Ok(rd) = std::fs::read_dir(old) else { return };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().to_ascii_lowercase();
        let program = n == "streyn.exe" || n == "streyn-server.exe" || is_leftover(&n);
        if !program || !e.path().is_file() {
            continue;
        }
        if std::fs::remove_file(e.path()).is_err() && !n.contains(".old-") {
            let _ = std::fs::rename(e.path(), old.join(format!("{n}.old-{}", std::process::id())));
        }
    }
}

fn install(dir: &Path) -> Result<bool, String> {
    // check everything first: a damaged setup changes nothing
    let files: Vec<(&str, &[u8])> = payloads().iter().map(|p| unpack(p).map(|d| (p.name, d))).collect::<Result<_, _>>()?;
    let fresh = !dir.join(APP_EXE).exists();
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    clean_leftovers(dir);
    for (name, data) in &files {
        place(dir, name, data)?;
    }
    Ok(fresh)
}

#[cfg(windows)]
mod win;

#[cfg(windows)]
fn main() {
    let args = parse_args(std::env::args().skip(1));
    let Some(dir) = win::install_dir() else {
        if !args.silent {
            win::message("Streyn Setup", "The folder for apps (%APPDATA%) was not found.", true);
        }
        std::process::exit(1);
    };
    // an installation from before 1.34 lives in %LOCALAPPDATA%\Streyn: that is an update, not a
    // first install, so no Desktop shortcut is added that the user did not have
    let old = win::old_install_dir();
    let had_old = old.as_ref().map(|o| o.join(APP_EXE).is_file()).unwrap_or(false);
    let result = install(&dir).and_then(|fresh| {
        let fresh = fresh && !had_old;
        let size: u64 = [APP_EXE, SERVER_EXE].iter().filter_map(|n| std::fs::metadata(dir.join(n)).ok()).map(|m| m.len()).sum();
        win::register(&dir, VERSION, size)?;
        win::shortcuts(&dir, fresh);
        // the old program files only go once the new entry and shortcuts are in place
        if let Some(old) = &old {
            retire_old_install(old, &dir);
        }
        Ok(())
    });
    match result {
        Ok(()) => {
            if args.launch {
                // a normal start as the same user, nothing inherited
                let _ = std::process::Command::new(dir.join(APP_EXE)).current_dir(&dir).spawn();
            }
        }
        Err(e) => {
            if !args.silent {
                win::message("Streyn Setup", &format!("Streyn could not be installed.\n\n{e}"), true);
            }
            std::process::exit(1);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Streyn Setup {VERSION} is for Windows. On Linux use Streyn.AppImage.");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("streyn-setup-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn args() {
        assert_eq!(parse_args(vec![]), Args { silent: false, launch: true });
        assert_eq!(parse_args(vec!["/S".into()]), Args { silent: true, launch: false });
        assert_eq!(parse_args(vec!["/S".into(), "/R".into()]), Args { silent: true, launch: true });
        // what the updater of older versions passes
        assert_eq!(parse_args(vec!["/P".into(), "/R".into()]), Args { silent: false, launch: true });
    }

    #[test]
    fn checksum_is_enforced() {
        let packed: &'static [u8] = b"program";
        let good: &'static str = Box::leak(format!("{:x}", Sha256::digest(packed)).into_boxed_str());
        assert_eq!(unpack(&Payload { name: "a", packed, sha256: good }).unwrap(), packed);
        assert!(unpack(&Payload { name: "a", packed, sha256: "00" }).is_err());
        assert!(unpack(&Payload { name: "a", packed: &[], sha256: good }).is_err());
        assert!(unpack(&Payload { name: "a", packed: b"changed", sha256: good }).is_err());
    }

    #[test]
    fn place_replaces_and_cleans() {
        let d = tmpdir("place");
        place(&d, "Streyn.exe", b"one").unwrap();
        place(&d, "Streyn.exe", b"two").unwrap();
        assert_eq!(std::fs::read(d.join("Streyn.exe")).unwrap(), b"two");
        assert!(!d.join("Streyn.exe.new").exists());
        std::fs::write(d.join("streyn.exe.old-12"), b"x").unwrap();
        std::fs::write(d.join("uninstall.exe"), b"x").unwrap();
        std::fs::write(d.join("notes.txt"), b"keep").unwrap();
        clean_leftovers(&d);
        assert!(!d.join("streyn.exe.old-12").exists());
        assert!(!d.join("uninstall.exe").exists());
        assert!(d.join("notes.txt").exists(), "only known leftovers are removed");
        assert!(d.join("Streyn.exe").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn old_install_keeps_data() {
        let t = tmpdir("retire");
        let (old, new) = (t.join("Local/Streyn"), t.join("Roaming/Streyn"));
        for d in ["Storage/music", "Browser/EBWebView", "Data"] {
            std::fs::create_dir_all(old.join(d)).unwrap();
        }
        for f in ["Streyn.exe", "streyn-server.exe", "uninstall.exe", "streyn.exe.old-9"] {
            std::fs::write(old.join(f), b"x").unwrap();
        }
        std::fs::write(old.join("Storage/music/a.opus"), b"song").unwrap();
        retire_old_install(&old, &new);
        for f in ["Streyn.exe", "streyn-server.exe", "uninstall.exe", "streyn.exe.old-9"] {
            assert!(!old.join(f).exists(), "{f}");
        }
        assert!(old.join("Storage/music/a.opus").is_file());
        assert!(old.join("Browser/EBWebView").is_dir());
        // never against the install folder itself
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("Streyn.exe"), b"x").unwrap();
        retire_old_install(&new, &new);
        assert!(new.join("Streyn.exe").exists());
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn leftovers_only_known_names() {
        assert!(is_leftover("streyn.exe.old-42"));
        assert!(is_leftover("streyn-server.exe.new"));
        assert!(is_leftover("uninstall.exe"));
        assert!(!is_leftover("streyn.exe"));
        assert!(!is_leftover("streyn-server.exe"));
        assert!(!is_leftover("other.exe.old-1"));
    }

    #[test]
    fn empty_setup_refuses() {
        // built without payloads (as in tests): nothing may be written
        let d = tmpdir("empty").join("Streyn");
        if APP_BIN.is_empty() {
            assert!(install(&d).is_err());
            assert!(!d.exists());
        }
    }
}
