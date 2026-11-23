// Packs the two program files into the setup: streyn.exe (app) and streyn-server.exe (offline mode).
// CI passes their paths in STREYN_APP_EXE and STREYN_SERVER_EXE. Without them (tests, local checks)
// the setup is built with empty payloads and refuses to install.
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn pack(env: &str, out: &PathBuf, name: &str) -> String {
    println!("cargo:rerun-if-env-changed={env}");
    let data = match std::env::var_os(env) {
        Some(p) => {
            println!("cargo:rerun-if-changed={}", PathBuf::from(&p).display());
            std::fs::read(&p).unwrap_or_else(|e| panic!("{env}: {e}"))
        }
        None => Vec::new(),
    };
    let hash = format!("{:x}", Sha256::digest(&data));
    let packed = if data.is_empty() { Vec::new() } else { miniz_oxide::deflate::compress_to_vec(&data, 10) };
    std::fs::write(out.join(name), packed).unwrap();
    hash
}

fn main() {
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let app = pack("STREYN_APP_EXE", &out, "app.bin");
    let srv = pack("STREYN_SERVER_EXE", &out, "server.bin");
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
        res.compile().expect("resources");
    }
}
