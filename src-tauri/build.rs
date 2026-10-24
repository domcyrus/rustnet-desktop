fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        let arch = if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        let status = std::process::Command::new("xcrun")
            .args([
                "clang",
                "-fobjc-arc",
                "-fblocks",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-arch",
                arch,
                "-mmacosx-version-min=13.0",
                "-c",
                "macos/client.m",
                "-o",
            ])
            .arg(out.join("helper-client.o"))
            .status()
            .expect("Xcode Command Line Tools are required");
        assert!(status.success(), "macOS helper client compilation failed");
        let status = std::process::Command::new("ar")
            .arg("crs")
            .arg(out.join("libhelper_client.a"))
            .arg(out.join("helper-client.o"))
            .status()
            .expect("Cannot build macOS helper client archive");
        assert!(status.success());
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-lib=static=helper_client");
        for framework in ["Foundation", "Security", "ServiceManagement"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rerun-if-changed=macos/client.m");
        println!("cargo:rerun-if-changed=macos/Helper.h");
    }
    println!(
        "cargo:rustc-env=RUSTNET_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    tauri_build::build();
}
