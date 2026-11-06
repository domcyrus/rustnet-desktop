// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SavedHistory, type HistoryReport } from "./SavedHistory";
import { ConnectionHistory } from "./ConnectionHistory";

vi.mock("./ConnectionHistory", () => ({
  ConnectionHistory: vi.fn(() => <div>Connection timeline</div>),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
const end = Math.floor(Date.now() / 60000) * 60000;
function fixture(): HistoryReport {
  return {
    exists: true,
    last_saved_ms: end,
    applications: [
      { key: "app", name: "Browser", executable: "/apps/browser" },
    ],
    interfaces: ["en0"],
    totals: {
      bytes_sent: 1024,
      bytes_received: 2048,
      connections: 2,
      observed_ms: 60000,
      incomplete_minutes: 1,
    },
    rows: [
      {
        app_key: "app",
        name: "Browser",
        executable: "/apps/browser",
        destination: "example.test",
        protocol: "TCP",
        port: 443,
        interface: "en0",
        first_ms: end - 60000,
        last_ms: end - 60000,
        bytes_sent: 1024,
        bytes_received: 2048,
        connections: 2,
      },
    ],
    row_count: 1,
    sessions: [],
    analysis: {
      findings: [],
      ready_profiles: 0,
      learning_profiles: 1,
      eligible_minutes: 1,
      limited: false,
      findings_limited: false,
    },
  };
}
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(fixture());
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    fn(0);
    return 1;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function select(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

it("guides users to opt in when no database exists", async () => {
  vi.mocked(invoke).mockResolvedValue({ ...fixture(), exists: false });
  const settings = vi.fn();
  render(<SavedHistory onCaptureSettings={settings} />);
  expect(await screen.findByText("No saved history yet")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Set up history collection" }),
  );
  expect(settings).toHaveBeenCalledOnce();
  expect(
    vi.mocked(invoke).mock.calls.every(([name]) => name === "saved_history"),
  ).toBe(true);
});

it("browses saved rows and resets pagination when filters change", async () => {
  vi.mocked(invoke).mockResolvedValue({ ...fixture(), row_count: 51 });
  render(<SavedHistory onCaptureSettings={vi.fn()} />);
  await screen.findByText("example.test");
  fireEvent.click(screen.getByText("Minute summaries and earlier history"));
  fireEvent.click(screen.getByRole("button", { name: "Next traffic" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("saved_history", {
      query: expect.objectContaining({ offset: 50 }),
    }),
  );
  await screen.findByText("example.test");
  await select("History application", "Browser");
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("saved_history", {
      query: expect.objectContaining({ app_key: "app", offset: 0 }),
    }),
  );
  await screen.findByText("example.test");
  await select("History interface", "en0");
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("saved_history", {
      query: expect.objectContaining({ interface: "en0" }),
    }),
  );
});

it("keeps the timeline primary and legacy summaries collapsed", async () => {
  render(<SavedHistory onCaptureSettings={vi.fn()} />);
  expect(await screen.findByText("Connection timeline")).toBeTruthy();
  const summary = screen.getByText("Minute summaries and earlier history");
  expect(summary.closest("details")?.open).toBe(false);
  expect(screen.queryByText("Unusual activity")).toBeNull();
});

it("ignores stale requests after filters change", async () => {
  let resolveOld!: (report: HistoryReport) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  render(<SavedHistory onCaptureSettings={vi.fn()} />);
  await select("History time range", "Last hour");
  await screen.findByText("example.test");
  await act(async () => resolveOld({ ...fixture(), exists: false }));
  expect(screen.queryByText("No saved history yet")).toBeNull();
  expect(screen.getByText("example.test")).toBeTruthy();
});

it("shows database errors and allows retry without erasing stored history", async () => {
  vi.mocked(invoke).mockRejectedValueOnce("Database busy");
  render(<SavedHistory onCaptureSettings={vi.fn()} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Database busy",
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
  await screen.findByText("example.test");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("polls only the timeline and waits for it before scheduling another refresh", async () => {
  vi.useFakeTimers();
  try {
    await act(async () => {
      render(<SavedHistory onCaptureSettings={vi.fn()} />);
    });
    const props = () => vi.mocked(ConnectionHistory).mock.calls.at(-1)![0];
    const version = props().refreshVersion!;
    const oldTo = props().toMs;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(props().refreshVersion).toBe(version + 1);
    expect(props().toMs).toBeGreaterThan(oldTo);
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      props().onRefreshingChange?.(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90000);
    });
    expect(props().refreshVersion).toBe(version + 1);
    await act(async () => {
      props().onRefreshingChange?.(false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(props().refreshVersion).toBe(version + 2);
    expect(invoke).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Auto-refresh: 30s" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(props().refreshVersion).toBe(version + 2);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});
