import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { bytes } from "./model";
import type { Point, SeriesReport } from "./ConnectionHistory";

type Kind = "traffic" | "connections" | "quality";
export type Brush = { start: number; end: number } | null;
const stamp = (time: number) => new Date(time).toLocaleString();
export const coverageLabel = (p: Point) =>
  p.observed_ms === 0
    ? "No capture coverage"
    : p.incomplete
      ? "Partial coverage"
      : "Observed";
// Missing capture and samples with no comparable predecessor are not zero traffic.
export const recordedTrafficKnown = (p: Point) =>
  p.uncertain_samples < p.samples || (p.observed_ms > 0 && p.samples === 0);
function ceiling(value: number) {
  if (value <= 0) return 1;
  const scale = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 5, 10].find((n) => n * scale >= value) ?? 10) * scale;
}

export function HistoryTimeSeries({
  kind,
  report,
  hover,
  onHover,
  brush,
  onBrush,
  onRange,
  onFinding,
}: {
  kind: Kind;
  report: SeriesReport;
  hover: number | null;
  onHover: (index: number | null) => void;
  brush: Brush;
  onBrush: (brush: Brush) => void;
  onRange: (from: number, to: number) => void;
  onFinding: (point: Point) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<number | null>(null);
  const [width, setWidth] = useState(640);
  const [hidden, setHidden] = useState<string[]>([]);
  const pattern = useId().replaceAll(":", "");
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(280, entries[0].contentRect.width)),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const title =
    kind === "traffic"
      ? "Traffic rate"
      : kind === "connections"
        ? "Observed connections"
        : "Capture health";
  const height = kind === "traffic" ? 266 : kind === "quality" ? 162 : 216;
  const left = 76,
    right = width - 18,
    top = 24,
    bottom = height - 36;
  const duration = Math.max(1, report.to_ms - report.from_ms);
  const x = (time: number) =>
    left + ((time - report.from_ms) / duration) * (right - left);
  const center = (p: Point) =>
    x(
      (Math.max(report.from_ms, p.timestamp_ms) +
        Math.min(report.to_ms, p.timestamp_ms + report.resolution_ms)) /
        2,
    );
  const channels =
    kind === "traffic"
      ? [
          {
            key: "received",
            label: "Download",
            value: (p: Point) =>
              p.bytes_received / (report.resolution_ms / 1000),
          },
          {
            key: "sent",
            label: "Upload",
            value: (p: Point) => p.bytes_sent / (report.resolution_ms / 1000),
          },
        ]
      : [
          {
            key: "connections",
            label: "Connections",
            value: (p: Point) => p.active_connections,
          },
        ];
  const visible = channels.filter((c) => !hidden.includes(c.key));
  const valid = (p: Point) =>
    kind === "connections"
      ? p.observed_ms > 0 || p.samples > 0
      : recordedTrafficKnown(p);
  const maximum = ceiling(
    Math.max(
      0,
      ...report.points
        .filter(valid)
        .flatMap((p) => visible.map((c) => c.value(p))),
    ),
  );
  const y = (value: number) => bottom - (value / maximum) * (bottom - top);
  const format = (value: number) =>
    kind === "traffic"
      ? value < 1000
        ? `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} B/s`
        : bytes(value, true)
      : value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  // Explicit tick counts keep labels readable on narrow panels.
  const tickCount = width < 440 ? 3 : 5;
  const timeTicks = Array.from(
    { length: tickCount },
    (_, i) => report.from_ms + (duration * i) / (tickCount - 1),
  );
  function paths(value: (p: Point) => number) {
    const segments: { line: string; area: string }[] = [];
    let line = "",
      first = 0,
      end = 0;
    const flush = () => {
      if (line)
        segments.push({ line, area: `${line} L${end},${bottom} H${first} Z` });
      line = "";
    };
    for (const p of report.points) {
      if (!valid(p)) {
        flush();
        continue;
      }
      const begin = x(Math.max(report.from_ms, p.timestamp_ms));
      end = x(Math.min(report.to_ms, p.timestamp_ms + report.resolution_ms));
      if (!line) {
        first = begin;
        line = `M${begin},${y(value(p))}`;
      } else line += ` V${y(value(p))}`;
      line += ` H${end}`;
    }
    flush();
    return segments;
  }
  function indexAt(event: React.PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const px =
      ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * width;
    const time =
      report.from_ms +
      Math.max(0, Math.min(1, (px - left) / (right - left))) * duration;
    return Math.max(
      0,
      Math.min(
        report.points.length - 1,
        Math.floor(
          (time - (report.points[0]?.timestamp_ms ?? report.from_ms)) /
            report.resolution_ms,
        ),
      ),
    );
  }
  function selectRange(a: number, b: number) {
    const start = report.points[Math.min(a, b)],
      end = report.points[Math.max(a, b)];
    if (start && end)
      onRange(
        Math.max(report.from_ms, start.timestamp_ms),
        Math.min(report.to_ms, end.timestamp_ms + report.resolution_ms),
      );
  }
  const point = hover === null ? null : report.points[hover];
  const selectionStart = brush
    ? report.points[Math.min(brush.start, brush.end)]
    : null;
  const selectionEnd = brush
    ? report.points[Math.max(brush.start, brush.end)]
    : null;
  const summary = point
    ? `${stamp(point.timestamp_ms)}. ${coverageLabel(point)}. ${kind === "quality" ? `${point.counter_resets} recorded counter resets` : channels.map((c) => `${c.label} ${valid(point) ? format(c.value(point)) : "unknown"}`).join(". ")}`
    : "Use left and right arrows to inspect intervals. Enter zooms to the selected interval. Drag to select a range.";
  return (
    <section className={`history-panel ${kind}`} aria-label={`${title} panel`}>
      <header>
        <h3>{title}</h3>
        <span>
          {kind === "traffic"
            ? `${report.resolution_ms / 1000}s averages`
            : kind === "connections"
              ? "Distinct connections per interval"
              : "Coverage and counter resets"}
        </span>
      </header>
      <div className="history-plot" ref={container}>
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          tabIndex={0}
          role="img"
          aria-label={`${title} timeline. ${summary}`}
          onPointerDown={(e) => {
            if (e.button !== 0 || !report.points.length) return;
            const i = indexAt(e);
            pointerStart.current = i;
            onHover(i);
            onBrush({ start: i, end: i });
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!report.points.length) return;
            const i = indexAt(e);
            onHover(i);
            if (pointerStart.current !== null)
              onBrush({ start: pointerStart.current, end: i });
          }}
          onPointerUp={(e) => {
            const start = pointerStart.current;
            pointerStart.current = null;
            onBrush(null);
            e.currentTarget.releasePointerCapture?.(e.pointerId);
            if (start !== null) {
              const end = indexAt(e);
              if (start !== end) selectRange(start, end);
            }
          }}
          onPointerCancel={() => {
            pointerStart.current = null;
            onBrush(null);
          }}
          onKeyDown={(e) => {
            if (!report.points.length) return;
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              onHover(
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? report.points.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          report.points.length - 1,
                          (hover ?? 0) + (e.key === "ArrowRight" ? 1 : -1),
                        ),
                      ),
              );
            }
            if (e.key === "Enter" && hover !== null) {
              e.preventDefault();
              selectRange(hover, hover);
            }
            if (e.key === "Escape") {
              pointerStart.current = null;
              onBrush(null);
              onHover(null);
            }
          }}
        >
          <defs>
            <pattern
              id={`${pattern}-partial`}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" className="health-partial-bg" />
              <rect width="2" height="6" className="health-partial-stripe" />
            </pattern>
          </defs>
          {timeTicks.map((t, i) => (
            <g key={i}>
              <line
                className="history-grid vertical"
                x1={x(t)}
                x2={x(t)}
                y1={top}
                y2={bottom}
              />
              <text
                x={x(t)}
                y={height - 12}
                textAnchor={
                  i === 0 ? "start" : i === tickCount - 1 ? "end" : "middle"
                }
              >
                {duration >= 86400000
                  ? new Date(t).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : new Date(t).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                      ...(duration <= 120000 ? { second: "2-digit" } : {}),
                    })}
              </text>
            </g>
          ))}
          {kind !== "quality" ? (
            <>
              {[0, 0.25, 0.5, 0.75, 1]
                .filter(
                  (f, i) =>
                    kind === "traffic" ||
                    (i % 2 === 0 && Number.isInteger(maximum * f)),
                )
                .map((f) => (
                  <g key={f}>
                    <line
                      className="history-grid"
                      x1={left}
                      x2={right}
                      y1={y(maximum * f)}
                      y2={y(maximum * f)}
                    />
                    <text x={left - 9} y={y(maximum * f) + 4} textAnchor="end">
                      {format(maximum * f)}
                    </text>
                  </g>
                ))}
              {report.points
                .filter((p) => p.observed_ms === 0)
                .map((p) => (
                  <rect
                    key={p.timestamp_ms}
                    className="history-gap"
                    x={x(Math.max(report.from_ms, p.timestamp_ms))}
                    y={top}
                    width={Math.max(
                      0,
                      x(
                        Math.min(
                          report.to_ms,
                          p.timestamp_ms + report.resolution_ms,
                        ),
                      ) - x(Math.max(report.from_ms, p.timestamp_ms)),
                    )}
                    height={bottom - top}
                  />
                ))}
              {visible.map((c) => (
                <g
                  key={c.key}
                  className={`plot-series ${c.key}`}
                  data-series={c.label}
                >
                  {paths(c.value).map((path, i) => (
                    <g key={i}>
                      <path d={path.area} className="plot-area" />
                      <path d={path.line} className="plot-line" />
                    </g>
                  ))}
                </g>
              ))}
            </>
          ) : (
            <>
              <text x={left - 9} y={top + 22} textAnchor="end">
                Coverage
              </text>
              <text x={left - 9} y={top + 68} textAnchor="end">
                Resets
              </text>
              {report.points.map((p) => {
                const begin = x(Math.max(report.from_ms, p.timestamp_ms)),
                  end = x(
                    Math.min(
                      report.to_ms,
                      p.timestamp_ms + report.resolution_ms,
                    ),
                  );
                return (
                  <g key={p.timestamp_ms}>
                    <rect
                      className={
                        p.observed_ms === 0
                          ? "health-missing"
                          : !p.incomplete
                            ? "health-complete"
                            : undefined
                      }
                      fill={
                        p.observed_ms > 0 && p.incomplete
                          ? `url(#${pattern}-partial)`
                          : undefined
                      }
                      x={begin}
                      y={top + 4}
                      width={Math.max(0, end - begin)}
                      height={28}
                    />
                    <rect
                      className="health-reset-track"
                      x={begin}
                      y={top + 48}
                      width={Math.max(0, end - begin)}
                      height={26}
                    />
                    {p.counter_resets > 0 && (
                      <circle
                        className="health-reset"
                        cx={(begin + end) / 2}
                        cy={top + 61}
                        r={4}
                      />
                    )}
                  </g>
                );
              })}
            </>
          )}
          {kind === "traffic" &&
            report.points
              .filter((p) => p.findings > 0)
              .map((p) => (
                <line
                  key={p.timestamp_ms}
                  className="history-annotation"
                  x1={center(p)}
                  x2={center(p)}
                  y1={top}
                  y2={bottom}
                />
              ))}
          {point && (
            <line
              className="history-crosshair"
              x1={center(point)}
              x2={center(point)}
              y1={top}
              y2={bottom}
            />
          )}
          {selectionStart && selectionEnd && (
            <rect
              className="history-brush"
              x={x(Math.max(report.from_ms, selectionStart.timestamp_ms))}
              y={top}
              width={Math.max(
                0,
                x(
                  Math.min(
                    report.to_ms,
                    selectionEnd.timestamp_ms + report.resolution_ms,
                  ),
                ) - x(Math.max(report.from_ms, selectionStart.timestamp_ms)),
              )}
              height={bottom - top}
            />
          )}
        </svg>
        {kind === "traffic" &&
          report.points
            .filter((p) => p.findings > 0)
            .map((p) => (
              <button
                key={p.timestamp_ms}
                className="history-annotation-button"
                style={{ left: `${(center(p) / width) * 100}%`, top: 8 }}
                aria-label={`${p.findings} unusual activity findings at ${stamp(p.timestamp_ms)}`}
                title="Inspect unusual activity"
                onClick={() => onFinding(p)}
              >
                <AlertCircle size={15} />
              </button>
            ))}
      </div>
      {kind !== "quality" ? (
        <div className="history-series-legend">
          <span>Series</span>
          <span>Last recorded</span>
          <span>Max</span>
          {channels.map((c) => {
            const values = report.points.filter(valid).map(c.value);
            return (
              <div className={`legend-series ${c.key}`} key={c.key}>
                <button
                  aria-label={`Toggle ${c.label.toLowerCase()} series`}
                  aria-pressed={!hidden.includes(c.key)}
                  onClick={() =>
                    setHidden(
                      hidden.includes(c.key)
                        ? hidden.filter((k) => k !== c.key)
                        : [...hidden, c.key],
                    )
                  }
                >
                  <i />
                  {c.label}
                </button>
                <span>
                  {values.length ? format(values.at(-1)!) : "Unknown"}
                </span>
                <span>
                  {values.length ? format(Math.max(...values)) : "Unknown"}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="history-health-legend">
          <span>
            <i className="observed" />
            Observed
          </span>
          <span>
            <i className="partial" />
            Partial
          </span>
          <span>
            <i className="missing" />
            No coverage
          </span>
          <span>
            <i className="resets" />
            {report.points.reduce((n, p) => n + p.counter_resets, 0)} recorded
            resets
          </span>
        </div>
      )}
    </section>
  );
}
