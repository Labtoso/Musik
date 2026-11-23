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
    // SAFETY: `id` is a valid GUID reference and no access token is passed (current user). On success
    // `p` is a NUL-terminated UTF-16 string allocated by the shell: it is read once and then freed
    // exactly once with CoTaskMemFree, as SHGetKnownFolderPath requires.
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
    // SAFETY: the HSTRING temporaries are NUL-terminated and live until the call returns; no owner window.
    unsafe {
        MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(title), MB_OK | if error { MB_ICONERROR } else { MB_ICONINFORMATION });
    }
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a key opened by `create_key` and is closed only here, once.
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

fn create_key(path: &str) -> Result<Key, String> {
    let mut k = HKEY::default();
    // SAFETY: predefined HKCU root, a NUL-terminated path that lives until the call returns and a valid
    // out pointer for the new key, which `Key` then owns.
    let r = unsafe { RegCreateKeyExW(HKEY_CURRENT_USER, &HSTRING::from(path), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut k, None) };
    if r != ERROR_SUCCESS {
        return Err(format!("registry {path}: {}", r.0));
    }
    Ok(Key(k))
}

fn set_value(k: &Key, name: &str, kind: windows::Win32::System::Registry::REG_VALUE_TYPE, data: &[u8]) -> Result<(), String> {
    // SAFETY: `k.0` is an open key with write access (see `create_key`); the name and `data` live
    // until the call returns and the length of `data` is passed along with it.
    let r = unsafe { RegSetValueExW(k.0, &HSTRING::from(name), None, kind, Some(data)) };
    if r != ERROR_SUCCESS {
        return Err(format!("registry {UNINSTALL_KEY}\\{name}: {}", r.0));
    }
    Ok(())
}

fn set_str(k: &Key, name: &str, value: &str) -> Result<(), String> {
    // REG_SZ: UTF-16 little endian with the closing NUL
    let bytes: Vec<u8> = value.encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect();
    set_value(k, name, REG_SZ, &bytes)
}

fn set_dword(k: &Key, name: &str, value: u32) -> Result<(), String> {
    set_value(k, name, REG_DWORD, &value.to_le_bytes())
}

/// Registers Streyn under "Installed apps" (per user). Uninstalling runs `Streyn.exe --uninstall`.
pub fn register(dir: &Path, version: &str, bytes: u64) -> Result<(), String> {
    let exe = dir.join(crate::APP_EXE);
    let k = create_key(UNINSTALL_KEY)?;
    set_str(&k, "DisplayName", "Streyn")?;
    set_str(&k, "DisplayVersion", version)?;
    set_str(&k, "Publisher", "LabtosoStudios")?;
    set_str(&k, "DisplayIcon", &format!("{},0", exe.display()))?;
    set_str(&k, "InstallLocation", &dir.display().to_string())?;
    set_str(&k, "UninstallString", &format!("\"{}\" --uninstall", exe.display()))?;
    set_str(&k, "QuietUninstallString", &format!("\"{}\" --uninstall /S", exe.display()))?;
    set_str(&k, "URLInfoAbout", "https://musik.labtoso.de")?;
    set_dword(&k, "NoModify", 1)?;
    set_dword(&k, "NoRepair", 1)?;
    set_dword(&k, "EstimatedSize", (bytes / 1024).min(u32::MAX as u64) as u32)?;
    // the old key may not exist; nothing to report then
    // SAFETY: predefined HKCU root and a NUL-terminated path that lives until the call returns.
    unsafe {
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(OLD_NSIS_KEY));
    }
    Ok(())
}

fn make_link(lnk: &Path, exe: &Path, dir: &Path) -> windows::core::Result<()> {
    // SAFETY: COM is initialised on this thread (see `shortcuts`); the interface pointers are owned by
    // the `windows` wrappers and released on drop; all strings live until each call returns.
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
    // SAFETY: plain COM initialisation of this thread; no reserved pointer is passed.
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
