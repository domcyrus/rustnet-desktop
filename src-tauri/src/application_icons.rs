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

static ICON_CACHE_ACCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());

// Cache failures only remove the persistence benefit, never the native icon or capture.
pub fn persisted(
    path: Option<std::path::PathBuf>,
    executable: Option<String>,
    icon: Option<String>,
) -> Option<String> {
    let saved = (|| -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
        let (Some(path), Some(executable)) = (path, executable) else {
            return Ok(None);
        };
        if !std::path::Path::new(&executable).is_absolute() {
            return Ok(None);
        }
        // Lists request many icons concurrently; serialize the short cache transactions
        // on the blocking pool to avoid losing writes during SQLite lock upgrades.
        let _access = ICON_CACHE_ACCESS.lock().unwrap_or_else(|e| e.into_inner());
        if icon.is_none() && !path.try_exists()? {
            return Ok(None);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as i64;
        let mut cache = rustnet_analytics::icons::IconCache::open(&path)?;
        if let Some(png) = &icon {
            cache.put(&executable, png, now)?;
            Ok(None)
        } else {
            cache.get(&executable, now)
        }
    })()
    .ok()
    .flatten();
    icon.or(saved)
}

#[cfg(test)]
mod persistence_tests {
    use super::persisted;
    #[test]
    fn concurrent_first_lookups_preserve_every_executable_reference() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("icons.db");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
        let png = "data:image/png;base64,iVBORw0KGgo=";
        let mut tasks = Vec::new();
        for i in 0..16 {
            let db = db.clone();
            let barrier = barrier.clone();
            let key = dir
                .path()
                .join(format!("app-{i}"))
                .to_string_lossy()
                .into_owned();
            tasks.push(std::thread::spawn(move || {
                barrier.wait();
                persisted(Some(db), Some(key.clone()), Some(png.into()));
                key
            }));
        }
        for task in tasks {
            assert_eq!(
                persisted(Some(db.clone()), Some(task.join().unwrap()), None).as_deref(),
                Some(png)
            );
        }
    }
    #[test]
    fn cache_failure_preserves_native_icon_and_missing_apps_use_saved_icons() {
        let dir = tempfile::tempdir().unwrap();
        let png = "data:image/png;base64,iVBORw0KGgo=".to_string();
        let executable = Some(
            dir.path()
                .join("removed-app")
                .to_string_lossy()
                .into_owned(),
        );
        assert_eq!(
            persisted(
                Some(dir.path().into()),
                executable.clone(),
                Some(png.clone())
            ),
            Some(png.clone())
        );
        let db = Some(dir.path().join("icons.sqlite3"));
        assert_eq!(
            persisted(db.clone(), executable.clone(), Some(png.clone())),
            Some(png.clone())
        );
        assert_eq!(persisted(db, executable, None), Some(png));
    }
}
