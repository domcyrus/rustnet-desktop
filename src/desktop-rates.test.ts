import { describe, expect, it } from "vitest";
import { sampleDesktopRates } from "./desktop-rates";
import { applications, received, sent, updateCaptureHistory } from "./model";
import { connectionFixture, viewFixture } from "./test-fixtures";

function snapshot(time: number, rx: number, tx = 0) {
  const view = viewFixture();
  view.snapshot!.timestamp = new Date(time).toISOString();
  view.snapshot!.connections = [
    connectionFixture({
      created_at: new Date(0).toISOString(),
      traffic: {
        bytes_received: rx,
        bytes_sent: tx,
        incoming_bytes_per_second: 999999,
        outgoing_bytes_per_second: 999999,
      },
    }),
  ];
  return view;
}
const rate = (state: ReturnType<typeof sampleDesktopRates>) =>
  received(state.view.snapshot!.connections[0]);

describe("shared desktop rates", () => {
  it("uses two-second deltas, preserves raw peaks and reaches zero without a decay tail", () => {
    let state = sampleDesktopRates(undefined, snapshot(0, 1000));
    expect(rate(state)).toBe(0);
    for (const time of [500, 1000, 1500, 2000])
      state = sampleDesktopRates(state, snapshot(time, 1000));
    state = sampleDesktopRates(state, snapshot(2500, 5000));
    expect(rate(state)).toBe(2000);
    expect(state.raw!.rx).toBe(8000);
    for (const time of [3000, 3500, 4000, 4500])
      state = sampleDesktopRates(state, snapshot(time, 5000));
    expect(rate(state)).toBe(0);
    expect(state.samples.length).toBeLessThanOrEqual(5);
  });

  it("interpolates the window boundary for irregular snapshots and ignores duplicate times", () => {
    let state = sampleDesktopRates(undefined, snapshot(0, 0));
    state = sampleDesktopRates(state, snapshot(1500, 1500));
    state = sampleDesktopRates(state, snapshot(3000, 6000));
    expect(rate(state)).toBe(2500);
    const duplicate = sampleDesktopRates(state, snapshot(3000, 6000));
    expect(rate(duplicate)).toBe(2500);
    expect(duplicate.samples).toBe(state.samples);
  });

  it("handles new flows, late discovery, resets, history and capture restarts without spikes", () => {
    let state = sampleDesktopRates(undefined, snapshot(1000, 10000));
    const next = snapshot(2000, 0);
    next.snapshot!.connections.push(
      connectionFixture({
        id: "new",
        created_at: new Date(1500).toISOString(),
        traffic: {
          bytes_received: 2000,
          bytes_sent: 0,
          incoming_bytes_per_second: 99,
          outgoing_bytes_per_second: 99,
        },
      }),
      connectionFixture({
        id: "late",
        created_at: new Date(0).toISOString(),
        traffic: {
          bytes_received: 900000,
          bytes_sent: 0,
          incoming_bytes_per_second: 99,
          outgoing_bytes_per_second: 99,
        },
      }),
    );
    state = sampleDesktopRates(state, next);
    expect(state.view.snapshot!.connections.map(received)).toEqual([
      0, 2000, 0,
    ]);
    const closed = structuredClone(next);
    closed.snapshot!.timestamp = new Date(3000).toISOString();
    closed.snapshot!.connections.forEach((c) => (c.historic = true));
    state = sampleDesktopRates(state, closed);
    expect(state.view.snapshot!.connections.map(received)).toEqual([0, 0, 0]);
    next.session++;
    expect(
      sampleDesktopRates(state, next).view.snapshot!.connections.map(received),
    ).toEqual([0, 0, 0]);
  });

  it("measures new bytes after late discovery without counting older bytes", () => {
    let state = sampleDesktopRates(undefined, snapshot(0, 0));
    const discovered = snapshot(1000, 0);
    const late = connectionFixture({
      id: "late",
      created_at: new Date(-1000).toISOString(),
    });
    discovered.snapshot!.connections.push(late);
    state = sampleDesktopRates(state, discovered);
    const next = structuredClone(discovered);
    next.snapshot!.timestamp = new Date(2000).toISOString();
    next.snapshot!.connections[1].traffic.bytes_received += 2000;
    state = sampleDesktopRates(state, next);
    expect(received(state.view.snapshot!.connections[1])).toBe(1000);
    expect(state.raw!.rx).toBe(2000);
    const older = sampleDesktopRates(state, discovered);
    expect(older.view.snapshot!.timestamp).toBe(next.snapshot!.timestamp);
    expect(received(older.view.snapshot!.connections[1])).toBe(1000);
  });

  it("keeps application sums, summary and overall history equal while attribution changes", () => {
    const initial = snapshot(0, 1000, 500);
    initial.snapshot!.connections.push(
      connectionFixture({ id: "unknown", process: null }),
    );
    let state = sampleDesktopRates(undefined, initial);
    const next = structuredClone(initial);
    next.snapshot!.timestamp = new Date(2000).toISOString();
    next.snapshot!.connections[0].traffic.bytes_received += 6000;
    next.snapshot!.connections[0].traffic.bytes_sent += 2000;
    next.snapshot!.connections[1].traffic.bytes_received += 4000;
    next.snapshot!.connections[1].process =
      initial.snapshot!.connections[0].process;
    state = sampleDesktopRates(state, next);
    const connections = state.view.snapshot!.connections;
    const apps = applications(connections);
    const rx = connections.reduce((sum, c) => sum + received(c), 0);
    const tx = connections.reduce((sum, c) => sum + sent(c), 0);
    expect(apps).toHaveLength(1);
    expect(apps[0].rx).toBe(rx);
    expect(rx).toBe(5000);
    expect(tx).toBe(1000);
    const history = updateCaptureHistory(
      { session: 0, traffic: [], coverage: [] },
      1,
      2000,
      {
        captured: 999999,
        tracked_received: 999999,
        tracked_sent: 0,
        attributed_received: 0,
        attributed_sent: 0,
      },
      { smoothed: { time: 2000, rx, tx }, raw: state.raw },
    );
    expect(history.traffic.at(-1)).toEqual({ time: 2000, rx, tx });
  });
});
