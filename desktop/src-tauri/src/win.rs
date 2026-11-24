//! Windows-only parts of the app: the offline server's lifetime and uninstalling.
//! Only documented Win32 APIs, only Streyn's own processes, files and HKCU keys.
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Puts the offline server (our own child, started by us) into a job that ends it when Streyn ends,
/// also if Streyn crashes. No handle to any other process is opened.
pub fn tie_to_app(child: &std::process::Child) {
    static JOB: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        // the handle stays open for the app's whole life; Windows closes it when the app ends
        job as usize
    });
    if job != 0 {
        unsafe {
            AssignProcessToJobObject(job as HANDLE, child.as_raw_handle() as HANDLE);
        }
    }
}

/// Removes renamed program files that an update left behind (they were in use at that moment).
pub fn clean_leftovers() {
    let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)) else { return };
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().to_ascii_lowercase();
        if (n.starts_with("streyn.exe.") || n.starts_with("streyn-server.exe.")) && (n.contains(".old-") || n.ends_with(".new")) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

mod uninstall {
    use super::*;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::System::Registry::{RegDeleteTreeW, HKEY_CURRENT_USER};
    use windows_sys::Win32::UI::Shell::{FOLDERID_Desktop, FOLDERID_Programs, SHGetKnownFolderPath};
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONINFORMATION, MB_ICONQUESTION, MB_OK, MB_YESNO};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub fn ask(text: &str) -> bool {
        unsafe { MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide("Streyn").as_ptr(), MB_YESNO | MB_ICONQUESTION) == IDYES }
    }
    pub fn tell(text: &str) {
        unsafe {
            MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide("Streyn").as_ptr(), MB_OK | MB_ICONINFORMATION);
        }
    }

    pub fn known_folder(id: &windows_sys::core::GUID) -> Option<PathBuf> {
        unsafe {
            let mut p: windows_sys::core::PWSTR = std::ptr::null_mut();
            if SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut p) != 0 || p.is_null() {
                return None;
            }
            let mut n = 0;
            while *p.add(n) != 0 {
                n += 1;
            }
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, n));
            CoTaskMemFree(p as _);
            Some(PathBuf::from(s))
        }
    }

    pub fn delete_key(path: &str) {
        unsafe {
            RegDeleteTreeW(HKEY_CURRENT_USER, wide(path).as_ptr());
        }
    }

    pub fn programs() -> Option<PathBuf> {
        known_folder(&FOLDERID_Programs)
    }
    pub fn desktop() -> Option<PathBuf> {
        known_folder(&FOLDERID_Desktop)
    }
}

/// Only a folder that really is Streyn's install folder is ever cleaned up.
pub fn is_install_dir(dir: &Path) -> bool {
    let named = dir.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case("Streyn")).unwrap_or(false);
    named && dir.join("Streyn.exe").is_file()
}

/// `Streyn.exe --uninstall [/S]`, run from "Installed apps". Removes exactly what the setup wrote:
/// the program files, the shortcuts and the "Installed apps" entry. Settings (%APPDATA%\Streyn\prefs)
/// and offline downloads (%LOCALAPPDATA%\Streyn\Storage) stay, like with Spotify.
/// The running Streyn.exe cannot delete itself, so it is moved to %TEMP%, where Windows' own
/// cleanup removes it. Nothing is started for that: no copy, no shell, no scheduled task.
pub fn uninstall(silent: bool) {
    let Some(exe) = std::env::current_exe().ok() else { return };
    let Some(dir) = exe.parent().map(PathBuf::from) else { return };
    if !is_install_dir(&dir) {
        if !silent {
            uninstall::tell("This copy of Streyn is not installed, there is nothing to remove.");
        }
        return;
    }
    if !silent && !uninstall::ask("Remove Streyn from this computer?\n\nYour settings and offline downloads stay and are used again if you reinstall Streyn.") {
        return;
    }
    for d in [uninstall::programs(), uninstall::desktop()].into_iter().flatten() {
        let _ = std::fs::remove_file(d.join("Streyn.lnk"));
    }
    // program files an installation before 1.34 may have left in %LOCALAPPDATA%\Streyn
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let old = local.join("Streyn");
        if old != dir {
            crate::dirs::retire_old_program(&old);
        }
    }
    uninstall::delete_key(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Streyn");
    uninstall::delete_key(r"Software\LabtosoStudios\Streyn");
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_ascii_lowercase();
            let ours = n == "streyn-server.exe" || n == "uninstall.exe" || n.starts_with("streyn.exe.") || n.starts_with("streyn-server.exe.");
            if ours && e.path() != exe {
                // a running offline server is renamed out of the way instead
                if std::fs::remove_file(e.path()).is_err() {
                    let _ = std::fs::rename(e.path(), std::env::temp_dir().join(format!("streyn-removed-{}-{n}", std::process::id())));
                }
            }
        }
    }
    let _ = std::fs::rename(&exe, std::env::temp_dir().join(format!("streyn-removed-{}.tmp", std::process::id())));
    // only removed if it is empty now; nothing else in it is touched
    let _ = std::fs::remove_dir(&dir);
    if !silent {
        uninstall::tell("Streyn was removed.");
    }
}
