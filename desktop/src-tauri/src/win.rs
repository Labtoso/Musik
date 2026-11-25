//! Windows-only parts of the app: the offline server's lifetime and uninstalling.
//! Only documented Win32 APIs, only Streyn's own processes, files and HKCU keys.
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Puts the offline server (our own child, started by us) into a job that ends it when Streyn ends,
/// also if Streyn crashes. No handle to any other process is opened.
/// Returns false if the job could not be set up or the child could not be put into it.
pub fn tie_to_app(child: &std::process::Child) -> bool {
    static JOB: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let job = *JOB.get_or_init(|| {
        // SAFETY: both pointers may be null (default security, unnamed job); the call returns a new
        // handle owned by this process or null.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return 0;
        }
        // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is a valid value (plain C struct).
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `job` is the valid handle created above; `info` lives until the call returns and the
        // size passed is exactly its size.
        let ok = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            // a job without "kill on close" would not do anything useful
            // SAFETY: `job` is our own valid handle and is not used after this.
            unsafe { CloseHandle(job) };
            return 0;
        }
        // the handle stays open for the app's whole life; Windows closes it when the app ends
        job as usize
    });
    if job == 0 {
        return false;
    }
    // SAFETY: `job` is the job handle kept open for the app's lifetime; the process handle belongs to
    // `child`, our own child process, which is borrowed for the duration of the call.
    unsafe { AssignProcessToJobObject(job as HANDLE, child.as_raw_handle() as HANDLE) != 0 }
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
    use windows_sys::Win32::UI::Shell::{FOLDERID_Desktop, FOLDERID_RoamingAppData, FOLDERID_Programs, SHGetKnownFolderPath};
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONINFORMATION, MB_ICONQUESTION, MB_OK, MB_YESNO};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub fn ask(text: &str) -> bool {
        let (text, title) = (wide(text), wide("Streyn"));
        // SAFETY: both buffers are NUL-terminated UTF-16 and live until the call returns; no owner window.
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONQUESTION) == IDYES }
    }
    pub fn tell(text: &str) {
        let (text, title) = (wide(text), wide("Streyn"));
        // SAFETY: as in `ask`.
        unsafe {
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONINFORMATION);
        }
    }

    pub fn known_folder(id: &windows_sys::core::GUID) -> Option<PathBuf> {
        let mut p: windows_sys::core::PWSTR = std::ptr::null_mut();
        // SAFETY: `id` is a valid GUID reference, no access token (current user), `p` is a valid out pointer.
        if unsafe { SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut p) } != 0 || p.is_null() {
            return None;
        }
        // SAFETY: on success `p` is a NUL-terminated UTF-16 string allocated by the shell; it is read
        // only up to the NUL and freed exactly once with CoTaskMemFree, as SHGetKnownFolderPath requires.
        unsafe {
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
        let path = wide(path);
        // SAFETY: predefined HKCU handle and a NUL-terminated UTF-16 path that lives until the call returns.
        unsafe {
            RegDeleteTreeW(HKEY_CURRENT_USER, path.as_ptr());
        }
    }

    pub fn programs() -> Option<PathBuf> {
        known_folder(&FOLDERID_Programs)
    }
    pub fn desktop() -> Option<PathBuf> {
        known_folder(&FOLDERID_Desktop)
    }
    /// %APPDATA%\Streyn, where the setup installs since 1.34 (like Spotify).
    pub fn install_dir() -> Option<PathBuf> {
        known_folder(&FOLDERID_RoamingAppData).map(|d| d.join("Streyn"))
    }
}

/// Only the folder the setup installs to (%APPDATA%\Streyn) is ever cleaned up, never a
/// portable copy somewhere else.
pub fn is_install_dir(dir: &Path) -> bool {
    let Some(expected) = uninstall::install_dir() else { return false };
    let (Ok(a), Ok(b)) = (dir.canonicalize(), expected.canonicalize()) else { return false };
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()) && dir.join("Streyn.exe").is_file()
}

/// `Streyn.exe --uninstall [/S]`, run from "Installed apps". Removes exactly what the setup wrote:
/// the program files, the shortcuts and the "Installed apps" entry. Settings (%APPDATA%\Streyn\prefs)
/// and offline downloads (%LOCALAPPDATA%\Streyn\Storage) stay, like with Spotify.
/// The running Streyn.exe cannot delete itself, so it is moved to %TEMP%, where Windows' own
/// cleanup removes it (if %TEMP% is on another drive, it is left next to the install folder).
/// Nothing is started for that: no copy, no shell, no scheduled task.
/// Returns false only if the removal failed.
pub fn uninstall(silent: bool) -> bool {
    let Some(exe) = std::env::current_exe().ok() else { return false };
    let Some(dir) = exe.parent().map(PathBuf::from) else { return false };
    if !is_install_dir(&dir) {
        if !silent {
            uninstall::tell("This copy of Streyn is not installed, there is nothing to remove.");
        }
        return true;
    }
    if !silent && !uninstall::ask("Remove Streyn from this computer?\n\nYour settings and offline downloads stay and are used again if you reinstall Streyn.") {
        return true;
    }
    // The program file goes first: if it cannot be moved, nothing else is changed, so Streyn stays
    // complete and keeps its "Installed apps" entry.
    // %TEMP% is tried first; a move cannot cross drives, so if %TEMP% is on another drive the file
    // goes next to the install folder (%LOCALAPPDATA%), which is always on the same drive.
    let name = format!("streyn-removed-{}.tmp", std::process::id());
    let moved = std::fs::rename(&exe, std::env::temp_dir().join(&name)).or_else(|e| match dir.parent() {
        Some(parent) => std::fs::rename(&exe, parent.join(&name)),
        None => Err(e),
    });
    if let Err(e) = moved {
        if !silent {
            uninstall::tell(&format!("Streyn could not be removed.\n\n{}: {e}", exe.display()));
        }
        return false;
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
    // only removed if it is empty now; nothing else in it is touched
    let _ = std::fs::remove_dir(&dir);
    if !silent {
        uninstall::tell("Streyn was removed.");
    }
    true
}

/// Keeps the screen on while the Chillscreen room is open, the way video players do it: one documented
/// call for this app's own UI thread, nothing else is touched. `false` hands it back to Windows.
pub fn keep_display_on(on: bool) {
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
    let flags = if on { ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS };
    // SAFETY: plain flag call without pointers; it only changes the power request of the calling thread.
    unsafe { SetThreadExecutionState(flags) };
}
