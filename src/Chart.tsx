import { useEffect, useId, useRef, useState } from "react";
import { bytes, type TrafficPoint } from "./model";

function smoothCurve(
  pts: { x: number; y: number }[],
  minY: number,
  maxY: number,
): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  if (pts.length === 2)
    return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;
  const n = pts.length;
  const dx: number[] = new Array(n - 1);
  const slope: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    slope[i] = dx[i] > 1e-6 ? (pts[i + 1].y - pts[i].y) / dx[i] : 0;
  }
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0;
    else m[i] = (2 * slope[i - 1] * slope[i]) / (slope[i - 1] + slope[i]);
  }
  const clamp = (v: number) => Math.max(minY, Math.min(maxY, v));
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    if (dx[i] <= 1e-6) {
      d += ` L${pts[i + 1].x},${pts[i + 1].y}`;
    } else {
      const cp1x = pts[i].x + dx[i] / 3;
      const cp1y = clamp(pts[i].y + (m[i] * dx[i]) / 3);
      const cp2x = pts[i + 1].x - dx[i] / 3;
      const cp2y = clamp(pts[i + 1].y - (m[i + 1] * dx[i]) / 3);
      d += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${pts[i + 1].x},${pts[i + 1].y}`;
    }
  }
  const last = pts[n - 1];
  return `${d} L${last.x},${last.y}`;
}

export function Chart({
  points,
  label,
  series = ["Download", "Upload"],
}: {
  points: TrafficPoint[];
  label: string;
  series?: [string, string];
}) {
  const uid = useId().replaceAll(":", "");
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [logarithmic, setLogarithmic] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0].contentRect.width),
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const end = points.at(-1)?.time ?? Date.now(),
    start = end - 60_000;
  const left = 84,
    right = Math.max(left + 20, width - 12),
    top = 12,
    bottom = 122;
  const max = Math.max(1000, ...points.flatMap((p) => [p.rx, p.tx])) * 1.12;
  const x = (time: number) => left + ((time - start) / 60_000) * (right - left);
  const fraction = (value: number) =>
    logarithmic ? Math.log1p(value) / Math.log1p(max) : value / max;
  const y = (value: number) => bottom - fraction(value) * (bottom - top);
  const latest = points.at(-1);
  const compressed =
    !logarithmic &&
    latest &&
    [latest.rx, latest.tx].some(
      (rate) => rate > 0 && fraction(rate) * (bottom - top) < 1,
    );
  const ticks = logarithmic ? [0] : [0, max / 2];
  if (logarithmic) {
    const exponent = Math.ceil(Math.log10(max));
    const step = Math.max(1, Math.ceil(exponent / 4));
    for (let power = 1; power < exponent; power += step) {
      const value = 10 ** power;
      if (fraction(value) < 0.88) ticks.push(value);
    }
  }
  ticks.push(max);
  const path = (key: "rx" | "tx") =>
    smoothCurve(
      points.map((p) => ({ x: x(p.time), y: y(p[key]) })),
      top,
      bottom,
    );
  const chosen =
    hover === null || !points.length
      ? null
      : points.reduce((a, b) =>
          Math.abs(x(a.time) - hover) < Math.abs(x(b.time) - hover) ? a : b,
        );
  return (
    <div className="traffic-chart" ref={container}>
      <div className="chart-caption">
        <span>{label}</span>
        <div className="legend">
          <span className="rx-key">{series[0]}</span>
          <span className="tx-key">{series[1]}</span>
        </div>
      </div>
      <svg
        width="100%"
        height="158"
        viewBox={`0 0 ${width} 158`}
        role="img"
        aria-label={`${label}. ${logarithmic ? "Logarithmic" : "Linear"} scale. ${points.length ? `Latest ${series[0]} ${bytes(points.at(-1)!.rx, true)}, ${series[1]} ${bytes(points.at(-1)!.tx, true)}.` : "Waiting for traffic samples."}`}
        onPointerMove={(e) =>
          setHover(e.clientX - e.currentTarget.getBoundingClientRect().left)
        }
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`rx-fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--rx)" stopOpacity="0.34" />
            <stop offset="65%" stopColor="var(--rx)" stopOpacity="0.09" />
            <stop offset="100%" stopColor="var(--rx)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`tx-fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--tx)" stopOpacity="0.24" />
            <stop offset="65%" stopColor="var(--tx)" stopOpacity="0.06" />
            <stop offset="100%" stopColor="var(--tx)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((value) => (
          <g key={value}>
            <line
              className={`grid-line${value === 0 ? " baseline" : ""}`}
              x1={left}
              x2={right}
              y1={y(value)}
              y2={y(value)}
            />
            <text x={left - 9} y={y(value) + 4} textAnchor="end">
              {bytes(value, true)}
            </text>
          </g>
        ))}
        {points.length > 1 && (
          <>
            <path
              className="tx-area"
              fill={`url(#tx-fill-${uid})`}
              d={`${path("tx")} L${x(points.at(-1)!.time)},${bottom} L${x(points[0].time)},${bottom}Z`}
            />
            <path
              className="rx-area"
              fill={`url(#rx-fill-${uid})`}
              d={`${path("rx")} L${x(points.at(-1)!.time)},${bottom} L${x(points[0].time)},${bottom}Z`}
            />
            <path className="tx-line" d={path("tx")} />
            <path className="rx-line" d={path("rx")} />
            {latest && !chosen && (
              <>
                <circle
                  className="rx-live-ring"
                  cx={x(latest.time)}
                  cy={y(latest.rx)}
                  r="6"
                />
                <circle
                  className="rx-live-dot"
                  cx={x(latest.time)}
                  cy={y(latest.rx)}
                  r="3.2"
                />
                <circle
                  className="tx-live-dot"
                  cx={x(latest.time)}
                  cy={y(latest.tx)}
                  r="2.6"
                />
              </>
            )}
          </>
        )}
        {points.length === 1 && (
          <circle
            className="rx-dot"
            cx={x(points[0].time)}
            cy={y(points[0].rx)}
            r="3"
          />
        )}
        <text x={left} y="146">
          60s ago
        </text>
        <text x={(left + right) / 2} y="146" textAnchor="middle">
          30s ago
        </text>
        <text x={right} y="146" textAnchor="end">
          Latest
        </text>
        <text x="0" y="146">
          Bytes/s
        </text>
        {chosen && (
          <>
            <line
              className="hover-line"
              x1={x(chosen.time)}
              x2={x(chosen.time)}
              y1={top}
              y2={bottom}
            />
            <circle
              className="hover-dot tx"
              cx={x(chosen.time)}
              cy={y(chosen.tx)}
              r="3.8"
            />
            <circle
              className="hover-dot rx"
              cx={x(chosen.time)}
              cy={y(chosen.rx)}
              r="4.2"
            />
          </>
        )}
      </svg>
      <div className="chart-scale">
        <span>
          {logarithmic
            ? "Log scale: small flows and large bursts remain visible."
            : compressed
              ? "Current traffic is below one pixel on this scale. Use log scale to see small flows."
              : "Linear scale"}
        </span>
        <button
          className="button"
          aria-pressed={logarithmic}
          onClick={() => setLogarithmic(!logarithmic)}
        >
          Log scale
        </button>
      </div>
      {!points.length && (
        <span className="chart-empty">Waiting for capture</span>
      )}
      {chosen && (
        <div className="chart-tooltip">
          <span className="tooltip-time">
            {new Date(chosen.time).toLocaleTimeString()}
          </span>
          <span className="tooltip-sep" aria-hidden="true">
            {" · "}
          </span>
          <span className="tooltip-rx">
            {series[0]} {bytes(chosen.rx, true)}
          </span>
          <span className="tooltip-sep" aria-hidden="true">
            {" · "}
          </span>
          <span className="tooltip-tx">
            {series[1]} {bytes(chosen.tx, true)}
          </span>
        </div>
      )}
    </div>
  );
}
