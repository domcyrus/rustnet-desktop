import { useRef, useState } from "react";
import {
  HistoryTimeSeries,
  coverageLabel,
  recordedTrafficKnown,
  type Brush,
} from "./HistoryTimeSeries";
import { bytes } from "./model";
import type { Finding, Point, SeriesReport } from "./ConnectionHistory";
const date = (ms: number) => new Date(ms).toLocaleString();
const names = {
  upload: "Unusual upload",
  download: "Unusual download",
  connections: "Connection burst",
  destination: "New destination",
};
export function HistoryGraphs({
  report,
  onZoom,
  onInspect,
  onRange,
  connectionSelected,
}: {
  report: SeriesReport;
  onZoom: (p: Point) => void;
  onInspect: (f: Finding) => void;
  onRange: (from: number, to: number) => void;
  connectionSelected: boolean;
}) {
  const [focus, setFocus] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(false);
  const findingsRef = useRef<HTMLDetailsElement>(null);
  // Anchor inspection to the recorded timestamp as the rolling window advances.
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const hoverIndex = report.points.findIndex(
    (p) => p.timestamp_ms === hoverTime,
  );
  const hover = hoverIndex < 0 ? null : hoverIndex;
  const setHover = (index: number | null) =>
    setHoverTime(
      index === null ? null : (report.points[index]?.timestamp_ms ?? null),
    );
  const [brush, setBrush] = useState<Brush>(null);
  const chosen = hover === null ? null : report.points[hover];
  const findings = report.analysis.findings.filter(
    (f) =>
      focus === null ||
      (f.timestamp_ms >= focus &&
        f.timestamp_ms < focus + report.resolution_ms),
  );
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(findings.length / 10) - 1),
  );
  function reveal(p: Point) {
    setFocus(p.timestamp_ms);
    setPage(0);
    setOpen(true);
    findingsRef.current?.scrollIntoView?.({ block: "nearest" });
  }
  return (
    <>
      <div className="history-dashboard-toolbar">
        <div>
          <strong>
            {date(report.from_ms)} to {date(report.to_ms)}
          </strong>
          <small>
            Local time · {report.resolution_ms / 1000}s display resolution · 10s
            stored samples
          </small>
        </div>
        <span>Drag to zoom · Arrow keys to inspect · Esc clears cursor</span>
      </div>
      <div
        className="history-shared-tooltip"
        aria-label="Selected history interval"
      >
        {chosen ? (
          <>
            <div>
              <strong>
                {date(Math.max(report.from_ms, chosen.timestamp_ms))} to{" "}
                {date(
                  Math.min(
                    report.to_ms,
                    chosen.timestamp_ms + report.resolution_ms,
                  ),
                )}
              </strong>
              <small>
                {coverageLabel(chosen)}
                {chosen.incomplete
                  ? " · Recorded values may be incomplete"
                  : ""}
              </small>
            </div>
            <span>
              ↓{" "}
              {recordedTrafficKnown(chosen)
                ? bytes(chosen.bytes_received)
                : "Unknown"}{" "}
              <small>downloaded</small>
            </span>
            <span>
              ↑{" "}
              {recordedTrafficKnown(chosen)
                ? bytes(chosen.bytes_sent)
                : "Unknown"}{" "}
              <small>uploaded</small>
            </span>
            <span>
              {chosen.observed_ms > 0 || chosen.samples > 0
                ? chosen.active_connections
                : "Unknown"}{" "}
              <small>connections</small>
            </span>
            <span>
              {chosen.observed_ms > 0 || chosen.samples > 0
                ? chosen.counter_resets
                : "Unknown"}{" "}
              <small>resets</small>
            </span>
            <button className="button" onClick={() => onZoom(chosen)}>
              Zoom to interval
            </button>
          </>
        ) : (
          <span>
            Hover over a graph to inspect a recorded interval across every
            panel. Shaded gaps are unknown, not zero traffic.
          </span>
        )}
      </div>
      <div className="history-dashboard-panels">
        {(["traffic", "connections", "quality"] as const).map((kind) => (
          <HistoryTimeSeries
            key={kind}
            kind={kind}
            report={report}
            hover={hover}
            onHover={setHover}
            brush={brush}
            onBrush={setBrush}
            onRange={onRange}
            onFinding={reveal}
          />
        ))}
      </div>
      <p className="history-note">
        Traffic rates are recorded bytes divided by the display interval, not
        instantaneous speeds. Connections are distinct sampled connections per
        interval. Capture health shows gaps and counter resets, not application
        error counts.
      </p>
      <details
        ref={findingsRef}
        className="history-findings-panel"
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary>
          Unusual activity{" "}
          <span>
            {report.analysis.findings.length}
            {report.analysis.findings_limited ? "+" : ""} findings
          </span>
        </summary>
        <p className="history-note">
          {report.analysis.ready_profiles} app/interface profiles ready ·{" "}
          {report.analysis.learning_profiles} learning. Each needs 180 earlier
          complete ten-second intervals (30 active minutes), within seven days.
          Up to 720 intervals form the baseline.{" "}
          {connectionSelected
            ? "Findings describe this connection's application across all its connections."
            : "Findings describe application behavior across connections."}
        </p>
        {report.analysis.limited && (
          <p className="notice warning">
            Analysis uses the newest 100,000 eligible app intervals. Older
            findings may be omitted.
          </p>
        )}
        {report.analysis.findings_limited && (
          <p className="history-note">
            Only the newest 100 findings are shown and marked on the timeline.
            Narrow the time range or application filter to inspect others.
          </p>
        )}
        {focus !== null && (
          <button
            className="button"
            onClick={() => {
              setFocus(null);
              setPage(0);
            }}
          >
            Show all findings
          </button>
        )}
        {!findings.length && (
          <p className="history-empty">
            {report.analysis.ready_profiles
              ? "No unusual activity found in this range"
              : "Learning application behavior"}
          </p>
        )}
        {findings.slice(safePage * 10, safePage * 10 + 10).map((f) => (
          <article
            className="history-finding"
            key={JSON.stringify([
              f.app_key,
              f.interface,
              f.timestamp_ms,
              f.kind,
            ])}
          >
            <div>
              <span className="history-kind">{names[f.kind]}</span>
              <h3>{f.name}</h3>
              <p>
                {f.kind === "destination"
                  ? `${f.destination}${f.observed > 1 ? ` and ${f.observed - 1} others` : ""} first observed after learning. Service changes and hostname discovery can explain this.`
                  : `${f.kind === "connections" ? f.observed : bytes(f.observed)} in ten seconds. Earlier median: ${f.kind === "connections" ? f.baseline : bytes(f.baseline)}; threshold: ${f.kind === "connections" ? f.threshold : bytes(f.threshold)}. Based on ${f.prior_intervals} earlier intervals.`}
              </p>
              <small>
                {date(f.timestamp_ms)} · {f.interface || "Automatic"}
              </small>
            </div>
            <button className="button" onClick={() => onInspect(f)}>
              Inspect traffic
            </button>
          </article>
        ))}
        {findings.length > 10 && (
          <div className="pagination">
            <button
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            >
              Previous findings
            </button>
            <span>
              {safePage + 1} / {Math.ceil(findings.length / 10)}
            </span>
            <button
              disabled={(safePage + 1) * 10 >= findings.length}
              onClick={() => setPage(safePage + 1)}
            >
              Next findings
            </button>
          </div>
        )}
      </details>
      <p className="history-note history-analysis-status">
        {report.analysis.ready_profiles
          ? `${report.analysis.ready_profiles} profiles ready`
          : `Learning application behavior (${report.analysis.learning_profiles} profiles)`}{" "}
        · Gaps and resets are excluded from comparisons. Counter differences are
        assigned to their ending timestamp; boundary intervals may include
        earlier traffic.
      </p>
    </>
  );
}
