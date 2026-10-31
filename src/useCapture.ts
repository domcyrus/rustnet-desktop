import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { sampleDesktopRates, type DesktopRates } from "./desktop-rates";
import {
  applications,
  idle,
  parseView,
  updateApplicationHistory,
  updateCaptureHistory,
  type Application,
  type CaptureHistory,
  type CaptureView,
  type TrafficPoint,
} from "./model";

interface CaptureState {
  rates: DesktopRates;
  apps: Application[];
  history: CaptureHistory;
  appHistory: Map<string, TrafficPoint[]>;
}

function initialState(view = idle): CaptureState {
  return {
    rates: sampleDesktopRates(undefined, view),
    apps: [],
    history: { session: view.session, traffic: [], coverage: [] },
    appHistory: new Map(),
  };
}

function advance(previous: CaptureState, view: CaptureView): CaptureState {
  const rates = sampleDesktopRates(previous.rates, view);
  const state =
    view.session === previous.rates.session ? previous : initialState(view);
  const snapshot = rates.view.snapshot;
  const apps = applications(snapshot?.connections ?? []);
  if (!snapshot) return { ...state, rates, apps };
  const time = Date.parse(snapshot.timestamp);
  const smoothed = {
    time,
    rx: apps.reduce((sum, app) => sum + app.rx, 0),
    tx: apps.reduce((sum, app) => sum + app.tx, 0),
  };
  return {
    rates,
    apps,
    history:
      !apps.length && snapshot.runtime.status === "starting"
        ? state.history
        : updateCaptureHistory(
            state.history,
            view.session,
            time,
            snapshot.stats.capture_accounting,
            { smoothed, raw: rates.raw },
          ),
    appHistory: updateApplicationHistory(state.appHistory, apps, time),
  };
}

export function useCapture() {
  const [live, setLive] = useState(() => initialState());
  const [frozen, setFrozen] = useState<CaptureState | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState(0);
  const [hidden, setHidden] = useState(() => document.hidden);
  const acceptedVersion = useRef(0);
  const acceptView = useCallback((view: CaptureView) => {
    acceptedVersion.current++;
    setLive((previous) => advance(previous, view));
  }, []);
  const paused = frozen !== null && frozen.rates.session === live.rates.session;
  const suspended = paused || hidden;

  useEffect(() => {
    const visibilityChanged = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () =>
      document.removeEventListener("visibilitychange", visibilityChanged);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastRevision = "";
    let known: Omit<CaptureView, "snapshot"> | null = null;
    async function poll() {
      const version = acceptedVersion.current;
      try {
        const response = await invoke<unknown>("capture_view", {
          known,
          includeSnapshot: !suspended,
        });
        if (!cancelled && version === acceptedVersion.current) {
          setBridgeError(null);
          if (response !== null) {
            const next = parseView(response);
            const { snapshot: _snapshot, ...cursor } = next;
            known = cursor;
            if (suspended) {
              // Keep capture status current without processing connection data.
              setLive((previous) => {
                if (next.session !== previous.rates.session)
                  return initialState(next);
                return {
                  ...previous,
                  rates: {
                    ...previous.rates,
                    view: {
                      ...previous.rates.view,
                      status: next.status,
                      error: next.error,
                      export_path: next.export_path,
                    },
                  },
                };
              });
            } else {
              acceptView(next);
              const key = `${next.session}:${next.revision}`;
              if (key !== lastRevision) {
                lastRevision = key;
                setLastUpdated(Date.now());
              }
            }
          }
        } else if (!cancelled) {
          // A start/stop command supplied a newer view while this poll was pending.
          known = null;
        }
      } catch (error) {
        if (!cancelled && version === acceptedVersion.current)
          setBridgeError(`Capture bridge: ${errorText(error)}`);
      } finally {
        if (!cancelled) timer = setTimeout(poll, 500);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [acceptView, suspended]);

  return {
    view: live.rates.view,
    display: paused ? frozen : live,
    paused,
    updatesSuspended: suspended,
    togglePaused: () => setFrozen(paused ? null : live),
    acceptView,
    bridgeError,
    lastUpdated,
  };
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
