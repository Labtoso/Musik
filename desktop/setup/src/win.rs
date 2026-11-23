//! The Windows parts of the setup: known folders, the "Installed apps" entry and shortcuts.
//! Only documented Shell and registry APIs, only below HKEY_CURRENT_USER, only Streyn's own keys.
use std::path::{Path, PathBuf};
use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows::Win32::UI::Shell::{FOLDERID_Desktop, FOLDERID_LocalAppData, FOLDERID_Programs, IShellLinkW, SHGetKnownFolderPath, ShellLink, KNOWN_FOLDER_FLAG};
use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_ICONINFORMATION, MB_OK};

/// The "Installed apps" entry. The former NSIS setup used the same key, so it is simply replaced.
pub const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Streyn";
/// Where the former NSIS setup remembered its folder; no longer needed.
const OLD_NSIS_KEY: &str = r"Software\LabtosoStudios\Streyn";

fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
    unsafe {
        let p = SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as _));
        s.map(PathBuf::from)
    }
}

/// %LOCALAPPDATA%\Streyn, the same folder the earlier versions used.
pub fn install_dir() -> Option<PathBuf> {
    known_folder(&FOLDERID_LocalAppData).map(|d| d.join("Streyn"))
}

pub fn message(title: &str, text: &str, error: bool) {
    unsafe {
        MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(title), MB_OK | if error { MB_ICONERROR } else { MB_ICONINFORMATION });
    }
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

fn create_key(path: &str) -> Result<Key, String> {
    let mut k = HKEY::default();
    let r = unsafe { RegCreateKeyExW(HKEY_CURRENT_USER, &HSTRING::from(path), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut k, None) };
    if r != ERROR_SUCCESS {
        return Err(format!("registry {path}: {}", r.0));
    }
    Ok(Key(k))
}

fn set_str(k: &Key, name: &str, value: &str) {
    let mut w: Vec<u16> = value.encode_utf16().collect();
    w.push(0);
    let bytes = unsafe { std::slice::from_raw_parts(w.as_ptr() as *const u8, w.len() * 2) };
    unsafe {
        let _ = RegSetValueExW(k.0, &HSTRING::from(name), None, REG_SZ, Some(bytes));
    }
}

fn set_dword(k: &Key, name: &str, value: u32) {
    unsafe {
        let _ = RegSetValueExW(k.0, &HSTRING::from(name), None, REG_DWORD, Some(&value.to_le_bytes()));
    }
}

/// Registers Streyn under "Installed apps" (per user). Uninstalling runs `Streyn.exe --uninstall`.
pub fn register(dir: &Path, version: &str, bytes: u64) -> Result<(), String> {
    let exe = dir.join(crate::APP_EXE);
    let k = create_key(UNINSTALL_KEY)?;
    set_str(&k, "DisplayName", "Streyn");
    set_str(&k, "DisplayVersion", version);
    set_str(&k, "Publisher", "LabtosoStudios");
    set_str(&k, "DisplayIcon", &format!("{},0", exe.display()));
    set_str(&k, "InstallLocation", &dir.display().to_string());
    set_str(&k, "UninstallString", &format!("\"{}\" --uninstall", exe.display()));
    set_str(&k, "QuietUninstallString", &format!("\"{}\" --uninstall /S", exe.display()));
    set_str(&k, "URLInfoAbout", "https://musik.labtoso.de");
    set_dword(&k, "NoModify", 1);
    set_dword(&k, "NoRepair", 1);
    set_dword(&k, "EstimatedSize", (bytes / 1024).min(u32::MAX as u64) as u32);
    unsafe {
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(OLD_NSIS_KEY));
    }
    Ok(())
}

fn make_link(lnk: &Path, exe: &Path, dir: &Path) -> windows::core::Result<()> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(exe.as_os_str()))?;
        link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()))?;
        link.SetDescription(&HSTRING::from("Streyn"))?;
        link.SetIconLocation(&HSTRING::from(exe.as_os_str()), 0)?;
        link.cast::<IPersistFile>()?.Save(&HSTRING::from(lnk.as_os_str()), true)
    }
}

/// Start menu shortcut every time (it points to the new file name), Desktop shortcut only on the
/// first install, so a shortcut the user deleted does not come back with every update.
pub fn shortcuts(dir: &Path, fresh: bool) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    let exe = dir.join(crate::APP_EXE);
    if let Some(p) = known_folder(&FOLDERID_Programs) {
        let _ = make_link(&p.join("Streyn.lnk"), &exe, dir);
    }
    if let Some(d) = known_folder(&FOLDERID_Desktop) {
        let lnk = d.join("Streyn.lnk");
        // an existing Desktop shortcut is refreshed so it points to Streyn.exe
        if fresh || lnk.exists() {
            let _ = make_link(&lnk, &exe, dir);
        }
    }
}
