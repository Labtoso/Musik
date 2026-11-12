// The version shown by the server comes from the repository's VERSION file.
fn main() {
    println!("cargo:rerun-if-changed=../VERSION");
    if let Ok(v) = std::fs::read_to_string("../VERSION") {
        let v = v.trim();
        if !v.is_empty() {
            println!("cargo:rustc-env=MUSIK_VERSION={v}");
        }
    }
}
