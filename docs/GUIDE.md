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

The bundled engine is pinned to [RustNet #721](https://github.com/domcyrus/rustnet/pull/721)
at `64fe320`, which includes merged #719. Shared CLI features come directly from
that revision. The only remaining engine patch,
`engine/patches/0003-windows-capture-helper.patch`, supplies the desktop-only Windows
capture protocol and preopened recording/GeoIP handles. It stays in this repository;
application icon lookup and the macOS helper also remain desktop-owned.
Every patch has a SHA-256 checksum; changing it requires updating the lock file.
The bridge accepts engine schema 2 and legacy schema 1, and exposes complete schema 1
snapshots to the UI and saved history. Additive fields are preserved. Engine updates
must pass frontend validation and Rust bridge tests, plus native helper/icon tests
on the corresponding platforms.

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
  rate sorting. Click a connection to open its inline details; click again or Collapse to close.
- The inspector shows process ancestry, user/group, container metadata, service/VLAN,
  hostnames, GeoIP, DNS, TLS and transport health. Missing observations remain
  unavailable. Linux executable paths may be retained from startup, but newly
  started or inaccessible processes may lack them.
- Prism uses lavender navigation, quieter panels, and purple/teal traffic accents in
  light and dark themes. The connection table separates application/PID,
  destination/status, download and upload so rate headings remain easy to click.
- Connection details open beneath the selected row. Wide windows show Connection &
  traffic, Process, and Protocol & transport together in three columns. Narrow
  windows stack these groups. **Show unobserved fields** reveals missing metadata;
  observed values and zero counters remain visible by default.
- All traffic uses a compact graph beside session totals and coverage. Coverage
  explanations expand on request, leaving application rows visible below the overview.
  Each application has one identity row; its chevron opens or closes inline details.
- Each view shares one scroll area between its
  list and details. Navigation and workspace controls stay fixed. Up/Down, Page
  Up/Page Down and Home/End scroll that area even when a button has focus, while
  text fields and dropdowns retain their normal keys. Collapse returns focus to
  the selected row. Changing connection filters resets the list to the top.
- Appearance offers **Comfortable (12px)** scrollbar tracks with 8px rounded thumbs,
  or **System default**, plus comfortable/compact connection rows. Scrollbars appear
  only when content overflows; system visibility preferences may still hide them.
  Capture settings, appearance and help use dialogs with a pinned heading and a
  single scrolling body. Live updates do not reset the reading position.
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
- Appearance, scrollbar style, row density, preferred view and the last successfully requested
  interface are saved locally. Traffic snapshots are not persisted by the UI.
  Sandbox status and packet counters appear above Capture Source in the sidebar.
- Mouse Back/Forward and Alt+Left/Right restore views and selections. In Connections,
  `/` focuses search, `g`/`G` select the first/last row, and `Ctrl+f`/`Ctrl+b` move
  down/up a page. Shortcuts respect the current filter and sort and do not intercept
  text fields or dropdowns. Scrolling keys move the current content pane. Escape closes the inspector or the current settings dialog.
- **Help** in the sidebar or `h` explains the current view and its shortcuts.
  Capture settings and the inspector also have their own help.

## Local traffic history (development)

Enable **Save traffic history** in Capture settings before starting capture.
The option defaults to off, remembers your choice across app restarts, and is
independent of PCAPNG recording. Changes apply
on the next capture. The desktop shows the database path and any storage error
or skipped snapshots. History continues while the view is hidden or frozen,
but stops when capture stops or the app exits.

Open **Saved history** in the sidebar to browse saved traffic after a restart,
filter by time (including custom local dates), application and capture interface,
and inspect uploaded/downloaded totals, destinations and the latest matching
capture sessions. **Inspect traffic** on a finding selects its application,
interface and time range. The sampled timeline refreshes every 30 seconds while visible; **Auto-refresh** pauses it;
the live view's Freeze control does not freeze saved-history queries.
Refresh keeps the current graphs, zoom, selection and legend choices visible until
replacement data arrives. Failures leave the last successful view available.
Automatic refresh waits for both history queries to finish before its next 30-second
interval, so slow queries do not accumulate.
After an initial read, timeline refresh uses a database change cursor to read new
or corrected ten-second samples, including one predecessor counter per connection.
The last ten-second bucket is revisited so partial intervals can finish. Totals,
application/connection rows and display bins are rebuilt from the cached window;
expired samples are removed as the window moves. Anomaly profiles advance from new
eligible intervals; corrections replay the cached baseline rather than rereading
all its samples. The desktop still sends a complete, bounded display report to the UI.

Changing filters, expanding backwards, a stale cursor, metadata corrections,
retention deletion or database replacement causes a full read. The cache holds one
view, up to 500,000 samples and 500,000 coverage rows, plus the newest 100,001 eligible
app intervals. Larger windows use full reads; narrowing the duration or changing
scope retries caching. The dirty-bucket journal retains the latest 100,000 revisions.
Version 1/2 databases remain readable without changes; incremental reads start after
capture upgrades the database to version 3. Minute summaries, session details and
filter options load initially and on **Refresh history** or filter changes, not on
every automatic timeline refresh.

The Connections **History** toggle still controls retained closed connections.

Saved application and connection rows, and the live Connections list, use the same
shared native icons. Connection icons sit beside the application name and PID;
retained closed connections never use their old PIDs for lookup. Icons are
cached when displayed in either view, in `application-icons.sqlite3` beside the
traffic database. Each distinct PNG is stored once under its SHA-256 digest;
executable paths reference that entry. Connections and ten-second samples do not
store image copies. Cached icons survive restarts and removal of the executable,
until evicted. The cache retains at most 256 PNGs (128 KiB each) and 2,048 executable
references; unused images and the oldest entries are removed. Live lookups can
refresh changed icons. Historical lookups never use saved PIDs, and icons without
a stable executable path are not persisted. Unavailable icons keep the placeholder.

The history dashboard uses per-connection samples, normally ten seconds apart.
Traffic rate, observed connections and capture health panels share a cursor and
time range. Hover to inspect values, drag to select a range, and use **Zoom out**
to return. With a graph focused, arrow keys inspect intervals, Enter zooms and
Escape clears the cursor. Legends toggle series and show last recorded and maximum
values. Anomaly markers open their evidence. Select a connection to inspect its
cumulative counters and differences.
Long ranges use larger display bins; zooming reveals the ten-second resolution.
Traffic rates divide recorded bytes by the full display interval. They are interval
averages, not instantaneous speeds. Missing values remain gaps. Capture health uses
gray for no coverage, stripes for partial coverage and dots for counter resets. The connection list has 50 rows per page; sample details have 200.
Sample totals assign each difference to its ending timestamp, without interpolating
traffic. A boundary difference can include time before the selected range.

Metadata is stored once in `flow_records` and enriched when process or hostname
information arrives. `flow_samples` holds timestamps, cumulative counters and a
continuity segment. The sampler consumes every delivered snapshot, records first
and final observations, and flushes pending counters on disappearance or capture
stop. Short connections are included if they appear in an engine snapshot; retained
closed connections are not repeatedly sampled. Gaps, reappearance and counter
resets start a new segment, so SQL must not subtract across segments. Missing
packet counters remain NULL. `capture_intervals` records coverage in ten-second
buckets independently of connection activity.

Schema version 3 migrates automatically when history collection starts. Existing
minute summaries remain browsable under **Minute summaries and earlier history**;
no connection samples are invented for old data. Timeline anomaly detection uses
connection samples; legacy minute summaries do not train its baseline. Connection metadata displays
its latest known identity; the older summaries retain attribution at ingestion.
Samples, coverage and inactive connection metadata expire after 30 days. Storage
scales with the number of active connections (8,640 periodic samples per continuously
observed connection per day), plus first/final/boundary records.

History opens with **Applications**, using the same compact rows as the live view.
Select an application to browse its **Connections** and select a connection for
counter details. The application list shows up to 200 busiest applications;
use the application filter to find others. Traffic, observed-connection and
capture-quality graphs share the selected range. Connection counts are distinct
sampled connections per display bin, not simultaneous concurrency. The quality
graph shows gaps, partial coverage and counter resets, not application errors.

**Unusual activity** uses the ten-second connection samples. Circled timeline
markers open the evidence; **Inspect traffic** narrows the view to the app,
interface and exact ten-second interval. On a single connection's timeline,
findings still describe its application's behavior across all its connections.
The detector requires an executable identity and 180 earlier complete ten-second
app/interface intervals (30 active minutes) within seven days, using up to 720
intervals. It excludes unknown deltas, origins without traffic, resets, intervals
over 15 seconds, incomplete capture coverage, overlapping sessions and capture
errors. Missing observations are never filled with zeroes. Earlier samples outside
the displayed range can train the baseline, but future samples cannot.

Upload thresholds are the maximum of 2 MiB per ten seconds, five times the earlier
median, and median + six median absolute deviations + 256 KiB. Download thresholds
use 10 MiB and a 1 MiB margin; connection thresholds use 20 and a margin of 4.
Quantitative outliers do not train the baseline. Newly observed destinations are
informational first-seen changes after learning; hostname enrichment or service
changes can explain them. Each finding refers to one ten-second interval, with
larger display bins showing the combined count of findings.

Findings are recalculated when browsing, not permanently archived or sent as
background notifications. Analysis uses the newest 100,000 eligible app intervals
within the selected range and its preceding seven-day training window. The newest
100 findings are shown and marked; truncation is indicated. Narrow the range or
application filter to inspect older findings. Connection pages contain 50 rows,
sample pages contain 200, and the legacy session list shows the latest 20 matches.

The separate `rustnet-analytics` Rust crate consumes existing engine metadata in
the unprivileged desktop backend. A blocking writer uses SQLite transactions and
a queue of at most two pending snapshots. A slow or failed writer does not block
the capture pipe: skipped snapshots are counted, and errors stop history only.
Stop capture to drain queued writes before inspecting a complete session.

The database is `traffic-history.sqlite3` in Tauri's local app data directory
(`~/Library/Application Support/io.github.domcyrus.rustnet.desktop/` on macOS).
Use the exact path displayed in the app on other platforms. It contains app
names/executable paths, destination hostnames or IPs, ports, protocols, byte
increments, connection counts and observation coverage. Packet payloads and full
snapshots are not stored. To remove history, stop capture, quit the app, and
remove this file and its `-wal` and `-shm` companions if present.

Tables are ordinary SQL: `sessions`, `applications`, `traffic_buckets`,
`destinations`, and `observation_buckets`. Schema migrations use `user_version`;
newer unknown versions are rejected. SQLite is bundled through `rusqlite` so
users do not need a separate database installation. Minute summaries and inactive
destinations expire after 30 days, checked when history opens and hourly during
ingestion. Active destinations retain their original first-seen time and count.
Expired space can be reused; deletion does not necessarily shrink the file.

Accounting limits for legacy minute summaries:

- The first snapshot establishes counters. Initial bytes and increments across
  missing snapshots, intervals over five seconds, or counter resets are omitted
  rather than assigned to a misleading burst. Final increments from retained
  closed connections are included. Flows absent from every snapshot remain unseen.
- Bytes belong to the minute when the increment was observed, without estimating
  their timing inside the interval. Coverage duration is split at minute boundaries.
- Missing minutes are unknown, not zero. `observation_buckets.incomplete` flags
  gaps, resets, packet loss and degraded attribution. Check `observed_ms`, session
  errors, `capture_error`, `dropped_snapshots`, and `ended_ms` before using data as
  a baseline. A clean capture should end with `runtime_status = 'stopped'`.
- App keys prefer executable paths, then names, with a separate unattributed group.
  Name-only identities are weaker. Later attribution applies to future increments;
  previous bytes are not reassigned. Hostnames are normalized for case and a trailing
  dot, with IP fallback. Later hostname discovery may create a second destination.
- Destination `connections` counts distinct observed flow/destination associations
  per session, including flows already present at startup. Traffic bucket counts
  include only newly observed flows created during a continuous interval.

For example, open the displayed path using `sqlite3 -readonly /path/to/traffic-history.sqlite3`
and run these queries:

```sql
SELECT f.id, f.remote_ip, f.remote_port, p.timestamp_ms, p.segment,
       p.bytes_sent, p.bytes_received, p.packets_sent, p.packets_received
FROM flow_samples AS p JOIN flow_records AS f ON f.id = p.flow_id
WHERE f.id = 1 ORDER BY p.timestamp_ms;

SELECT a.name, a.executable,
       SUM(t.bytes_sent) AS uploaded, SUM(t.bytes_received) AS downloaded
FROM traffic_buckets AS t JOIN applications AS a ON a.key = t.app_key
GROUP BY a.key ORDER BY uploaded DESC;

SELECT a.name, d.kind, d.value, d.connections,
       datetime(d.first_seen_ms / 1000, 'unixepoch') AS first_seen_utc,
       datetime(d.last_seen_ms / 1000, 'unixepoch') AS last_seen_utc
FROM destinations AS d JOIN applications AS a ON a.key = d.app_key
ORDER BY d.first_seen_ms DESC LIMIT 50;
```

Test the collector without building Tauri:
`cargo test --locked --manifest-path src-tauri/Cargo.toml -p rustnet-analytics`.

## Process boundary

The desktop launches only its bundled `rustnet-capture-engine` executable using structured
arguments, directly or through the approved macOS helper. `--list-interfaces` returns JSON without opening capture. A capture
uses `--headless --output jsonl-delta --include-historic --stop-on-stdin-close`. Closing the controller pipe
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

The bundled engine uses schema 2 incremental output and full metadata from [RustNet #721](https://github.com/domcyrus/rustnet/pull/721) at `64fe320`, including merged #719. The engine emits full initial, periodic, and terminal snapshots, with complete changed connections and removals between them. Its delta baseline is limited to 10,000 records and 16 MiB of encoded JSON; larger captures fall back to full snapshots. Projection still scans the selected connections, so smaller output does not imply constant CPU use as history grows.

The Rust bridge applies every delta before UI polling or saved-history delivery. It checks sequence continuity, IDs, and reconstructed counts, preserves raw metadata, and shares unchanged connection records. Missing or invalid updates keep the last good view visible with an error until a later full snapshot restores synchronization. Each new capture starts with a fresh baseline. Saved history receives complete snapshots and preserves sequence gaps.

Individual input records and reconstructed snapshots are each limited to 128 MiB, with up to 100,000 connections in incremental mode. Exceeding either bound stops capture with an explicit error rather than truncating data. Diagnostic output is also bounded. The bridge builds complete schema 1 JSON only when the UI or history writer needs it; schema 1 debug-engine input remains supported.

The UI polls every 500 ms with a cursor; unchanged responses omit the payload and do not update charts. Frozen or hidden views poll only status, including errors. Reconstruction continues, and resuming fetches the latest complete snapshot, including additions, removals, and late metadata.
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
default cooldown (7 days for major, 4 for minor, 3 for patch releases). GitHub Actions
updates have a 3-day cooldown. Dependabot automatically exempts security updates
from cooldowns. Review the PR and CI results before merging;
no automatic merging or external app installation is configured.

`engine.lock.json` and the temporary engine patches remain manually maintained
together. Dependabot does not update the patched engine revision.
