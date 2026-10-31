# User and developer guide (unreleased)

[English](GUIDE.md) | [简体中文](GUIDE.zh-CN.md) | [日本語](GUIDE.ja.md)

[Back to the overview](../README.md)


**Contents**

- [Develop](#develop)
- [GeoIP databases](#geoip-databases)
- [Capture permissions](#capture-permissions)
- [macOS sudo development mode](#macos-sudo-development-mode)
- [Linux rendering troubleshooting](#linux-rendering-troubleshooting)
- [Views and recording](#views-and-recording)
- [Process boundary](#process-boundary)
- [Verify and package](#verify-and-package)
- [Dependency updates](#dependency-updates)

## Develop

Install Rust, Node.js 22.22.2+ or 24.15.0+ LTS, the existing RustNet build
requirements, and [Tauri's desktop prerequisites](https://v2.tauri.app/start/prerequisites/).
Linux additionally needs WebKitGTK 4.1 and GTK 3 development packages. Windows
needs the MSVC toolchain, WebView2, and Npcap. Build on the target platform.
macOS builds require macOS 13+ and Xcode Command Line Tools (`xcode-select --install`).

Install [pnpm](https://pnpm.io/installation) 12.15.0 (pinned in `package.json`).
For example, `npm install --global pnpm@12.15.0 --allow-scripts=pnpm`.

For an isolated install/build on macOS or Linux, start with
`node scripts/isolated-build.mjs`. No prior `pnpm install` is needed.
See [isolated builds and sudo capture](../BUILDING.md).

For ordinary development with hot reload, from this directory:

```sh
pnpm install --frozen-lockfile
pnpm run desktop
```

This repository contains the desktop UI, Tauri bridge, and packaging. RustNet's
capture engine and TUI remain in [domcyrus/rustnet](https://github.com/domcyrus/rustnet).
Git is required on the build machine. The first launch fetches the exact engine
commit in `engine.lock.json`, verifies and applies the listed patches, builds the
CLI, and copies it into `src-tauri/binaries`. Sources are cached under `.engine/`.
No sibling RustNet checkout is required. `pnpm run dev` alone previews the browser
layout; capture controls require Tauri.

### Engine development and updates

This repository temporarily carries `engine/patches/0001-desktop-integration.patch`
for engine changes that have not landed upstream: interface discovery, supervised
shutdown, retained history, richer metadata, and capture coverage. The original
changes remain in the RustNet checkout for separate review. After they merge,
update `engine.lock.json` to that commit and remove the patch entry and file.
Every patch has a SHA-256 checksum; changing it requires updating the lock file.
The desktop expects snapshot schema 1 and tolerates additive fields. Engine
updates must pass frontend validation tests and the Rust bridge tests below.
The patch is a temporary integration aid, not a second engine implementation.

The desktop explicitly enables `--headless-details full` and
`--capture-accounting`. Ordinary headless runs keep the upstream schema and
skip the extra detail construction and accounting. Coverage reuses the lifetime
captured-byte counter and publishes tracked and attributed frame-byte totals
once per processor batch. Attribution reflects ownership when a packet is
processed; later process discovery does not revise past totals. Debug engine
overrides must support both options. Rebuild older bundled engines after updating.

For local engine development, set `RUSTNET_ENGINE_SOURCE` to your RustNet checkout
before `pnpm run desktop`. It must include the integration changes above. The
script builds that source without applying patches or modifying its Git state.
Alternatively, `RUSTNET_DESKTOP_ENGINE` uses an existing compatible binary and
skips the engine build. Both overrides are debug-only; release bundles require
the pinned engine. Cached source edits cause an error rather than being reset.
Preserve any edits before removing `.engine/` to fetch it again.

## GeoIP databases

The engine discovers GeoLite2 databases in `~/.local/share/rustnet/geoip/`
(or `$XDG_DATA_HOME/rustnet/geoip/`) and standard system locations. Put
`GeoLite2-Country.mmdb`, `GeoLite2-ASN.mmdb` and optionally `GeoLite2-City.mmdb`
there to share them with the TUI. Files found only in a terminal's current
working directory may not be found by the desktop.

Alternatively, open capture settings and select **Choose GeoIP folder**. Choose
the folder containing those files; any subset is supported. The selection is
remembered and passed as explicit database paths to the engine. Use
**Apply and restart capture** during capture, or start a new capture, to load
the databases. **Use automatic discovery** restores the engine's normal search.
No database download or elevated desktop permissions are needed. A missing lookup
still appears as Unavailable, for example when city data is absent.

## Capture permissions

Run the desktop as your regular user. Only the capture engine needs capture
permissions. The optional macOS development mode invokes sudo for the engine only.
The desktop does not install firewall rules or disable the engine's sandbox.

- **Linux:** after the first engine build, grant the bundled engine the capabilities
  described in [INSTALL.md](https://github.com/domcyrus/rustnet/blob/main/INSTALL.md). For capture without eBPF, from this
  directory, replace the target triple if necessary:

  ```sh
  sudo setcap cap_net_raw+eip src-tauri/binaries/rustnet-capture-engine-x86_64-unknown-linux-gnu
  ```

  Copying or rebuilding the engine clears file capabilities. To reuse an already
  configured engine during development, set `RUSTNET_DESKTOP_ENGINE` to an
  absolute path to a compatible engine binary. This override is supported
  only by debug builds. Packaged builds use the adjacent bundled engine; granting
  capabilities is a separate installation step, not an automatic installer action.
- **macOS:** for PKTAP, install a Developer ID signed, notarized build in
  `/Applications`. Open capture settings, select **Enable capture helper**, then
  approve RustNet Desktop in **System Settings > General > Login Items & Extensions**.
  Select **Recheck helper status**, choose **Automatic**, and start capture. The
  `SMAppService` helper launches the bundled engine as root; the engine drops to
  your user and applies its strict sandbox after opening capture. The UI stays
  unprivileged. Explicit interfaces disable PKTAP in the current engine.
  Stop capture before **Remove capture helper**. Remove and enable it again after
  an update changes the helper or launch-daemon plist. Development and ad-hoc
  builds without sudo development mode use ordinary BPF capture with `lsof` attribution. Configure BPF access
  as described in [INSTALL.md](https://github.com/domcyrus/rustnet/blob/main/INSTALL.md);
  ChmodBPF alone does not grant PKTAP access. Helper approval is separate from BPF permissions.
- **Windows:** install Npcap and launch the desktop normally. **Start capture**
  requests UAC approval for the bundled capture engine; the UI stays unprivileged.
  The engine removes unnecessary token privileges and exits when capture stops
  or the UI closes. No service or helper installation is required. See
  [Windows testing](../BUILDING.md#windows-testing) for launch instructions,
  tests, and the limits of the engine's privilege reduction.
- **FreeBSD:** the existing CLI remains supported; desktop support is not provided
  by this initial Tauri application.

Choose an interface and click **Start capture**. Permission, driver, and capture
errors appear in the application. Process attribution may be limited by the OS;
unattributed connections remain visible.

## macOS sudo development mode

For PKTAP without signing or notarization, run as your normal user:

```sh
node scripts/desktop-sudo.mjs
```

To authenticate and reuse the existing debug build without rebuilding or testing, run `node scripts/desktop-sudo.mjs --no-build`. Rebuild after changing source or dependencies.

The launcher completes an isolated offline debug build and tests before asking for
sudo authentication. It then starts the built desktop with embedded assets, with
no dev server or build watcher. Choose **Automatic** and start capture. Only the
engine uses sudo; the UI stays unprivileged. Credentials are not refreshed on a
timer. See [isolated builds](../BUILDING.md) for prerequisites, limitations and retry
instructions. `pnpm run desktop:sudo` remains an alias when dependencies are installed.

## Linux rendering troubleshooting

If the entire window stops responding or resizing exposes black areas, stop the
current development run with Ctrl+C in its terminal, then try:

```bash
pnpm run desktop:linux-compat
```

This Linux-only command sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` for that launch.
It tests the [WebKitGTK graphics workaround documented by Tauri](https://tauri-v2.netlify.app/develop/debug/linux-graphics/)
without changing normal launches, capture permissions or sandboxing. It requires
restarting the desktop, not rebuilding the capture engine. If it still hangs,
collect the terminal output and WebKitGTK/graphics driver versions before applying
further workarounds. Black areas alone do not establish the exact cause.

## Views and recording

- **Applications** opens on **All traffic**, showing the overall graph, tracked
  session totals, connection/application/host counts, and capture coverage. Click
  an application for details; double-click to filter Connections to that group,
  including matching retained history. **Clear filter** returns to all applications.
- **Connections** is a continuous, searchable table. Search by process, PID,
  hostname, IP, port, or protocol using words, not TUI filter expressions.
  Applications and connections default to name order; click rate headings for live
  rate sorting. Click a connection to inspect it or double-click to expand details.
- The inspector shows process ancestry, user/group, container metadata, service/VLAN,
  hostnames, GeoIP, DNS, TLS and transport health. Missing observations remain
  unavailable. Linux executable paths may be retained from startup, but newly
  started or inaccessible processes may lack them.
- Drag the inspector divider or use Left/Right arrows to resize it. Wide inspectors
  show Overview, Process and Protocol together; compact ones use tabs. **Expand**
  opens focused details. Close or press Escape to return with filters preserved.
- Live rates use the same two-second moving average across views, including
  Unattributed traffic. Newly observed existing flows establish a baseline;
  closed connections leave the live sum. **Show raw peaks** reveals interval rates,
  and **Log scale** makes small flows visible alongside bursts. Invalid snapshots
  keep the last valid view until recovery.
- Charts retain up to 121 samples over 60 seconds for every application, including
  while viewing another application. A new capture resets them. **Freeze view**
  pauses only the display; capture and recording continue.
  While frozen or hidden, the window requests only capture status. Resuming fetches
  the latest snapshot; chart samples from the suspended period are not reconstructed.
- **Show breakdown graph** compares captured and attributed rates. Coverage counts
  original frame lengths, including link-layer headers, split into attributed,
  tracked but unattributed, and outside tracked connections. Attribution is fixed
  at packet processing time, and totals survive connection expiry. The outside gap
  includes pending processing, skipped packets and queue drops, and may shrink as
  the queue drains. Undelivered packets cannot be measured; VPN/all-interface
  capture may count traffic twice. Coverage totals differ from connection counters.
- Application byte totals include active and retained closed connections and may
  decrease as history expires; they are not complete session totals. **Hosts**
  counts unique remote IPs across active connections, regardless of port.
  Applications group by process name and distinguish known executable paths;
  ambiguous missing paths remain in an executable-unavailable group.
- Open capture settings from the source button beside capture status. Linux
  defaults to **All interfaces (any)** when available and no preference is saved.
  On macOS, **Automatic** attempts PKTAP with the helper enabled. Missing saved
  interfaces require a replacement. **Apply and restart capture** stops the old
  session cleanly; recording requires a new file. **Stop capture** is also here.
- **History** (`t`) toggles retained closed connections locally; its count remains
  visible when hidden. Historic rates are excluded from live totals, which cover
  active tracked connections only. Idle connections fade and show a countdown to
  history when supported by the engine; selected and active rows stay readable.
- Select **Record PCAPNG** before capture and choose an unused filename in the save
  dialog. Recording uses the engine's annotated exporter and is not retroactive.
  Stop capture to flush output; export errors or dropped records mean it may be incomplete.
- Appearance, preferred view, inspector width and the last successfully requested
  interface are saved locally. Traffic snapshots are not persisted by the UI.
  Sandbox status and packet counters appear above Capture Source in the sidebar.
- Mouse Back/Forward and Alt+Left/Right restore views and selections. In Connections,
  `/` focuses search, `g`/`G` select the first/last row, and `Ctrl+f`/`Ctrl+b` move
  down/up a page. Shortcuts respect the current filter and sort and do not intercept
  text fields or dropdowns. Escape closes the inspector or appearance panel.
- **Help** in the sidebar or `h` explains the current view and its shortcuts.
  Capture settings and the inspector also have their own help.

## Process boundary

The desktop launches only its bundled `rustnet-capture-engine` executable using structured
arguments, directly or through the approved macOS helper. `--list-interfaces` returns JSON without opening capture. A capture
uses `--headless --output jsonl --include-historic --stop-on-stdin-close`. Closing the controller pipe
requests the CLI's normal shutdown and output flush, including after a desktop
crash. Closing the window waits for shutdown. A child that fails to stop within
15 seconds is terminated and the recording is marked potentially incomplete.

The macOS helper and app authenticate XPC messages using Developer ID signing
requirements with the same Team ID and fixed identifiers. The helper accepts
only a bounded interface name and already-open recording/GeoIP descriptors,
never executable paths, shell commands, or arbitrary arguments. It derives the
engine's drop identity from the authenticated caller, permits one capture per
user, and stops capture when XPC disconnects. Approved helper launches always
copy the bundled engine to a private root-owned directory, verify its signature,
and execute that protected copy; debug engine overrides are rejected. Recording
files are created exclusively by the regular user. User GeoIP discovery is
resolved by the app before descriptors cross the privilege boundary.

The bundled engine also reuses encoded JSON for unchanged historic connections, including extended details. The cache retains up to 10,000 records and 16 MiB of encoded JSON, plus their projected fields and bookkeeping. Late metadata and final counters still update. Full snapshots are still built and sent, so this reduces repeated encoding work but does not make CPU use independent of history size.

The bridge retains the latest validated snapshot as shared raw JSON, caps individual
records at 16 MiB, and bounds diagnostic output. It forwards JSON without rebuilding
or deep-copying its connection tree. The UI polls every 500 ms with a cursor;
unchanged responses omit the payload and do not update charts. Frozen or hidden
views poll only status, including errors, and request a full snapshot on resume.
The UI validates schema 1,
and shows Connections as one continuous table. Application lists and their destination
lists use pages of 75 items. Packet decoding, process lookup,
privilege dropping, and sandboxing stay in the existing engine. The webview has no
shell or general filesystem plugin permissions. Firewall and process termination
controls are outside this first version.

## Verify and package

```sh
pnpm run prepare:engine
pnpm run build
pnpm test
pnpm run test:engine-source
pnpm run test:macos-helper
pnpm run test:application-icons
pnpm run check:engine
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm audit
cargo audit --file src-tauri/Cargo.lock
pnpm run bundle
```

`pnpm run bundle` builds the release CLI and desktop and includes the engine in the
platform bundle. Production signing/notarization credentials and automated capture
permission provisioning for Linux/Windows are not configured. macOS bundles also
contain the capture helper and its launch-daemon plist. For a deployable PKTAP
build, set `APPLE_SIGNING_IDENTITY` to your Developer ID Application identity and
provide Tauri's notarization credentials (`APPLE_ID`, `APPLE_PASSWORD`, and
`APPLE_TEAM_ID`, or Apple API key credentials) before `pnpm run bundle`.
See [Tauri's signing and notarization guide](https://v2.tauri.app/distribute/sign/macos/).
Both sidecars and the app must retain their identifiers and use the same Team ID.
Unsigned/ad-hoc bundles compile but cannot enable the privileged helper.
`test:application-icons` checks native icons on macOS, Linux, and Windows. Linux requires
`xvfb`, `xauth`, and the SVG loader (`librsvg2-common` on Debian/Ubuntu).
Development builds resolve Linux icons from installed desktop entries and the
active GTK theme. Apps launched through Flatpak, Snap, or shell wrappers may
retain placeholders when their executable cannot be matched reliably.
Development builds on Windows extract icons from executable files, resolving
process paths by PID when needed. Inaccessible processes and files without an
embedded icon retain placeholders.

`test:macos-helper` runs unprivileged broker/descriptor tests on macOS and skips
other platforms; it does not install a daemon. Signed integration validation
must additionally approve the helper, confirm PKTAP in the snapshot's attribution
method with Automatic, and check recording flush, UI closure and helper removal.
If DMG packaging stalls in Finder's layout step, `CI=true pnpm run bundle`
skips that cosmetic step. Run the RustNet repository checks from
[CONTRIBUTING.md](https://github.com/domcyrus/rustnet/blob/main/CONTRIBUTING.md) when changing the engine.

The current Tauri Linux dependency tree reports upstream RustSec warnings for
unmaintained crates and GLib `VariantStrIter` soundness (RUSTSEC-2024-0429).
These warnings are not suppressed in the desktop checks. Review upstream fixes
before distributing a production release.

## Dependency updates

GitHub Dependabot checks pnpm dependencies at the repository root, Cargo dependencies
in `src-tauri`, and GitHub Actions daily. Its configuration follows RustNet: updates
are grouped by ecosystem, including major upgrades. Package updates have a 3-day
default cooldown (7 days for major, 4 for minor, 3 for patch releases). Security
updates are not delayed by cooldowns. Review the PR and CI results before merging;
no automatic merging or external app installation is configured.

`engine.lock.json` and the temporary engine patches remain manually maintained
together. Dependabot does not update the patched engine revision.
