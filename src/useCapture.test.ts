// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCapture } from "./useCapture";
import { connectionFixture, viewFixture } from "./test-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(), invoke: vi.fn() }));
beforeEach(() => vi.mocked(isTauri).mockReturnValue(false));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function pollingHook() {
  vi.useFakeTimers();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const hook = renderHook(() => useCapture());
  await act(async () => {});
  return hook;
}

it("keeps unchanged polls out of the model and sends only a small cursor", async () => {
  const view = viewFixture();
  vi.mocked(invoke).mockResolvedValueOnce(view).mockResolvedValue(null);
  const { result } = await pollingHook();
  const display = result.current.display;
  const updated = result.current.lastUpdated;
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(result.current.display).toBe(display);
  expect(result.current.lastUpdated).toBe(updated);
  const { snapshot: _snapshot, ...known } = view;
  expect(invoke).toHaveBeenLastCalledWith("capture_view", { known, includeSnapshot: true });
});

it("polls status while frozen and fetches the newest data on resume", async () => {
  const view = viewFixture();
  vi.mocked(invoke).mockResolvedValueOnce(view).mockResolvedValue(null);
  const { result } = await pollingHook();
  await act(async () => result.current.togglePaused());
  const frozen = result.current.display;
  expect(invoke).toHaveBeenLastCalledWith("capture_view", { known: null, includeSnapshot: false });
  const stopped = { ...view, revision: 10, status: "error", error: "Capture failed", snapshot: null };
  vi.mocked(invoke).mockResolvedValueOnce(stopped);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(result.current.view.error).toBe("Capture failed");
  expect(result.current.display).toBe(frozen);
  expect(result.current.view.snapshot).toBe(frozen.rates.view.snapshot);
  const latest = structuredClone(view);
  latest.revision = 11;
  latest.snapshot!.timestamp = "2026-09-27T12:00:10Z";
  vi.mocked(invoke).mockResolvedValueOnce(latest);
  await act(async () => result.current.togglePaused());
  expect(invoke).toHaveBeenLastCalledWith("capture_view", { known: null, includeSnapshot: true });
  expect(result.current.view.revision).toBe(11);
  expect(result.current.display.history.traffic).toHaveLength(2);
});

it("suspends snapshot transfers while hidden and refreshes immediately when visible", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewFixture()).mockResolvedValue(null);
  const { result } = await pollingHook();
  const display = result.current.display;
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(invoke).toHaveBeenLastCalledWith("capture_view", { known: null, includeSnapshot: false });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(result.current.display).toBe(display);
  const latest = { ...viewFixture(), revision: 20 };
  vi.mocked(invoke).mockResolvedValueOnce(latest);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(invoke).toHaveBeenLastCalledWith("capture_view", { known: null, includeSnapshot: true });
  expect(result.current.view.revision).toBe(20);
});

it("unfreezes on a new session reported by status polling", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewFixture()).mockResolvedValue(null);
  const { result } = await pollingHook();
  await act(async () => result.current.togglePaused());
  const next = { ...viewFixture(), session: 2 };
  vi.mocked(invoke)
    .mockResolvedValueOnce({ ...next, snapshot: null })
    .mockResolvedValueOnce(next);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(result.current.paused).toBe(false);
  expect(result.current.view.session).toBe(2);
  expect(result.current.display.history.traffic).toHaveLength(1);
});

it("ignores an in-flight full snapshot after freezing", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
    .mockResolvedValue(null);
  const { result } = await pollingHook();
  await act(async () => result.current.togglePaused());
  const frozen = result.current.display;
  await act(async () => resolve(viewFixture()));
  expect(result.current.view.snapshot).toBeNull();
  expect(result.current.display).toBe(frozen);
});

it("does not overwrite an explicit command result with a stale pending poll", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
    .mockResolvedValue(null);
  const { result } = await pollingHook();
  const next = { ...viewFixture(), session: 2 };
  act(() => result.current.acceptView(next));
  await act(async () => resolve(viewFixture()));
  expect(result.current.view.session).toBe(2);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(invoke).toHaveBeenLastCalledWith("capture_view", { known: null, includeSnapshot: true });
});

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
