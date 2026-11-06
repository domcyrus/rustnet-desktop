// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ConnectionHistory, type SeriesReport } from "./ConnectionHistory";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));
const from = 1_800_000_000_000,
  to = from + 60_000;
function fixture(): SeriesReport {
  return {
    application_count: 1,
    applications: [
      {
        key: "app",
        name: "Browser",
        executable: "/browser",
        connections: 1,
        bytes_sent: 100,
        bytes_received: 200,
      },
    ],
    analysis: {
      findings: [],
      ready_profiles: 0,
      learning_profiles: 1,
      eligible_intervals: 1,
      limited: false,
      findings_limited: false,
    },
    available: true,
    from_ms: from,
    to_ms: to,
    resolution_ms: 10000,
    bytes_sent: 100,
    bytes_received: 200,
    uncertain_samples: 1,
    points: [
      {
        timestamp_ms: from,
        bytes_sent: 100,
        bytes_received: 200,
        samples: 2,
        uncertain_samples: 0,
        observed_ms: 10000,
        incomplete: false,
        active_connections: 1,
        counter_resets: 0,
        findings: 0,
      },
      {
        timestamp_ms: from + 10000,
        bytes_sent: 0,
        bytes_received: 0,
        samples: 0,
        uncertain_samples: 0,
        observed_ms: 0,
        incomplete: true,
        active_connections: 0,
        counter_resets: 0,
        findings: 0,
      },
    ],
    connections: [
      {
        id: 7,
        name: "Browser",
        executable: "/browser",
        pid: 12,
        local_ip: "192.0.2.1",
        local_port: 42000,
        remote_ip: "203.0.113.1",
        remote_port: 443,
        hostname: "example.test",
        protocol: "TCP",
        interface: "en0",
        first_seen_ms: from,
        last_seen_ms: to - 1,
        ended_ms: null,
        end_reason: null,
        bytes_sent: 100,
        bytes_received: 200,
        uncertain_samples: 1,
      },
    ],
    connection_count: 1,
    sample_count: 2,
    samples: [],
  };
}
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(fixture());
  vi.mocked(isTauri).mockReturnValue(false);
});
afterEach(cleanup);
const show = () =>
  render(<ConnectionHistory fromMs={from} toMs={to} app="app" iface="en0" />);
it("zooms into an interval and restores the wider range without turning gaps into traffic", async () => {
  show();
  const chart = await screen.findByRole("img", {
    name: /^Traffic rate timeline/,
  });
  fireEvent.keyDown(chart, { key: "End" });
  expect(chart.getAttribute("aria-label")).toContain("No capture coverage");
  expect(
    screen
      .getByLabelText("Selected history interval")
      .textContent?.match(/Unknown/g),
  ).toHaveLength(4);
  expect(document.querySelectorAll(".history-crosshair")).toHaveLength(3);
  fireEvent.keyDown(chart, { key: "Home" });
  fireEvent.keyDown(chart, { key: "Enter" });
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("connection_history", {
      query: {
        from_ms: from,
        to_ms: from + 10000,
        app_key: "app",
        interface: "en0",
        offset: 0,
      },
      connectionId: null,
      cursor: null,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("connection_history", {
      query: {
        from_ms: from,
        to_ms: to,
        app_key: "app",
        interface: "en0",
        offset: 0,
      },
      connectionId: null,
      cursor: null,
    }),
  );
});
it("opens cumulative samples for one connection with unknown deltas marked unavailable", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Connections" }));
  const connection = await screen.findByRole("button", {
    name: "Browser · #7",
  });
  const detail = fixture();
  detail.samples = [
    {
      timestamp_ms: from,
      interval_start_ms: null,
      bytes_sent: 100,
      bytes_received: 200,
      packets_sent: 2,
      packets_received: 4,
      delta_sent: null,
      delta_received: null,
      kind: "gap",
    },
  ];
  vi.mocked(invoke).mockResolvedValue(detail);
  fireEvent.click(connection);
  expect(
    await screen.findByText("Counter samples for connection #7"),
  ).toBeTruthy();
  expect(screen.getByText("Unavailable / Unavailable")).toBeTruthy();
  expect(invoke).toHaveBeenLastCalledWith(
    "connection_history",
    expect.objectContaining({ connectionId: 7 }),
  );
  fireEvent.click(screen.getByRole("button", { name: "All connections" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith(
      "connection_history",
      expect.objectContaining({ connectionId: null }),
    ),
  );
});
it("paginates connections and samples independently and resets on selection", async () => {
  vi.mocked(invoke).mockResolvedValue({ ...fixture(), connection_count: 51 });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Connections" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Next connections" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith(
      "connection_history",
      expect.objectContaining({
        query: expect.objectContaining({ offset: 50 }),
      }),
    ),
  );
  await screen.findByText("51–51 of 51");
  vi.mocked(invoke).mockResolvedValue({ ...fixture(), sample_count: 201 });
  fireEvent.click(screen.getByRole("button", { name: "Browser · #7" }));
  fireEvent.click(await screen.findByRole("button", { name: "Next samples" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith(
      "connection_history",
      expect.objectContaining({
        connectionId: 7,
        cursor: null,
        query: expect.objectContaining({ offset: 200 }),
      }),
    ),
  );
});
it("explains legacy history and allows retry after a database error", async () => {
  vi.mocked(invoke).mockRejectedValueOnce("database busy");
  show();
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("database busy"),
  );
  vi.mocked(invoke).mockResolvedValue({ ...fixture(), available: false });
  fireEvent.click(screen.getByRole("button", { name: "Refresh timeline" }));
  expect(
    await screen.findByText(/Earlier history contains minute summaries only/),
  ).toBeTruthy();
});
it("discards a response for an earlier time range", async () => {
  let resolve!: (r: SeriesReport) => void;
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise<SeriesReport>((done) => {
      resolve = done;
    }),
  );
  const view = show();
  view.rerender(
    <ConnectionHistory fromMs={from + 10000} toMs={to} app="app" iface="en0" />,
  );
  await screen.findByRole("button", { name: "Browser, 1 connections" });
  await act(async () => resolve({ ...fixture(), available: false }));
  expect(
    screen.queryByText(/Earlier history contains minute summaries only/),
  ).toBeNull();
});

it("starts with applications and drills into their connections without losing the time range", async () => {
  show();
  const application = await screen.findByRole("button", {
    name: "Browser, 1 connections",
  });
  expect(screen.queryByRole("button", { name: "Browser · #7" })).toBeNull();
  fireEvent.click(application);
  await screen.findByRole("button", { name: "Browser · #7" });
  expect(invoke).toHaveBeenLastCalledWith(
    "connection_history",
    expect.objectContaining({
      query: expect.objectContaining({
        from_ms: from,
        to_ms: to,
        app_key: "app",
        offset: 0,
      }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "All applications" }));
  expect(
    await screen.findByRole("button", { name: "Browser, 1 connections" }),
  ).toBeTruthy();
});

it("shows anomaly evidence from a timeline marker and inspects the exact ten-second app interval", async () => {
  const report = fixture();
  report.points[0].findings = 1;
  report.analysis.ready_profiles = 1;
  report.analysis.findings = [
    {
      kind: "upload",
      app_key: "other",
      name: "Uploader",
      interface: "en1",
      timestamp_ms: from,
      observed: 4 * 1024 * 1024,
      baseline: 1024,
      threshold: 2 * 1024 * 1024,
      prior_intervals: 180,
      destination: null,
    },
  ];
  vi.mocked(invoke).mockResolvedValue(report);
  show();
  fireEvent.click(
    await screen.findByRole("button", {
      name: /1 unusual activity findings at/,
    }),
  );
  expect(await screen.findByText("Unusual upload")).toBeTruthy();
  expect(screen.getByText(/Based on 180 earlier intervals/)).toBeTruthy();
  expect(screen.getByText("Unusual activity").closest("details")?.open).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Inspect traffic" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("connection_history", {
      query: {
        from_ms: from,
        to_ms: from + 10000,
        app_key: "other",
        interface: "en1",
        offset: 0,
      },
      connectionId: null,
      cursor: null,
    }),
  );
  expect(await screen.findByText(/Inspecting Uploader on en1/)).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "Capture health panel" }),
  ).toBeTruthy();
  expect(screen.getByText(/not application error counts/)).toBeTruthy();
});

it("keeps graphs, inspection time and legend choices mounted during rolling refreshes and failures", async () => {
  const view = show();
  const chart = await screen.findByRole("img", {
    name: /^Traffic rate timeline/,
  });
  fireEvent.keyDown(chart, { key: "End" });
  const inspected = screen.getByLabelText(
    "Selected history interval",
  ).textContent;
  fireEvent.click(
    screen.getByRole("button", { name: "Toggle download series" }),
  );
  fireEvent.click(screen.getByText("Unusual activity"));
  let resolve!: (data: SeriesReport) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  view.rerender(
    <ConnectionHistory
      fromMs={from + 10000}
      toMs={to + 10000}
      app="app"
      iface="en0"
    />,
  );
  expect(screen.getByRole("img", { name: /^Traffic rate timeline/ })).toBe(
    chart,
  );
  expect(screen.queryByText("Loading connection samples…")).toBeNull();
  expect(screen.getByText("Refreshing saved activity…")).toBeTruthy();
  const next = fixture();
  next.from_ms += 10000;
  next.to_ms += 10000;
  next.points = [
    next.points[1],
    { ...next.points[0], timestamp_ms: from + 20000 },
  ];
  await act(async () => resolve(next));
  expect(screen.getByRole("img", { name: /^Traffic rate timeline/ })).toBe(
    chart,
  );
  expect(screen.getByLabelText("Selected history interval").textContent).toBe(
    inspected,
  );
  expect(
    screen
      .getByRole("button", { name: "Toggle download series" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  expect(screen.getByText("Unusual activity").closest("details")?.open).toBe(
    true,
  );
  vi.mocked(invoke).mockRejectedValueOnce("Database busy");
  view.rerender(
    <ConnectionHistory
      fromMs={from + 20000}
      toMs={to + 20000}
      app="app"
      iface="en0"
    />,
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Database busy",
  );
  expect(screen.getByRole("img", { name: /^Traffic rate timeline/ })).toBe(
    chart,
  );
});

it("refreshes a fixed or zoomed range without resetting its selection", async () => {
  const view = show();
  const chart = await screen.findByRole("img", {
    name: /^Traffic rate timeline/,
  });
  fireEvent.keyDown(chart, { key: "Home" });
  fireEvent.keyDown(chart, { key: "Enter" });
  await screen.findByRole("button", { name: "Zoom out" });
  await waitFor(() =>
    expect(screen.queryByText("Loading connection samples…")).toBeNull(),
  );
  const calls = vi.mocked(invoke).mock.calls.length;
  view.rerender(
    <ConnectionHistory
      fromMs={from}
      toMs={to}
      app="app"
      iface="en0"
      refreshVersion={1}
    />,
  );
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(calls + 1));
  expect(invoke).toHaveBeenLastCalledWith("connection_history", {
    query: expect.objectContaining({ from_ms: from, to_ms: from + 10000 }),
    connectionId: null,
    cursor: null,
  });
  expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy();
});

it("returns the last successful cursor on refresh and retains it after an error", async () => {
  const report = {
    ...fixture(),
    refresh: { cursor: 42, incremental: false, samples_read: 2 },
  };
  vi.mocked(invoke).mockResolvedValueOnce(report);
  show();
  await screen.findByRole("img", { name: /^Traffic rate timeline/ });
  vi.mocked(invoke).mockRejectedValueOnce("Database busy");
  fireEvent.click(screen.getByRole("button", { name: "Refresh timeline" }));
  await screen.findByRole("alert");
  expect(invoke).toHaveBeenLastCalledWith(
    "connection_history",
    expect.objectContaining({ cursor: 42 }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh timeline" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(invoke).toHaveBeenLastCalledWith(
    "connection_history",
    expect.objectContaining({ cursor: 42 }),
  );
});

it("shares retained icons between saved application and connection rows", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const png = "data:image/png;base64,iVBORw0KGgo=";
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "application_icon" ? png : fixture(),
  );
  show();
  const app = await screen.findByRole("button", {
    name: "Browser, 1 connections",
  });
  await waitFor(() =>
    expect(app.querySelector("img")?.getAttribute("src")).toBe(png),
  );
  expect(invoke).toHaveBeenCalledWith("application_icon", {
    executable: "/browser",
    name: "Browser",
    pids: [],
    historical: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Connections" }));
  const connection = await screen.findByRole("button", {
    name: "Browser · #7",
  });
  await waitFor(() =>
    expect(
      connection.closest("td")?.querySelector("img")?.getAttribute("src"),
    ).toBe(png),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "application_icon"),
  ).toHaveLength(1);
});
