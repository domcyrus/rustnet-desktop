import { useEffect, useRef, useState } from "react";
import { bytes, type TrafficPoint } from "./model";

export function Chart({
  points,
  label,
  series = ["Download", "Upload"],
}: {
  points: TrafficPoint[];
  label: string;
  series?: [string, string];
}) {
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
    points.map((p, i) => `${i ? "L" : "M"}${x(p.time)},${y(p[key])}`).join(" ");
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
        {ticks.map((value) => (
          <g key={value}>
            <line
              className="grid-line"
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
              className="rx-area"
              d={`${path("rx")} L${x(points.at(-1)!.time)},${bottom} L${x(points[0].time)},${bottom}Z`}
            />
            <path className="rx-line" d={path("rx")} />
            <path className="tx-line" d={path("tx")} />
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
          <line
            className="hover-line"
            x1={x(chosen.time)}
            x2={x(chosen.time)}
            y1={top}
            y2={bottom}
          />
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
          {new Date(chosen.time).toLocaleTimeString()} · {series[0]}{" "}
          {bytes(chosen.rx, true)} · {series[1]} {bytes(chosen.tx, true)}
        </div>
      )}
    </div>
  );
}
