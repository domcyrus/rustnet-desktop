//! SMAppService registration and an authenticated XPC capture connection.
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::fs::{File, OpenOptions};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde_json::Value;

unsafe extern "C" {
    fn rustnet_helper_manage(action: *const c_char) -> *mut c_char;
    fn rustnet_helper_free(text: *mut c_char);
    fn rustnet_helper_start(
        interface: *const c_char,
        files: *const c_int,
        result: *mut c_int,
        error: *mut *mut c_char,
    ) -> *mut c_void;
    fn rustnet_helper_disconnect(session: *mut c_void);
}

fn take_string(pointer: *mut c_char) -> Result<String, String> {
    if pointer.is_null() {
        return Err("The macOS helper returned no response".into());
    }
    // SAFETY: native functions return NUL-terminated allocations, freed exactly
    // once through the matching allocator after copying their contents.
    let value = unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    unsafe { rustnet_helper_free(pointer) };
    Ok(value)
}

pub fn manage(action: &str) -> Result<Value, String> {
    if !matches!(action, "status" | "register" | "unregister" | "settings") {
        return Err("Unknown helper operation".into());
    }
    if crate::engine::sudo_mode() {
        if action != "status" {
            return Err(
                "Restart without desktop:sudo to manage the installed capture helper.".into(),
            );
        }
        return Ok(serde_json::json!({
            "status": "dev_sudo",
            "can_register": false,
            "message": "Sudo development mode: capture uses terminal authentication. The desktop stays unprivileged; choose Automatic for PKTAP."
        }));
    }
    let action = CString::new(action).map_err(|e| e.to_string())?;
    // SAFETY: action stays alive throughout the synchronous native call.
    let text = take_string(unsafe { rustnet_helper_manage(action.as_ptr()) })?;
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(message) = value["error"].as_str() {
        return Err(message.into());
    }
    Ok(value)
}

pub struct Capture {
    // The retained NSXPCConnection is thread-safe and is owned solely by this
    // supervisor. Keep its opaque address out of the webview and request data.
    session: Option<usize>,
    pub output: Option<tokio::fs::File>,
    pub diagnostics: Option<tokio::fs::File>,
    pub exit: Option<tokio::fs::File>,
}

impl Capture {
    #[cfg(test)]
    pub fn fixture(output: File, diagnostics: File, exit: File) -> Self {
        Self {
            session: None,
            output: Some(tokio::fs::File::from_std(output)),
            diagnostics: Some(tokio::fs::File::from_std(diagnostics)),
            exit: Some(tokio::fs::File::from_std(exit)),
        }
    }

    pub fn stop(&mut self) {
        if let Some(session) = self.session.take() {
            // SAFETY: start returned this retained connection. Disconnect
            // releases it exactly once, including on cancellation or Drop.
            unsafe { rustnet_helper_disconnect(session as *mut c_void) };
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn automatic_geoip() -> Vec<(&'static str, PathBuf)> {
    let mut directories = vec![PathBuf::from("resources/geoip2"), PathBuf::from(".")];
    if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
        directories.push(PathBuf::from(&data).join("rustnet/geoip"));
        directories.push(PathBuf::from(data).join("GeoIP"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        directories.push(PathBuf::from(&home).join(".local/share/rustnet/geoip"));
        directories.push(PathBuf::from(home).join(".local/share/GeoIP"));
    }
    directories.extend(
        [
            "/usr/share/GeoIP",
            "/usr/local/share/GeoIP",
            "/opt/homebrew/share/GeoIP",
            "/var/lib/GeoIP",
        ]
        .map(PathBuf::from),
    );
    [
        ("--geoip-country", "GeoLite2-Country.mmdb"),
        ("--geoip-asn", "GeoLite2-ASN.mmdb"),
        ("--geoip-city", "GeoLite2-City.mmdb"),
    ]
    .into_iter()
    .filter_map(|(flag, name)| {
        directories
            .iter()
            .map(|directory| directory.join(name))
            .find(|path| path.is_file())
            .map(|path| (flag, path))
    })
    .collect()
}

pub fn start_if_enabled(
    interface: &str,
    export: Option<&Path>,
    geoip: Option<&Path>,
) -> Result<Option<Capture>, String> {
    if manage("status")?["status"] != "enabled" {
        return Ok(None);
    }
    if cfg!(debug_assertions)
        && (std::env::var_os("RUSTNET_DESKTOP_ENGINE").is_some()
            || std::env::var_os("RUSTNET_ENGINE_SOURCE").is_some())
    {
        return Err("The privileged helper only uses the signed bundled engine. Remove engine overrides or disable the helper for development.".into());
    }
    let databases = match geoip {
        Some(directory) => crate::engine::geoip_arguments(Some(directory))?,
        None => automatic_geoip(),
    };
    let mut files: [Option<File>; 4] = [None, None, None, None];
    // Open inputs as the desktop user. The daemon receives descriptors only,
    // so it cannot be tricked into opening root-only paths or following races.
    for (flag, path) in databases {
        let index = match flag {
            "--geoip-country" => 1,
            "--geoip-asn" => 2,
            "--geoip-city" => 3,
            _ => unreachable!(),
        };
        files[index] =
            Some(File::open(&path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?);
    }
    let interface = CString::new(interface).map_err(|e| e.to_string())?;
    if let Some(path) = export {
        files[0] = Some(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .map_err(|e| format!("Cannot create recording {}: {e}", path.display()))?,
        );
    }
    let descriptors = files
        .each_ref()
        .map(|file| file.as_ref().map_or(-1, AsRawFd::as_raw_fd));
    let mut result = [-1; 3];
    let mut error = std::ptr::null_mut();
    // SAFETY: the C string and descriptor arrays remain live for this bounded
    // call. Native code borrows inputs and transfers three owned output fds.
    let session = unsafe {
        rustnet_helper_start(
            interface.as_ptr(),
            descriptors.as_ptr(),
            result.as_mut_ptr(),
            &mut error,
        )
    };
    if session.is_null() {
        return Err(take_string(error)?);
    }
    let [output, diagnostics, exit] = result.map(|fd| {
        // SAFETY: successful native calls return three distinct, valid,
        // close-on-exec descriptors. Each is adopted exactly once.
        tokio::fs::File::from_std(unsafe { File::from_raw_fd(fd) })
    });
    Ok(Some(Capture {
        session: Some(session as usize),
        output: Some(output),
        diagnostics: Some(diagnostics),
        exit: Some(exit),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_builds_do_not_register_or_accept_unknown_operations() {
        assert!(manage("shell").is_err());
        let state = manage("status").unwrap();
        assert!(state["status"].is_string());
        if state["status"] == "unavailable" {
            assert_eq!(state["can_register"], false);
            assert!(manage("register").is_err());
        }
        if state["status"] == "dev_sudo" {
            assert_eq!(state["can_register"], false);
            for action in ["register", "unregister", "settings"] {
                assert!(manage(action).is_err());
            }
        }
        #[cfg(not(debug_assertions))]
        assert!(!crate::engine::sudo_mode());
    }
}
