import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Blocks,
  ChevronRight,
  ArrowDownLeft,
  ArrowUpRight,
  Network,
} from "lucide-react";
import { Metric } from "./components";
import { ApplicationIcon } from "./ApplicationIcon";
import { HistoryGraphs } from "./HistoryGraphs";
import { bytes } from "./model";
import { errorText } from "./useCapture";

export interface Point {
  timestamp_ms: number;
  bytes_sent: number;
  bytes_received: number;
  samples: number;
  uncertain_samples: number;
  observed_ms: number;
  incomplete: boolean;
  active_connections: number;
  counter_resets: number;
  findings: number;
}
interface SavedConnection {
  id: number;
  name: string;
  executable: string | null;
  pid: number | null;
  local_ip: string | null;
  local_port: number | null;
  remote_ip: string;
  remote_port: number;
  hostname: string | null;
  protocol: string;
  interface: string;
  first_seen_ms: number;
  last_seen_ms: number;
  ended_ms: number | null;
  end_reason: string | null;
  bytes_sent: number;
  bytes_received: number;
  uncertain_samples: number;
}
export interface Finding {
  kind: "upload" | "download" | "connections" | "destination";
  app_key: string;
  name: string;
  interface: string;
  timestamp_ms: number;
  observed: number;
  baseline: number;
  threshold: number;
  prior_intervals: number;
  destination: string | null;
}
export interface SeriesReport {
  refresh?: {
    cursor: number | null;
    incremental: boolean;
    samples_read: number;
  };
  applications: {
    key: string;
    name: string;
    executable: string | null;
    connections: number;
    bytes_sent: number;
    bytes_received: number;
  }[];
  application_count: number;
  analysis: {
    findings: Finding[];
    ready_profiles: number;
    learning_profiles: number;
    eligible_intervals: number;
    limited: boolean;
    findings_limited: boolean;
  };
  available: boolean;
  from_ms: number;
  to_ms: number;
  resolution_ms: number;
  bytes_sent: number;
  bytes_received: number;
  uncertain_samples: number;
  points: Point[];
  connections: SavedConnection[];
  connection_count: number;
  sample_count: number;
  samples: {
    timestamp_ms: number;
    interval_start_ms: number | null;
    bytes_sent: number;
    bytes_received: number;
    packets_sent: number | null;
    packets_received: number | null;
    delta_sent: number | null;
    delta_received: number | null;
    kind: string;
  }[];
}
const date = (ms: number) => new Date(ms).toLocaleString();
const time = (ms: number) => new Date(ms).toLocaleTimeString();
const endpoint = (ip: string | null, port: number | null) =>
  ip ? `${ip.includes(":") ? `[${ip}]` : ip}:${port ?? "?"}` : "Unavailable";

export function ConnectionHistory({
  fromMs,
  toMs,
  app,
  iface,
  refreshVersion = 0,
  onRefreshingChange,
}: {
  fromMs: number;
  toMs: number;
  app: string;
  iface: string;
  refreshVersion?: number;
  onRefreshingChange?: (refreshing: boolean) => void;
}) {
  const cursor = useRef<number | null>(null);
  const [zoom, setZoom] = useState<{ from: number; to: number }[]>([]);
  const [connection, setConnection] = useState<number | null>(null);
  const [mode, setMode] = useState<"applications" | "connections">(
    "applications",
  );
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [selectedInterface, setSelectedInterface] = useState<string | null>(
    null,
  );
  const [inspectedFinding, setInspectedFinding] = useState<Finding | null>(
    null,
  );
  const appScope = selectedApp ?? app;
  const interfaceScope = selectedInterface ?? iface;
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    report: SeriesReport;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const range = zoom.at(-1) ?? { from: fromMs, to: toMs };
  // A moving live window is a refresh of the same view, not a new selection.
  const key = JSON.stringify([
    zoom.at(-1) ?? null,
    appScope,
    interfaceScope,
    connection,
    offset,
  ]);
  const report = result?.key === key ? result.report : null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    onRefreshingChange?.(true);
    setError(null);
    void invoke<SeriesReport>("connection_history", {
      query: {
        from_ms: range.from,
        to_ms: range.to,
        app_key: appScope || null,
        interface: interfaceScope === "*" ? null : interfaceScope,
        offset,
      },
      connectionId: connection,
      cursor: cursor.current,
    })
      .then((report) => {
        if (!cancelled) {
          cursor.current = report.refresh?.cursor ?? null;
          setResult({ key, report });
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          onRefreshingChange?.(false);
        }
      });
    return () => {
      cancelled = true;
      onRefreshingChange?.(false);
    };
  }, [
    key,
    range.from,
    range.to,
    appScope,
    interfaceScope,
    connection,
    offset,
    refresh,
    refreshVersion,
    onRefreshingChange,
    toMs,
  ]);

  function select(id: number | null) {
    setConnection(id);
    setMode("connections");
    setOffset(0);
  }
  function zoomRange(from: number, to: number) {
    const next = {
      from: Math.max(report?.from_ms ?? range.from, from),
      to: Math.min(report?.to_ms ?? range.to, to),
    };
    if (
      next.from >= next.to ||
      (next.from === range.from && next.to === range.to)
    )
      return;
    setZoom([...zoom, next]);
    setOffset(0);
  }
  function zoomTo(point: Point) {
    if (report)
      zoomRange(point.timestamp_ms, point.timestamp_ms + report.resolution_ms);
  }
  function openApplication(key: string) {
    setSelectedApp(key);
    setConnection(null);
    setMode("connections");
    setOffset(0);
    setInspectedFinding(null);
  }
  function inspectFinding(f: Finding) {
    setSelectedApp(f.app_key);
    setSelectedInterface(f.interface);
    setConnection(null);
    setMode("connections");
    setOffset(0);
    setInspectedFinding(f);
    setZoom([...zoom, { from: f.timestamp_ms, to: f.timestamp_ms + 10000 }]);
  }
  function allApplications() {
    setSelectedApp(null);
    setSelectedInterface(null);
    setConnection(null);
    setOffset(0);
    setMode("applications");
    setInspectedFinding(null);
  }
  const count =
    connection === null
      ? (report?.connection_count ?? 0)
      : (report?.sample_count ?? 0);
  const pageSize = connection === null ? 50 : 200;
  return (
    <section
      className="history-section connection-history"
      aria-label="Connection timeline"
      aria-busy={loading}
    >
      <div className="history-section-heading">
        <h2>Saved activity</h2>
        <div className="timeline-actions">
          {loading && report && (
            <small role="status">Refreshing saved activity…</small>
          )}
          {selectedApp !== null && (
            <button className="button" onClick={allApplications}>
              All applications
            </button>
          )}
          {connection !== null && (
            <button className="button" onClick={() => select(null)}>
              All connections
            </button>
          )}
          {zoom.length > 0 && (
            <button
              className="button"
              onClick={() => {
                setZoom(zoom.slice(0, -1));
                setOffset(0);
              }}
            >
              Zoom out
            </button>
          )}
          <button
            className="button"
            disabled={loading}
            onClick={() => setRefresh((n) => n + 1)}
          >
            Refresh timeline
          </button>
        </div>
      </div>
      <p className="history-note">
        Select an application or connection below the graphs to inspect its
        saved samples.
      </p>
      {error && (
        <p className="notice warning" role="alert">
          Unable to read connection samples: {error}
        </p>
      )}
      {loading && !report && <p role="status">Loading connection samples…</p>}
      {report && (
        <>
          {!report.available ? (
            <p className="history-empty">
              Earlier history contains minute summaries only. Start capture with
              Save traffic history enabled to collect connection samples.
            </p>
          ) : (
            <>
              <div className="history-summary">
                <Metric
                  icon={<ArrowUpRight />}
                  label="Uploaded"
                  value={bytes(report.bytes_sent)}
                  caption="Selected time range"
                />
                <Metric
                  icon={<ArrowDownLeft />}
                  label="Downloaded"
                  value={bytes(report.bytes_received)}
                  caption="Selected time range"
                />
                <Metric
                  icon={<Network />}
                  label="Connections"
                  value={String(report.connection_count)}
                  caption={`${report.sample_count.toLocaleString()} counter samples`}
                />
              </div>
              <HistoryGraphs
                report={report}
                onZoom={zoomTo}
                onRange={zoomRange}
                onInspect={inspectFinding}
                connectionSelected={connection !== null}
              />
              {inspectedFinding && (
                <p className="notice">
                  Inspecting {inspectedFinding.name} on{" "}
                  {inspectedFinding.interface || "Automatic"} at{" "}
                  {date(inspectedFinding.timestamp_ms)}. The connection list
                  shows traffic contributing to this app interval.
                </p>
              )}
              <div
                className="history-view-tabs"
                role="group"
                aria-label="History views"
              >
                <button
                  className="button"
                  aria-pressed={mode === "applications"}
                  onClick={allApplications}
                >
                  <Blocks size={15} /> Applications
                </button>
                <button
                  className="button"
                  aria-pressed={mode === "connections"}
                  onClick={() => {
                    setMode("connections");
                    setOffset(0);
                  }}
                >
                  Connections
                </button>
                <span className="history-note">
                  {selectedApp
                    ? report.applications[0]?.name || "Selected application"
                    : "All matching applications"}
                  {connection !== null ? ` / Connection #${connection}` : ""}
                </span>
              </div>
              {mode === "applications" && (
                <div
                  className="app-list history-application-list"
                  aria-label="Saved applications"
                >
                  <div className="section-caption">
                    Application <span>Download / upload totals</span>
                  </div>
                  {report.applications.map((a) => (
                    <button
                      className="app-row"
                      key={a.key}
                      onClick={() => openApplication(a.key)}
                      aria-label={`${a.name}, ${a.connections} connections`}
                    >
                      <ApplicationIcon app={{ ...a, pids: [] }} historical />
                      <span className="app-name">
                        <strong>{a.name}</strong>
                        <small>{a.connections} connections</small>
                        <small
                          className="app-path"
                          title={a.executable ?? undefined}
                        >
                          {a.executable || "Executable unavailable"}
                        </small>
                      </span>
                      <span className="app-rate">
                        {bytes(a.bytes_received)}
                        <small>↑ {bytes(a.bytes_sent)}</small>
                      </span>
                      <span className="app-disclosure">
                        <ChevronRight size={16} />
                      </span>
                    </button>
                  ))}
                  {report.application_count > report.applications.length && (
                    <p className="history-note">
                      Showing the 200 busiest applications. Use the application
                      filter to narrow the results.
                    </p>
                  )}
                </div>
              )}
              {!count && (
                <p className="history-empty">
                  No connection samples in this interval. Earlier minute
                  summaries are available below.
                </p>
              )}
              {mode === "connections" && report.connections.length > 0 && (
                <div className="history-table-scroll">
                  <table className="history-table">
                    <thead>
                      <tr>
                        <th>Application / connection</th>
                        <th>Endpoints</th>
                        <th>Observation</th>
                        <th>Uploaded</th>
                        <th>Downloaded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.connections.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <div className="connection-identity">
                              <ApplicationIcon
                                app={{
                                  name: c.name,
                                  executable: c.executable,
                                  pids: [],
                                }}
                                historical
                              />
                              <div className="connection-identity-text">
                                <button
                                  className="timeline-connection"
                                  onClick={() => select(c.id)}
                                >
                                  {c.name} · #{c.id}
                                </button>
                                <small title={c.executable ?? undefined}>
                                  {c.executable ?? "Executable unavailable"}
                                  {c.pid !== null ? ` · PID ${c.pid}` : ""}
                                </small>
                              </div>
                            </div>
                          </td>
                          <td>
                            <strong>{c.hostname || c.remote_ip}</strong>
                            <small>
                              {endpoint(c.local_ip, c.local_port)} →{" "}
                              {endpoint(c.remote_ip, c.remote_port)}
                            </small>
                            <small>
                              {c.protocol} · {c.interface || "Automatic"}
                            </small>
                          </td>
                          <td>
                            {date(c.first_seen_ms)}
                            <small>Last seen: {date(c.last_seen_ms)}</small>
                            <small>
                              {c.end_reason === "closed"
                                ? `Closed: ${date(c.ended_ms ?? c.last_seen_ms)}`
                                : c.end_reason === "disappeared"
                                  ? "No longer observed"
                                  : c.end_reason === "capture-ended"
                                    ? "Capture ended"
                                    : "Open or interrupted capture"}
                            </small>
                          </td>
                          <td>{bytes(c.bytes_sent)}</td>
                          <td>{bytes(c.bytes_received)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {mode === "connections" &&
                connection !== null &&
                report.samples.length > 0 && (
                  <>
                    <h3>Counter samples for connection #{connection}</h3>
                    <div className="history-table-scroll">
                      <table className="history-table">
                        <thead>
                          <tr>
                            <th>Timestamp / interval</th>
                            <th>Total sent / received</th>
                            <th>Interval sent / received</th>
                            <th>Packets sent / received</th>
                            <th>Observation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.samples.map((s) => (
                            <tr key={s.timestamp_ms}>
                              <td>
                                {date(s.timestamp_ms)}
                                <small>
                                  {s.interval_start_ms !== null
                                    ? `Since ${time(s.interval_start_ms)}`
                                    : "First retained sample"}
                                </small>
                              </td>
                              <td>
                                {bytes(s.bytes_sent)} /{" "}
                                {bytes(s.bytes_received)}
                              </td>
                              <td>
                                {s.delta_sent === null
                                  ? "Unavailable"
                                  : bytes(s.delta_sent)}{" "}
                                /{" "}
                                {s.delta_received === null
                                  ? "Unavailable"
                                  : bytes(s.delta_received)}
                              </td>
                              <td>
                                {s.packets_sent?.toLocaleString() ??
                                  "Unavailable"}{" "}
                                /{" "}
                                {s.packets_received?.toLocaleString() ??
                                  "Unavailable"}
                              </td>
                              <td>{s.kind}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              {mode === "connections" && count > pageSize && (
                <div className="pagination">
                  <button
                    disabled={loading || offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - pageSize))}
                  >
                    Previous {connection === null ? "connections" : "samples"}
                  </button>
                  <span>
                    {offset + 1}–{Math.min(offset + pageSize, count)} of {count}
                  </span>
                  <button
                    disabled={
                      loading ||
                      offset + pageSize >= count ||
                      offset + pageSize > 1_000_000
                    }
                    onClick={() => setOffset(offset + pageSize)}
                  >
                    Next {connection === null ? "connections" : "samples"}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
