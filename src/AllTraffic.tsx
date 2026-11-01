import { useState } from "react";
import { Metric } from "./components";
import { Chart } from "./Chart";
import {
  bytes,
  captureBreakdown,
  type CaptureHistory,
  type Snapshot,
} from "./model";

export function AllTraffic({
  snapshot,
  history,
}: {
  snapshot: Snapshot | null | undefined;
  history: CaptureHistory;
}) {
  const [breakdown, setBreakdown] = useState(false);
  const [raw, setRaw] = useState(false);
  const traffic = raw ? (history.rawTraffic ?? []) : history.traffic;
  const coveragePoints = raw ? (history.rawCoverage ?? []) : history.coverage;
  const totals = snapshot?.stats.capture_accounting;
  const coverage = totals ? captureBreakdown(totals) : null;
  const rows = coverage
    ? [
        {
          label: "Attributed to applications",
          value: coverage.attributed,
          color: "var(--rx)",
        },
        {
          label: "Unknown application",
          value: coverage.unknown,
          color: "var(--tx)",
        },
        {
          label: "Outside tracked connections",
          value: coverage.outside,
          color: "var(--muted)",
        },
      ]
    : [];
  return (
    <div className="traffic-overview">
      <div className="overview-plot">
        <Chart points={traffic} label="Tracked traffic · last 60 seconds" />
        {totals && (
          <div className="traffic-resolution">
            <span>
              {raw ? "Raw interval rates" : "2-second moving average"} ·{" "}
              {traffic.length} samples
            </span>
            <button
              className="text-button"
              aria-pressed={raw}
              onClick={() => setRaw(!raw)}
            >
              {raw ? "Show smoothed rates" : "Show raw peaks"}
            </button>
          </div>
        )}
      </div>
      <div className="overview-side">
        <div className="session-totals" aria-label="Session totals">
          <Metric
            label="Total downloaded"
            value={totals ? bytes(totals.tracked_received) : "Unavailable"}
            caption="Tracked frame bytes · session"
            placeholder={!totals}
          />
          <Metric
            label="Total uploaded"
            value={totals ? bytes(totals.tracked_sent) : "Unavailable"}
            caption="Tracked frame bytes · session"
            placeholder={!totals}
          />
        </div>
        {totals && coverage ? (
          <section className="capture-coverage" aria-label="Capture coverage">
            <div className="coverage-heading">
              <h3>Capture coverage</h3>
              <span>{bytes(totals.captured)} captured</span>
            </div>
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
            <dl className="coverage-legend">
              {rows.map((r) => (
                <div key={r.label}>
                  <dt>
                    <span
                      className="coverage-dot"
                      style={{ background: r.color }}
                    />
                    {r.label}
                  </dt>
                  <dd>
                    <span>{bytes(r.value)}</span>
                    <strong>
                      {totals.captured
                        ? `${((r.value / totals.captured) * 100).toFixed(1)}%`
                        : "No traffic"}
                    </strong>
                  </dd>
                </div>
              ))}
            </dl>
            <details className="coverage-notes">
              <summary>How coverage is measured</summary>
              <p>
                All categories count original captured frame bytes, including
                link-layer headers. Totals survive connection expiry.{" "}
                {bytes(coverage.tracked)} assigned to connections.
              </p>
              <p>
                Attributed bytes had a known process when processed. Unknown
                application bytes stay in that category even if the process is
                identified later. Outside tracked connections includes pending,
                skipped, unsupported or queue-dropped packets; this gap can
                shrink as queued packets are processed.
              </p>
              <p>
                Traffic the backend never captured is not measured here. Driver
                drops have no known byte total. With VPNs or all-interface
                capture, the same traffic may be observed more than once.
              </p>
              <button
                className="text-button"
                aria-pressed={breakdown}
                onClick={() => setBreakdown(!breakdown)}
              >
                {breakdown ? "Hide breakdown graph" : "Show breakdown graph"}
              </button>
            </details>
          </section>
        ) : (
          <p className="overview-empty">
            {snapshot
              ? "Capture coverage unavailable. Rebuild the capture engine and restart capture to measure attribution."
              : "Start capture to see traffic and coverage."}
          </p>
        )}
      </div>
      {breakdown && (
        <div className="overview-breakdown">
          <Chart
            points={coveragePoints}
            label="Capture and attribution rates · last 60 seconds"
            series={["Captured", "Attributed"]}
          />
        </div>
      )}
    </div>
  );
}
