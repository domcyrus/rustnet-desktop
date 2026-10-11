import type { CaptureView, Connection } from "./model";

export const connectionFixture = (
  overrides: Partial<Connection> = {},
): Connection => ({
  id: "TCP|127.0.0.1:42000|198.51.100.2:443|1",
  protocol: "TCP",
  state: "ESTABLISHED",
  local: { ip: "127.0.0.1", port: 42000 },
  remote: { ip: "198.51.100.2", port: 443 },
  direction: "outbound",
  process: {
    pid: 42,
    name: "Firefox",
    executable: "/usr/bin/firefox",
    attribution_match: "exact_tuple",
  },
  application: "HTTPS",
  hostname: "example.org",
  hostname_source: "application",
  traffic: {
    bytes_sent: 100,
    bytes_received: 4000,
    incoming_bytes_per_second: 2500,
    outgoing_bytes_per_second: 100,
  },
  rtt: { current_ms: 14.2 },
  historic: false,
  created_at: "2026-09-27T12:00:00Z",
  last_activity: "2026-09-27T12:00:02Z",
  ...overrides,
});
export const viewFixture = (): CaptureView => ({
  session: 1,
  revision: 1,
  status: "running",
  error: null,
  export_path: null,
  snapshot: {
    schema_version: 1,
    type: "snapshot",
    timestamp: "2026-09-27T12:00:02Z",
    runtime: {
      status: "running",
      interface: "lo",
      capture_error: null,
      process_detection: {
        method: "procfs",
        degraded: false,
        degradation_reason: null,
      },
    },
    sandbox: { status: "fully_enforced", message: "Sandbox active" },
    stats: {
      packets_captured: 10,
      packets_dropped: 0,
      capture_packets_dropped: 0,
      interface_packets_dropped: 0,
      pcapng_export_errors: 0,
      pcapng_records_dropped: 0,
    },
    connections: [
      connectionFixture(),
      connectionFixture({
        id: "unknown",
        process: null,
        hostname: null,
        hostname_source: null,
      }),
    ],
  },
});

export const richConnectionFixture = (): Connection =>
  connectionFixture({
    process: {
      pid: 42,
      ppid: 21,
      name: "Firefox",
      executable: "/usr/lib/firefox/firefox",
      uid: 1000,
      gid: 1000,
      user_group: "user:user",
      attribution_match: "startup-snapshot",
      lineage: {
        truncated: false,
        ancestors: [
          {
            pid: 1,
            name: "systemd",
            executable: "/usr/lib/systemd/systemd",
            started_at_unix_ms: null,
          },
          {
            pid: 21,
            name: "gnome-shell",
            executable: "/usr/bin/gnome-shell",
            started_at_unix_ms: null,
          },
        ],
      },
    },
    service: "https",
    remote_scope: "PUBLIC",
    remote_is_gateway: false,
    observed_vlan_ids: [0, 42],
    local: { ip: "192.168.1.10", port: 42000, address_kind: "unicast" },
    remote: { ip: "198.51.100.2", port: 443, address_kind: "unicast" },
    geoip: {
      country_name: "Switzerland",
      country_code: "CH",
      city: "Zurich",
      asn: 64500,
      as_org: "Example network",
    },
    network_context: {
      local_hostname: "workstation.local",
      remote_hostname: "edge.example.org",
      local_mac: { mac: "02:00:00:00:00:01", vendor: null },
      remote_mac: null,
    },
    attributed_hostname: {
      name: "example.org",
      source: "captured_dns",
      observed_at: "2026-09-27T12:00:00Z",
    },
    protocol_details: [
      { label: "SNI", value: "example.org", warning: false },
      { label: "ALPN", value: "h2, http/1.1", warning: false },
      { label: "TLS Version", value: "TLS 1.3", warning: false },
      {
        label: "Cipher Suite",
        value: "TLS_AES_128_GCM_SHA256 (0x1301)",
        warning: false,
      },
    ],
    health_details: [],
    tcp_health: {
      retransmits: 2,
      out_of_order: 1,
      duplicate_acks: 3,
      fast_retransmits: 0,
      local_receive_window: { bytes: 83968, scale_known: true },
      remote_receive_window: { bytes: 32768, scale_known: false },
    },
    request_health: {
      retries: null,
      timeouts: null,
      quic_retries: 0,
      quic_version_negotiations: 0,
    },
    rtt: { current_ms: 14.2, initial_ms: 3.7, tcp_smoothed_ms: 14.2 },
    traffic: {
      bytes_received: 350000,
      bytes_sent: 18000,
      packets_received: 240,
      packets_sent: 94,
      incoming_bytes_per_second: 2500,
      outgoing_bytes_per_second: 100,
    },
  });
