# Isolated builds (unreleased)

[English](BUILDING.md) | [简体中文](BUILDING.zh-CN.md) | [日本語](BUILDING.ja.md)

Use this workflow on macOS or Linux to reduce the host access available to dependency scripts, build tools and tests. Install the normal platform prerequisites, Rust through rustup, Node.js and the pnpm version pinned in `package.json` first. These tools and this repository's launcher scripts are trusted inputs. On Linux, also install Bubblewrap (`sudo apt-get install bubblewrap` on Debian/Ubuntu); unprivileged user namespaces must be available. macOS requires the system `sandbox-exec` command. Windows is unsupported by this workflow.

On Ubuntu with AppArmor user-namespace restrictions, an administrator must also enable the distribution's `bwrap-userns-restrict` profile (provided by `apparmor-profiles` on Ubuntu 24.04). See [Ubuntu's namespace guidance](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007). The launcher does not change system policy or disable AppArmor; a namespace setup failure stops the build.

From the repository, without running `pnpm install` first:

```sh
node scripts/isolated-build.mjs
```

The launcher copies Git-tracked files into `.isolated-build/runs/build-*/work`, preserving local edits but rejecting symlinks and special files. Stage new source files with `git add` before building; untracked files are excluded. Common credential files (`.npmrc`, `.netrc`, `.env*`, `credentials` and `credentials.toml`) are excluded even if tracked. Do not commit other secrets into build inputs. It uses a private HOME, temporary directory, pnpm store, Cargo cache and build target directory. The original checkout, Git metadata, normal caches, SSH agent, signing keys and credential environment variables are not exposed to the sandbox. System tools and the selected Rust toolchain are readable but not writable. The working copy and private caches are writable.

The fetch phase permits networking, downloads locked pnpm packages with lifecycle scripts and pnpmfile hooks disabled, fetches the pinned engine and verifies its patch hashes, and runs `cargo fetch --locked`. Private repositories and authenticated registries are deliberately unsupported. The fetch phase has network access, not a hostname allowlist.

The build phase blocks networking at the OS level, installs from the private store offline, runs the explicitly approved package build scripts, builds the pinned engine and frontend, runs frontend and Rust tests plus formatting/Clippy checks, then builds the desktop with embedded frontend assets. Cargo also uses offline mode. macOS uses a Seatbelt profile; Linux uses Bubblewrap mount, PID, user and network namespaces with dropped capabilities and no new privileges. Neither platform falls back to an ordinary build if sandbox setup fails. These are build sandboxes, not a sandbox for the running desktop.

The executable and capture sidecar are written to `.isolated-build/target/debug/`. The command prints the executable path. It does not open the UI or capture traffic. For an optimized build, use `--release`; output then goes to `.isolated-build/target/release/`. This workflow builds executables, not installers or signed/notarized bundles. Existing `pnpm run bundle` remains a separate, ordinary packaging workflow.

You can separate the phases:

```sh
node scripts/isolated-build.mjs --fetch-only
node scripts/isolated-build.mjs --build-only
```

`--build-only` uses the last fetched source snapshot, not subsequent checkout edits. Missing dependencies fail offline. A normal invocation takes a new snapshot and reuses only the dedicated caches. Remove `.isolated-build/` while no build or launched desktop is running to start with empty caches. Concurrent builds and sudo sessions are rejected by `.isolated-build.lock/`; after a forced termination, remove that lock only after confirming the previous session has exited.

## Sudo capture after building

On macOS, use an interactive terminal as your regular user:

```sh
node scripts/desktop-sudo.mjs
```

To reuse the existing debug desktop and capture engine without fetching dependencies, compiling or running tests:

```sh
node scripts/desktop-sudo.mjs --no-build
```

This checks that both executables exist in `.isolated-build/target/debug/` before requesting sudo authentication. Missing, non-executable or symlinked artifacts fail with a rebuild instruction; it never rebuilds automatically. It holds the same build lock until the desktop exits. It does not check whether the binaries match current sources, so omit `--no-build` after source or dependency changes. `pnpm run desktop:sudo --no-build` is also supported.

`pnpm run desktop:sudo` is an alias when project dependencies are already installed. The direct Node command avoids needing an ordinary dependency install. By default, the launcher first completes the isolated debug build and tests. Only after success does it request sudo authentication, then it directly runs the built desktop with embedded assets. No Vite server, watcher, compiler or package-manager task is started after authentication. There is no periodic sudo credential refresh.

Choose **Automatic** and start capture. Only the engine starts through sudo; the UI stays unprivileged. The pinned engine drops privileges and applies its strict sandbox after opening capture. Explicit interfaces disable PKTAP. Engine source/binary overrides are not supported by this workflow. No helper registration, signing, notarization or sudoers changes are required. Release builds still ignore `RUSTNET_DEV_SUDO` and use the signed helper for PKTAP.

If sudo credentials expire, an existing capture continues but a new capture may fail. Quit the desktop and rerun with `--no-build` to authenticate and reuse the same build. Stop capture or close the desktop to flush the recording. Live PKTAP capture and signed SMAppService deployment still require separate validation.

## Windows testing

Windows uses an ordinary build, not the isolated workflow above. In a normal,
non-administrator PowerShell, install the locked dependencies and build:

```powershell
pnpm install --frozen-lockfile
node scripts/build-windows.mjs
```

The launcher refuses to build elevated. It prepares the pinned engine and an
unpackaged debug desktop with embedded frontend assets. No Vite server is needed.
Close an existing test app before rebuilding, since Windows locks running binaries.

Launch from a normal, non-administrator PowerShell:

~~~powershell
Set-Location C:\path\to\rustnet-desktop
& .\src-tauri\target\debug\rustnet-desktop.exe
~~~

Click **Start capture**, then approve the Windows UAC prompt for the capture
engine. The desktop and WebView stay unprivileged. The desktop refuses an elevated
launch before creating its WebView. Each new capture requests approval again;
cancelling approval leaves capture stopped. No service, scheduled task, group
membership change, or persistent elevated broker is installed.

The helper is a restricted mode of the bundled engine executable. The desktop
holds that executable open against modification during capture. Engine overrides
(RUSTNET_DESKTOP_ENGINE and RUSTNET_ENGINE_SOURCE) are rejected for capture.
Three local-only named pipes use random session identifiers, restrictive ACLs,
and kernel process-ID checks in both directions. The elevated client uses
identification-only security quality of service to prevent pipe impersonation.
The protocol accepts an interface and existing file handles, not commands or
privileged file paths. Recording files are created without overwriting as the
normal user; GeoIP files are opened read-only by the UI. The engine duplicates
only those existing access rights and reads GeoIP data after token reduction.

The Windows engine opens capture handles, permanently removes every token
privilege except SeChangeNotifyPrivilege (ordinary directory traversal), verifies
the remaining privileges, and blocks child processes with a job object. Strict
sandbox failures stop capture. ETW starts after these restrictions, using
trace-session access through group membership; the engine does not retain debug,
driver-loading, impersonation, backup/restore, or system-profiling privileges.
ETW startup failures still fall back to IP Helper polling and show the
limited-process-detection warning.

The Windows helper uses DNS names observed in captured traffic and TLS SNI.
It does not issue active reverse-DNS queries: Windows system resolver calls can
remain blocked beyond shutdown, and those queries do not belong in the elevated
capture process. Addresses without an observed name remain numeric. The standalone
CLI retains its existing reverse-DNS option.

Stopping capture closes the control pipe, drains the final snapshot, and flushes
the recording. The helper also watches the UI process so a crash cannot leave
capture running indefinitely. A watchdog bounds initialization to 30 seconds and
stuck shutdown to 15 seconds after a stop request; forced shutdown can leave an
incomplete recording and is reported as an error.

**Privilege removal is not de-elevation.** Administrator group membership and
integrity level remain in the engine, so it retains filesystem and registry
access granted to Administrators. The Windows sandbox does not constrain
filesystem or outbound network access. “Fully enforced” means the configured
token/job restrictions succeeded, not that the engine became a standard user.
The UI never receives those administrator permissions. Use trusted builds;
signed installer deployment and UAC with credentials for a different account
need separate validation.

Run the ordinary automated checks from a non-administrator terminal:

~~~powershell
node scripts/test-windows-sandbox.mjs
cargo test --locked --manifest-path src-tauri/Cargo.toml
~~~

These cover token removal on a duplicate token, idempotence, child-process
blocking, protocol rejection, preservation of read-only file access, pipe
exclusivity, and peer PID checks. They never change the caller's token.
After building, run the interactive integration checks individually; each asks
for UAC approval and requires Npcap:

~~~powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml elevated_engine_records_and_stops_while_controller_stays_unprivileged -- --ignored --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml controller_crash_stops_elevated_engine -- --ignored --nocapture
~~~

The first verifies an unprivileged controller, ETW attribution, sandbox status,
PCAPNG recording, and graceful shutdown. The second kills its own disposable
controller process and checks that the elevated engine exits.

## Boundaries and checks

Sandboxing limits what a compromised build can do to the host; it does not prove that its output is trustworthy. Build scripts can modify their working copy, private caches and artifacts. Never run or elevate output from untrusted source or dependencies. The capture engine still has a privileged initialization phase before its runtime sandbox. Existing sudo credentials are neither requested nor refreshed during building; the macOS policy blocks sudo/su execution, while the Linux sandbox prevents privilege gains.

The macOS custom-profile interface is deprecated. A missing or incompatible sandbox is an error, not permission to run unconfined. For a stronger boundary against OS vulnerabilities or genuinely untrusted source, use a disposable VM. The normal `pnpm run desktop` hot-reload workflow remains outside this isolation.

Run `node --test scripts/isolation.check.mjs` to verify real filesystem/network restrictions, subprocess inheritance, and build-before-authentication sequencing. CI runs these checks on both macOS and Linux. They must run outside any outer sandbox that prohibits creating the required OS sandbox.
