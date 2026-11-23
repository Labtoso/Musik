// The version shown by the server comes from the repository's VERSION file.
fn main() {
    println!("cargo:rerun-if-changed=../VERSION");
    println!("cargo:rerun-if-changed=windows/streyn-server.manifest");
    let v = std::fs::read_to_string("../VERSION").map(|v| v.trim().to_string()).unwrap_or_default();
    if !v.is_empty() {
        println!("cargo:rustc-env=STREYN_VERSION={v}");
    }
    // Windows: file details (publisher, product, version) and a manifest, like any regular program
    #[cfg(windows)]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let v = if v.is_empty() { env!("CARGO_PKG_VERSION").to_string() } else { v };
        let mut n = v.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).chain(std::iter::repeat(0));
        let packed = (n.next().unwrap() << 48) | (n.next().unwrap() << 32) | (n.next().unwrap() << 16);
        let mut res = winresource::WindowsResource::new();
        res.set("ProductName", "Streyn Server")
            .set("FileDescription", "Streyn Server")
            .set("CompanyName", "LabtosoStudios")
            .set("LegalCopyright", "Copyright (c) LabtosoStudios. All rights reserved.")
            .set("OriginalFilename", "streyn-server.exe")
            .set("InternalName", "streyn-server")
            .set("ProductVersion", &v)
            .set("FileVersion", &v)
            .set_version_info(winresource::VersionInfo::PRODUCTVERSION, packed)
            .set_version_info(winresource::VersionInfo::FILEVERSION, packed)
            .set_manifest_file("windows/streyn-server.manifest");
        if let Err(e) = res.compile() {
            println!("cargo:warning=no Windows resources: {e}");
        }
    }
}
