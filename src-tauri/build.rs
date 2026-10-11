fn main() {
    println!(
        "cargo:rustc-env=RUSTNET_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    tauri_build::build();
}
