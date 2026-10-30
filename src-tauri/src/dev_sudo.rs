//! Opt-in macOS debug capture. Never compiled into release builds.
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};

pub const AUTH_HINT: &str = "Restart node scripts/desktop-sudo.mjs in an interactive terminal to build and then authenticate capture. Do not run the desktop itself with sudo.";

pub fn enabled() -> bool {
    std::env::var_os("RUSTNET_DEV_SUDO").is_some_and(|value| value == "1")
}

pub async fn command(engine: &Path) -> Result<Command, String> {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    // SAFETY: geteuid has no arguments and returns the current effective uid.
    if unsafe { geteuid() } == 0 {
        return Err("The desktop must run as your normal user, even in sudo dev mode.".into());
    }
    let status = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new("/usr/bin/sudo")
            .args(["-n", "-v"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status(),
    )
    .await;
    if !matches!(status, Ok(Ok(status)) if status.success()) {
        return Err(format!("Sudo authentication is unavailable. {AUTH_HINT}"));
    }
    let engine = engine
        .canonicalize()
        .map_err(|e| format!("Cannot locate capture engine: {e}"))?;
    Ok(capture_command(&engine))
}

fn capture_command(engine: &Path) -> Command {
    let mut command = Command::new("/usr/bin/sudo");
    command
        .args(["-n", "--"])
        .arg(engine)
        .arg("--sandbox-strict");
    // Keep sudo outside the UI's process group so it accepts forwarded timeout
    // signals. Keep the controlling terminal for sudo's credential cache.
    command.process_group(0);
    command
}

pub async fn terminate(child: &mut Child) -> Result<(), String> {
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    let pid = child.id().ok_or("Sudo process is unavailable")?;
    // sudo handles ALRM by terminating its command, then escalating to KILL.
    // Killing only the sudo monitor could leave a privileged engine running.
    // The child has not been reaped, so its PID cannot have been reused.
    let status = Command::new("/bin/kill")
        .args(["-ALRM", &pid.to_string()])
        .status()
        .await
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Could not signal sudo to stop capture. Check the launching terminal.".into());
    }
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| {
            "Sudo did not confirm capture shutdown. Check the launching terminal.".to_string()
        })?
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sudo_launch_is_noninteractive_and_preserves_path_arguments() {
        let command = capture_command(Path::new("/tmp/engine with spaces"));
        let command = command.as_std();
        assert_eq!(command.get_program(), "/usr/bin/sudo");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["-n", "--", "/tmp/engine with spaces", "--sandbox-strict"]
        );
    }

    #[tokio::test]
    async fn timeout_signals_the_monitor_instead_of_killing_it() {
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                "trap 'exit 42' ALRM; echo ready; while :; do sleep 0.1; done",
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .await
            .unwrap();
        assert_eq!(ready, "ready\n");
        terminate(&mut child).await.unwrap();
        assert_eq!(child.wait().await.unwrap().code(), Some(42));
    }
}
