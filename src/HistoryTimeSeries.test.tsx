// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HistoryTimeSeries, type Brush } from "./HistoryTimeSeries";
import type { SeriesReport } from "./ConnectionHistory";
const start = 1_800_000_000_000;
function report(): SeriesReport {
  return {
    available: true,
    from_ms: start,
    to_ms: start + 40000,
    resolution_ms: 10000,
    bytes_sent: 0,
    bytes_received: 60000,
    uncertain_samples: 0,
    applications: [],
    application_count: 0,
    connections: [],
    connection_count: 0,
    samples: [],
    sample_count: 3,
    analysis: {
      findings: [],
      ready_profiles: 0,
      learning_profiles: 0,
      eligible_intervals: 0,
      limited: false,
      findings_limited: false,
    },
    points: [0, 1, 2, 3].map((i) => ({
      timestamp_ms: start + i * 10000,
      bytes_sent: 0,
      bytes_received: i === 1 ? 0 : 20000,
      observed_ms: i === 1 ? 0 : 10000,
      samples: i === 1 ? 0 : 1,
      uncertain_samples: 0,
      incomplete: i === 1,
      active_connections: i === 1 ? 0 : 1,
      counter_resets: 0,
      findings: 0,
    })),
  };
}
function Harness({
  onRange = vi.fn(),
  data = report(),
}: {
  onRange?: (a: number, b: number) => void;
  data?: SeriesReport;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [brush, setBrush] = useState<Brush>(null);
  return (
    <HistoryTimeSeries
      kind="traffic"
      report={data}
      hover={hover}
      onHover={setHover}
      brush={brush}
      onBrush={setBrush}
      onRange={onRange}
      onFinding={vi.fn()}
    />
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("keeps unknown intervals as gaps and displays per-second rates with toggles", () => {
  const { container } = render(<Harness />);
  expect(
    container.querySelectorAll('[data-series="Download"] .plot-line'),
  ).toHaveLength(2);
  expect(container.querySelectorAll(".history-gap")).toHaveLength(1);
  expect(screen.getAllByText("2 kB/s")).toHaveLength(3);
  fireEvent.click(
    screen.getByRole("button", { name: "Toggle download series" }),
  );
  expect(container.querySelector('[data-series="Download"]')).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Toggle download series" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});
it("does not draw observations with only uncertain counter differences as zero traffic", () => {
  const data = report();
  data.points[2].uncertain_samples = 1;
  const { container } = render(<Harness data={data} />);
  const graph = screen.getByRole("img");
  fireEvent.keyDown(graph, { key: "Home" });
  fireEvent.keyDown(graph, { key: "ArrowRight" });
  fireEvent.keyDown(graph, { key: "ArrowRight" });
  expect(graph.getAttribute("aria-label")).toContain("Download unknown");
  expect(
    container.querySelectorAll('[data-series="Download"] .plot-line'),
  ).toHaveLength(2);
});
it("supports reverse range selection and cancels an unfinished drag", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const onRange = vi.fn();
  render(<Harness onRange={onRange} />);
  const graph = screen.getByRole("img");
  vi.spyOn(graph, "getBoundingClientRect").mockReturnValue({
    left: 0,
    width: 640,
  } as DOMRect);
  fireEvent.pointerDown(graph, { clientX: 550, button: 0 });
  fireEvent.pointerMove(graph, { clientX: 240 });
  expect(document.querySelector(".history-brush")).toBeTruthy();
  fireEvent.pointerUp(graph, { clientX: 240 });
  expect(onRange).toHaveBeenCalledWith(start + 10000, start + 40000);
  expect(document.querySelector(".history-brush")).toBeNull();
  onRange.mockClear();
  fireEvent.pointerDown(graph, { clientX: 100, button: 0 });
  fireEvent.pointerMove(graph, { clientX: 550 });
  fireEvent.keyDown(graph, { key: "Escape" });
  fireEvent.pointerUp(graph, { clientX: 550 });
  expect(onRange).not.toHaveBeenCalled();
  expect(document.querySelector(".history-crosshair")).toBeNull();
});
