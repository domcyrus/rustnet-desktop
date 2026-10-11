import type { CaptureView, Connection, TrafficPoint } from "./model";

type Counters = { rx: number; tx: number };
type Sample = { time: number; counters: Map<string, Counters> };
export interface DesktopRates {
  session: number;
  samples: Sample[];
  view: CaptureView;
  raw?: TrafficPoint;
}

/** Derive every desktop rate from the same snapshot interval and byte counters. */
export function sampleDesktopRates(
  previous: DesktopRates | undefined,
  view: CaptureView,
): DesktopRates {
  const snapshot = view.snapshot;
  const state = previous?.session === view.session ? previous : undefined;
  if (!snapshot) return { session: view.session, samples: [], view };
  const time = Date.parse(snapshot.timestamp);
  const last = state?.samples.at(-1);
  if (last && time < last.time) {
    return { ...state!, view: { ...view, snapshot: state!.view.snapshot } };
  }
  if (last && time === last.time) {
    const rates = new Map(
      state!.view.snapshot?.connections.map((c) => [c.id, c.traffic]),
    );
    return {
      ...state!,
      view: {
        ...view,
        snapshot: {
          ...snapshot,
          connections: snapshot.connections.map((c) => ({
            ...c,
            traffic: {
              ...c.traffic,
              incoming_bytes_per_second: c.historic
                ? 0
                : (rates.get(c.id)?.incoming_bytes_per_second ?? 0),
              outgoing_bytes_per_second: c.historic
                ? 0
                : (rates.get(c.id)?.outgoing_bytes_per_second ?? 0),
            },
          })),
        },
      },
    };
  }
  const current: Sample = {
    time,
    counters: new Map(
      snapshot.connections
        .filter((c) => !c.historic)
        .map((c) => [
          c.id,
          {
            rx: c.traffic.bytes_received,
            tx: c.traffic.bytes_sent,
          },
        ]),
    ),
  };
  const samples = [...(state?.samples ?? []), current];
  const cutoff = time - 2000;
  while (samples.length > 2 && samples[1].time <= cutoff) samples.shift();
  const oldest = samples[0];
  const start = Math.max(cutoff, oldest.time);
  const newer = samples[1];
  const fraction =
    newer && start > oldest.time
      ? (start - oldest.time) / (newer.time - oldest.time)
      : 0;
  const firstObserved = new Map<string, Counters>();
  for (const sample of samples)
    for (const [id, counters] of sample.counters)
      if (!firstObserved.has(id)) firstObserved.set(id, counters);
  // A newly observed old flow is a baseline, not a burst of all its past bytes.
  const countAt = (sample: Sample, c: Connection, key: keyof Counters) =>
    sample.counters.get(c.id)?.[key] ??
    (Date.parse(c.created_at) >= sample.time
      ? 0
      : firstObserved.get(c.id)![key]);
  const raw = { time, rx: 0, tx: 0 };
  const connections = snapshot.connections.map((c) => {
    const rates = { rx: 0, tx: 0 };
    if (!c.historic && last && time > start) {
      for (const key of ["rx", "tx"] as const) {
        const end = current.counters.get(c.id)![key];
        const baseline = countAt(oldest, c, key);
        const interpolated =
          baseline +
          fraction * ((newer ? countAt(newer, c, key) : baseline) - baseline);
        rates[key] = (Math.max(0, end - interpolated) * 1000) / (time - start);
        raw[key] +=
          (Math.max(0, end - countAt(last, c, key)) * 1000) /
          (time - last.time);
      }
    }
    return {
      ...c,
      traffic: {
        ...c.traffic,
        incoming_bytes_per_second: rates.rx,
        outgoing_bytes_per_second: rates.tx,
      },
    };
  });
  return {
    session: view.session,
    samples,
    raw,
    view: { ...view, snapshot: { ...snapshot, connections } },
  };
}
