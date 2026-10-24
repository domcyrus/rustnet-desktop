# RustNet Desktop (unreleased)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

A Tauri 2 desktop frontend for the RustNet capture engine. The application explorer,
connection table, inspector, and traffic charts consume real version 1 headless
snapshots. No sample traffic is used by the application.

## Develop

Install Rust, Node.js 22.22.2+ or 24.15.0+ LTS, the existing RustNet build
requirements, and [Tauri's desktop prerequisites](https://v2.tauri.app/start/prerequisites/).
Linux additionally needs WebKitGTK 4.1 and GTK 3 development packages. Windows
needs the MSVC toolchain, WebView2, and Npcap. Build on the target platform.
macOS builds require macOS 13+ and Xcode Command Line Tools (`xcode-select --install`).

Install [pnpm](https://pnpm.io/installation) 12.15.0 (pinned in `package.json`).
For example, `npm install --global pnpm@12.15.0 --allow-scripts=pnpm`.

From this directory:

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

The private repository temporarily carries `engine/patches/0001-desktop-integration.patch`
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
permissions. The desktop never invokes sudo, installs firewall rules, or disables
the engine's sandbox.

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
  builds use ordinary BPF capture with `lsof` attribution. Configure BPF access
  as described in [INSTALL.md](https://github.com/domcyrus/rustnet/blob/main/INSTALL.md);
  ChmodBPF alone does not grant PKTAP access. Helper approval is separate from BPF permissions.
- **Windows:** install Npcap with access for your normal user. An installation
  restricted to administrators needs its permissions configured separately.
- **FreeBSD:** the existing CLI remains supported; desktop support is not provided
  by this initial Tauri application.

Choose an interface and click **Start capture**. Permission, driver, and capture
errors appear in the application. Process attribution may be limited by the OS;
unattributed connections remain visible.

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

- The inspector exposes engine service/VLAN and scope information, packet totals,
  process ancestry, parent PID, user/group, container/Kubernetes metadata, hostnames,
  observed neighbor MACs, GeoIP and captured-DNS attribution. Protocol fields share
  their definitions with the TUI, including TLS/SNI/ALPN and cipher suites. Transport
  health shows RTT, TCP counters/windows and protocol-specific request outcomes.
  Unknown window scaling is labeled as raw; missing observations remain unavailable.
  On Linux, validated startup matches can retain executable paths captured before
  sandboxing; newly started or inaccessible processes may still lack paths.
  Rebuild the bundled engine and restart capture to receive the new metadata.

- The header, All traffic, application lists/details and connection rates use the same two-second window over active connection byte counters. Their live rates agree, including Unattributed traffic. Newly observed existing flows establish a baseline before reporting rates; closed connections leave the live sum. Coverage and overall session totals remain separate original-frame measurements, so their byte totals can differ from connection counters. **Log scale** reveals small flows alongside large bursts.
- Live rates use a two-second moving average; **Show raw peaks** reveals interval rates. Graphs show the actual sample count, retain up to 121 points over 60 seconds, and skip near-simultaneous updates without losing byte deltas. Invalid bridge snapshots keep the last valid view and the error clears after recovery.
- Applications opens on **All traffic**, with the overall graph, tracked download/upload
  session totals, connection/application/host counts, and capture coverage. Select an
  application for its details and All traffic to return. The overview is no longer
  under Connections. **Show breakdown graph** compares captured and attributed rates.
- Coverage counts original captured frame lengths, including link-layer headers:
  attributed application bytes, tracked bytes with unknown applications, and bytes
  outside tracked connections. Ownership is recorded at packet processing time,
  without retroactive reassignment. Totals survive connection expiry. The outside
  gap includes pending processing, skipped packets and queue drops; it can shrink
  as the queue drains. Packets never delivered by the backend cannot be measured
  in bytes. VPN/all-interface capture may observe traffic more than once.
  These counters differ from per-application connection byte totals. Rebuild the
  engine and restart capture to enable coverage; older engines show an explanation.
- Click an application for its traffic overview; double-click it to open Connections
  filtered to that application group. Clear filter returns to all applications.
  The filter includes matching retained history and follows Back/Forward navigation.
- Connections uses one scrollable table without pagination. Click anywhere in a row
  to inspect it; double-click to open expanded details. Double-clicking a destination
  under an application also opens expanded connection details directly.
- Applications and connections start in alphabetical order; rates update in place.
  Click the download/upload column heading to sort connections by current rate,
  or the application's Download rate heading to rank applications. Rate sorting is live.
- Application details show total downloaded/uploaded bytes across active and retained
  closed connections. These totals can decrease when old connections are evicted;
  they are not lifetime or complete session counters. Hosts counts unique remote IPs
  across active connections, ignoring port differences.
- Dropdowns follow the appearance theme. Use arrows, Home/End, or type a label prefix
  to navigate; Enter selects, Escape cancels, and Tab closes the menu.
- Capture settings open from the source button beside capture status. Linux defaults
  to **All interfaces (any)** when available and no preference has been saved.
  **Automatic** and explicit interface choices remain available. On macOS,
  Automatic attempts PKTAP when the capture helper is enabled.
  Existing choices, including Automatic, are preserved. Missing saved interfaces
  require choosing a replacement. During capture, **Apply and restart capture**
  stops the old session cleanly before starting the new one; recording uses a new file.
- The connection inspector has independently scrolling Overview, Process, and Protocol
  details. Drag its divider or use Left/Right arrows to resize it. **Expand** opens a
  focused view; smaller windows show details in place of the list. Close details or
  press Escape to return with filters preserved.
- Wide inspectors show Overview, Process, and Protocol together; compact inspectors use tabs.
- Mouse Back/Forward and Alt+Left/Right restore earlier views and selections.
- Sandbox status and packet counters appear above Capture Source in the sidebar.
- Inspector width is saved locally. Live rate values stay on one line in fixed-width
  summary slots so changing traffic does not shift the layout.
- Applications are grouped by process name, with contributing PIDs. Missing executable
  paths do not split a group or reset its graph when a path arrives. Distinct known
  executables with the same name remain separate and show their paths. If several
  paths exist, missing paths join a known live PID only when unambiguous; otherwise
  they remain in an executable-unavailable group.
- Connections can be searched by process, PID, hostname, IP, port, or protocol,
  sorted by traffic or name, and inspected without losing identity on refresh.
  Search is a local word search, not the TUI filter expression language.
- The desktop requests retained history from the engine with `--include-historic`;
  the History button filters visibility locally, so its count remains available when hidden.
- **History** (`t`) shows retained historic connections. Historic rates are excluded
  from live totals. These totals cover active tracked connections, not all interface
  bytes or traffic outside capture visibility.
- Charts keep at most 60 seconds of observed samples. Every application retains history
  throughout capture, so switching applications shows existing samples immediately.
  A new capture session starts fresh. **Freeze view** freezes displayed
  data while capture and recording continue.
- A dot beside the capture source indicates live capture. Open the source control
  for capture settings and **Stop capture**. **Freeze view** remains directly accessible.
- Select **Record PCAPNG** before starting. A native save dialog chooses the
  destination; choose an unused filename. Recording starts with capture, is not
  retroactive, and uses the engine's annotated PCAPNG exporter. Stop capture to
  flush it. Export errors and dropped export records indicate incomplete output.
- Appearance, preferred view, and the last successfully requested interface are
  stored locally. Traffic snapshots are not persisted by the UI.
- In Connections, `g`/`G` select the first/last row and `Ctrl+f`/`Ctrl+b` move a page
  down/up, following the current filter and sort. Shortcuts do not intercept text fields or dropdowns.
- **Help** in the sidebar or `h` opens guidance for the current view, with relevant
  shortcuts and explanations. Capture settings and the inspector have their own help.
- Idle connections follow the engine cleanup clock: after half the timeout, context
  columns gently fade and a countdown shows time to history. Nonzero rates and selected
  rows stay readable. Reduced-motion settings disable transitions. Older bundled engines
  still support history; rebuild the engine to enable cleanup timing.
- `/` focuses connection search; Escape closes the inspector or appearance panel.

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

The bridge retains one latest snapshot, caps individual records at 16 MiB, and
bounds diagnostic output. The UI polls serially every 500 ms, validates schema 1,
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
