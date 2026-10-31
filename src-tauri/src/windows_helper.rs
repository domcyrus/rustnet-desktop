//! UAC launch and authenticated, per-capture local pipes. The engine executable
//! implements the helper protocol itself; no elevated broker/service stays running.
use std::fs::{File, OpenOptions};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{
    GetLastError, HANDLE, LocalFree, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER,
    TokenElevation, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
use windows_sys::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, GetProcessId, OpenProcessToken, WaitForSingleObject,
};
use windows_sys::Win32::UI::Shell::{
    SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    ShellExecuteExW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW, SW_HIDE};

const ACK: &[u8] = b"RUSTNET/1\n";
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn raw(handle: &impl AsRawHandle) -> HANDLE {
    handle.as_raw_handle()
}
fn os_error() -> String {
    std::io::Error::last_os_error().to_string()
}

fn token() -> Result<OwnedHandle, String> {
    let mut token = null_mut();
    // SAFETY: output handle is adopted once on success.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(token) })
}

pub fn ensure_unprivileged() -> Result<(), String> {
    let token = token()?;
    let mut elevation = TOKEN_ELEVATION::default();
    let mut size = 0;
    if unsafe {
        GetTokenInformation(
            raw(&token),
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        )
    } == 0
    {
        return Err(os_error());
    }
    if elevation.TokenIsElevated != 0 {
        return Err("Start RustNet Desktop normally, without Run as administrator. Only the capture engine requests administrator approval when you start capture.".into());
    }
    Ok(())
}

pub fn startup_error(message: &str) {
    unsafe {
        MessageBoxW(
            null_mut(),
            wide(message).as_ptr(),
            wide("RustNet Desktop").as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

struct Descriptor(*mut std::ffi::c_void);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn pipe_descriptor() -> Result<Descriptor, String> {
    let token = token()?;
    let mut size = 0;
    unsafe {
        GetTokenInformation(raw(&token), TokenUser, null_mut(), 0, &mut size);
    }
    if size == 0 {
        return Err(os_error());
    }
    let mut storage = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            raw(&token),
            TokenUser,
            storage.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(os_error());
    }
    let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    let mut sid = null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) } == 0 {
        return Err(os_error());
    }
    let sid_allocation = Descriptor(sid.cast());
    let mut length = 0;
    unsafe {
        while *sid.add(length) != 0 {
            length += 1;
        }
    }
    let sid_text = String::from_utf16(unsafe { std::slice::from_raw_parts(sid, length) })
        .map_err(|e| e.to_string())?;
    drop(sid_allocation);
    // Current user, Administrators (including credential-over-the-shoulder UAC), SYSTEM.
    let sddl = wide(&format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{sid_text})"));
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(os_error());
    }
    Ok(Descriptor(descriptor))
}

fn make_pipe(id: &str, role: &str, inbound: bool) -> Result<NamedPipeServer, String> {
    let descriptor = pipe_descriptor()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    // SAFETY: descriptor and attributes stay alive until creation returns.
    unsafe {
        ServerOptions::new()
            .access_inbound(inbound)
            .access_outbound(!inbound)
            .first_pipe_instance(true)
            .max_instances(1)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                format!(r"\\.\pipe\rustnet-desktop-{id}-{role}"),
                (&attributes as *const SECURITY_ATTRIBUTES)
                    .cast_mut()
                    .cast(),
            )
    }
    .map_err(|e| e.to_string())
}

fn elevate(executable: &Path, id: &str) -> Result<OwnedHandle, String> {
    let path: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let arguments = wide(&format!("--desktop-helper {id} {}", std::process::id()));
    let verb = wide("runas");
    let directory = executable
        .parent()
        .ok_or("Capture engine directory is missing")?;
    let directory: Vec<u16> = directory.as_os_str().encode_wide().chain(Some(0)).collect();
    let initialized = unsafe { CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) } >= 0;
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: verb.as_ptr(),
        lpFile: path.as_ptr(),
        lpParameters: arguments.as_ptr(),
        lpDirectory: directory.as_ptr(),
        nShow: SW_HIDE,
        ..Default::default()
    };
    let result = unsafe { ShellExecuteExW(&mut info) };
    let error = unsafe { GetLastError() };
    if initialized {
        unsafe {
            CoUninitialize();
        }
    }
    if result == 0 {
        return Err(if error == 1223 {
            "Administrator approval was cancelled. Capture was not started.".into()
        } else {
            format!(
                "Cannot start the capture helper: {}",
                std::io::Error::from_raw_os_error(error as i32)
            )
        });
    }
    if info.hProcess.is_null() {
        return Err("Windows did not return a capture helper process handle".into());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(info.hProcess) })
}

use std::os::windows::ffi::OsStrExt;

async fn authenticate(pipe: &NamedPipeServer, process: &OwnedHandle) -> Result<(), String> {
    let expected = unsafe { GetProcessId(raw(process)) };
    if expected == 0 {
        return Err(os_error());
    }
    loop {
        pipe.connect().await.map_err(|e| e.to_string())?;
        if peer_matches(pipe, expected)?
            && unsafe { WaitForSingleObject(raw(process), 0) } == WAIT_TIMEOUT
        {
            return Ok(());
        }
        pipe.disconnect().map_err(|e| e.to_string())?;
    }
}

fn peer_matches(pipe: &NamedPipeServer, expected: u32) -> Result<bool, String> {
    let mut actual = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut actual) } == 0 {
        return Err(os_error());
    }
    Ok(actual == expected)
}

pub struct Capture {
    process: OwnedHandle,
    controller: Option<NamedPipeServer>,
    pub output: Option<NamedPipeServer>,
    pub diagnostics: Option<NamedPipeServer>,
    // Deny modification/deletion of the exact engine while UAC/capture is active.
    _executable: File,
}
impl Capture {
    pub fn stop(&mut self) {
        self.controller.take();
    }
    pub async fn wait(&self) -> Result<u32, String> {
        loop {
            match unsafe { WaitForSingleObject(raw(&self.process), 0) } {
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    if unsafe { GetExitCodeProcess(raw(&self.process), &mut code) } == 0 {
                        return Err(os_error());
                    }
                    return Ok(code);
                }
                WAIT_TIMEOUT => tokio::time::sleep(Duration::from_millis(50)).await,
                _ => return Err(os_error()),
            }
        }
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.stop();
    }
}

fn geoip_files(directory: Option<&Path>) -> Result<[Option<File>; 3], String> {
    let mut files = [None, None, None];
    let explicit = directory.is_some();
    let paths = if let Some(directory) = directory {
        crate::engine::geoip_arguments(Some(directory))?
            .into_iter()
            .map(|(_, path)| path)
            .collect::<Vec<_>>()
    } else {
        let mut directories = vec![
            std::path::PathBuf::from("resources/geoip2"),
            std::path::PathBuf::from("."),
        ];
        for (variable, suffixes) in [
            ("XDG_DATA_HOME", vec!["rustnet/geoip", "GeoIP"]),
            (
                "HOME",
                vec![".local/share/rustnet/geoip", ".local/share/GeoIP"],
            ),
            ("ProgramData", vec!["GeoIP"]),
        ] {
            if let Some(base) = std::env::var_os(variable) {
                directories.extend(suffixes.into_iter().map(|s| Path::new(&base).join(s)));
            }
        }
        directories
            .into_iter()
            .flat_map(|directory| {
                [
                    "GeoLite2-Country.mmdb",
                    "GeoLite2-ASN.mmdb",
                    "GeoLite2-City.mmdb",
                ]
                .map(|name| directory.join(name))
            })
            .collect()
    };
    for path in paths {
        let index = match path.file_name().and_then(|s| s.to_str()) {
            Some("GeoLite2-Country.mmdb") => 0,
            Some("GeoLite2-ASN.mmdb") => 1,
            Some("GeoLite2-City.mmdb") => 2,
            _ => continue,
        };
        if files[index].is_some() {
            continue;
        }
        match File::open(&path) {
            Ok(file) if file.metadata().map_err(|e| e.to_string())?.is_file() => {
                files[index] = Some(file)
            }
            Ok(_) => return Err("GeoIP input must be a regular file".into()),
            Err(error) if explicit => {
                return Err(format!("Cannot open {}: {error}", path.display()));
            }
            Err(_) => {}
        }
    }
    Ok(files)
}

pub async fn start(
    interface: &str,
    export: Option<&Path>,
    geoip: Option<&Path>,
) -> Result<Capture, String> {
    ensure_unprivileged()?;
    if std::env::var_os("RUSTNET_DESKTOP_ENGINE").is_some()
        || std::env::var_os("RUSTNET_ENGINE_SOURCE").is_some()
    {
        return Err(
            "The Windows helper requires the bundled engine. Remove engine overrides and rebuild."
                .into(),
        );
    }
    let executable = crate::engine::engine_path()?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let executable_lock = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&executable)
        .map_err(|e| e.to_string())?;
    let [country, asn, city] = geoip_files(geoip)?;
    let recording = export
        .map(|path| {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|e| format!("Cannot create recording {}: {e}", path.display()))
        })
        .transpose()?;
    let files = [recording, country, asn, city];
    let mut random = [0; 32];
    if unsafe {
        BCryptGenRandom(
            null_mut(),
            random.as_mut_ptr(),
            random.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } < 0
    {
        return Err("Cannot create a secure capture session identifier".into());
    }
    let id: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let mut controller = make_pipe(&id, "control", false)?;
    let mut output = make_pipe(&id, "output", true)?;
    let diagnostics = make_pipe(&id, "diagnostics", true)?;
    let process = tokio::task::spawn_blocking(move || elevate(&executable, &id))
        .await
        .map_err(|e| e.to_string())??;
    let handshake = async {
        tokio::try_join!(
            authenticate(&controller, &process),
            authenticate(&output, &process),
            authenticate(&diagnostics, &process)
        )?;
        let request = serde_json::to_vec(&serde_json::json!({"version":1,"interface":interface,
            "files":files.each_ref().map(|file| file.as_ref().map(|f| f.as_raw_handle() as usize as u64))})).map_err(|e| e.to_string())?;
        controller
            .write_u32_le(request.len() as u32)
            .await
            .map_err(|e| e.to_string())?;
        controller
            .write_all(&request)
            .await
            .map_err(|e| e.to_string())?;
        let mut ack = [0; ACK.len()];
        output
            .read_exact(&mut ack)
            .await
            .map_err(|e| e.to_string())?;
        if ack != ACK {
            return Err("Capture helper protocol mismatch. Rebuild the desktop.".into());
        }
        Ok::<_, String>(())
    };
    tokio::time::timeout(Duration::from_secs(10), handshake)
        .await
        .map_err(|_| "Timed out connecting to the capture helper".to_string())??;
    // Original file handles close only after the helper acknowledges duplication.
    Ok(Capture {
        process,
        controller: Some(controller),
        output: Some(output),
        diagnostics: Some(diagnostics),
        _executable: executable_lock,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::windows::named_pipe::ClientOptions;

    #[tokio::test]
    #[ignore = "Child of controller_crash_stops_elevated_engine; not a standalone test"]
    async fn crash_controller_child() {
        assert_eq!(
            std::env::var("RUSTNET_HELPER_CRASH_TEST").as_deref(),
            Ok("1")
        );
        let mut capture = start("", None, None).await.unwrap();
        let diagnostics = capture.diagnostics.take().unwrap();
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut BufReader::new(diagnostics), &mut tokio::io::sink()).await;
        });
        let mut output = BufReader::new(capture.output.take().unwrap()).lines();
        tokio::time::timeout(Duration::from_secs(25), output.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        println!("HELPER_PID={}", unsafe {
            GetProcessId(raw(&capture.process))
        });
        // The parent kills this controller without running Capture::drop.
        loop {
            output.next_line().await.unwrap().unwrap();
        }
    }

    #[tokio::test]
    #[ignore = "Requires interactive UAC approval and Npcap; run explicitly as a normal user"]
    async fn controller_crash_stops_elevated_engine() {
        use std::process::Stdio;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        ensure_unprivileged().unwrap();
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "windows_helper::tests::crash_controller_child",
                "--ignored",
                "--nocapture",
            ])
            .env("RUSTNET_HELPER_CRASH_TEST", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let pid = tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                let line = lines
                    .next_line()
                    .await
                    .unwrap()
                    .expect("controller exited before capture");
                if let Some(pid) = line.strip_prefix("HELPER_PID=") {
                    break pid.parse::<u32>().unwrap();
                }
            }
        })
        .await
        .unwrap();
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!process.is_null(), "{}", os_error());
        let process = unsafe { OwnedHandle::from_raw_handle(process) };
        child.kill().await.unwrap();
        child.wait().await.unwrap();
        tokio::time::timeout(Duration::from_secs(35), async {
            while unsafe { WaitForSingleObject(raw(&process), 0) } == WAIT_TIMEOUT {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("elevated helper survived its controller");
        assert_eq!(
            unsafe { WaitForSingleObject(raw(&process), 0) },
            WAIT_OBJECT_0
        );
    }

    #[tokio::test]
    async fn pipes_are_exclusive_and_check_the_kernel_client_pid() {
        let id = format!(
            "test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let server = make_pipe(&id, "output", true).unwrap();
        assert!(make_pipe(&id, "output", true).is_err());
        let client = ClientOptions::new()
            .read(false)
            .write(true)
            .open(format!(r"\\.\pipe\rustnet-desktop-{id}-output"))
            .unwrap();
        server.connect().await.unwrap();
        assert!(peer_matches(&server, std::process::id()).unwrap());
        assert!(!peer_matches(&server, 0).unwrap());
        drop(client);
    }

    #[tokio::test]
    #[ignore = "Requires interactive UAC approval and Npcap; run explicitly as a normal user"]
    async fn elevated_engine_records_and_stops_while_controller_stays_unprivileged() {
        ensure_unprivileged().unwrap();
        let recording =
            std::env::temp_dir().join(format!("rustnet-helper-test-{}.pcapng", std::process::id()));
        let mut capture = start("", Some(&recording), None).await.unwrap();
        let diagnostics = capture.diagnostics.take().unwrap();
        let diagnostics = tokio::spawn(async move {
            let mut text = String::new();
            BufReader::new(diagnostics)
                .read_to_string(&mut text)
                .await
                .unwrap();
            text
        });
        let mut output = BufReader::new(capture.output.take().unwrap()).lines();
        let first = tokio::time::timeout(Duration::from_secs(25), output.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let first: serde_json::Value = serde_json::from_str(&first).unwrap();
        assert_eq!(
            first["runtime"]["process_detection"]["method"],
            "windows-etw+iphlpapi"
        );
        assert_eq!(first["runtime"]["process_detection"]["degraded"], false);
        assert_eq!(first["sandbox"]["status"], "fully_enforced");
        ensure_unprivileged().unwrap();
        let mut last = first;
        // Keep reading throughout a sustained capture, so the pipe cannot fill
        // and disguise shutdown issues behind output backpressure.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while let Ok(line) = tokio::time::timeout_at(deadline, output.next_line()).await {
            last = serde_json::from_str(&line.unwrap().expect("capture exited early")).unwrap();
            assert!(matches!(
                last["runtime"]["status"].as_str(),
                Some("starting" | "running")
            ));
        }
        assert_eq!(last["runtime"]["status"], "running");
        capture.stop();
        tokio::time::timeout(Duration::from_secs(35), async {
            while let Some(line) = output.next_line().await.unwrap() {
                last = serde_json::from_str(&line).unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(
            capture.wait().await.unwrap(),
            0,
            "{}",
            diagnostics.await.unwrap()
        );
        assert_eq!(last["runtime"]["status"], "stopped");
        assert_eq!(last["runtime"]["shutdown"]["timed_out_workers"], 0);
        assert_eq!(last["runtime"]["shutdown"]["panicked_workers"], 0);
        assert_eq!(last["runtime"]["shutdown"]["output_errors"], 0);
        let bytes = std::fs::read(&recording).unwrap();
        assert_eq!(&bytes[..4], &[0x0a, 0x0d, 0x0d, 0x0a]);
        std::fs::remove_file(recording).unwrap();
    }
}
