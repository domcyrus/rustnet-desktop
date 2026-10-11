import { describe, expect, it } from "vitest";
import {
  applications,
  captureBreakdown,
  updateCaptureHistory,
  validCaptureAccounting,
  appendPoint,
  connectionsForView,
  connectionsForApplication,
  endpoint,
  parseView,
  received,
  connectionLifecycle,
  updateApplicationHistory,
} from "./model";
import { connectionFixture, viewFixture } from "./test-fixtures";

describe("headless snapshot contract", () => {
  it("scopes application connections using the same identity, including history", () => {
    const process = connectionFixture().process!;
    const connections = [
      connectionFixture({
        id: "one",
        process: { ...process, executable: "/one/firefox" },
      }),
      connectionFixture({
        id: "two",
        process: { ...process, executable: "/two/firefox", pid: 99 },
      }),
      connectionFixture({
        id: "history",
        historic: true,
        process: { ...process, executable: "/one/firefox" },
      }),
      connectionFixture({ id: "unknown", process: null }),
    ];
    const app = applications(connections).find(
      (a) => a.executable === "/one/firefox",
    )!;
    expect(
      connectionsForApplication(connections, app.key).map((c) => c.id),
    ).toEqual(["one", "history"]);
    const unknown = applications(connections).find(
      (a) => a.name === "Unattributed",
    )!;
    expect(
      connectionsForApplication(connections, unknown.key).map((c) => c.id),
    ).toEqual(["unknown"]);
    expect(connectionsForApplication(connections, null)).toBe(connections);
  });
  it("accepts version 1 snapshots and rejects incompatible or malformed records", () => {
    expect(parseView(viewFixture()).snapshot?.connections).toHaveLength(2);
    const invalid = viewFixture();
    invalid.snapshot!.schema_version = 2;
    expect(() => parseView(invalid)).toThrow("Unsupported");
    const missingRuntime = {
      ...viewFixture(),
      snapshot: { schema_version: 1, connections: [] },
    };
    expect(() => parseView(missingRuntime)).toThrow();
    const duplicate = viewFixture();
    duplicate.snapshot!.connections = [
      connectionFixture(),
      connectionFixture(),
    ];
    expect(() => parseView(duplicate)).toThrow("Duplicate connection identity");
  });
  it("rejects invalid traffic instead of rendering NaN", () => {
    const invalid = viewFixture();
    invalid.snapshot!.connections[0].traffic.bytes_sent = NaN;
    expect(() => parseView(invalid)).toThrow();
  });
});
describe("application and connection views", () => {
  it("groups instances of one executable but separates matching names at different paths", () => {
    const base = connectionFixture();
    const rows = [
      base,
      connectionFixture({
        id: "second",
        process: { ...base.process!, pid: 43 },
      }),
      connectionFixture({
        id: "other-path",
        process: { ...base.process!, executable: "/tmp/firefox" },
      }),
      connectionFixture({ id: "unknown", process: null }),
    ];
    const groups = applications(rows);
    expect(groups).toHaveLength(3);
    expect(groups[0].pids).toEqual([42, 43]);
    expect(groups[0].rx).toBe(5000);
    expect(groups.some((g) => g.name === "Unattributed")).toBe(true);
  });
  it("merges missing and known paths across PIDs, including retained totals", () => {
    const base = connectionFixture();
    const missing = connectionFixture({
      id: "missing",
      process: { ...base.process!, executable: null },
    });
    const otherPid = connectionFixture({
      id: "other-pid",
      process: { ...base.process!, pid: 43 },
    });
    const closed = connectionFixture({
      ...missing,
      id: "closed",
      historic: true,
    });
    for (const rows of [
      [missing, otherPid, closed],
      [closed, otherPid, missing],
    ]) {
      const groups = applications(rows);
      expect(groups).toHaveLength(1);
      expect(groups[0].connections).toHaveLength(2);
      expect(groups[0].pids.sort()).toEqual([42, 43]);
      expect(groups[0].rx).toBe(5000);
      expect(groups[0].downloaded).toBe(12000);
      expect(groups[0].executable).toBe("/usr/bin/firefox");
    }
  });
  it("keeps group identity and graph samples when executable metadata arrives or disappears", () => {
    const known = connectionFixture();
    const missing = connectionFixture({
      process: { ...known.process!, executable: null },
    });
    const key = applications([missing])[0].key;
    expect(applications([known])[0].key).toBe(key);
    let history = updateApplicationHistory(
      new Map(),
      applications([missing]),
      1000,
    );
    history = updateApplicationHistory(history, applications([known]), 2000);
    history = updateApplicationHistory(history, applications([missing]), 3000);
    expect(history.size).toBe(1);
    expect(history.get(key)?.map((p) => p.time)).toEqual([1000, 2000, 3000]);
  });
  it("resolves missing paths by live PID when names collide, without guessing unknown owners", () => {
    const base = connectionFixture();
    const missing = connectionFixture({
      id: "missing",
      process: { ...base.process!, executable: null },
    });
    const unrelated = connectionFixture({
      id: "different",
      process: { ...base.process!, pid: 99, executable: "/tmp/firefox" },
    });
    const unresolved = connectionFixture({
      id: "unresolved",
      process: { ...missing.process!, pid: 100 },
    });
    const archived = connectionFixture({
      ...missing,
      id: "archived",
      historic: true,
    });
    const groups = applications([
      missing,
      unrelated,
      unresolved,
      base,
      archived,
    ]);
    expect(groups).toHaveLength(3);
    expect(
      groups
        .find((g) => g.executable === base.process!.executable)
        ?.connections.map((c) => c.id)
        .sort(),
    ).toEqual([base.id, missing.id].sort());
    expect(groups.find((g) => g.executable === "/tmp/firefox")?.pids).toEqual([
      99,
    ]);
    expect(
      groups.find((g) => g.executable === null)?.connections.map((c) => c.id),
    ).toEqual([unresolved.id]);
    // An archived record may refer to an earlier owner of a reused PID.
    expect(groups.find((g) => g.executable === null)?.downloaded).toBe(8000);
  });
  it("keeps unnamed PIDs separate from unattributed traffic", () => {
    const rows = [42, 43].map((pid) =>
      connectionFixture({
        id: String(pid),
        process: { pid, name: null, executable: null },
      }),
    );
    expect(
      applications([...rows, connectionFixture({ process: null })]),
    ).toHaveLength(3);
  });
  it("does not count stale rates from closed connections", () => {
    const closed = connectionFixture({ historic: true });
    expect(received(closed)).toBe(0);
    expect(applications([closed])).toEqual([]);
    expect(connectionsForView([closed], "", "all", false, "download")).toEqual(
      [],
    );
    expect(
      connectionsForView([closed], "", "all", true, "download"),
    ).toHaveLength(1);
  });
  it("combines search terms and protocol filters without mutating the snapshot", () => {
    const rows = [
      connectionFixture(),
      connectionFixture({
        id: "ssh",
        application: "SSH",
        hostname: "server.local",
      }),
    ];
    expect(
      connectionsForView(rows, "firefox 443", "HTTPS", false, "download").map(
        (c) => c.id,
      ),
    ).toEqual([rows[0].id]);
    expect(
      connectionsForView(rows, "<script>", "all", false, "download"),
    ).toEqual([]);
    expect(rows[1].id).toBe("ssh");
  });
  it("counts unique active remote IPs and includes retained closed connections in byte totals", () => {
    const first = connectionFixture();
    const second = connectionFixture({
      id: "other-port",
      remote: { ...first.remote, port: 8443 },
    });
    const closed = connectionFixture({
      id: "closed",
      historic: true,
      remote: { ip: "203.0.113.2", port: 443 },
    });
    const [app] = applications([first, second, closed]);
    expect(app.hosts).toBe(1);
    expect(app.connections).toHaveLength(2);
    expect(app.downloaded).toBe(12000);
    expect(app.uploaded).toBe(300);
    expect(app.rx).toBe(5000);
    expect(app.pids).toEqual([42]);
  });
  it("formats IPv6 endpoints without ambiguous port separators", () => {
    expect(endpoint({ ip: "::1", port: 443 })).toBe("[::1]:443");
  });
});
it("bounds history and ignores repeated polls of the same snapshot", () => {
  let points = [{ time: 0, rx: 10, tx: 20 }];
  expect(appendPoint(points, { time: 0, rx: 10, tx: 20 })).toBe(points);
  for (let time = 500; time <= 90_000; time += 500)
    points = appendPoint(points, { time, rx: 10, tx: 20 });
  expect(points).toHaveLength(121);
  expect(points[0].time).toBe(30_000);
});

it("retains bounded history for every application before selection", () => {
  const rows = viewFixture().snapshot!.connections;
  const groups = applications(rows);
  const first = updateApplicationHistory(new Map(), applications(rows), 0);
  const next = updateApplicationHistory(first, applications(rows), 30_000);
  for (const app of groups) {
    expect(next.get(app.key)?.map((point) => point.time)).toEqual([0, 30_000]);
    expect(first.get(app.key)).toHaveLength(1);
  }
  const duplicate = updateApplicationHistory(next, applications(rows), 30_000);
  expect(duplicate.get(groups[0].key)).toHaveLength(2);
  const expired = updateApplicationHistory(
    next,
    applications([rows[0]]),
    90_001,
  );
  expect(expired.size).toBe(1);
  expect(expired.get(groups[0].key)?.map((point) => point.time)).toEqual([
    90_001,
  ]);
});

it("fades only idle live connections in the engine's cleanup window", () => {
  const c = connectionFixture({
    lifecycle: { timeout_ms: 30000, remaining_ms: 7500 },
  });
  expect(connectionLifecycle(c)).toBeNull();
  c.traffic.incoming_bytes_per_second = 0;
  c.traffic.outgoing_bytes_per_second = 0;
  expect(connectionLifecycle(c)).toEqual({ fade: 0.5, label: "8s to history" });
  c.lifecycle!.remaining_ms = 16000;
  expect(connectionLifecycle(c)).toBeNull();
  c.lifecycle!.remaining_ms = 0;
  expect(connectionLifecycle(c)).toEqual({ fade: 1, label: "0s to history" });
  c.historic = true;
  expect(connectionLifecycle(c)).toBeNull();
  expect(connectionLifecycle(connectionFixture())).toBeNull();
});

it("rejects invalid lifecycle timing but accepts older snapshots without it", () => {
  const view = viewFixture();
  expect(parseView(view)).toBeTruthy();
  view.snapshot!.connections[0].lifecycle = { timeout_ms: 0, remaining_ms: 0 };
  expect(() => parseView(view)).toThrow();
  view.snapshot!.connections[0].lifecycle = {
    timeout_ms: 100,
    remaining_ms: 200,
  };
  expect(() => parseView(view)).toThrow();
});

describe("capture coverage", () => {
  // Desktop traffic uses connection counters, independently of frame coverage.
  const desktopRates = (time: number) => ({
    smoothed: { time, rx: 7, tx: 3 },
    raw: { time, rx: 9, tx: 5 },
  });
  it("smooths batched counters over two seconds while retaining raw peaks and a full minute of samples", () => {
    const makeTotals = (n: number) => ({
      captured: n,
      tracked_received: n,
      tracked_sent: 0,
      attributed_received: n,
      attributed_sent: 0,
    });
    let history = updateCaptureHistory(
      { session: 0, traffic: [], coverage: [] },
      1,
      0,
      makeTotals(0),
      desktopRates(0),
    );
    for (let time = 500; time <= 2000; time += 500)
      history = updateCaptureHistory(
        history,
        1,
        time,
        makeTotals(0),
        desktopRates(time),
      );
    history = updateCaptureHistory(
      history,
      1,
      2500,
      makeTotals(1000),
      desktopRates(2500),
    );
    expect(history.coverage.at(-1)?.rx).toBe(500);
    expect(history.rawCoverage?.at(-1)?.rx).toBe(2000);
    expect(
      updateCaptureHistory(
        history,
        1,
        2510,
        makeTotals(1100),
        desktopRates(2510),
      ),
    ).toBe(history);
    history = updateCaptureHistory(
      history,
      1,
      3000,
      makeTotals(1100),
      desktopRates(3000),
    );
    expect(history.rawCoverage?.at(-1)?.rx).toBe(200);
    for (let time = 3500; time <= 65000; time += 500)
      history = updateCaptureHistory(
        history,
        1,
        time,
        makeTotals(1100),
        desktopRates(time),
      );
    expect(history.traffic).toHaveLength(121);
    expect(history.traffic[0].time).toBe(5000);
    expect(history.coverage.at(-1)?.rx).toBe(0);
    expect(history.traffic.at(-1)?.rx).toBe(7);
    expect(history.rawTraffic?.at(-1)?.rx).toBe(9);
  });
  const totals = {
    captured: 1000,
    tracked_received: 500,
    tracked_sent: 200,
    attributed_received: 300,
    attributed_sent: 100,
  };
  it("partitions comparable totals without depending on retained connections", () => {
    expect(validCaptureAccounting(totals)).toBe(true);
    expect(captureBreakdown(totals)).toEqual({
      tracked: 700,
      attributed: 400,
      unknown: 300,
      outside: 300,
    });
    expect(validCaptureAccounting({ ...totals, captured: 600 })).toBe(false);
    expect(validCaptureAccounting({ ...totals, attributed_sent: 201 })).toBe(
      false,
    );
    expect(validCaptureAccounting({ ...totals, captured: NaN })).toBe(false);
  });
  it("uses elapsed sample time and resets at a new session or counter reset", () => {
    const first = updateCaptureHistory(
      { session: 0, traffic: [], coverage: [] },
      1,
      1000,
      totals,
      desktopRates(1000),
    );
    expect(first.coverage).toEqual([]);
    const next = updateCaptureHistory(
      first,
      1,
      3000,
      {
        ...totals,
        captured: 2000,
        tracked_received: 900,
        attributed_received: 600,
      },
      desktopRates(3000),
    );
    expect(next.traffic.at(-1)).toEqual({ time: 3000, rx: 7, tx: 3 });
    expect(next.coverage[0]).toEqual({ time: 3000, rx: 500, tx: 150 });
    expect(
      updateCaptureHistory(next, 1, 3000, totals, desktopRates(3000)),
    ).toBe(next);
    expect(
      updateCaptureHistory(next, 2, 4000, totals, desktopRates(4000)).coverage,
    ).toEqual([]);
    expect(
      updateCaptureHistory(next, 1, 4000, totals, desktopRates(4000)).coverage,
    ).toEqual([]);
    expect(
      updateCaptureHistory(next, 1, 5000, undefined, desktopRates(5000))
        .coverage,
    ).toEqual([]);
  });
});
