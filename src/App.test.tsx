// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { idle } from "./model";
import { connectionFixture, viewFixture } from "./test-fixtures";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
let view = viewFixture();
let geoipSelection: string | null = null;
let availableInterfaces = [
  { name: "lo", description: "Loopback", addresses: ["127.0.0.1"] },
];
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
    clear: () => saved.clear(),
  });
  view = viewFixture();
  geoipSelection = null;
  availableInterfaces = [
    { name: "lo", description: "Loopback", addresses: ["127.0.0.1"] },
  ];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_interfaces") return availableInterfaces;
    if (command === "capture_view") return view;
    if (command === "stop_capture") {
      view = { ...view, status: "stopped" };
      return undefined;
    }
    if (command === "start_capture") return true;
    if (command === "choose_geoip_directory") return geoipSelection;
    throw new Error(`Unexpected command ${command}`);
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function selectOption(label: string, option: string) {
  const trigger = screen.getByRole("combobox", { name: label });
  await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("desktop workflow", () => {
  it("aligns the summary, overview and applications on counter-derived rates", async () => {
    view.snapshot!.stats.capture_accounting = {
      captured: 900000,
      tracked_received: 800000,
      tracked_sent: 100000,
      attributed_received: 700000,
      attributed_sent: 50000,
    };
    const { container } = render(<App />);
    await screen.findByRole("button", { name: /Firefox.*1 connections/ });
    view = structuredClone(view);
    view.revision++;
    view.snapshot!.timestamp = "2026-09-27T12:00:04Z";
    view.snapshot!.connections[0].traffic.bytes_received += 2000;
    view.snapshot!.connections[1].traffic.bytes_received += 1000;
    const header = () =>
      container.querySelector(".summary .metric strong")!.textContent;
    const detail = () =>
      container.querySelector(".app-metrics .metric strong")!.textContent;
    await waitFor(() => expect(header()).toBe("1.5 kB/s"));
    expect(detail()).toBe(header());
    fireEvent.click(screen.getByRole("button", { name: /Firefox.*1 kB\/s/ }));
    await waitFor(() => expect(detail()).toBe("1 kB/s"));
    fireEvent.click(screen.getByRole("button", { name: /All traffic/ }));
    expect(detail()).toBe(header());
    fireEvent.click(screen.getByRole("button", { name: "Freeze view" }));
    view = structuredClone(view);
    view.revision++;
    view.snapshot!.timestamp = "2026-09-27T12:00:06Z";
    expect(header()).toBe("1.5 kB/s");
    expect(detail()).toBe(header());
    fireEvent.click(screen.getByRole("button", { name: "Resume view" }));
    await waitFor(() => expect(header()).toBe("0 B/s"));
    expect(detail()).toBe(header());
  });
  it("recovers from a malformed snapshot without retaining the bridge error or losing the last good view", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /Firefox.*1 connections/ });
    const valid = structuredClone(view);
    view = structuredClone(view);
    view.revision++;
    view.snapshot!.connections.push(view.snapshot!.connections[0]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Duplicate connection identity");
    expect(alert.textContent).toContain("last valid snapshot");
    expect(alert.textContent).not.toContain("configure capture capabilities");
    expect(
      screen.getByRole("button", { name: /Firefox.*1 connections/ }),
    ).toBeTruthy();
    view = valid;
    view.revision += 2;
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("starts on All traffic, keeps session coverage across app selection and freezes the overview", async () => {
    view.snapshot!.stats.capture_accounting = {
      captured: 1000,
      tracked_received: 500,
      tracked_sent: 200,
      attributed_received: 300,
      attributed_sent: 100,
    };
    render(<App />);
    await screen.findByRole("heading", { name: "All traffic" });
    await screen.findByRole("region", { name: "Capture coverage" });
    expect(screen.getByText("40.0%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show raw peaks" }));
    expect(screen.getByText(/Raw interval rates/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Show smoothed rates" }),
    );
    expect(screen.getByText(/2-second moving average/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Show breakdown graph" }),
    );
    expect(
      screen.getByRole("img", { name: /Capture and attribution rates/ }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Firefox.*1 connections/ }),
    );
    await screen.findByRole("heading", { name: "Firefox" });
    fireEvent.click(
      screen.getByRole("button", { name: /All trafficCapture coverage/ }),
    );
    expect(screen.getByText("40.0%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Freeze view" }));
    view = structuredClone(view);
    view.revision++;
    view.snapshot!.timestamp = "2026-09-27T12:00:03Z";
    view.snapshot!.stats.capture_accounting!.captured = 2000;
    fireEvent.click(screen.getByRole("button", { name: "Resume view" }));
    await screen.findByText("20.0%");
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    expect(screen.queryByText("Traffic overview · last 60 seconds")).toBeNull();
  });
  it("double-clicks an application into an exact removable connection filter with navigation history", async () => {
    const process = connectionFixture().process!;
    view.snapshot!.connections = [
      connectionFixture({ id: "firefox" }),
      connectionFixture({
        id: "other",
        process: { ...process, name: "Firefox Helper", pid: 99 },
      }),
      connectionFixture({ id: "history", historic: true }),
    ];
    const { container } = render(<App />);
    const app = await screen.findByRole("button", {
      name: /^Firefox1 connections/,
    });
    fireEvent.click(app);
    expect(
      screen.getByRole("heading", { name: "Applications", level: 1 }),
    ).toBeTruthy();
    fireEvent.doubleClick(app);
    expect(
      screen.getByRole("heading", { name: "Connections", level: 1 }),
    ).toBeTruthy();
    expect(container.querySelectorAll("tr[data-connection-id]")).toHaveLength(
      1,
    );
    expect(
      container.querySelector("tr[data-connection-id=firefox]"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Show historic connections" }),
    );
    expect(container.querySelectorAll("tr[data-connection-id]")).toHaveLength(
      2,
    );
    fireEvent.mouseUp(window, { button: 3 });
    await screen.findByRole("heading", { name: "Applications", level: 1 });
    fireEvent.mouseUp(window, { button: 4 });
    await screen.findByRole("button", { name: "Clear application filter" });
    expect(container.querySelectorAll("tr[data-connection-id]")).toHaveLength(
      2,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clear application filter" }),
    );
    expect(container.querySelectorAll("tr[data-connection-id]")).toHaveLength(
      3,
    );
  });
  it("remembers a GeoIP folder, preserves it on cancel and applies it on restart", async () => {
    geoipSelection = "/data/GeoIP databases";
    const rendered = render(<App />);
    await screen.findByText("Live capture");
    fireEvent.click(screen.getByRole("button", { name: "Capture settings" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Choose GeoIP folder" }),
    );
    await screen.findByText(geoipSelection);
    expect(
      vi.mocked(invoke).mock.calls.some(([c]) => c === "stop_capture"),
    ).toBe(false);
    rendered.unmount();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Capture settings" }));
    await screen.findByText(geoipSelection);
    geoipSelection = null;
    fireEvent.click(
      screen.getByRole("button", { name: "Choose GeoIP folder" }),
    );
    const restart = screen.getByRole("button", {
      name: "Apply and restart capture",
    });
    await waitFor(() => expect(restart.hasAttribute("disabled")).toBe(false));
    expect(screen.getByText("/data/GeoIP databases")).toBeTruthy();
    fireEvent.click(restart);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_capture", {
        interface: "",
        record: false,
        geoipDirectory: "/data/GeoIP databases",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Capture settings" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Use automatic discovery" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Start capture" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_capture", {
        interface: "",
        record: false,
        geoipDirectory: null,
      }),
    );
  });
  it("keeps one selected app while executable paths arrive", async () => {
    const base = connectionFixture();
    view.snapshot!.connections = [
      connectionFixture({ process: { ...base.process!, executable: null } }),
    ];
    render(<App />);
    const row = await screen.findByRole("button", {
      name: /Firefox.*1 connections/,
    });
    fireEvent.click(row);
    view = structuredClone(view);
    view.revision++;
    view.snapshot!.connections.push(
      connectionFixture({
        id: "enriched",
        process: { ...base.process!, pid: 43 },
      }),
    );
    const combined = await screen.findByRole("button", {
      name: /Firefox.*2 connections.*2 PIDs/,
    });
    expect(combined.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getAllByRole("button", { name: /Firefox.*connections/ }),
    ).toHaveLength(1);
    expect(screen.getByText("/usr/bin/firefox")).toBeTruthy();
    expect(screen.queryByText("No active connections")).toBeNull();
  });
  it("tracks live to idle to historic without losing the inspected identity", async () => {
    const { container } = render(<App />);
    await screen.findByRole("button", { name: /Firefox.*1 connections/ });
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Inspect Firefox connection to example.org",
      }),
    );
    view = structuredClone(view);
    view.revision++;
    const c = view.snapshot!.connections[0];
    c.lifecycle = { timeout_ms: 30000, remaining_ms: 7500 };
    c.traffic.incoming_bytes_per_second = 0;
    c.traffic.outgoing_bytes_per_second = 0;
    await waitFor(() =>
      expect(container.querySelector("tr.stale-connection")).toBeTruthy(),
    );
    expect(
      screen.getByRole("complementary", { name: "Connection inspector" })
        .textContent,
    ).toContain("8s to history");
    view = structuredClone(view);
    view.revision++;
    view.snapshot!.connections[0].historic = true;
    view.snapshot!.connections[0].lifecycle = null;
    view.snapshot!.connections[0].closed_at = "2026-09-27T12:00:04Z";
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "Inspect Firefox connection to example.org",
        }),
      ).toBeNull(),
    );
    expect(screen.getByRole("heading", { name: "example.org" })).toBeTruthy();
    const toggle = screen.getByRole("button", {
      name: "Show historic connections",
    });
    expect(toggle.textContent).toContain("1");
    fireEvent.keyDown(window, { key: "t" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("tr.historic")?.textContent).toContain(
      "Closed",
    );
    expect(container.querySelector("tr.stale-connection")).toBeNull();
    fireEvent.click(toggle);
    expect(container.querySelector("tr.historic")).toBeNull();
  });
  it("opens contextual help with h or the button without capturing text input", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
    render(<App />);
    await screen.findByRole("button", { name: /Firefox.*1 connections/ });
    fireEvent.keyDown(window, { key: "h" });
    expect(
      screen.getByRole("dialog", { name: "Applications help" }),
    ).toBeTruthy();
    fireEvent.keyDown(window, { key: "h" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Find connections" }),
      { key: "h" },
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Help h/ }));
    expect(
      screen.getByRole("dialog", { name: "Connections help" }).textContent,
    ).toContain("Ctrl+f");
    fireEvent.click(screen.getByRole("button", { name: "Close help" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Inspect Firefox connection to example.org",
      }),
    );
    fireEvent.keyDown(window, { key: "h" });
    expect(
      screen.getByRole("dialog", { name: "Connection inspector help" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close help" }));
    fireEvent.click(screen.getByRole("button", { name: "Capture settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Help h/ }));
    expect(
      screen.getByRole("dialog", { name: "Capture settings help" }),
    ).toBeTruthy();
  });
  it("supports TUI connection navigation without intercepting search input", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    view.snapshot!.connections = Array.from({ length: 20 }, (_, i) =>
      connectionFixture({
        id: `row-${String(i).padStart(2, "0")}`,
        hostname: `host-${i}.example.org`,
      }),
    );
    render(<App />);
    await screen.findByRole("button", { name: /Firefox.*20 connections/ });
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    fireEvent.keyDown(window, { key: "G", shiftKey: true });
    expect(
      screen.getByRole("heading", { name: "host-19.example.org" }),
    ).toBeTruthy();
    fireEvent.keyDown(window, { key: "g" });
    expect(
      screen.getByRole("heading", { name: "host-0.example.org" }),
    ).toBeTruthy();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(
      screen.queryByRole("heading", { name: "host-0.example.org" }),
    ).toBeNull();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(
      screen.getByRole("heading", { name: "host-0.example.org" }),
    ).toBeTruthy();
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Find connections" }),
      { key: "G", shiftKey: true },
    );
    expect(
      screen.getByRole("heading", { name: "host-0.example.org" }),
    ).toBeTruthy();
  });
  it("shows earlier samples when selecting an application for the first time", async () => {
    const { container } = render(<App />);
    await screen.findByRole("button", { name: /Firefox.*1 connections/ });
    view = structuredClone(view);
    view.revision++;
    view.snapshot!.timestamp = "2026-09-27T12:00:03Z";
    view.snapshot!.connections[1].traffic.bytes_received += 7000;
    await screen.findByRole("button", { name: /Unattributed.*7 kB\/s/ });
    fireEvent.click(
      screen.getByRole("button", { name: /Unattributed.*7 kB\/s/ }),
    );
    await waitFor(() => {
      const line = container.querySelector(".rx-line");
      expect(line?.getAttribute("d")).toContain("L");
    });
  });
  it("shows real snapshot data, filters connections and opens the inspector", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /Firefox.*1 connections/ });
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    const search = screen.getByRole("textbox", { name: "Find connections" });
    fireEvent.change(search, { target: { value: "Firefox" } });
    const row = screen.getByRole("button", {
      name: "Inspect Firefox connection to example.org",
    });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: "Process" }));
    expect(
      screen.getByRole("complementary", { name: "Connection inspector" })
        .textContent,
    ).toContain("/usr/bin/firefox");
    expect(
      screen.queryByRole("button", { name: /Inspect Unattributed/ }),
    ).toBeNull();
    fireEvent.change(search, { target: { value: "does-not-exist" } });
    expect(screen.getByText("No matching connections")).toBeTruthy();
  });
  it("keeps selected connection identity across sorting and live updates", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /Firefox.*1 connections/ });
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Inspect Firefox connection to example.org",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Process" }));
    view = structuredClone(view);
    view.revision++;
    view.snapshot!.connections[0].hostname = "updated.example.org";
    view.snapshot!.connections.reverse();
    await selectOption("Sort connections", "Upload ↓");
    await screen.findByRole("heading", { name: "updated.example.org" });
    await waitFor(() =>
      expect(
        screen.getByRole("complementary", { name: "Connection inspector" })
          .textContent,
      ).toContain("/usr/bin/firefox"),
    );
  });
  it("requests a clean stop and preserves the final snapshot", async () => {
    render(<App />);
    await screen.findByText("Live capture");
    expect(screen.queryByRole("button", { name: "Stop capture" })).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Capture settings" })
        .getAttribute("aria-describedby"),
    ).toBe("capture-state");
    fireEvent.click(screen.getByRole("button", { name: "Capture settings" }));
    const stop = await screen.findByRole("button", { name: "Stop capture" });
    fireEvent.click(stop);
    await screen.findByRole("button", { name: "Start capture" });
    expect(invoke).toHaveBeenCalledWith("stop_capture");
    expect(screen.getByText("Capture stopped")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Firefox.*1 connections/ }),
    ).toBeTruthy();
  });
  it("keeps recording optional and sends only structured capture options", async () => {
    view = { ...idle };
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Capture settings" }));
    await selectOption("Capture interface", "lo · Loopback");
    fireEvent.click(screen.getByRole("checkbox", { name: "Record PCAPNG" }));
    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_capture", {
        interface: "lo",
        record: true,
        geoipDirectory: null,
      }),
    );
  });
  it("renders network names as text, never HTML", async () => {
    view.snapshot!.connections[0].hostname = "<img src=x onerror=alert(1)>";
    const { container } = render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Firefox.*1 connections/ }),
    );
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
  it("shows permission failures and makes retry available", async () => {
    view = {
      ...idle,
      status: "error",
      error: "Missing CAP_NET_RAW capability",
    };
    render(<App />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("CAP_NET_RAW");
    expect(
      screen
        .getByRole("button", { name: "Start capture" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
  it("freezes displayed data while continuing to poll capture", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Firefox.*1 connections/ }),
    );
    await screen.findByRole("button", { name: /Firefox.*1 connections/ });
    fireEvent.click(screen.getByRole("button", { name: "Freeze view" }));
    const previousPolls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "capture_view").length;
    view = structuredClone(view);
    view.revision++;
    view.snapshot!.timestamp = "2026-09-27T12:00:03Z";
    view.snapshot!.connections[0].hostname = "after-freeze.example.org";
    await waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([command]) => command === "capture_view").length,
      ).toBeGreaterThan(previousPolls),
    );
    expect(screen.queryByText("after-freeze.example.org")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume view" }));
    await screen.findByText("after-freeze.example.org");
  });
  it("retains the selected application when bandwidth rankings change", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Firefox.*1 connections/ }),
    );
    await screen.findByRole("heading", { name: "Firefox" });
    view = structuredClone(view);
    view.revision++;
    view.snapshot!.timestamp = "2026-09-27T12:00:04Z";
    view.snapshot!.connections[1].traffic.bytes_received += 200000;
    await screen.findByRole("button", { name: /Unattributed.*100 kB\/s/ });
    expect(screen.getByRole("heading", { name: "Firefox" })).toBeTruthy();
  });
  it("defaults to any when offered, but preserves an explicitly saved automatic choice", async () => {
    view = { ...idle };
    availableInterfaces.push({
      name: "any",
      description: "All devices",
      addresses: [],
    });
    const first = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Capture settings" }));
    const picker = screen.getByRole("combobox", { name: "Capture interface" });
    await waitFor(() =>
      expect(picker.textContent).toContain("All interfaces (any)"),
    );
    await selectOption("Capture interface", "Automatic (one interface)");
    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await waitFor(() =>
      expect(localStorage.getItem("rustnet.interface")).toBe(""),
    );
    first.unmount();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Capture settings" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("combobox", { name: "Capture interface" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(
      screen.getByRole("combobox", { name: "Capture interface" }).textContent,
    ).toContain("Automatic (one interface)");
  });
  it("does not silently replace an unavailable saved interface", async () => {
    view = { ...idle };
    localStorage.setItem("rustnet.interface", "wlan-missing");
    render(<App />);
    await screen.findByText(/Saved interface wlan-missing is unavailable/);
    expect(
      screen
        .getByRole("button", { name: "Start capture" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Capture settings" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("combobox", { name: "Capture interface" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("combobox", { name: "Capture interface" }),
    );
    await screen.findByRole("option", { name: "lo · Loopback" });
    expect(
      screen.queryByRole("option", { name: "All interfaces (any)" }),
    ).toBeNull();
  });
  it("changes a live source only after an explicit restart and clean stop", async () => {
    availableInterfaces.push({
      name: "any",
      description: "All devices",
      addresses: [],
    });
    render(<App />);
    await screen.findByText("Live capture");
    fireEvent.click(screen.getByRole("button", { name: "Capture settings" }));
    await selectOption("Capture interface", "All interfaces (any)");
    expect(
      vi.mocked(invoke).mock.calls.some(([c]) => c === "stop_capture"),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Apply and restart capture" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_capture", {
        interface: "any",
        record: false,
        geoipDirectory: null,
      }),
    );
    const commands = vi.mocked(invoke).mock.calls.map(([c]) => c);
    expect(commands.indexOf("stop_capture")).toBeLessThan(
      commands.indexOf("start_capture"),
    );
  });
  it("does not restart after an unclean shutdown", async () => {
    view.error = "Recording flush failed";
    render(<App />);
    await screen.findByText("Live capture");
    fireEvent.click(screen.getByRole("button", { name: "Capture settings" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("combobox", { name: "Capture interface" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Apply and restart capture" }),
    );
    await screen.findByRole("button", { name: "Start capture" });
    expect(
      vi.mocked(invoke).mock.calls.some(([c]) => c === "start_capture"),
    ).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain(
      "Recording flush failed",
    );
  });
  it("expands, resizes with the keyboard, and closes the inspector without losing list filters", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /Firefox.*1 connections/ });
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    const search = screen.getByRole("textbox", { name: "Find connections" });
    fireEvent.change(search, { target: { value: "Firefox" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Inspect Firefox connection to example.org",
      }),
    );
    expect(screen.getByText("Remote endpoint")).toBeTruthy();
    const resize = screen.getByRole("separator", {
      name: "Resize connection inspector",
    });
    Object.defineProperty(resize.parentElement, "clientWidth", {
      configurable: true,
      value: 1100,
    });
    fireEvent.keyDown(resize, { key: "ArrowLeft" });
    expect(localStorage.getItem("rustnet.inspector-width")).toBe("460");
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByRole("button", { name: "Back to list" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Protocol" }));
    expect(screen.getByText("Name evidence")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("complementary", { name: "Connection inspector" }),
    ).toBeNull();
    expect((search as HTMLInputElement).value).toBe("Firefox");
  });
  it("keeps both lists alphabetical as rates change, then sorts by download on request", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /Firefox.*1 connections/ });
    const applicationRows = () =>
      screen
        .getAllByRole("button", { name: /1 connections/ })
        .map((e) => e.textContent);
    view = structuredClone(view);
    view.revision++;
    view.snapshot!.timestamp = "2026-09-27T12:00:04Z";
    view.snapshot!.connections[1].traffic.bytes_received += 200000;
    await screen.findByRole("button", { name: /Unattributed.*100 kB\/s/ });
    expect(applicationRows()[0]).toContain("Firefox");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Sort applications by download rate",
      }),
    );
    expect(applicationRows()[0]).toContain("Unattributed");
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    const connectionRows = () =>
      screen
        .getAllByRole("button", { name: /^Inspect / })
        .map((e) => e.textContent);
    expect(connectionRows()[0]).toBe("Firefox");
    view = structuredClone(view);
    view.revision++;
    view.snapshot!.timestamp = "2026-09-27T12:00:06Z";
    view.snapshot!.connections[1].traffic.bytes_received += 400000;
    await screen.findAllByText("200 kB/s");
    expect(connectionRows()[0]).toBe("Firefox");
    fireEvent.click(
      screen.getByRole("button", { name: "Sort by download rate" }),
    );
    expect(connectionRows()[0]).toBe("Unattributed");
    expect(
      screen
        .getByRole("button", { name: "Sort by download rate" })
        .closest("th")
        ?.getAttribute("aria-sort"),
    ).toBe("descending");
    expect(
      screen.getByRole("combobox", { name: "Sort connections" }).textContent,
    ).toContain("Download ↓");
  });
  it("shows all connections without pagination and opens details from any row cell", async () => {
    view.snapshot!.connections = Array.from({ length: 94 }, (_, i) =>
      connectionFixture({ id: `row-${i}`, hostname: `host-${i}.example.org` }),
    );
    render(<App />);
    await screen.findByRole("button", { name: /Firefox.*94 connections/ });
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    expect(screen.getAllByRole("button", { name: /^Inspect / })).toHaveLength(
      94,
    );
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    fireEvent.click(screen.getByRole("cell", { name: /host-93.example.org/ }));
    expect(
      screen.getByRole("heading", { name: "host-93.example.org" }),
    ).toBeTruthy();
    fireEvent.doubleClick(
      screen.getByRole("cell", { name: /host-93.example.org/ }),
    );
    expect(screen.getByRole("button", { name: "Back to list" })).toBeTruthy();
  });
  it("opens expanded details directly by double-clicking an application destination", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Firefox.*1 connections/ }),
    );
    const destination = await screen.findByRole("button", {
      name: /example.org.*HTTPS/,
    });
    fireEvent.doubleClick(destination);
    expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "example.org" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to list" })).toBeTruthy();
  });
});
