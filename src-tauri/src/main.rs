#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod application_icons;
#[cfg(all(target_os = "macos", debug_assertions))]
mod dev_sudo;
mod engine;
#[cfg(target_os = "macos")]
mod macos;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

#[derive(Default)]
struct Desktop {
    engine: Mutex<engine::Engine>,
    exiting: AtomicBool,
    exit_ready: AtomicBool,
}

#[tauri::command]
async fn application_icon(
    _app: tauri::AppHandle,
    executable: Option<String>,
    name: String,
    pids: Vec<u32>,
) -> Result<Option<String>, String> {
    if executable.as_ref().is_some_and(|path| path.len() > 4096)
        || name.len() > 256
        || pids.len() > 32
    {
        return Ok(None);
    }
    #[cfg(target_os = "linux")]
    {
        let icon = tauri::async_runtime::spawn_blocking(move || {
            application_icons::linux::find_icon(executable.as_deref(), &name, &pids)
        })
        .await
        .map_err(|e| e.to_string())?;
        let Some(icon) = icon else { return Ok(None) };
        let (send, receive) = tokio::sync::oneshot::channel();
        // GTK objects must stay on the UI thread, including the active theme.
        _app.run_on_main_thread(move || {
            let _ = send.send(application_icons::linux::render_icon(&icon));
        })
        .map_err(|e| e.to_string())?;
        receive.await.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        tauri::async_runtime::spawn_blocking(move || {
            application_icons::lookup(executable.as_deref(), &name, &pids)
        })
        .await
        .map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn list_interfaces() -> Result<serde_json::Value, String> {
    engine::interfaces().await
}

#[tauri::command]
async fn capture_view(
    state: State<'_, Desktop>,
    known: Option<engine::CaptureCursor>,
    include_snapshot: Option<bool>,
) -> Result<Option<engine::CaptureView>, String> {
    Ok(state
        .engine
        .lock()
        .await
        .view(known.as_ref(), include_snapshot.unwrap_or(true)))
}

#[tauri::command]
async fn choose_geoip_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose GeoLite2 database folder")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|e| e.to_string())?;
    engine::geoip_arguments(Some(&path))?;
    path.into_os_string()
        .into_string()
        .map(Some)
        .map_err(|_| "GeoIP folder path is not valid UTF-8".into())
}

#[tauri::command]
async fn start_capture(
    app: tauri::AppHandle,
    state: State<'_, Desktop>,
    interface: String,
    record: bool,
    geoip_directory: Option<String>,
) -> Result<bool, String> {
    if state.exiting.load(Ordering::Relaxed) {
        return Err("Desktop is closing".into());
    }
    let export = if record {
        let path = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title("Record network packets")
                .add_filter("PCAPNG capture", &["pcapng"])
                .set_file_name("rustnet-capture.pcapng")
                .blocking_save_file()
        })
        .await
        .map_err(|e| e.to_string())?;
        match path {
            Some(path) => Some(path.into_path().map_err(|e| e.to_string())?),
            None => return Ok(false),
        }
    } else {
        None
    };
    let mut engine = state.engine.lock().await;
    if state.exiting.load(Ordering::Relaxed) {
        return Err("Desktop is closing".into());
    }
    engine
        .start(interface, export, geoip_directory.map(Into::into))
        .await?;
    Ok(true)
}

#[tauri::command]
async fn stop_capture(state: State<'_, Desktop>) -> Result<(), String> {
    state.engine.lock().await.stop().await;
    Ok(())
}

#[tauri::command]
async fn macos_helper(
    state: State<'_, Desktop>,
    action: String,
) -> Result<Option<serde_json::Value>, String> {
    if !matches!(
        action.as_str(),
        "status" | "register" | "unregister" | "settings"
    ) {
        return Err("Unknown helper operation".into());
    }
    let engine = state.engine.lock().await;
    if matches!(action.as_str(), "register" | "unregister") && engine.is_active() {
        return Err("Stop capture before changing the helper".into());
    }
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || macos::manage(&action).map(Some))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    Ok(None)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Desktop::default())
        .invoke_handler(tauri::generate_handler![
            list_interfaces,
            capture_view,
            start_capture,
            choose_geoip_directory,
            stop_capture,
            application_icon,
            macos_helper
        ])
        .build(tauri::generate_context!())
        .expect("failed to build RustNet desktop");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let state = app.state::<Desktop>();
            if state.exit_ready.load(Ordering::Relaxed) {
                return;
            }
            api.prevent_exit();
            if !state.exiting.swap(true, Ordering::Relaxed) {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    handle.state::<Desktop>().engine.lock().await.stop().await;
                    handle
                        .state::<Desktop>()
                        .exit_ready
                        .store(true, Ordering::Relaxed);
                    handle.exit(0);
                });
            }
        }
    });
}
