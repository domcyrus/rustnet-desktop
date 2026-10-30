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

`pnpm run desktop:sudo` is an alias when project dependencies are already installed. The direct Node command avoids needing an ordinary dependency install. The launcher first completes the isolated debug build and tests. Only after success does it request sudo authentication, then it directly runs the built desktop with embedded assets. No Vite server, watcher, compiler or package-manager task is started after authentication. There is no periodic sudo credential refresh.

Choose **Automatic** and start capture. Only the engine starts through sudo; the UI stays unprivileged. The pinned engine drops privileges and applies its strict sandbox after opening capture. Explicit interfaces disable PKTAP. Engine source/binary overrides are not supported by this workflow. No helper registration, signing, notarization or sudoers changes are required. Release builds still ignore `RUSTNET_DEV_SUDO` and use the signed helper for PKTAP.

If sudo credentials expire, an existing capture continues but a new capture may fail. Quit the desktop and rerun the command to rebuild and authenticate. Stop capture or close the desktop to flush the recording. Live PKTAP capture and signed SMAppService deployment still require separate validation.

## Boundaries and checks

Sandboxing limits what a compromised build can do to the host; it does not prove that its output is trustworthy. Build scripts can modify their working copy, private caches and artifacts. Never run or elevate output from untrusted source or dependencies. The capture engine still has a privileged initialization phase before its runtime sandbox. Existing sudo credentials are neither requested nor refreshed during building; the macOS policy blocks sudo/su execution, while the Linux sandbox prevents privilege gains.

The macOS custom-profile interface is deprecated. A missing or incompatible sandbox is an error, not permission to run unconfined. For a stronger boundary against OS vulnerabilities or genuinely untrusted source, use a disposable VM. The normal `pnpm run desktop` hot-reload workflow remains outside this isolation.

Run `node --test scripts/isolation.check.mjs` to verify real filesystem/network restrictions, subprocess inheritance, and build-before-authentication sequencing. CI runs these checks on both macOS and Linux. They must run outside any outer sandbox that prohibits creating the required OS sandbox.
