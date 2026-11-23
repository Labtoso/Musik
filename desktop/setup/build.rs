// Packs the two program files into the setup: streyn.exe (app) and streyn-server.exe (offline mode).
// CI passes their paths in STREYN_APP_EXE and STREYN_SERVER_EXE. Without them (tests, local checks)
// the setup is built with empty payloads and refuses to install.
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn pack(env: &str, out: &Path, name: &str) -> Result<String, String> {
    println!("cargo:rerun-if-env-changed={env}");
    let data = match std::env::var_os(env) {
        Some(p) => {
            let p = PathBuf::from(p);
            println!("cargo:rerun-if-changed={}", p.display());
            std::fs::read(&p).map_err(|e| format!("{env}: reading {}: {e}", p.display()))?
        }
        None => Vec::new(),
    };
    let hash = format!("{:x}", Sha256::digest(&data));
    let packed = if data.is_empty() { Vec::new() } else { miniz_oxide::deflate::compress_to_vec(&data, 10) };
    let dest = out.join(name);
    std::fs::write(&dest, packed).map_err(|e| format!("writing {}: {e}", dest.display()))?;
    Ok(hash)
}

fn main() -> Result<(), String> {
    let out = PathBuf::from(std::env::var("OUT_DIR").map_err(|e| format!("OUT_DIR: {e}"))?);
    let app = pack("STREYN_APP_EXE", &out, "app.bin")?;
    let srv = pack("STREYN_SERVER_EXE", &out, "server.bin")?;
    println!("cargo:rustc-env=STREYN_APP_SHA256={app}");
    println!("cargo:rustc-env=STREYN_SERVER_SHA256={srv}");
    println!("cargo:rerun-if-env-changed=STREYN_VERSION");
    let version = std::env::var("STREYN_VERSION").unwrap_or_else(|_| "0.0.0".into());
    println!("cargo:rustc-env=STREYN_VERSION={version}");

    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../src-tauri/icons/icon.ico")
            .set("ProductName", "Streyn")
            .set("FileDescription", "Streyn Setup")
            .set("CompanyName", "LabtosoStudios")
            .set("LegalCopyright", "Copyright (c) LabtosoStudios. All rights reserved.")
            .set("OriginalFilename", "StreynSetup.exe")
            .set("ProductVersion", &version)
            .set("FileVersion", &version)
            .set_manifest(include_str!("setup.manifest"));
        res.compile().map_err(|e| format!("resources: {e}"))?;
    }
    Ok(())
}
