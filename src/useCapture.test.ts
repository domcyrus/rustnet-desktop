// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCapture } from "./useCapture";
import { connectionFixture, viewFixture } from "./test-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
afterEach(cleanup);

it.each([true, false])(
  "freezes a coherent view while retaining live history (coverage: %s)",
  (coverage) => {
    const { result } = renderHook(() => useCapture());
    const view = viewFixture();
    view.snapshot!.connections = [connectionFixture()];
    if (coverage)
      view.snapshot!.stats.capture_accounting = {
        captured: 10000,
        tracked_received: 8000,
        tracked_sent: 2000,
        attributed_received: 8000,
        attributed_sent: 2000,
      };
    act(() => result.current.acceptView(view));
    act(() => result.current.togglePaused());
    const frozen = result.current.display;
    for (let i = 1; i <= 3; i++) {
      const next = structuredClone(view);
      next.revision += i;
      next.snapshot!.timestamp = new Date(
        Date.parse(view.snapshot!.timestamp) + i * 1000,
      ).toISOString();
      next.snapshot!.connections[0].traffic.bytes_received += i * 1000;
      act(() => result.current.acceptView(next));
      expect(result.current.display).toBe(frozen);
      expect(result.current.view.revision).toBe(next.revision);
    }
    act(() => result.current.togglePaused());
    const display = result.current.display;
    expect(display.apps[0].rx).toBe(1000);
    expect(display.history.traffic).toHaveLength(4);
    expect(display.history.traffic.at(-1)?.rx).toBe(display.apps[0].rx);
    expect(display.appHistory.get(display.apps[0].key)).toEqual(
      display.history.traffic,
    );
    expect(frozen.history.traffic).toHaveLength(1);
    // Repeated bridge polls must not create extra graph samples.
    act(() => result.current.acceptView(result.current.view));
    expect(result.current.display.history.traffic).toHaveLength(4);
  },
);

it("unfreezes and clears every history when a new capture starts before its first snapshot", () => {
  const { result } = renderHook(() => useCapture());
  act(() => result.current.acceptView(viewFixture()));
  act(() => result.current.togglePaused());
  const next = {
    ...viewFixture(),
    session: 2,
    status: "starting",
    snapshot: null,
  };
  act(() => result.current.acceptView(next));
  expect(result.current.paused).toBe(false);
  expect(result.current.display.rates.view).toBe(next);
  expect(result.current.display.apps).toEqual([]);
  expect(result.current.display.history.traffic).toEqual([]);
  expect(result.current.display.history.coverage).toEqual([]);
  expect(result.current.display.appHistory.size).toBe(0);
  act(() => result.current.acceptView({ ...viewFixture(), session: 2 }));
  expect(result.current.display.history.traffic).toHaveLength(1);
  expect(result.current.display.history.traffic[0].rx).toBe(0);
  act(() => result.current.togglePaused());
  expect(result.current.paused).toBe(true);
  expect(result.current.display.rates.session).toBe(2);
});
