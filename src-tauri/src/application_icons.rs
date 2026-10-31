#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "windows")]
mod windows;

// Keep platform-specific icon discovery behind the same optional PNG response.
#[cfg(not(target_os = "linux"))]
pub fn lookup(executable: Option<&str>, name: &str, pids: &[u32]) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::{CStr, CString, c_char};

        unsafe extern "C" {
            fn rustnet_application_icon(
                executable: *const c_char,
                name: *const c_char,
                pids: *const u32,
                count: usize,
            ) -> *mut c_char;
            fn rustnet_application_icon_free(icon: *mut c_char);
        }

        let executable = CString::new(executable.unwrap_or_default()).ok()?;
        let name = CString::new(name).ok()?;
        // SAFETY: all inputs remain live throughout this synchronous call.
        // Native code returns either null or an owned, null-terminated string.
        let pointer = unsafe {
            rustnet_application_icon(
                executable.as_ptr(),
                name.as_ptr(),
                pids.as_ptr(),
                pids.len(),
            )
        };
        if pointer.is_null() {
            return None;
        }
        // SAFETY: read the returned string before freeing its allocation once.
        let icon = unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned();
        unsafe { rustnet_application_icon_free(pointer) };
        Some(icon)
    }
    #[cfg(target_os = "windows")]
    {
        windows::lookup(executable, name, pids)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (executable, name, pids);
        None
    }
}
