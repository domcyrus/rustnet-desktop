import { useState } from "react";
import { Activity } from "lucide-react";
import { Metric } from "./components";
import { Chart } from "./Chart";
import {
  bytes,
  captureBreakdown,
  type Application,
  type CaptureHistory,
  type Snapshot,
} from "./model";

export function AllTraffic({
  snapshot,
  apps,
  history,
}: {
  snapshot: Snapshot | null | undefined;
  apps: Application[];
  history: CaptureHistory;
}) {
  const [breakdown, setBreakdown] = useState(false);
  const [raw, setRaw] = useState(false);
  const traffic = raw ? (history.rawTraffic ?? []) : history.traffic;
  const coveragePoints = raw ? (history.rawCoverage ?? []) : history.coverage;
  const totals = snapshot?.stats.capture_accounting;
  const coverage = totals ? captureBreakdown(totals) : null;
  const rx = apps.reduce((sum, app) => sum + app.rx, 0);
  const tx = apps.reduce((sum, app) => sum + app.tx, 0);
  const active = snapshot?.connections.filter((c) => !c.historic) ?? [];
  const rows =
    totals && coverage
      ? [
          {
            label: "Attributed to applications",
            value: coverage.attributed,
            color: "var(--rx)",
            detail: "Process known when the packet was processed",
          },
          {
            label: "Unknown application",
            value: coverage.unknown,
            color: "var(--tx)",
            detail: "Tracked connection, process not yet known",
          },
          {
            label: "Outside tracked connections",
            value: coverage.outside,
            color: "var(--muted)",
            detail:
              "Pending processing, skipped, unsupported or queue-dropped packets",
          },
        ]
      : [];
  return (
    <>
      <div className="app-title">
        <span className="app-icon large">
          <Activity size={23} />
        </span>
        <div>
          <h2>All traffic</h2>
          <p className="subtitle">
            Selected capture source · current capture session
          </p>
        </div>
      </div>
      <p className="app-counts">
        {active.length} active connections ·{" "}
        {apps.filter((a) => a.pids.length).length} applications ·{" "}
        {new Set(active.map((c) => c.remote.ip)).size} hosts
      </p>
      <div className="app-metrics">
        {[
          [
            "Download",
            snapshot ? bytes(rx, true) : "Waiting for samples",
            "2-second average · tracked connections",
          ],
          [
            "Upload",
            snapshot ? bytes(tx, true) : "Waiting for samples",
            "2-second average · tracked connections",
          ],
          [
            "Total downloaded",
            totals ? bytes(totals.tracked_received) : "Unavailable",
            "Tracked frame bytes · session",
          ],
          [
            "Total uploaded",
            totals ? bytes(totals.tracked_sent) : "Unavailable",
            "Tracked frame bytes · session",
          ],
        ].map(([label, value, caption]) => (
          <Metric
            key={label}
            label={label}
            value={value}
            caption={caption}
            placeholder={
              value === "Waiting for samples" || value === "Unavailable"
            }
          />
        ))}
      </div>
      {totals && (
        <div className="traffic-resolution">
          <span>
            {raw ? "Raw interval rates" : "2-second moving average"} ·{" "}
            {traffic.length} observed samples · 60-second window
          </span>
          <button
            className="button"
            aria-pressed={raw}
            onClick={() => setRaw(!raw)}
          >
            {raw ? "Show smoothed rates" : "Show raw peaks"}
          </button>
        </div>
      )}
      <Chart
        points={totals ? traffic : history.traffic}
        label="Tracked traffic · last 60 seconds"
      />
      {totals && coverage ? (
        <section className="capture-coverage" aria-label="Capture coverage">
          <div className="endpoints-title">
            <h3>Capture coverage</h3>
            <span>{bytes(totals.captured)} captured</span>
          </div>
          <p>
            All categories count original captured frame bytes, including
            link-layer headers. Totals survive connection expiry.
          </p>
          <div
            className="coverage-bar"
            role="img"
            aria-label={rows
              .map((r) => `${r.label}: ${bytes(r.value)}`)
              .join(", ")}
          >
            {rows.map((r) => (
              <span
                key={r.label}
                style={{
                  width: `${totals.captured ? (r.value / totals.captured) * 100 : 0}%`,
                  background: r.color,
                }}
              />
            ))}
          </div>
          <div className="coverage-table">
            <table>
              <thead>
                <tr>
                  <th>Coverage</th>
                  <th>Bytes</th>
                  <th>Of captured</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <td>
                      <strong>{r.label}</strong>
                      <small>{r.detail}</small>
                    </td>
                    <td>{bytes(r.value)}</td>
                    <td>
                      {totals.captured
                        ? `${((r.value / totals.captured) * 100).toFixed(1)}%`
                        : "No traffic"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            {bytes(coverage.tracked)} assigned to connections. Unknown
            application bytes stay in that category even if the process is
            identified later. The outside gap can shrink as queued packets are
            processed.
          </p>
          <p>
            Traffic the backend never captured is not measured here. Driver
            drops have no known byte total. With VPNs or all-interface capture,
            the same traffic may be observed more than once.
          </p>
          <button
            className="button"
            aria-pressed={breakdown}
            onClick={() => setBreakdown(!breakdown)}
          >
            {breakdown ? "Hide breakdown graph" : "Show breakdown graph"}
          </button>
          {breakdown && (
            <Chart
              points={coveragePoints}
              label="Capture and attribution rates · last 60 seconds"
              series={["Captured", "Attributed"]}
            />
          )}
        </section>
      ) : (
        <p className="notice">
          {snapshot
            ? "Rebuild the capture engine and restart capture to measure the attribution gap. Older snapshots cannot provide comparable totals."
            : "Start capture to see overall traffic and attribution coverage."}
        </p>
      )}
    </>
  );
}
