import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Blocks,
  CircleHelp,
  History,
  Download,
  ListFilter,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import { sampleDesktopRates, type DesktopRates } from "./desktop-rates";
import { useNavigation } from "./useNavigation";
import { Select } from "./Select";
import { Inspector } from "./Inspector";
import { Help } from "./Help";
import { AllTraffic } from "./AllTraffic";
import { Chart } from "./Chart";
import {
  applications,
  updateApplicationHistory,
  updateCaptureHistory,
  type CaptureHistory,
  appendPoint,
  bytes,
  connectionsForView,
  connectionsForApplication,
  connectionLifecycle,
  destination,
  endpoint,
  idle,
  nameEvidence,
  parseView,
  processName,
  received,
  sent,
  type Application,
  type CaptureInterface,
  type CaptureView,
  type Sort,
  type TrafficPoint,
} from "./model";

const PAGE_SIZE = 75;
type Theme = "system" | "light" | "dark";
function preference(key: string, fallback: string) {
  try {
    return localStorage.getItem(`rustnet.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(`rustnet.${key}`, value);
  } catch {
    /* Preferences are optional in restricted webviews. */
  }
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export default function App() {
  const { navigation, navigate } = useNavigation(
    preference("screen", "applications") === "connections"
      ? "connections"
      : "applications",
  );
  const {
    screen,
    connection: selectedConnection,
    application: selectedApplication,
    applicationFilter,
    expanded,
  } = navigation;
  const [theme, setTheme] = useState<Theme>(() => {
    const value = preference("theme", "system");
    return value === "light" || value === "dark" ? value : "system";
  });
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(false);
  const [captureSettings, setCaptureSettings] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const width = Number(preference("inspector-width", "440"));
    return Number.isFinite(width) ? Math.max(320, Math.min(640, width)) : 440;
  });
  const workbench = useRef<HTMLDivElement>(null);
  function resizeInspector(width: number) {
    const limit = Math.max(
      320,
      Math.min(640, (workbench.current?.clientWidth ?? 1000) - 300),
    );
    const next = Math.round(Math.max(320, Math.min(limit, width)));
    setInspectorWidth(next);
    savePreference("inspector-width", String(next));
  }
  const [view, setView] = useState<CaptureView>(idle);
  const rateSampler = useRef<DesktopRates | undefined>(undefined);
  function acceptView(next: CaptureView) {
    const sampled = sampleDesktopRates(rateSampler.current, next);
    rateSampler.current = sampled;
    setView(sampled.view);
  }
  const [display, setDisplay] = useState<CaptureView>(idle);
  const [interfaces, setInterfaces] = useState<CaptureInterface[]>([]);
  const [interfaceName, setInterfaceName] = useState(() =>
    preference("interface", "__unset__"),
  );
  const [interfaceLoading, setInterfaceLoading] = useState(false);
  const [record, setRecord] = useState(false);
  const [geoipDirectory, setGeoipDirectory] = useState(() =>
    preference("geoip-directory", ""),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [protocol, setProtocol] = useState("all");
  const [historic, setHistoric] = useState(false);
  const [sort, setSort] = useState<Sort>("process");
  const [appSort, setAppSort] = useState<"name" | "download">("name");
  const [appPage, setAppPage] = useState(0);
  const [points, setPoints] = useState<TrafficPoint[]>([]);
  const [appHistory, setAppHistory] = useState({
    session: 0,
    values: new Map<string, TrafficPoint[]>(),
  });
  const [captureHistory, setCaptureHistory] = useState<CaptureHistory>({
    session: 0,
    traffic: [],
    coverage: [],
  });
  const frozenCaptureHistory = useRef(captureHistory);
  useEffect(() => {
    const raw = rateSampler.current?.raw;
    if (view.snapshot)
      setCaptureHistory((previous) =>
        updateCaptureHistory(
          previous,
          view.session,
          Date.parse(view.snapshot!.timestamp),
          view.snapshot!.stats.capture_accounting,
          {
            smoothed: {
              time: Date.parse(view.snapshot!.timestamp),
              rx: view.snapshot!.connections.reduce(
                (sum, c) => sum + received(c),
                0,
              ),
              tx: view.snapshot!.connections.reduce(
                (sum, c) => sum + sent(c),
                0,
              ),
            },
            raw,
          },
        ),
      );
  }, [view]);
  const frozenAppHistory = useRef(new Map<string, TrafficPoint[]>());
  const [lastUpdated, setLastUpdated] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const connectionScroll = useRef<HTMLDivElement>(null);
  const lastClickedConnection = useRef<string | null>(null);
  const lastRevision = useRef("");
  const active = ["starting", "running", "stopping"].includes(view.status);
  const snapshot = display.snapshot;
  const all = snapshot?.connections ?? [];
  const live = useMemo(() => all.filter((c) => !c.historic), [all]);
  const apps = useMemo(
    () =>
      applications(all).sort(
        (a, b) =>
          (appSort === "download"
            ? b.rx - a.rx
            : a.name.localeCompare(b.name)) || a.key.localeCompare(b.key),
      ),
    [all, appSort],
  );
  const duplicateAppNames = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const app of apps) {
      if (seen.has(app.name)) duplicates.add(app.name);
      seen.add(app.name);
    }
    return duplicates;
  }, [apps]);
  const app = apps.find((a) => a.key === selectedApplication);
  const connection = all.find((c) => c.id === selectedConnection);
  const rx = live.reduce((total, c) => total + received(c), 0),
    tx = live.reduce((total, c) => total + sent(c), 0);
  const scopedConnections = useMemo(
    () => connectionsForApplication(all, applicationFilter?.key ?? null),
    [all, applicationFilter],
  );
  const filtered = useMemo(
    () =>
      connectionsForView(scopedConnections, query, protocol, historic, sort),
    [scopedConnections, query, protocol, historic, sort],
  );
  const protocols = [
    ...new Set(all.map((c) => c.application || c.protocol)),
  ].sort();
  const stale =
    active &&
    view.status === "running" &&
    lastUpdated > 0 &&
    Date.now() - lastUpdated > 4000;

  async function refreshInterfaces() {
    if (!isTauri()) return;
    setInterfaceLoading(true);
    try {
      const found = await invoke<CaptureInterface[]>("list_interfaces");
      if (
        !Array.isArray(found) ||
        found.some(
          (i) => typeof i.name !== "string" || !Array.isArray(i.addresses),
        )
      )
        throw new Error("Invalid capture interface list");
      setInterfaces(found);
      setInterfaceName((previous) =>
        previous === "__unset__"
          ? found.some((i) => i.name === "any")
            ? "any"
            : ""
          : previous,
      );
    } catch (e) {
      setError(`Unable to list interfaces: ${errorText(e)}`);
    } finally {
      setInterfaceLoading(false);
    }
  }
  useEffect(() => {
    void refreshInterfaces();
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = parseView(await invoke<unknown>("capture_view"));
        if (!cancelled) {
          setBridgeError(null);
          acceptView(next);
          const key = `${next.session}:${next.revision}`;
          if (key !== lastRevision.current) {
            lastRevision.current = key;
            setLastUpdated(Date.now());
          }
        }
      } catch (e) {
        if (!cancelled) setBridgeError(`Capture bridge: ${errorText(e)}`);
      } finally {
        if (!cancelled) timer = setTimeout(poll, 500);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (display.session !== view.session) {
      setPaused(false);
      setDisplay(view);
      setPoints([]);
      navigate(
        {
          connection: null,
          expanded: false,
          application: null,
          applicationFilter: null,
        },
        true,
      );
      setAppPage(0);
    } else if (!paused) setDisplay(view);
  }, [view, paused, display.session, navigate]);
  useEffect(() => {
    if (!snapshot || (!live.length && snapshot.runtime.status === "starting"))
      return;
    const time = Date.parse(snapshot.timestamp);
    setPoints((previous) => appendPoint(previous, { time, rx, tx }));
  }, [snapshot, rx, tx, live.length]);
  useEffect(() => {
    if (!view.snapshot) return;
    const sample = view.snapshot;
    setAppHistory((previous) => ({
      session: view.session,
      values: updateApplicationHistory(
        previous.session === view.session ? previous.values : new Map(),
        sample.connections,
        Date.parse(sample.timestamp),
      ),
    }));
  }, [view.session, view.snapshot]);
  const appPoints =
    (paused ? frozenAppHistory.current : appHistory.values).get(
      app?.key || "",
    ) || [];
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    savePreference("theme", theme);
  }, [theme]);
  useEffect(() => {
    savePreference("screen", screen);
  }, [screen]);
  useEffect(() => {
    if (connectionScroll.current) connectionScroll.current.scrollTop = 0;
  }, [query, protocol, historic, sort, applicationFilter]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const editable =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof Element &&
          Boolean(
            event.target.closest(
              '[contenteditable="true"], [role="combobox"], [role="listbox"]',
            ),
          ));
      if (
        !editable &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key === "h"
      ) {
        event.preventDefault();
        setHelp((open) => !open);
        return;
      }
      if (help) return;
      if (
        !editable &&
        screen === "connections" &&
        !settings &&
        !captureSettings &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key === "t"
      ) {
        event.preventDefault();
        setHistoric((show) => !show);
        return;
      }
      if (
        !editable &&
        screen === "connections" &&
        !settings &&
        !captureSettings &&
        !event.altKey &&
        !event.metaKey &&
        filtered.length
      ) {
        const first = !event.ctrlKey && event.key === "g" && !event.shiftKey;
        const last =
          !event.ctrlKey &&
          (event.key === "G" || (event.key === "g" && event.shiftKey));
        const down = event.ctrlKey && !event.shiftKey && event.key === "f";
        const up = event.ctrlKey && !event.shiftKey && event.key === "b";
        if (first || last || down || up) {
          event.preventDefault();
          const table = connectionScroll.current;
          const rowHeight =
            table?.querySelector("tbody tr")?.getBoundingClientRect().height ||
            60;
          const pageSize = Math.max(
            1,
            Math.floor(
              ((table?.clientHeight || window.innerHeight - 260) - 40) /
                rowHeight,
            ),
          );
          const current = Math.max(
            0,
            filtered.findIndex((c) => c.id === selectedConnection),
          );
          const index = first
            ? 0
            : last
              ? filtered.length - 1
              : Math.max(
                  0,
                  Math.min(
                    filtered.length - 1,
                    current + (down ? pageSize : -pageSize),
                  ),
                );
          navigate(
            { connection: filtered[index].id },
            selectedConnection !== null,
          );
          requestAnimationFrame(() => {
            connectionScroll.current
              ?.querySelectorAll("tbody tr")
              [index]?.scrollIntoView({ block: "center" });
          });
        }
      }
      if (event.key === "/" && !editable) {
        event.preventDefault();
        navigate({ screen: "connections" });
        requestAnimationFrame(() => search.current?.focus());
      }
      if (event.key === "Escape") {
        setSettings(false);
        setCaptureSettings(false);
        navigate({ expanded: false, connection: null });
        if (editable) (event.target as HTMLElement).blur();
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [
    navigate,
    screen,
    settings,
    captureSettings,
    filtered,
    selectedConnection,
    help,
  ]);

  const chosenInterface = interfaceName === "__unset__" ? "" : interfaceName;
  const interfaceMissing =
    Boolean(chosenInterface) &&
    !interfaces.some((i) => i.name === chosenInterface);
  const sourceName = active
    ? view.snapshot?.runtime.interface
    : chosenInterface;
  const sourceLabel =
    sourceName === "any" ? "All interfaces · any" : sourceName || "Automatic";

  async function startCapture() {
    const started = await invoke<boolean>("start_capture", {
      interface: chosenInterface,
      record,
      geoipDirectory: geoipDirectory || null,
    });
    if (started) {
      savePreference("interface", chosenInterface);
      setCaptureSettings(false);
    }
  }
  async function chooseGeoipDirectory() {
    setBusy(true);
    setError(null);
    try {
      const directory = await invoke<string | null>("choose_geoip_directory");
      if (directory !== null) {
        setGeoipDirectory(directory);
        savePreference("geoip-directory", directory);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function restartCapture() {
    setBusy(true);
    setError(null);
    try {
      await invoke("stop_capture");
      const stopped = parseView(await invoke("capture_view"));
      acceptView(stopped);
      if (
        stopped.error ||
        ["starting", "running", "stopping"].includes(stopped.status)
      ) {
        throw new Error(
          stopped.error ||
            "Capture has not stopped yet. Try again after shutdown.",
        );
      }
      await startCapture();
      acceptView(parseView(await invoke("capture_view")));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function toggleCapture() {
    setBusy(true);
    setError(null);
    try {
      if (active) {
        await invoke("stop_capture");
      } else {
        await startCapture();
      }
      acceptView(parseView(await invoke("capture_view")));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const captureError = error || bridgeError || view.error;
  const unknown = live.filter((c) => c.process?.pid == null).length;
  const statusLabel =
    view.status === "running"
      ? stale
        ? "Waiting for updates"
        : "Live capture"
      : {
          idle: "Ready to capture",
          starting: "Starting capture",
          stopping: "Stopping capture",
          stopped: "Capture stopped",
          stopped_with_errors: "Capture failed",
          error: "Capture failed",
        }[view.status] || view.status;

  return (
    <div
      className={`desktop ${screen === "connections" ? "connections-screen" : ""}`}
    >
      <aside className="sidebar">
        <div className="brand">
          <img src="/rustnet.svg" alt="RustNet" />
          <span>
            rustnet<small>DESKTOP</small>
          </span>
        </div>
        <div className="nav-label">MONITOR</div>
        <nav aria-label="Main navigation">
          <button
            aria-current={screen === "applications" ? "page" : undefined}
            onClick={() =>
              navigate({
                screen: "applications",
                connection: null,
                expanded: false,
              })
            }
          >
            <Blocks size={18} />
            Applications
          </button>
          <button
            aria-current={screen === "connections" ? "page" : undefined}
            onClick={() =>
              navigate({
                screen: "connections",
                applicationFilter: null,
                connection: null,
                expanded: false,
              })
            }
          >
            <ListFilter size={18} />
            Connections
          </button>
        </nav>
        <section className="sidebar-health" aria-label="Capture health">
          <span className="sandbox-status">
            <ShieldCheck size={14} />
            <span>
              {view.snapshot ? (
                <>
                  Sandbox
                  <strong>
                    {view.snapshot.sandbox.status.replaceAll("_", " ")}
                  </strong>
                </>
              ) : (
                "Capture engine runs separately"
              )}
            </span>
          </span>
          {view.snapshot && (
            <dl>
              <div>
                <dt>Packets</dt>
                <dd>{view.snapshot.stats.packets_captured.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Dropped (all stages)</dt>
                <dd>
                  {(
                    view.snapshot.stats.packets_dropped +
                    view.snapshot.stats.capture_packets_dropped +
                    view.snapshot.stats.interface_packets_dropped
                  ).toLocaleString()}
                </dd>
              </div>
            </dl>
          )}
          <small>Encrypted payloads stay opaque</small>
        </section>
        <div className="sidebar-source">
          <span className="nav-label">CAPTURE SOURCE</span>
          <strong>{sourceLabel}</strong>
          <small>
            {interfaces
              .find(
                (i) =>
                  i.name ===
                  (view.snapshot?.runtime.interface || interfaceName),
              )
              ?.addresses.slice(0, 2)
              .join("\n") || "Local machine"}
          </small>
        </div>
        <button
          className="settings-button"
          onClick={() => setSettings(!settings)}
          aria-expanded={settings}
        >
          <Settings size={16} />
          Appearance
        </button>
        <button
          className="settings-button"
          onClick={() => setHelp(true)}
          aria-haspopup="dialog"
        >
          <CircleHelp size={16} />
          Help <kbd>h</kbd>
        </button>
      </aside>
      <main>
        <header>
          <h1>{screen === "applications" ? "Applications" : "Connections"}</h1>
          <div className="header-actions">
            <span
              id="capture-state"
              className={
                view.status === "running" && !stale
                  ? "sr-only"
                  : "capture-status"
              }
              role="status"
            >
              <span />
              {statusLabel}
            </span>
            <button
              className="button"
              aria-label="Capture settings"
              aria-describedby="capture-state"
              title={`${statusLabel}. Open capture settings`}
              aria-expanded={captureSettings}
              onClick={() => setCaptureSettings(!captureSettings)}
            >
              {view.status === "running" && !stale ? (
                <span className="capture-indicator" aria-hidden="true" />
              ) : (
                <Radio size={15} />
              )}
              {sourceLabel}
              <span aria-hidden="true">▾</span>
            </button>
            {!active && (
              <button
                className="button primary"
                onClick={() => void toggleCapture()}
                disabled={
                  busy ||
                  interfaceLoading ||
                  interfaceName === "__unset__" ||
                  interfaceMissing ||
                  !isTauri()
                }
              >
                <Play size={15} />
                {busy ? "Please wait…" : "Start capture"}
              </button>
            )}
          </div>
        </header>
        {settings && (
          <section className="settings-panel" aria-label="Appearance">
            <label>
              Appearance
              <Select
                label="Appearance"
                value={theme}
                onChange={(value) => setTheme(value as Theme)}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            </label>
            <button
              className="icon-button"
              aria-label="Close appearance settings"
              onClick={() => setSettings(false)}
            >
              <X size={16} />
            </button>
          </section>
        )}
        {captureSettings && (
          <section className="capture-bar" aria-label="Capture controls">
            {active && (
              <div className="capture-session">
                <div>
                  <strong>{statusLabel}</strong>
                  <small>
                    Freeze view pauses the display. Stop capture ends the
                    session and finishes recording.
                  </small>
                </div>
                <button
                  className="button stop"
                  onClick={() => void toggleCapture()}
                  disabled={busy || view.status === "stopping" || !isTauri()}
                >
                  <Square size={15} />
                  {busy ? "Please wait…" : "Stop capture"}
                </button>
              </div>
            )}
            <label className="interface-picker">
              <Radio size={16} />
              <span className="sr-only">Capture interface</span>
              <Select
                label="Capture interface"
                value={chosenInterface}
                disabled={busy || interfaceLoading}
                onChange={setInterfaceName}
                options={[
                  { value: "", label: "Automatic (one interface)" },
                  ...(interfaces.some((i) => i.name === "any")
                    ? [{ value: "any", label: "All interfaces (any)" }]
                    : []),
                  ...(interfaceMissing
                    ? [
                        {
                          value: chosenInterface,
                          label: `${chosenInterface} · unavailable`,
                        },
                      ]
                    : []),
                  ...interfaces
                    .filter((i) => i.name !== "any")
                    .map((i) => ({
                      value: i.name,
                      label: i.description
                        ? `${i.name} · ${i.description}`
                        : i.name,
                    })),
                ]}
              />
            </label>
            <button
              className="icon-button"
              aria-label="Refresh interfaces"
              disabled={busy || interfaceLoading || !isTauri()}
              onClick={() => void refreshInterfaces()}
            >
              <RefreshCw size={16} className={interfaceLoading ? "spin" : ""} />
            </button>
            <label className="record-toggle">
              <input
                type="checkbox"
                checked={record}
                disabled={busy}
                onChange={(e) => setRecord(e.target.checked)}
              />
              <Download size={15} />
              Record PCAPNG
            </label>
            {active && (
              <button
                className="button"
                onClick={() => void restartCapture()}
                disabled={
                  busy ||
                  interfaceLoading ||
                  interfaceMissing ||
                  view.status !== "running"
                }
              >
                Apply and restart capture
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Close capture settings"
              onClick={() => setCaptureSettings(false)}
            >
              <X size={16} />
            </button>
            <div className="geoip-settings">
              <div>
                <strong>GeoIP databases</strong>
                <p>
                  {geoipDirectory ||
                    "Automatic discovery in user and system folders"}
                </p>
                <small>
                  Local GeoLite2 databases provide country, city and ASN
                  information.
                </small>
              </div>
              <button
                className="button"
                disabled={busy || !isTauri()}
                onClick={() => void chooseGeoipDirectory()}
              >
                Choose GeoIP folder
              </button>
              {geoipDirectory && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setGeoipDirectory("");
                    savePreference("geoip-directory", "");
                  }}
                >
                  Use automatic discovery
                </button>
              )}
            </div>
            <p className="capture-hint">
              {active
                ? "Changes apply only when you restart capture. Recording will use a new file."
                : "Choose a source, then start capture."}
            </p>
          </section>
        )}
        {interfaceMissing && (
          <div className="notice warning">
            Saved interface {chosenInterface} is unavailable. Choose another
            source in capture settings.
          </div>
        )}
        {!isTauri() && (
          <div className="notice">
            Open the Tauri desktop app to capture traffic. This browser view has
            no access to the capture engine.
          </div>
        )}
        {captureError && (
          <div className="notice error" role="alert">
            <strong>Capture needs attention</strong>
            <p>{captureError}</p>
            {bridgeError && !error ? (
              <p>
                The last valid snapshot is shown. Capture may still be running;
                the display will recover automatically when valid data arrives.
              </p>
            ) : (
              <p>
                Linux: configure capture capabilities on the bundled engine.
                macOS: configure BPF access. Windows: install Npcap. Keep the
                desktop running as your regular user. See the desktop setup
                guide.
              </p>
            )}
            {error && <button onClick={() => setError(null)}>Dismiss</button>}
          </div>
        )}
        {view.snapshot?.runtime.process_detection.degraded && (
          <div className="notice warning">
            Process detection is limited:{" "}
            {view.snapshot.runtime.process_detection.degradation_reason ||
              view.snapshot.runtime.process_detection.method}
            . Unattributed traffic remains visible.
          </div>
        )}
        {view.export_path && (
          <div className="recording-info">
            <Download size={14} />
            <span>
              {active ? "Recording to" : "Recording destination"}{" "}
              <strong>{view.export_path}</strong>
              {!active &&
              (view.error ||
                (view.snapshot?.stats.pcapng_export_errors ?? 0) > 0 ||
                (view.snapshot?.stats.pcapng_records_dropped ?? 0) > 0)
                ? " · recording may be incomplete"
                : ""}
            </span>
          </div>
        )}
        <section className="summary" aria-label="Traffic summary">
          <Metric
            icon={<ArrowDownLeft />}
            label="Receiving"
            value={snapshot ? bytes(rx, true) : "Waiting"}
            caption="2-second average · tracked connections"
          />
          <Metric
            icon={<ArrowUpRight />}
            label="Sending"
            value={snapshot ? bytes(tx, true) : "Waiting"}
            caption="2-second average · tracked connections"
          />
          <Metric
            icon={<Activity />}
            label="Active connections"
            value={String(live.length)}
            caption={`${apps.length} application groups · ${unknown} unattributed`}
          />
          <button
            className="button freeze"
            disabled={!snapshot}
            aria-pressed={paused}
            onClick={() => {
              if (!paused) {
                frozenCaptureHistory.current = captureHistory;
                frozenAppHistory.current = appHistory.values;
              }
              setPaused(!paused);
            }}
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
            {paused ? "Resume view" : "Freeze view"}
          </button>
        </section>
        {paused && (
          <div className="freeze-note" role="status">
            View frozen at{" "}
            {snapshot && new Date(snapshot.timestamp).toLocaleTimeString()}.
            Capture and recording continue.
          </div>
        )}
        {screen === "connections" ? (
          <div
            ref={workbench}
            className={`workbench ${selectedConnection ? "with-inspector" : ""} ${expanded && selectedConnection ? "expanded-inspector" : ""}`}
            style={
              { "--inspector-width": `${inspectorWidth}px` } as CSSProperties
            }
          >
            <section className="connection-list" aria-label="Connections">
              <section className="filter-bar" aria-label="Connection filters">
                <label className="search">
                  <Search size={16} />
                  <input
                    ref={search}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find process, host, address, or port…"
                    aria-label="Find connections"
                  />
                  <kbd>/</kbd>
                </label>
                <Select
                  label="Protocol"
                  value={protocol}
                  onChange={setProtocol}
                  options={[
                    { value: "all", label: "All protocols" },
                    ...protocols.map((p) => ({ value: p, label: p })),
                  ]}
                />
                <Select
                  label="Sort connections"
                  value={sort}
                  onChange={(value) => setSort(value as Sort)}
                  options={[
                    { value: "download", label: "Download ↓" },
                    { value: "upload", label: "Upload ↓" },
                    { value: "process", label: "Process A–Z" },
                    { value: "destination", label: "Destination A–Z" },
                  ]}
                />
                <button
                  className="button history-toggle"
                  aria-pressed={historic}
                  aria-label="Show historic connections"
                  title="Show retained closed connections (t)"
                  onClick={() => setHistoric(!historic)}
                >
                  <History size={15} /> History
                  <span className="history-count">
                    {scopedConnections
                      .filter((c) => c.historic)
                      .length.toLocaleString()}
                  </span>
                  <kbd>t</kbd>
                </button>
              </section>
              {applicationFilter && (
                <div className="application-filter">
                  <span>
                    Application: <strong>{applicationFilter.label}</strong>
                  </span>
                  <button
                    className="button"
                    aria-label="Clear application filter"
                    onClick={() => navigate({ applicationFilter: null })}
                  >
                    <X size={14} /> Clear filter
                  </button>
                </div>
              )}
              <div className="table-scroll" ref={connectionScroll}>
                <table
                  onDoubleClick={(event) => {
                    const row = (
                      event.target as Element
                    ).closest<HTMLTableRowElement>("tr[data-connection-id]");
                    const connection =
                      lastClickedConnection.current ||
                      row?.dataset.connectionId;
                    if (connection)
                      navigate({ connection, expanded: true }, true);
                  }}
                >
                  <thead>
                    <tr>
                      <th aria-sort={sort === "process" ? "ascending" : "none"}>
                        <button
                          className="sort-heading"
                          aria-label="Sort by process"
                          onClick={() => setSort("process")}
                        >
                          Process {sort === "process" && "↑"}
                        </button>
                      </th>
                      <th
                        aria-sort={
                          sort === "destination" ? "ascending" : "none"
                        }
                      >
                        <button
                          className="sort-heading"
                          aria-label="Sort by destination"
                          onClick={() => setSort("destination")}
                        >
                          Destination {sort === "destination" && "↑"}
                        </button>
                      </th>
                      <th>Protocol</th>
                      <th>State</th>
                      <th
                        className="numeric"
                        aria-sort={sort === "download" ? "descending" : "none"}
                      >
                        <button
                          className="sort-heading"
                          aria-label="Sort by download rate"
                          onClick={() => setSort("download")}
                        >
                          Download rate {sort === "download" && "↓"}
                        </button>
                      </th>
                      <th
                        className="numeric"
                        aria-sort={sort === "upload" ? "descending" : "none"}
                      >
                        <button
                          className="sort-heading"
                          aria-label="Sort by upload rate"
                          onClick={() => setSort("upload")}
                        >
                          Upload rate {sort === "upload" && "↓"}
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => {
                      const lifecycle = connectionLifecycle(c);
                      return (
                        <tr
                          key={c.id}
                          data-connection-id={c.id}
                          style={
                            {
                              "--lifecycle-fade": lifecycle?.fade ?? 0,
                            } as CSSProperties
                          }
                          onClick={(event) => {
                            if (event.detail < 2) {
                              lastClickedConnection.current = c.id;
                              navigate({ connection: c.id, expanded: false });
                            } else
                              navigate(
                                {
                                  connection:
                                    lastClickedConnection.current || c.id,
                                  expanded: true,
                                },
                                true,
                              );
                          }}
                          className={`${selectedConnection === c.id ? "selected" : ""} ${c.historic ? "historic" : ""} ${lifecycle ? "stale-connection" : ""}`}
                        >
                          <td>
                            <button
                              className="row-select"
                              aria-pressed={selectedConnection === c.id}
                              aria-label={`Inspect ${processName(c)} connection to ${destination(c)}`}
                            >
                              {processName(c)}
                            </button>
                            <small>
                              {c.process?.pid == null
                                ? "PID unknown"
                                : `PID ${c.process.pid}`}
                            </small>
                          </td>
                          <td>
                            <span className="hostname" title={destination(c)}>
                              {destination(c)}
                            </span>
                            <small>{endpoint(c.remote)}</small>
                          </td>
                          <td>
                            <span className="protocol-badge">
                              {c.application || c.protocol}
                            </span>
                            <small>{c.protocol}</small>
                          </td>
                          <td>
                            <span className="state-label">
                              {c.historic ? "Closed" : c.state}
                            </span>
                            {c.historic && <small>Last state: {c.state}</small>}
                            {lifecycle && (
                              <small className="lifecycle-countdown">
                                {lifecycle.label}
                              </small>
                            )}
                          </td>
                          <td className="numeric">
                            {c.historic
                              ? "Closed"
                              : bytes(
                                  c.traffic.incoming_bytes_per_second,
                                  true,
                                )}
                          </td>
                          <td className="numeric">
                            {c.historic
                              ? "Closed"
                              : bytes(
                                  c.traffic.outgoing_bytes_per_second,
                                  true,
                                )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!filtered.length && (
                <Empty
                  active={active}
                  filtered={Boolean(
                    applicationFilter || query || protocol !== "all",
                  )}
                />
              )}
              <div className="list-footer">
                <span>
                  {filtered.length.toLocaleString()} connections
                  {query && " matching search"}
                </span>
              </div>
            </section>
            {selectedConnection && (
              <>
                <div
                  role="separator"
                  aria-label="Resize connection inspector"
                  aria-orientation="vertical"
                  aria-valuemin={320}
                  aria-valuemax={640}
                  aria-valuenow={inspectorWidth}
                  tabIndex={0}
                  className="inspector-resizer"
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      resizeInspector(
                        (workbench.current?.getBoundingClientRect().right ??
                          0) - e.clientX,
                      );
                    }
                  }}
                  onPointerUp={(e) =>
                    e.currentTarget.releasePointerCapture(e.pointerId)
                  }
                  onKeyDown={(e) => {
                    if (
                      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                    ) {
                      e.preventDefault();
                      resizeInspector(
                        e.key === "Home"
                          ? 320
                          : e.key === "End"
                            ? 640
                            : inspectorWidth +
                              (e.key === "ArrowLeft" ? 20 : -20),
                      );
                    }
                  }}
                />
                <Inspector
                  connection={connection}
                  expanded={expanded}
                  onExpand={() => navigate({ expanded: !expanded })}
                  onClose={() => {
                    navigate({ connection: null, expanded: false });
                    requestAnimationFrame(() => search.current?.focus());
                  }}
                />
              </>
            )}
          </div>
        ) : (
          <section className="app-layout" aria-label="Applications">
            <div className="app-list">
              <div className="section-caption">
                <button
                  className="sort-heading"
                  aria-label="Sort applications alphabetically"
                  aria-pressed={appSort === "name"}
                  onClick={() => {
                    setAppSort("name");
                    setAppPage(0);
                  }}
                >
                  Applications {appSort === "name" && "↑"}
                </button>
                <button
                  className="sort-heading"
                  aria-label="Sort applications by download rate"
                  aria-pressed={appSort === "download"}
                  onClick={() => {
                    setAppSort("download");
                    setAppPage(0);
                  }}
                >
                  Download rate {appSort === "download" && "↓"}
                </button>
              </div>
              <button
                className="app-row all-traffic-row"
                aria-pressed={selectedApplication === null}
                onClick={() =>
                  navigate({
                    application: null,
                    connection: null,
                    expanded: false,
                  })
                }
              >
                <span className="app-icon">
                  <Activity size={20} />
                </span>
                <span className="app-name">
                  <strong>All traffic</strong>
                  <small>Capture coverage and application attribution</small>
                </span>
              </button>
              {apps
                .slice(
                  Math.min(
                    appPage,
                    Math.max(0, Math.ceil(apps.length / PAGE_SIZE) - 1),
                  ) * PAGE_SIZE,
                  (Math.min(
                    appPage,
                    Math.max(0, Math.ceil(apps.length / PAGE_SIZE) - 1),
                  ) +
                    1) *
                    PAGE_SIZE,
                )
                .map((a) => (
                  <button
                    className="app-row"
                    key={a.key}
                    aria-pressed={a.key === app?.key}
                    title="Click for traffic overview; double-click to show this application's connections"
                    onDoubleClick={() => {
                      setQuery("");
                      setProtocol("all");
                      navigate({
                        screen: "connections",
                        application: a.key,
                        applicationFilter: {
                          key: a.key,
                          label: duplicateAppNames.has(a.name)
                            ? `${a.name} · ${a.executable || "Executable unavailable"}`
                            : a.name,
                        },
                        connection: null,
                        expanded: false,
                      });
                    }}
                    onClick={() => {
                      navigate({
                        application: a.key,
                        connection: null,
                        expanded: false,
                      });
                    }}
                  >
                    <span className="app-icon">
                      {a.name === "Unattributed" ? (
                        <CircleHelp size={20} />
                      ) : (
                        <Blocks size={20} />
                      )}
                    </span>
                    <span className="app-name">
                      <strong>{a.name}</strong>
                      {duplicateAppNames.has(a.name) && (
                        <small
                          className="app-path"
                          title={a.executable || "Executable unavailable"}
                        >
                          {a.executable || "Executable unavailable"}
                        </small>
                      )}
                      <small>
                        {a.connections.length} connections · {a.pids.length}{" "}
                        PIDs · {a.hosts} {a.hosts === 1 ? "host" : "hosts"}
                      </small>
                    </span>
                    <span className="app-rate">{bytes(a.rx, true)}</span>
                    <span className="share-track">
                      <span
                        style={{ width: `${rx ? (a.rx / rx) * 100 : 0}%` }}
                      />
                    </span>
                  </button>
                ))}
              {!apps.length && <Empty active={active} />}
              {apps.length > PAGE_SIZE && (
                <Pagination
                  page={appPage}
                  pages={Math.ceil(apps.length / PAGE_SIZE)}
                  onChange={setAppPage}
                />
              )}
            </div>
            <div className="app-detail">
              {selectedApplication === null ? (
                <AllTraffic
                  snapshot={snapshot}
                  points={points}
                  apps={apps}
                  history={
                    paused ? frozenCaptureHistory.current : captureHistory
                  }
                />
              ) : app ? (
                <AppDetails
                  app={app}
                  points={appPoints}
                  totalRx={rx}
                  selected={selectedConnection}
                  onSelect={(connection) => navigate({ connection }, true)}
                  onInspect={(id, expand = false) => {
                    navigate({
                      screen: "connections",
                      connection: id,
                      applicationFilter: null,
                      expanded: expand,
                    });
                    setQuery("");
                    setProtocol("all");
                  }}
                />
              ) : selectedApplication ? (
                <div className="empty">
                  <Activity size={28} />
                  <h2>No active connections</h2>
                  <p>
                    The selected application is no longer active in this
                    capture.
                  </p>
                  <button
                    className="button"
                    onClick={() => navigate({ application: null })}
                  >
                    Select an active application
                  </button>
                </div>
              ) : (
                <div className="empty welcome">
                  <img src="/rustnet.svg" alt="" />
                  <h2>A clearer view of your network.</h2>
                  <p>
                    Choose an interface and start capture to see applications,
                    live traffic, and connection details.
                  </p>
                  <span className="empty-hint">
                    Packet analysis stays on this machine.
                  </span>
                </div>
              )}
            </div>
          </section>
        )}
      </main>
      {help && (
        <Help
          context={
            captureSettings
              ? "capture"
              : screen === "connections" && selectedConnection
                ? "inspector"
                : screen
          }
          onClose={() => setHelp(false)}
        />
      )}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  caption,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {icon}
        {label}
      </div>
      <strong>{value}</strong>
      <small>{caption}</small>
    </div>
  );
}
function Pagination({
  page,
  pages,
  onChange,
}: {
  page: number;
  pages: number;
  onChange: (page: number) => void;
}) {
  return pages > 1 ? (
    <div className="pagination">
      <button disabled={page === 0} onClick={() => onChange(page - 1)}>
        Previous
      </button>
      <span>
        {page + 1} / {pages}
      </span>
      <button disabled={page >= pages - 1} onClick={() => onChange(page + 1)}>
        Next
      </button>
    </div>
  ) : null;
}
function Empty({
  active,
  filtered = false,
}: {
  active: boolean;
  filtered?: boolean;
}) {
  return (
    <div className="empty compact">
      <Activity size={26} />
      <h2>
        {filtered
          ? "No matching connections"
          : active
            ? "Listening for traffic"
            : "No captured connections"}
      </h2>
      <p>
        {filtered
          ? "Try another search or protocol."
          : active
            ? "Connections appear when packets are observed on the selected interface."
            : "Start a capture to populate this view."}
      </p>
    </div>
  );
}
function AppDetails({
  app,
  points,
  totalRx,
  selected,
  onSelect,
  onInspect,
}: {
  app: Application;
  points: TrafficPoint[];
  totalRx: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onInspect: (id: string, expand?: boolean) => void;
}) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [app.key]);
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(app.connections.length / PAGE_SIZE) - 1),
  );
  return (
    <>
      <div className="app-title">
        <span className="app-icon large">
          <Blocks size={23} />
        </span>
        <div>
          <h2>{app.name}</h2>
          <p className="subtitle">
            {app.pids.length
              ? `PIDs ${app.pids.slice(0, 8).join(", ")}${app.pids.length > 8 ? "…" : ""}`
              : "Process owner unavailable"}
          </p>
        </div>
      </div>
      {app.executable && <p className="executable">{app.executable}</p>}
      <p className="app-counts">
        {app.connections.length} active connections · {app.pids.length} PIDs ·{" "}
        <span title="Unique remote IP addresses across active connections">
          {app.hosts} {app.hosts === 1 ? "host" : "hosts"}
        </span>
      </p>
      <div className="app-metrics">
        <Metric
          icon={<ArrowDownLeft />}
          label="Download"
          value={bytes(app.rx, true)}
          caption="2-second average"
        />
        <Metric
          icon={<ArrowUpRight />}
          label="Upload"
          value={bytes(app.tx, true)}
          caption="2-second average"
        />
        <Metric
          icon={<ArrowDownLeft />}
          label="Total downloaded"
          value={bytes(app.downloaded)}
          caption="Retained connections"
        />
        <Metric
          icon={<ArrowUpRight />}
          label="Total uploaded"
          value={bytes(app.uploaded)}
          caption="Retained connections"
        />
      </div>
      <Chart points={points} label="Traffic · last 60 seconds" />
      <div className="endpoints-title">
        <h3>Talking to</h3>
        <span>{app.connections.length} connections</span>
      </div>
      {app.connections
        .slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
        .map((c) => (
          <div
            className="endpoint"
            key={c.id}
            onDoubleClick={() => onInspect(c.id, true)}
          >
            <button
              className="endpoint-summary"
              aria-expanded={selected === c.id}
              onClick={() => onSelect(selected === c.id ? null : c.id)}
            >
              <span>
                <strong>{destination(c)}</strong>
                <small>
                  {c.application || c.protocol} · {nameEvidence(c)}
                </small>
              </span>
              <span>{bytes(received(c), true)}</span>
            </button>
            {selected === c.id && (
              <div className="endpoint-expanded">
                <span>
                  {endpoint(c.remote)} · {c.state} · PID{" "}
                  {c.process?.pid ?? "unknown"}
                </span>
                <button className="button" onClick={() => onInspect(c.id)}>
                  Inspect connection
                </button>
              </div>
            )}
          </div>
        ))}
      <div className="list-footer">
        <span>
          {totalRx
            ? `${((app.rx / totalRx) * 100).toFixed(1)}% of current download traffic`
            : "No current download traffic"}
        </span>
        <Pagination
          page={current}
          pages={Math.ceil(app.connections.length / PAGE_SIZE)}
          onChange={setPage}
        />
      </div>
    </>
  );
}
