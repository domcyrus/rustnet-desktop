export interface Neighbor {
  mac: string;
  vendor: string | null;
}
export interface TcpWindow {
  bytes: number;
  scale_known: boolean;
}
export interface Connection {
  id: string;
  protocol: string;
  state: string;
  local: { ip: string; port: number; address_kind?: string };
  remote: { ip: string; port: number; address_kind?: string };
  direction: string | null;
  process: {
    pid: number | null;
    name: string | null;
    executable: string | null;
    attribution_match?: string | null;
    user_group?: string | null;
    ppid?: number | null;
    uid?: number | null;
    gid?: number | null;
    lineage?: {
      ancestors: {
        pid: number;
        name: string;
        executable: string | null;
        started_at_unix_ms: number | null;
      }[];
      truncated: boolean;
    } | null;
  } | null;
  service?: string | null;
  remote_scope?: string;
  remote_is_gateway?: boolean;
  observed_vlan_ids?: number[];
  geoip?: {
    country_name?: string | null;
    country_code?: string | null;
    city?: string | null;
    postal_code?: string | null;
    asn?: number | null;
    as_org?: string | null;
  } | null;
  container?: {
    runtime: string;
    id: string;
    name: string | null;
    cgroup_path: string | null;
  } | null;
  kubernetes?: {
    pod_name: string | null;
    pod_namespace: string | null;
    pod_uid: string | null;
    container_name: string | null;
    container_id: string | null;
    cgroup_path: string | null;
  } | null;
  network_context?: {
    local_hostname: string | null;
    remote_hostname: string | null;
    local_mac: Neighbor | null;
    remote_mac: Neighbor | null;
  };
  attributed_hostname?: {
    name: string;
    source: string;
    observed_at: string;
  } | null;
  health_details?: { label: string; value: string | null; warning: boolean }[];
  protocol_details?: {
    label: string;
    value: string | null;
    warning: boolean;
  }[];
  tcp_health?: {
    retransmits: number;
    out_of_order: number;
    duplicate_acks: number;
    fast_retransmits: number;
    local_receive_window: TcpWindow | null;
    remote_receive_window: TcpWindow | null;
  } | null;
  request_health?: {
    retries: number | null;
    timeouts: number | null;
    quic_retries: number;
    quic_version_negotiations: number;
  };
  application: string | null;
  hostname: string | null;
  hostname_source: string | null;
  traffic: {
    packets_sent?: number;
    packets_received?: number;
    bytes_sent: number;
    bytes_received: number;
    incoming_bytes_per_second: number | null;
    outgoing_bytes_per_second: number | null;
  };
  rtt: {
    current_ms: number | null;
    initial_ms?: number | null;
    tcp_smoothed_ms?: number | null;
    dns_response_ms?: number | null;
    llmnr_response_ms?: number | null;
    netbios_response_ms?: number | null;
    icmp_echo_ms?: number | null;
    stun_ms?: number | null;
    ntp_ms?: number | null;
  };
  historic: boolean;
  closed_at?: string | null;
  lifecycle?: { timeout_ms: number; remaining_ms: number } | null;
  created_at: string;
  last_activity: string;
}
export interface CaptureAccounting {
  captured: number;
  tracked_received: number;
  tracked_sent: number;
  attributed_received: number;
  attributed_sent: number;
}
export function validCaptureAccounting(
  value: unknown,
): value is CaptureAccounting {
  if (
    !object(value) ||
    ![
      "captured",
      "tracked_received",
      "tracked_sent",
      "attributed_received",
      "attributed_sent",
    ].every((key) => counter(value[key]))
  )
    return false;
  const c = value as unknown as CaptureAccounting;
  return (
    c.attributed_received <= c.tracked_received &&
    c.attributed_sent <= c.tracked_sent &&
    c.tracked_received + c.tracked_sent <= c.captured
  );
}
export function captureBreakdown(c: CaptureAccounting) {
  const tracked = c.tracked_received + c.tracked_sent;
  const attributed = c.attributed_received + c.attributed_sent;
  return {
    tracked,
    attributed,
    unknown: tracked - attributed,
    outside: c.captured - tracked,
  };
}
export interface Snapshot {
  schema_version: number;
  type: string;
  timestamp: string;
  runtime: {
    status: string;
    interface: string | null;
    capture_error: string | null;
    process_detection: {
      method: string;
      degraded: boolean;
      degradation_reason: string | null;
    };
  };
  sandbox: { status: string; message: string };
  stats: {
    capture_accounting?: CaptureAccounting;
    packets_captured: number;
    packets_dropped: number;
    capture_packets_dropped: number;
    interface_packets_dropped: number;
    pcapng_export_errors: number;
    pcapng_records_dropped: number;
  };
  connections: Connection[];
}
export interface CaptureView {
  session: number;
  revision: number;
  status: string;
  error: string | null;
  export_path: string | null;
  snapshot: Snapshot | null;
}
export interface CaptureInterface {
  name: string;
  description: string | null;
  addresses: string[];
}
export interface Application {
  key: string;
  name: string;
  executable: string | null;
  pids: number[];
  connections: Connection[];
  downloaded: number;
  uploaded: number;
  hosts: number;
  rx: number;
  tx: number;
}
export interface TrafficPoint {
  time: number;
  rx: number;
  tx: number;
}
export type Sort = "download" | "upload" | "process" | "destination";
export const idle: CaptureView = {
  session: 0,
  revision: 0,
  status: "idle",
  error: null,
  export_path: null,
  snapshot: null,
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const optionalText = (value: unknown) =>
  value === null || typeof value === "string";
const optionalNumber = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

// Rich metadata is additive, so older engines may omit it. Validate nested
// values before rendering to keep malformed engine data out of React children.
const maybeText = (v: unknown) => v === undefined || optionalText(v);
const maybeNumber = (v: unknown) => v === undefined || optionalNumber(v);
const textFields = (v: unknown, keys: string[]) =>
  object(v) && keys.every((k) => maybeText(v[k]));
const neighbor = (v: unknown) =>
  v == null ||
  (object(v) && typeof v.mac === "string" && optionalText(v.vendor));
const tcpWindow = (v: unknown) =>
  v == null ||
  (object(v) && counter(v.bytes) && typeof v.scale_known === "boolean");
function validDetails(c: Record<string, unknown>): boolean {
  const p = c.process;
  if (object(p)) {
    if (!maybeText(p.user_group)) return false;
    if (!["ppid", "uid", "gid"].every((k) => maybeNumber(p[k]))) return false;
    const lineage = p.lineage;
    if (
      lineage != null &&
      (!object(lineage) ||
        typeof lineage.truncated !== "boolean" ||
        !Array.isArray(lineage.ancestors) ||
        !lineage.ancestors.every(
          (a) =>
            object(a) &&
            counter(a.pid) &&
            typeof a.name === "string" &&
            optionalText(a.executable) &&
            optionalNumber(a.started_at_unix_ms),
        ))
    )
      return false;
  }
  const n = c.network_context,
    h = c.tcp_health,
    r = c.request_health,
    a = c.attributed_hostname;
  return (
    maybeText(c.service) &&
    maybeText(c.remote_scope) &&
    (c.remote_is_gateway === undefined ||
      typeof c.remote_is_gateway === "boolean") &&
    (c.observed_vlan_ids === undefined ||
      (Array.isArray(c.observed_vlan_ids) &&
        c.observed_vlan_ids.every(counter))) &&
    [c.protocol_details, c.health_details].every(
      (fields) =>
        fields === undefined ||
        (Array.isArray(fields) &&
          fields.every(
            (f) =>
              object(f) &&
              typeof f.label === "string" &&
              optionalText(f.value) &&
              typeof f.warning === "boolean",
          )),
    ) &&
    (c.geoip == null ||
      (textFields(c.geoip, [
        "country_name",
        "country_code",
        "city",
        "postal_code",
        "as_org",
      ]) &&
        object(c.geoip) &&
        maybeNumber(c.geoip.asn))) &&
    (c.container == null ||
      textFields(c.container, ["runtime", "id", "name", "cgroup_path"])) &&
    (c.kubernetes == null ||
      textFields(c.kubernetes, [
        "pod_name",
        "pod_namespace",
        "pod_uid",
        "container_name",
        "container_id",
        "cgroup_path",
      ])) &&
    (n === undefined ||
      (textFields(n, ["local_hostname", "remote_hostname"]) &&
        object(n) &&
        neighbor(n.local_mac) &&
        neighbor(n.remote_mac))) &&
    (a == null ||
      (object(a) &&
        typeof a.name === "string" &&
        typeof a.source === "string" &&
        typeof a.observed_at === "string" &&
        Number.isFinite(Date.parse(a.observed_at)))) &&
    (h == null ||
      (object(h) &&
        [
          "retransmits",
          "out_of_order",
          "duplicate_acks",
          "fast_retransmits",
        ].every((k) => counter(h[k])) &&
        tcpWindow(h.local_receive_window) &&
        tcpWindow(h.remote_receive_window))) &&
    (r === undefined ||
      (object(r) &&
        optionalNumber(r.retries) &&
        optionalNumber(r.timeouts) &&
        counter(r.quic_retries) &&
        counter(r.quic_version_negotiations))) &&
    object(c.local) &&
    maybeText(c.local.address_kind) &&
    object(c.remote) &&
    maybeText(c.remote.address_kind) &&
    object(c.traffic) &&
    ["packets_sent", "packets_received"].every(
      (k) =>
        c.traffic &&
        object(c.traffic) &&
        (c.traffic[k] === undefined || counter(c.traffic[k])),
    ) &&
    object(c.rtt) &&
    [
      "initial_ms",
      "tcp_smoothed_ms",
      "dns_response_ms",
      "llmnr_response_ms",
      "netbios_response_ms",
      "icmp_echo_ms",
      "stun_ms",
      "ntp_ms",
    ].every((k) => object(c.rtt) && maybeNumber(c.rtt[k]))
  );
}

// Never trust a wire version alone. A mismatched or damaged engine must show
// an error instead of crashing the interface during a live capture.
export function parseView(value: unknown): CaptureView {
  if (
    !object(value) ||
    typeof value.status !== "string" ||
    !counter(value.revision) ||
    !counter(value.session) ||
    !optionalText(value.error) ||
    !optionalText(value.export_path)
  )
    throw new Error("Invalid capture response");
  const s = value.snapshot;
  if (s !== null) {
    if (
      !object(s) ||
      s.schema_version !== 1 ||
      s.type !== "snapshot" ||
      typeof s.timestamp !== "string" ||
      !Number.isFinite(Date.parse(s.timestamp)) ||
      !Array.isArray(s.connections) ||
      !object(s.runtime) ||
      typeof s.runtime.status !== "string" ||
      !optionalText(s.runtime.interface) ||
      !optionalText(s.runtime.capture_error) ||
      !object(s.runtime.process_detection) ||
      typeof s.runtime.process_detection.method !== "string" ||
      typeof s.runtime.process_detection.degraded !== "boolean" ||
      !optionalText(s.runtime.process_detection.degradation_reason) ||
      !object(s.sandbox) ||
      typeof s.sandbox.status !== "string" ||
      typeof s.sandbox.message !== "string" ||
      !object(s.stats) ||
      (s.stats.capture_accounting !== undefined &&
        !validCaptureAccounting(s.stats.capture_accounting)) ||
      ![
        "packets_captured",
        "packets_dropped",
        "capture_packets_dropped",
        "interface_packets_dropped",
        "pcapng_export_errors",
        "pcapng_records_dropped",
      ].every((k) => counter((s.stats as Record<string, unknown>)[k]))
    )
      throw new Error(
        "Unsupported RustNet snapshot. Rebuild the bundled capture engine.",
      );
    const ids = new Set<string>();
    for (const c of s.connections) {
      if (
        !object(c) ||
        typeof c.id !== "string" ||
        typeof c.protocol !== "string" ||
        typeof c.state !== "string" ||
        typeof c.historic !== "boolean" ||
        (c.closed_at !== undefined && !optionalText(c.closed_at)) ||
        (c.lifecycle != null &&
          (!object(c.lifecycle) ||
            !counter(c.lifecycle.timeout_ms) ||
            c.lifecycle.timeout_ms === 0 ||
            !counter(c.lifecycle.remaining_ms) ||
            c.lifecycle.remaining_ms > c.lifecycle.timeout_ms)) ||
        !optionalText(c.application) ||
        !optionalText(c.hostname) ||
        !optionalText(c.hostname_source) ||
        !optionalText(c.direction) ||
        typeof c.created_at !== "string" ||
        typeof c.last_activity !== "string" ||
        !object(c.local) ||
        typeof c.local.ip !== "string" ||
        !counter(c.local.port) ||
        !object(c.remote) ||
        typeof c.remote.ip !== "string" ||
        !counter(c.remote.port) ||
        !object(c.traffic) ||
        !counter(c.traffic.bytes_sent) ||
        !counter(c.traffic.bytes_received) ||
        !optionalNumber(c.traffic.incoming_bytes_per_second) ||
        !optionalNumber(c.traffic.outgoing_bytes_per_second) ||
        !object(c.rtt) ||
        !optionalNumber(c.rtt.current_ms) ||
        (c.process !== null &&
          (!object(c.process) ||
            !optionalNumber(c.process.pid) ||
            !optionalText(c.process.name) ||
            !optionalText(c.process.executable) ||
            (c.process.attribution_match !== undefined &&
              !optionalText(c.process.attribution_match))))
      )
        throw new Error("Invalid connection in capture snapshot");
      if (ids.has(c.id))
        throw new Error("Duplicate connection identity in capture snapshot");
      if (!validDetails(c))
        throw new Error("Invalid connection details in capture snapshot");
      ids.add(c.id);
    }
  }
  return value as unknown as CaptureView;
}
export const received = (c: Connection) =>
  c.historic ? 0 : Math.max(0, c.traffic.incoming_bytes_per_second ?? 0);
export const sent = (c: Connection) =>
  c.historic ? 0 : Math.max(0, c.traffic.outgoing_bytes_per_second ?? 0);
export const processName = (c: Connection) =>
  c.process?.name ||
  (c.process?.pid != null ? `PID ${c.process.pid}` : "Unattributed");
export const destination = (c: Connection) => c.hostname || c.remote.ip;
/** Resolve optional paths across the snapshot before choosing application groups. */
function applicationKey(connections: Connection[]): (c: Connection) => string {
  const pathsByName = new Map<string, Set<string>>();
  const livePathsByPid = new Map<string, Set<string>>();
  for (const c of connections) {
    const { name, executable, pid } = c.process ?? {};
    if (!name || !executable) continue;
    const paths = pathsByName.get(name) ?? new Set<string>();
    paths.add(executable);
    pathsByName.set(name, paths);
    if (!c.historic && pid != null) {
      const key = JSON.stringify([name, pid]);
      const paths = livePathsByPid.get(key) ?? new Set<string>();
      paths.add(executable);
      livePathsByPid.set(key, paths);
    }
  }
  return (c) => {
    const { name, executable, pid } = c.process ?? {};
    if (name) {
      // A path arriving later must not change selection or restart the graph.
      if ((pathsByName.get(name)?.size ?? 0) <= 1)
        return JSON.stringify(["name", name]);
      const pidPaths =
        !c.historic && pid != null
          ? livePathsByPid.get(JSON.stringify([name, pid]))
          : undefined;
      const path =
        executable || (pidPaths?.size === 1 ? [...pidPaths][0] : null);
      // Never guess between two known executables sharing the same name.
      return JSON.stringify(["name", name, "executable", path ?? null]);
    }
    if (executable) return JSON.stringify(["executable", executable]);
    return JSON.stringify(["pid", pid ?? null]);
  };
}
export function connectionsForApplication(
  connections: Connection[],
  key: string | null,
): Connection[] {
  if (key === null) return connections;
  const keyFor = applicationKey(connections);
  return connections.filter((c) => keyFor(c) === key);
}

export function applications(connections: Connection[]): Application[] {
  const grouped = new Map<string, Application>();
  const keyFor = applicationKey(connections);
  for (const c of connections.filter((c) => !c.historic)) {
    const key = keyFor(c);
    let app = grouped.get(key);
    if (!app) {
      app = {
        key,
        name: processName(c),
        executable: c.process?.executable ?? null,
        pids: [],
        connections: [],
        downloaded: 0,
        uploaded: 0,
        hosts: 0,
        rx: 0,
        tx: 0,
      };
      grouped.set(key, app);
    }
    app.connections.push(c);
    if (c.process?.pid != null && !app.pids.includes(c.process.pid))
      app.pids.push(c.process.pid);
    app.rx += received(c);
    app.tx += sent(c);
  }
  // Byte counters include retained closed connections, while current rates,
  // hosts, and PIDs describe only the active connections shown in the list.
  for (const c of connections) {
    const app = grouped.get(keyFor(c));
    if (app) {
      app.executable ||= c.process?.executable || null;
      app.downloaded += c.traffic.bytes_received;
      app.uploaded += c.traffic.bytes_sent;
    }
  }
  for (const app of grouped.values()) {
    app.hosts = new Set(app.connections.map((c) => c.remote.ip)).size;
    app.connections.sort(
      (a, b) =>
        destination(a).localeCompare(destination(b)) ||
        a.id.localeCompare(b.id),
    );
  }
  return [...grouped.values()];
}
export function connectionsForView(
  connections: Connection[],
  query: string,
  protocol: string,
  historic: boolean,
  sort: Sort,
): Connection[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return connections
    .filter(
      (c) =>
        (historic || !c.historic) &&
        (protocol === "all" || (c.application || c.protocol) === protocol) &&
        words.every((word) =>
          [
            processName(c),
            c.process?.pid,
            c.process?.executable,
            destination(c),
            c.remote.ip,
            c.remote.port,
            c.local.ip,
            c.local.port,
            c.application,
            c.protocol,
            c.state,
          ]
            .join(" ")
            .toLowerCase()
            .includes(word),
        ),
    )
    .sort(
      (a, b) =>
        (sort === "download"
          ? received(b) - received(a)
          : sort === "upload"
            ? sent(b) - sent(a)
            : sort === "process"
              ? processName(a).localeCompare(processName(b))
              : destination(a).localeCompare(destination(b))) ||
        a.id.localeCompare(b.id),
    );
}
export function bytes(value: number | null | undefined, rate = false): string {
  if (value == null || !Number.isFinite(value)) return "Unknown";
  const positive = Math.max(0, value);
  const exponent =
    positive < 1000 ? 0 : Math.min(3, Math.floor(Math.log10(positive) / 3));
  return `${(positive / 1000 ** exponent).toLocaleString(undefined, { maximumFractionDigits: exponent ? 2 : 0 })} ${["B", "kB", "MB", "GB"][exponent]}${rate ? "/s" : ""}`;
}
export function endpoint(value: { ip: string; port: number }): string {
  return `${value.ip.includes(":") ? `[${value.ip}]` : value.ip}:${value.port}`;
}
export const nameEvidence = (c: Connection) =>
  c.hostname_source === "captured_dns"
    ? "Inferred from captured DNS"
    : c.hostname_source === "application"
      ? "Observed in application protocol"
      : "No hostname observed";
export function appendPoint(
  points: TrafficPoint[],
  point: TrafficPoint,
): TrafficPoint[] {
  if (points.at(-1)?.time === point.time) return points;
  return [...points.filter((p) => p.time >= point.time - 60_000), point].slice(
    -121,
  );
}

/** Retain observed samples for every application, independent of selection. */
export function updateApplicationHistory(
  previous: Map<string, TrafficPoint[]>,
  apps: Application[],
  time: number,
): Map<string, TrafficPoint[]> {
  const result = new Map<string, TrafficPoint[]>();
  for (const [key, history] of previous) {
    const recent = history.filter((point) => point.time >= time - 60000);
    if (recent.length) result.set(key, recent);
  }
  for (const app of apps) {
    result.set(
      app.key,
      appendPoint(result.get(app.key) || [], { time, rx: app.rx, tx: app.tx }),
    );
  }
  return result;
}

/** Match the TUI's halfway cleanup threshold and zero-rate gate. */
export function connectionLifecycle(
  c: Connection,
): { fade: number; label: string } | null {
  if (c.historic || !c.lifecycle || received(c) > 0 || sent(c) > 0) return null;
  const ratio = 1 - c.lifecycle.remaining_ms / c.lifecycle.timeout_ms;
  if (ratio < 0.5) return null;
  const seconds = Math.ceil(c.lifecycle.remaining_ms / 1000);
  const time =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return { fade: Math.min(1, (ratio - 0.5) * 2), label: `${time} to history` };
}

type CaptureSample = { time: number; totals: CaptureAccounting };
export interface CaptureHistory {
  session: number;
  previous?: CaptureSample;
  samples?: CaptureSample[];
  traffic: TrafficPoint[];
  coverage: TrafficPoint[];
  rawTraffic?: TrafficPoint[];
  rawCoverage?: TrafficPoint[];
}
const accountingKeys = [
  "captured",
  "tracked_received",
  "tracked_sent",
  "attributed_received",
  "attributed_sent",
] as const;
export function updateCaptureHistory(
  previous: CaptureHistory,
  session: number,
  time: number,
  totals: CaptureAccounting | undefined,
  desktopRates: { smoothed: TrafficPoint; raw?: TrafficPoint },
): CaptureHistory {
  const state: CaptureHistory =
    previous.session === session
      ? previous
      : { session, traffic: [], coverage: [] };
  const traffic = {
    traffic: appendPoint(state.traffic, desktopRates.smoothed),
    rawTraffic: desktopRates.raw
      ? appendPoint(state.rawTraffic ?? [], desktopRates.raw)
      : state.rawTraffic,
  };
  if (!totals) return { session, ...traffic, coverage: [] };
  const current = { time, totals };
  const last = state.previous;
  if (last && time <= last.time) return state;
  if (!last || accountingKeys.some((key) => totals[key] < last.totals[key])) {
    return {
      session,
      previous: current,
      samples: [current],
      ...traffic,
      coverage: [],
    };
  }
  // Ignore near-simultaneous bridge updates without losing their byte deltas.
  if (time - last.time < 250) return state;
  const samples = [...(state.samples ?? [last]), current];
  const cutoff = time - 2000;
  while (samples.length > 2 && samples[1].time <= cutoff) samples.shift();
  let baseline = samples[0];
  if (baseline.time < cutoff) {
    const newer = samples[1];
    const fraction = (cutoff - baseline.time) / (newer.time - baseline.time);
    baseline = { time: cutoff, totals: { ...baseline.totals } };
    for (const key of accountingKeys)
      baseline.totals[key] +=
        (newer.totals[key] - baseline.totals[key]) * fraction;
  }
  const rates = (start: CaptureSample): TrafficPoint => {
    const seconds = (time - start.time) / 1000;
    return {
      time,
      rx: (totals.captured - start.totals.captured) / seconds,
      tx:
        (totals.attributed_received +
          totals.attributed_sent -
          start.totals.attributed_received -
          start.totals.attributed_sent) /
        seconds,
    };
  };
  return {
    session,
    previous: current,
    samples,
    ...traffic,
    coverage: appendPoint(state.coverage, rates(baseline)),
    rawCoverage: appendPoint(state.rawCoverage ?? [], rates(last)),
  };
}
