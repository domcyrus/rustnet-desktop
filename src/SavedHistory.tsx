import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ArrowDownLeft, ArrowUpRight, History, RefreshCw } from "lucide-react";
import { ConnectionHistory } from "./ConnectionHistory";
import { Select } from "./Select";
import { Metric } from "./components";
import { bytes } from "./model";
import { errorText } from "./useCapture";

interface Finding {
  kind: "upload" | "connections" | "destination";
  app_key: string;
  name: string;
  interface: string;
  first_ms: number;
  last_ms: number;
  observed: number;
  baseline: number;
  threshold: number;
  prior_minutes: number;
  destination: string | null;
}

export interface HistoryReport {
  exists: boolean;
  last_saved_ms: number | null;
  applications: { key: string; name: string; executable: string | null }[];
  interfaces: string[];
  totals: {
    bytes_sent: number;
    bytes_received: number;
    connections: number;
    observed_ms: number;
    incomplete_minutes: number;
  };
  rows: {
    app_key: string;
    name: string;
    executable: string | null;
    destination: string;
    protocol: string;
    port: number;
    interface: string;
    first_ms: number;
    last_ms: number;
    bytes_sent: number;
    bytes_received: number;
    connections: number;
  }[];
  row_count: number;
  sessions: {
    id: number;
    started_ms: number;
    last_seen_ms: number;
    ended_ms: number | null;
    interface: string;
    runtime_status: string;
    dropped_snapshots: number;
    error: string | null;
    capture_error: string | null;
  }[];
  analysis: {
    findings: Finding[];
    ready_profiles: number;
    learning_profiles: number;
    eligible_minutes: number;
    limited: boolean;
    findings_limited: boolean;
  };
}

const minute = 60_000;
const date = (time: number) => new Date(time).toLocaleString();
const source = (name: string) => name || "Automatic";
function localInput(time: number) {
  const d = new Date(time);
  return new Date(time - d.getTimezoneOffset() * minute)
    .toISOString()
    .slice(0, 19);
}
export function SavedHistory({
  onCaptureSettings,
}: {
  onCaptureSettings: () => void;
}) {
  const [range, setRange] = useState("24");
  const [from, setFrom] = useState(() =>
    localInput(Date.now() - 24 * 60 * minute),
  );
  const [to, setTo] = useState(() => localInput(Date.now()));
  const [app, setApp] = useState("");
  const [iface, setInterface] = useState("*");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [poll, setPoll] = useState({ version: 0, time: 0 });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [data, setData] = useState<{
    key: string;
    report: HistoryReport;
    updated: number;
    revision: number;
    fromMs: number;
    toMs: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([range, from, to, app, iface, offset]);
  const report = data?.key === key ? data.report : null;
  // Keep options available while changing filters or refreshing a page.
  const applications = data?.report.applications ?? [];
  const interfaces = data?.report.interfaces ?? [];

  useEffect(() => {
    if (!autoRefresh || loading || timelineLoading) return;
    const timer = window.setInterval(() => {
      if (!document.hidden)
        setPoll((p) => ({ version: p.version + 1, time: Date.now() }));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, loading, timelineLoading]);

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const end = range === "custom" ? new Date(to).getTime() : now;
    const start =
      range === "custom"
        ? new Date(from).getTime()
        : now - Number(range) * 60 * minute;
    setError(null);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      start >= end ||
      end > now ||
      end - start > 30 * 24 * 60 * minute
    ) {
      setError("Choose a past time range of at most 30 days.");
      setLoading(false);
      return;
    }
    if (!isTauri()) {
      setError("Open the desktop app to browse saved traffic history.");
      setLoading(false);
      return;
    }
    setLoading(true);
    void invoke<HistoryReport>("saved_history", {
      query: {
        from_ms: start,
        to_ms: end,
        app_key: app || null,
        interface: iface === "*" ? null : iface,
        offset,
      },
    })
      .then((result) => {
        if (!cancelled)
          setData((previous) => ({
            key,
            report: result,
            updated: Date.now(),
            revision: (previous?.revision ?? 0) + 1,
            fromMs: start,
            toMs: end,
          }));
      })
      .catch((e) => {
        if (!cancelled)
          setError(`Unable to read saved history: ${errorText(e)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, refresh, range, from, to, app, iface, offset]);

  function changed() {
    setOffset(0);
  }

  return (
    <section
      className="saved-history scroll-region"
      aria-label="Saved history"
      aria-busy={loading}
    >
      <div className="history-intro">
        <p>Explore connection timelines and changes in application behavior.</p>
        <button className="button" onClick={onCaptureSettings}>
          Capture settings
        </button>
      </div>
      <div className="history-filters" aria-label="Saved history filters">
        <Select
          label="History time range"
          value={range}
          onChange={(v) => {
            setRange(v);
            changed();
          }}
          options={[
            { value: "0.25", label: "Last 15 minutes" },
            { value: "1", label: "Last hour" },
            { value: "6", label: "Last 6 hours" },
            { value: "24", label: "Last 24 hours" },
            { value: "168", label: "Last 7 days" },
            { value: "720", label: "Last 30 days" },
            { value: "custom", label: "Custom range" },
          ]}
        />
        <Select
          label="History application"
          value={app}
          onChange={(v) => {
            setApp(v);
            changed();
          }}
          options={[
            { value: "", label: "All applications" },
            ...applications.map((a) => ({
              value: a.key,
              label: `${a.name}${applications.filter((b) => b.name === a.name).length > 1 && a.executable ? ` (${a.executable})` : ""}`,
            })),
          ]}
        />
        <Select
          label="History interface"
          value={iface}
          onChange={(v) => {
            setInterface(v);
            changed();
          }}
          options={[
            { value: "*", label: "All capture interfaces" },
            ...interfaces.map((i) => ({ value: i, label: source(i) })),
          ]}
        />
        <button
          className="button"
          disabled={loading || timelineLoading}
          onClick={() => setRefresh((n) => n + 1)}
        >
          <RefreshCw size={15} className={loading ? "spin" : undefined} />{" "}
          Refresh history
        </button>
        <button
          className="button"
          aria-pressed={autoRefresh}
          onClick={() => setAutoRefresh(!autoRefresh)}
        >
          Auto-refresh: {autoRefresh ? "30s" : "Off"}
        </button>
        {range === "custom" && (
          <div className="history-dates">
            <label>
              From{" "}
              <input
                aria-label="History from"
                type="datetime-local"
                step="1"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  changed();
                }}
              />
            </label>
            <label>
              To{" "}
              <input
                aria-label="History to"
                type="datetime-local"
                step="1"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  changed();
                }}
              />
            </label>
            <small>Local time. Totals use stored minute buckets.</small>
          </div>
        )}
      </div>
      {error && (
        <div className="notice warning" role="alert">
          {error}
        </div>
      )}
      {loading && !report && <p role="status">Loading saved history…</p>}
      {report && !report.exists && (
        <div className="empty">
          <History size={30} />
          <h2>No saved history yet</h2>
          <p>
            Enable Save traffic history in Capture settings, then start or
            restart capture.
          </p>
          <button className="button primary" onClick={onCaptureSettings}>
            Set up history collection
          </button>
        </div>
      )}
      {report?.exists && (
        <>
          {data && (
            <ConnectionHistory
              key={JSON.stringify([range, from, to, app, iface])}
              fromMs={
                range === "custom"
                  ? data.fromMs
                  : Math.max(data.toMs, poll.time) - (data.toMs - data.fromMs)
              }
              toMs={
                range === "custom" ? data.toMs : Math.max(data.toMs, poll.time)
              }
              app={app}
              iface={iface}
              refreshVersion={data.revision + poll.version}
              onRefreshingChange={setTimelineLoading}
            />
          )}
          <p className="history-note">
            Minute summaries, session details and filter options update with
            Refresh history. Automatic refresh updates the sampled timeline.
          </p>
          <details className="history-section">
            <summary>Minute summary totals</summary>
            <div className="history-summary">
              <Metric
                icon={<ArrowUpRight />}
                label="Uploaded"
                value={bytes(report.totals.bytes_sent)}
                caption="Saved traffic in this range"
              />
              <Metric
                icon={<ArrowDownLeft />}
                label="Downloaded"
                value={bytes(report.totals.bytes_received)}
                caption={`${report.totals.connections.toLocaleString()} new connections observed`}
              />
              <Metric
                icon={<History />}
                label="Observation time"
                value={`${Math.round(report.totals.observed_ms / minute).toLocaleString()} min`}
                caption={`${report.totals.incomplete_minutes} partial or incomplete capture minutes across selected interfaces`}
              />
            </div>
          </details>
          <details className="history-section" id="saved-traffic">
            <summary>Minute summaries and earlier history</summary>
            <div className="history-section-heading">
              <span>
                {report.row_count.toLocaleString()} destinations and services
              </span>
            </div>
            <p className="history-note">
              Totals may undercount traffic during capture gaps. Missing
              observations are not zero traffic.
            </p>
            <div className="history-table-scroll">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Application</th>
                    <th>Destination</th>
                    <th>Last observed minute</th>
                    <th>Uploaded</th>
                    <th>Downloaded</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr
                      key={JSON.stringify([
                        r.app_key,
                        r.destination,
                        r.protocol,
                        r.port,
                        r.interface,
                      ])}
                    >
                      <td>
                        <strong>{r.name}</strong>
                        <small title={r.executable ?? undefined}>
                          {r.executable || "Executable unavailable"}
                        </small>
                      </td>
                      <td>
                        <strong>{r.destination}</strong>
                        <small>
                          {r.protocol} · port {r.port} · {source(r.interface)}
                        </small>
                      </td>
                      <td>
                        {date(r.last_ms)}
                        <small>First in range: {date(r.first_ms)}</small>
                      </td>
                      <td>{bytes(r.bytes_sent)}</td>
                      <td>{bytes(r.bytes_received)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!report.rows.length && (
              <p className="history-empty">
                No saved traffic matches these filters.
                {report.last_saved_ms
                  ? ` Last saved capture: ${date(report.last_saved_ms)}.`
                  : ""}
              </p>
            )}
            {report.row_count > 50 && (
              <div className="pagination">
                <button
                  disabled={loading || offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  Previous traffic
                </button>
                <span>
                  {offset + 1}–{Math.min(offset + 50, report.row_count)} of{" "}
                  {report.row_count}
                </span>
                <button
                  disabled={
                    loading ||
                    offset + 50 >= report.row_count ||
                    offset + 50 > 1_000_000
                  }
                  onClick={() => setOffset(offset + 50)}
                >
                  Next traffic
                </button>
              </div>
            )}
          </details>
          <details className="history-section history-sessions">
            <summary>
              Capture sessions{" "}
              <span>(latest {report.sessions.length} matching)</span>
            </summary>
            {report.sessions.map((s) => (
              <div className="history-session" key={s.id}>
                <strong>
                  {source(s.interface)} · {date(s.started_ms)}
                </strong>
                <p>
                  Last snapshot: {date(s.last_seen_ms)} ·{" "}
                  {s.ended_ms === null
                    ? "Open or interrupted session"
                    : s.runtime_status === "stopped"
                      ? "Capture ended"
                      : "Final capture snapshot missing"}
                </p>
                {(s.error || s.capture_error || s.dropped_snapshots > 0) && (
                  <p className="history-note">
                    {s.error || s.capture_error || "Incomplete history"} ·{" "}
                    {s.dropped_snapshots} snapshots not saved
                  </p>
                )}
              </div>
            ))}
            {!report.sessions.length && <p>No matching capture sessions.</p>}
          </details>
          <p className="history-note">
            Summaries updated {data && date(data.updated)}.{" "}
            {autoRefresh
              ? "Timeline refreshes every 30 seconds while visible."
              : "Automatic refresh is off."}{" "}
            Findings use retained history.
          </p>
        </>
      )}
    </section>
  );
}
