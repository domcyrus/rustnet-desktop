//! Own a sandboxed CLI child and retain only its latest versioned snapshot.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

const MAX_RECORD_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES: usize = 16 * 1024;
const STOP_TIMEOUT: Duration = Duration::from_secs(15);

type SharedView = Arc<Mutex<CaptureView>>;

#[derive(Clone, Default, Serialize)]
pub struct CaptureView {
    pub session: u64,
    pub revision: u64,
    pub status: String,
    pub error: Option<String>,
    pub export_path: Option<String>,
    pub snapshot: Option<Value>,
}

struct Running {
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

pub struct Engine {
    running: Option<Running>,
    view: SharedView,
}

impl Default for Engine {
    fn default() -> Self {
        Self {
            running: None,
            view: Arc::new(Mutex::new(CaptureView {
                status: "idle".into(),
                ..CaptureView::default()
            })),
        }
    }
}

impl Engine {
    pub fn is_active(&self) -> bool {
        self.running
            .as_ref()
            .is_some_and(|run| !run.task.is_finished())
    }

    pub fn view(&self) -> CaptureView {
        self.view.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub async fn start(
        &mut self,
        interface: String,
        export: Option<PathBuf>,
        geoip_directory: Option<PathBuf>,
    ) -> Result<(), String> {
        if self.is_active() {
            return Err("A capture is already active. Stop it before changing interfaces.".into());
        }
        if let Some(previous) = self.running.take() {
            let _ = previous.task.await;
        }
        if interface.len() > 1024 || interface.contains('\0') {
            return Err("Invalid interface name".into());
        }
        if let Some(path) = &export
            && path.exists()
        {
            return Err("Choose a new filename. Existing captures are never overwritten.".into());
        }
        let process = launch(interface, export.clone(), geoip_directory).await?;
        let (stop, receive) = oneshot::channel();
        {
            let mut view = self.view.lock().unwrap_or_else(|e| e.into_inner());
            *view = CaptureView {
                session: view.session + 1,
                status: "starting".into(),
                export_path: export.map(|p| p.display().to_string()),
                ..CaptureView::default()
            };
        }
        let view = self.view.clone();
        self.running = Some(Running {
            stop,
            task: tokio::spawn(async move {
                match process {
                    CaptureProcess::Local(child, sudo) => {
                        supervise(child, receive, view, sudo).await
                    }
                    #[cfg(target_os = "macos")]
                    CaptureProcess::Helper(capture) => {
                        supervise_helper(*capture, receive, view).await
                    }
                }
            }),
        });
        Ok(())
    }

    pub async fn stop(&mut self) {
        if let Some(run) = self.running.take() {
            if !run.task.is_finished() {
                self.view.lock().unwrap_or_else(|e| e.into_inner()).status = "stopping".into();
            }
            let _ = run.stop.send(());
            let _ = run.task.await;
        }
    }
}

enum CaptureProcess {
    Local(Child, bool),
    #[cfg(target_os = "macos")]
    Helper(Box<crate::macos::Capture>),
}

pub fn sudo_mode() -> bool {
    #[cfg(all(target_os = "macos", debug_assertions))]
    {
        crate::dev_sudo::enabled()
    }
    #[cfg(not(all(target_os = "macos", debug_assertions)))]
    {
        false
    }
}

async fn launch(
    interface: String,
    export: Option<PathBuf>,
    geoip_directory: Option<PathBuf>,
) -> Result<CaptureProcess, String> {
    let sudo = sudo_mode();
    #[cfg(target_os = "macos")]
    if !sudo {
        let options = (interface.clone(), export.clone(), geoip_directory.clone());
        let helper = tokio::task::spawn_blocking(move || {
            crate::macos::start_if_enabled(&options.0, options.1.as_deref(), options.2.as_deref())
        })
        .await
        .map_err(|e| e.to_string())??;
        if let Some(helper) = helper {
            return Ok(CaptureProcess::Helper(Box::new(helper)));
        }
    }
    let mut command = if sudo {
        #[cfg(all(target_os = "macos", debug_assertions))]
        {
            crate::dev_sudo::command(&engine_path()?).await?
        }
        #[cfg(not(all(target_os = "macos", debug_assertions)))]
        {
            unreachable!("sudo capture is only available in macOS debug builds")
        }
    } else {
        engine_command()?
    };
    #[cfg(target_os = "macos")]
    let databases = if sudo && geoip_directory.is_none() {
        crate::macos::automatic_geoip()
    } else {
        geoip_arguments(geoip_directory.as_deref())?
    };
    #[cfg(not(target_os = "macos"))]
    let databases = geoip_arguments(geoip_directory.as_deref())?;
    for (flag, path) in databases {
        command.arg(flag).arg(path);
    }
    command.args([
        "--headless",
        "--output",
        "jsonl",
        "--headless-details",
        "full",
        "--capture-accounting",
        "--stop-on-stdin-close",
        "--include-historic",
        "--refresh-interval",
        "500",
    ]);
    if !interface.is_empty() {
        command.arg("--interface").arg(interface);
    }
    if let Some(path) = &export {
        command.arg("--pcapng-export").arg(path);
    }
    let child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Cannot start the RustNet capture engine: {e}"))?;
    Ok(CaptureProcess::Local(child, sudo))
}

impl Drop for Engine {
    fn drop(&mut self) {
        // Dropping the sender wakes the supervisor, which closes stdin even
        // if the webview disappears before explicitly stopping capture.
        self.running.take();
    }
}

pub fn engine_path() -> Result<PathBuf, String> {
    if cfg!(debug_assertions)
        && let Some(path) = std::env::var_os("RUSTNET_DESKTOP_ENGINE")
    {
        return Ok(PathBuf::from(path));
    }
    if cfg!(debug_assertions) && cfg!(dev) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "rustnet-capture-engine-{}{}",
                env!("RUSTNET_TARGET"),
                std::env::consts::EXE_SUFFIX
            )));
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = executable
        .parent()
        .ok_or("Cannot locate the bundled capture engine")?;
    Ok(parent.join(format!(
        "rustnet-capture-engine{}",
        std::env::consts::EXE_SUFFIX
    )))
}

pub fn geoip_arguments(directory: Option<&Path>) -> Result<Vec<(&'static str, PathBuf)>, String> {
    let Some(directory) = directory else {
        // Omit overrides so the engine keeps its usual user/system discovery.
        return Ok(Vec::new());
    };
    if !directory.is_absolute() || !directory.is_dir() {
        return Err(
            "GeoIP folder is unavailable. Choose an existing folder in capture settings.".into(),
        );
    }
    let arguments: Vec<_> = [
        ("--geoip-country", "GeoLite2-Country.mmdb"),
        ("--geoip-asn", "GeoLite2-ASN.mmdb"),
        ("--geoip-city", "GeoLite2-City.mmdb"),
    ]
    .into_iter()
    .filter_map(|(flag, name)| {
        let path = directory.join(name);
        path.is_file().then_some((flag, path))
    })
    .collect();
    if arguments.is_empty() {
        return Err("No GeoLite2 databases found. Choose a folder containing GeoLite2-Country.mmdb, GeoLite2-ASN.mmdb or GeoLite2-City.mmdb.".into());
    }
    Ok(arguments)
}

fn engine_command() -> Result<Command, String> {
    let mut command = Command::new(engine_path()?);
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    Ok(command)
}

pub async fn interfaces() -> Result<Value, String> {
    let mut command = engine_command()?;
    let mut child = command
        .arg("--list-interfaces")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Interface output pipe unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Interface diagnostic pipe unavailable")?;
    let output = tokio::spawn(read_limited(stdout, 1024 * 1024));
    let diagnostics = tokio::spawn(read_limited(stderr, MAX_DIAGNOSTIC_BYTES));
    let status = match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
        Ok(result) => result.map_err(|e| e.to_string())?,
        Err(_) => {
            let _ = child.kill().await;
            output.abort();
            diagnostics.abort();
            return Err("Timed out listing capture interfaces".into());
        }
    };
    let bytes = output.await.map_err(|e| e.to_string())??;
    let stderr = diagnostics.await.map_err(|e| e.to_string())??;
    if !status.success() {
        return Err(String::from_utf8_lossy(&stderr).trim().to_string());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if !value.is_array() {
        return Err("Capture engine returned an invalid interface list".into());
    }
    Ok(value)
}

async fn read_limited(mut reader: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::new();
    (&mut reader)
        .take(limit as u64 + 1)
        .read_to_end(&mut buffer)
        .await
        .map_err(|e| e.to_string())?;
    if buffer.len() > limit {
        return Err("Capture engine output exceeded its size limit".into());
    }
    Ok(buffer)
}

async fn diagnostics(mut reader: impl AsyncRead + Unpin) -> String {
    let mut tail = Vec::new();
    let mut buffer = [0; 2048];
    while let Ok(count) = reader.read(&mut buffer).await {
        if count == 0 {
            break;
        }
        tail.extend_from_slice(&buffer[..count]);
        if tail.len() > MAX_DIAGNOSTIC_BYTES {
            tail.drain(..tail.len() - MAX_DIAGNOSTIC_BYTES);
        }
    }
    String::from_utf8_lossy(&tail).trim().to_string()
}

fn decode_snapshot(bytes: &[u8]) -> Result<Value, String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|e| format!("Invalid capture snapshot: {e}"))?;
    if value["schema_version"] != 1
        || value["type"] != "snapshot"
        || !value["connections"].is_array()
        || !value["runtime"]["status"].is_string()
    {
        return Err(
            "Unsupported capture schema. Rebuild the desktop's bundled RustNet engine.".into(),
        );
    }
    Ok(value)
}

async fn read_snapshots(
    mut reader: impl AsyncBufRead + Unpin,
    view: SharedView,
) -> Result<(), String> {
    let mut line = Vec::new();
    loop {
        line.clear();
        let count = (&mut reader)
            .take(MAX_RECORD_BYTES + 1)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Ok(());
        }
        if count as u64 > MAX_RECORD_BYTES {
            return Err("Capture snapshot exceeded 16 MiB".into());
        }
        let snapshot = decode_snapshot(&line)?;
        let mut view = view.lock().unwrap_or_else(|e| e.into_inner());
        // A late running snapshot cannot undo an explicit stop request.
        if view.status != "stopping" {
            view.status = snapshot["runtime"]["status"]
                .as_str()
                .unwrap_or("error")
                .into();
        }
        if let Some(error) = snapshot["runtime"]["capture_error"].as_str() {
            view.error = Some(error.into());
        }
        view.revision += 1;
        view.snapshot = Some(snapshot);
    }
}

async fn stop_child(child: &mut Child, sudo: bool) -> Result<std::process::ExitStatus, String> {
    drop(child.stdin.take());
    match tokio::time::timeout(STOP_TIMEOUT, child.wait()).await {
        Ok(result) => result.map_err(|e| e.to_string()),
        Err(_) => {
            terminate_child(child, sudo).await?;
            Err("Capture did not stop within 15 seconds and was terminated. The recording may be incomplete.".into())
        }
    }
}

async fn terminate_child(child: &mut Child, sudo: bool) -> Result<(), String> {
    #[cfg(all(target_os = "macos", debug_assertions))]
    if sudo {
        return crate::dev_sudo::terminate(child).await;
    }
    if sudo {
        return Err("Sudo capture is unavailable in this build".into());
    }
    child.kill().await.map_err(|e| e.to_string())
}

async fn supervise(
    mut child: Child,
    mut stop: oneshot::Receiver<()>,
    view: SharedView,
    sudo: bool,
) {
    // Child::wait closes any stdin it owns. Keep the controller pipe here
    // so observing process exit does not itself request engine shutdown.
    let mut controller = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout configured as a pipe");
    let stderr = child.stderr.take().expect("stderr configured as a pipe");
    let mut reader = tokio::spawn(read_snapshots(BufReader::new(stdout), view.clone()));
    let diagnostics = tokio::spawn(diagnostics(stderr));
    let mut read_complete = false;
    let result = tokio::select! {
        status = child.wait() => status.map_err(|e| e.to_string()),
        _ = &mut stop => {
            drop(controller.take());
            stop_child(&mut child, sudo).await
        },
        read = &mut reader => {
            drop(controller.take());
            read_complete = true;
            match read {
                Ok(Ok(())) => stop_child(&mut child, sudo).await,
                failure => {
                    let _ = stop_child(&mut child, sudo).await;
                    Err(match failure {
                        Ok(Err(error)) => error,
                        Err(error) => error.to_string(),
                        Ok(Ok(())) => unreachable!(),
                    })
                }
            }
        }
    };
    drop(controller);
    let read_error = if !read_complete {
        match tokio::time::timeout(Duration::from_secs(2), &mut reader).await {
            Ok(Ok(Err(error))) => Some(error),
            Ok(Err(error)) => Some(error.to_string()),
            Err(_) => {
                reader.abort();
                Some("Capture output did not close cleanly".into())
            }
            Ok(Ok(Ok(()))) => None,
        }
    } else {
        None
    };
    let mut diagnostics = diagnostics;
    let message = match tokio::time::timeout(Duration::from_secs(2), &mut diagnostics).await {
        Ok(Ok(message)) => message,
        _ => {
            diagnostics.abort();
            String::new()
        }
    };
    let error = match result {
        Err(error) => Some(error),
        Ok(status) if !status.success() => Some(if message.is_empty() {
            format!("Capture exited with {status}")
        } else {
            message
        }),
        Ok(_) => read_error,
    };
    #[cfg(all(target_os = "macos", debug_assertions))]
    let error = error.map(|error| {
        if sudo {
            format!("{error}\n{}", crate::dev_sudo::AUTH_HINT)
        } else {
            error
        }
    });
    finish_capture(&view, error);
}

fn finish_capture(view: &SharedView, error: Option<String>) {
    let mut view = view.lock().unwrap_or_else(|e| e.into_inner());
    let error = error.or_else(|| view.error.clone());
    let terminal_failed = !view
        .snapshot
        .as_ref()
        .is_some_and(|s| s["runtime"]["status"].as_str() == Some("stopped"));
    view.error = error.or_else(|| {
        terminal_failed
            .then(|| "Capture shutdown was incomplete. Check the recording before using it.".into())
    });
    view.status = if view.error.is_some() {
        "error"
    } else {
        "stopped"
    }
    .into();
}

#[cfg(target_os = "macos")]
async fn supervise_helper(
    mut capture: crate::macos::Capture,
    mut stop: oneshot::Receiver<()>,
    view: SharedView,
) {
    let output = capture.output.take().expect("helper output configured");
    let stderr = capture
        .diagnostics
        .take()
        .expect("helper diagnostics configured");
    let exit = capture.exit.take().expect("helper exit pipe configured");
    let mut reader = tokio::spawn(read_snapshots(BufReader::new(output), view.clone()));
    let diagnostics = tokio::spawn(diagnostics(stderr));
    let mut reader_done = false;
    let mut error = tokio::select! {
        _ = &mut stop => None,
        result = &mut reader => {
            reader_done = true;
            result.map_err(|e| e.to_string()).and_then(|r| r).err()
        }
    };
    // Invalidating XPC closes the daemon-owned controller and starts its
    // independent 15-second termination deadline, including after a UI crash.
    capture.stop();
    if !reader_done {
        match tokio::time::timeout(STOP_TIMEOUT + Duration::from_secs(2), &mut reader).await {
            Ok(result) => error = result.map_err(|e| e.to_string()).and_then(|r| r).err(),
            Err(_) => {
                reader.abort();
                error = Some(
                    "Capture helper output did not close. The recording may be incomplete.".into(),
                );
            }
        }
    }
    let mut diagnostics = diagnostics;
    let message = match tokio::time::timeout(Duration::from_secs(2), &mut diagnostics).await {
        Ok(Ok(message)) => message,
        _ => {
            diagnostics.abort();
            String::new()
        }
    };
    let status = tokio::time::timeout(Duration::from_secs(2), read_limited(exit, 32)).await;
    if !matches!(status, Ok(Ok(ref bytes)) if bytes == b"0\n") {
        error = error.or_else(|| {
            Some(if message.is_empty() {
                "Privileged capture exited abnormally. The recording may be incomplete.".into()
            } else {
                message
            })
        });
    }
    finish_capture(&view, error);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn helper_supervision_requires_clean_exit_and_a_terminal_snapshot() {
        fn pipe_fixture(bytes: &[u8]) -> std::fs::File {
            let path = std::env::temp_dir().join(format!(
                "rustnet-helper-output-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::write(&path, bytes).unwrap();
            let file = std::fs::File::open(&path).unwrap();
            std::fs::remove_file(path).unwrap();
            file
        }
        let stopped = b"{\"schema_version\":1,\"type\":\"snapshot\",\"connections\":[],\"runtime\":{\"status\":\"stopped\"}}\n";
        for (output, status, expected) in [
            (stopped.as_slice(), b"0\n".as_slice(), None),
            (
                stopped.as_slice(),
                b"1\n".as_slice(),
                Some("capture permission denied"),
            ),
            (
                b"".as_slice(),
                b"0\n".as_slice(),
                Some("Capture shutdown was incomplete"),
            ),
        ] {
            let capture = crate::macos::Capture::fixture(
                pipe_fixture(output),
                pipe_fixture(b"capture permission denied"),
                pipe_fixture(status),
            );
            let view = Arc::new(Mutex::new(CaptureView::default()));
            let (_sender, receiver) = oneshot::channel();
            tokio::time::timeout(
                Duration::from_secs(3),
                supervise_helper(capture, receiver, view.clone()),
            )
            .await
            .unwrap();
            let result = view.lock().unwrap();
            if let Some(message) = expected {
                assert_eq!(result.status, "error");
                assert!(result.error.as_deref().unwrap().contains(message));
            } else {
                assert_eq!(result.status, "stopped");
                assert!(result.error.is_none());
            }
        }
    }

    #[test]
    fn geoip_overrides_require_a_folder_and_pass_each_available_database() {
        assert!(geoip_arguments(None).unwrap().is_empty());
        assert!(geoip_arguments(Some(Path::new("relative/path"))).is_err());
        let directory = std::env::temp_dir().join(format!(
            "rustnet-geoip-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        assert!(geoip_arguments(Some(&directory)).is_err());
        let country = directory.join("GeoLite2-Country.mmdb");
        std::fs::write(&country, []).unwrap();
        assert_eq!(
            geoip_arguments(Some(&directory)).unwrap(),
            vec![("--geoip-country", country.clone())]
        );
        let asn = directory.join("GeoLite2-ASN.mmdb");
        let city = directory.join("GeoLite2-City.mmdb");
        std::fs::write(&asn, []).unwrap();
        std::fs::write(&city, []).unwrap();
        assert_eq!(
            geoip_arguments(Some(&directory)).unwrap(),
            vec![
                ("--geoip-country", country),
                ("--geoip-asn", asn),
                ("--geoip-city", city),
            ]
        );
        std::fs::remove_dir_all(&directory).unwrap();
        assert!(geoip_arguments(Some(&directory)).is_err());
    }

    #[test]
    fn incompatible_or_non_snapshot_output_is_rejected() {
        for line in [br#"{"schema_version":2,"type":"snapshot","connections":[],"runtime":{"status":"running"}}"#.as_slice(), b"not json", br#"{"schema_version":1,"type":"event"}"#] {
            assert!(decode_snapshot(line).is_err());
        }
    }

    #[tokio::test]
    async fn snapshots_replace_each_other_and_preserve_stop_requests() {
        let view = Arc::new(Mutex::new(CaptureView {
            status: "stopping".into(),
            ..CaptureView::default()
        }));
        let line = "{\"schema_version\":1,\"type\":\"snapshot\",\"connections\":[],\"runtime\":{\"status\":\"running\"}}\n";
        read_snapshots(
            BufReader::new(format!("{line}{line}").as_bytes()),
            view.clone(),
        )
        .await
        .unwrap();
        let view = view.lock().unwrap();
        assert_eq!(view.revision, 2);
        assert_eq!(view.status, "stopping");
        assert_eq!(
            view.snapshot.as_ref().unwrap()["connections"],
            serde_json::json!([])
        );
    }

    #[tokio::test]
    async fn oversized_records_fail_without_retaining_them() {
        let view = Arc::new(Mutex::new(CaptureView::default()));
        let bytes = vec![b'x'; MAX_RECORD_BYTES as usize + 2];
        assert!(
            read_snapshots(BufReader::new(bytes.as_slice()), view.clone())
                .await
                .is_err()
        );
        assert!(view.lock().unwrap().snapshot.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_closes_controller_pipe_and_reaps_child() {
        let mut child = Command::new("sh")
            .args(["-c", "cat >/dev/null"])
            .stdin(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        assert!(stop_child(&mut child, false).await.unwrap().success());
        assert!(child.try_wait().unwrap().is_some());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn supervisor_keeps_controller_pipe_open_until_stop_requested() {
        let start = r#"{"schema_version":1,"type":"snapshot","connections":[],"runtime":{"status":"running"}}"#;
        let end = start.replace("running", "stopped");
        let child = Command::new("sh")
            .args([
                "-c",
                "printf '%s\\n' \"$1\"; cat >/dev/null; printf '%s\\n' \"$2\"",
                "engine-test",
                start,
                &end,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let view = Arc::new(Mutex::new(CaptureView::default()));
        let (sender, receiver) = oneshot::channel();
        let mut task = tokio::spawn(supervise(child, receiver, view.clone(), false));
        tokio::time::timeout(Duration::from_secs(3), async {
            while view.lock().unwrap().revision == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(200), &mut task)
                .await
                .is_err(),
            "capture exited before the controller requested a stop"
        );
        assert_eq!(view.lock().unwrap().status, "running");
        sender.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        let view = view.lock().unwrap();
        assert_eq!(view.status, "stopped");
        assert_eq!(view.revision, 2);
        assert!(view.error.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supervisor_flushes_final_snapshot_when_controller_disappears() {
        let start = r#"{"schema_version":1,"type":"snapshot","connections":[],"runtime":{"status":"running"}}"#;
        let end = start.replace("running", "stopped");
        let child = Command::new("sh")
            .args([
                "-c",
                "printf '%s\\n' \"$1\"; cat >/dev/null; printf '%s\\n' \"$2\"",
                "engine-test",
                start,
                &end,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let view = Arc::new(Mutex::new(CaptureView::default()));
        let (sender, receiver) = oneshot::channel();
        let task = tokio::spawn(supervise(child, receiver, view.clone(), false));
        drop(sender);
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        let view = view.lock().unwrap();
        assert_eq!(view.status, "stopped");
        assert_eq!(view.revision, 2);
        assert!(view.error.is_none());
        assert_eq!(
            view.snapshot.as_ref().unwrap()["runtime"]["status"],
            "stopped"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supervisor_surfaces_startup_diagnostics() {
        let child = Command::new("sh")
            .args(["-c", "printf 'capture permission denied' >&2; exit 1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let view = Arc::new(Mutex::new(CaptureView::default()));
        let (_sender, receiver) = oneshot::channel();
        tokio::time::timeout(
            Duration::from_secs(3),
            supervise(child, receiver, view.clone(), false),
        )
        .await
        .unwrap();
        let view = view.lock().unwrap();
        assert_eq!(view.status, "error");
        assert!(
            view.error
                .as_ref()
                .unwrap()
                .contains("capture permission denied")
        );
    }
}
