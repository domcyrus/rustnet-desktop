import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Blocks,
  CircleHelp,
  ChevronDown,
  ChevronRight,
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
import { useCapture, errorText } from "./useCapture";
import { useNavigation } from "./useNavigation";
import { Select } from "./Select";
import { Inspector } from "./Inspector";
import { Help } from "./Help";
import { PanelDialog } from "./PanelDialog";
import { MacosHelper } from "./MacosHelper";
import { WindowsHelper } from "./WindowsHelper";
import { AllTraffic } from "./AllTraffic";
import { ApplicationDetails } from "./ApplicationDetails";
import { ApplicationIcon } from "./ApplicationIcon";
import { ConnectionTable, revealConnectionRow } from "./ConnectionTable";
import { scrollPane } from "./scrollPane";
import { Metric, Empty } from "./components";
import {
  bytes,
  parseView,
  connectionsForView,
  connectionsForApplication,
  type CaptureInterface,
  type Sort,
} from "./model";

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
  } = navigation;
  const [theme, setTheme] = useState<Theme>(() => {
    const value = preference("theme", "system");
    return value === "light" || value === "dark" ? value : "system";
  });
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(false);
  const [captureSettings, setCaptureSettings] = useState(false);
  const {
    view,
    display,
    paused,
    updatesSuspended,
    togglePaused,
    acceptView,
    bridgeError,
    lastUpdated,
  } = useCapture();
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
  const [query, setQuery] = useState("");
  const [protocol, setProtocol] = useState("all");
  const [historic, setHistoric] = useState(false);
  const [sort, setSort] = useState<Sort>("process");
  const [appSort, setAppSort] = useState<"name" | "download">("name");
  const [applicationOpen, setApplicationOpen] = useState(true);
  const search = useRef<HTMLInputElement>(null);
  const connectionScroll = useRef<HTMLDivElement>(null);
  const connectionScrollTop = useRef(0);
  const lastConnection = useRef<string | null>(null);
  const appList = useRef<HTMLDivElement>(null);
  const appScrollTop = useRef(0);
  const [scrollbars, setScrollbars] = useState(() =>
    preference("scrollbars", "comfortable") === "system"
      ? "system"
      : "comfortable",
  );
  const [density, setDensity] = useState(() =>
    preference("density", "comfortable") === "compact"
      ? "compact"
      : "comfortable",
  );
  const active = ["starting", "running", "stopping"].includes(view.status);
  const snapshot = display.rates.view.snapshot;
  const all = snapshot?.connections ?? [];
  const live = useMemo(() => all.filter((c) => !c.historic), [all]);
  const apps = useMemo(
    () =>
      [...display.apps].sort(
        (a, b) =>
          (appSort === "download"
            ? b.rx - a.rx
            : a.name.localeCompare(b.name)) || a.key.localeCompare(b.key),
      ),
    [display.apps, appSort],
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
  const rx = apps.reduce((total, app) => total + app.rx, 0),
    tx = apps.reduce((total, app) => total + app.tx, 0);
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
    !updatesSuspended &&
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
  // Clear the previous session's selection before new rows can be clicked.
  useLayoutEffect(() => {
    navigate(
      {
        connection: null,

        application: null,
        applicationFilter: null,
      },
      true,
    );
  }, [view.session, navigate]);
  const appPoints = display.appHistory.get(app?.key || "") || [];
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    savePreference("theme", theme);
  }, [theme]);
  useEffect(() => {
    savePreference("screen", screen);
  }, [screen]);
  useEffect(() => {
    document.documentElement.dataset.scrollbars = scrollbars;
    document.documentElement.dataset.density = density;
    savePreference("scrollbars", scrollbars);
    savePreference("density", density);
  }, [scrollbars, density]);
  useLayoutEffect(() => {
    connectionScrollTop.current = 0;
    if (connectionScroll.current) connectionScroll.current.scrollTop = 0;
  }, [query, protocol, historic, sort, applicationFilter, view.session]);
  useLayoutEffect(() => {
    setApplicationOpen(true);
  }, [selectedApplication]);
  useLayoutEffect(() => {
    appScrollTop.current = 0;
    if (appList.current) appList.current.scrollTop = 0;
  }, [appSort, view.session]);
  useLayoutEffect(() => {
    if (connectionScroll.current)
      connectionScroll.current.scrollTop = connectionScrollTop.current;
    if (appList.current) appList.current.scrollTop = appScrollTop.current;
  }, [screen]);
  useLayoutEffect(() => {
    const list = connectionScroll.current;
    if (!list) return;
    const id = selectedConnection || lastConnection.current;
    const row = Array.from(
      list.querySelectorAll<HTMLTableRowElement>("tr[data-connection-id]"),
    ).find((row) => row.dataset.connectionId === id);
    if (row) {
      revealConnectionRow(row);
      // Keep a little list context above the opened details.
      if (selectedConnection && list.clientHeight > 0) {
        const top =
          row.getBoundingClientRect().top - list.getBoundingClientRect().top;
        const heading =
          list.querySelector("thead")?.getBoundingClientRect().height || 42;
        list.scrollTop += Math.max(0, top - heading - 60);
      }
      row
        .querySelector<HTMLButtonElement>("button")
        ?.focus({ preventScroll: true });
    }
    lastConnection.current = selectedConnection;
  }, [screen, selectedConnection]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
      const pane = dialog
        ? dialog.querySelector<HTMLElement>(".scroll-region")
        : screen === "connections"
          ? connectionScroll.current
          : appList.current;
      if (scrollPane(event, pane)) return;
      if (document.querySelector(".panel-dialog[open]")) return;
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
      if (help || document.querySelector("dialog[open]")) return;
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
            table
              ?.querySelector("tbody tr[data-connection-id]")
              ?.getBoundingClientRect().height || 60;
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
            revealConnectionRow(
              connectionScroll.current?.querySelectorAll<HTMLTableRowElement>(
                "tbody tr[data-connection-id]",
              )[index],
            );
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
        navigate({ connection: null });
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
  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function chooseGeoipDirectory() {
    return runAction(async () => {
      const directory = await invoke<string | null>("choose_geoip_directory");
      if (directory !== null) {
        setGeoipDirectory(directory);
        savePreference("geoip-directory", directory);
      }
    });
  }
  function restartCapture() {
    return runAction(async () => {
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
    });
  }
  function toggleCapture() {
    return runAction(async () => {
      if (active) await invoke("stop_capture");
      else await startCapture();
      acceptView(parseView(await invoke("capture_view")));
    });
  }
  const captureError = error || bridgeError || view.error;
  const shutdownError = /shutdown|did not stop|did not close cleanly/i.test(
    captureError ?? "",
  );
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

  const captureNotice = captureError && (
    <div className="notice error" role="alert">
      <strong>Capture needs attention</strong>
      <p>{captureError}</p>
      {bridgeError && !error ? (
        <p>
          The last valid snapshot is shown. Capture may still be running; the
          display will recover automatically when valid data arrives.
        </p>
      ) : shutdownError ? (
        <p>
          Capture did not finish cleanly. Any recording may be incomplete.
          Restart the desktop with the latest build before trying again.
        </p>
      ) : (
        <p>
          Linux: configure capture capabilities on the bundled engine. macOS:
          configure BPF access. Windows: install Npcap. Keep the desktop running
          as your regular user. See the desktop setup guide.
        </p>
      )}
      {error && <button onClick={() => setError(null)}>Dismiss</button>}
    </div>
  );

  const applicationDetails = applicationOpen && (
    <div className="app-detail">
      {selectedApplication === null ? (
        <AllTraffic snapshot={snapshot} history={display.history} />
      ) : app ? (
        <ApplicationDetails
          key={app.key}
          app={app}
          points={appPoints}
          totalRx={rx}
          selected={selectedConnection}
          onSelect={(connection) => navigate({ connection }, true)}
          onInspect={(id) => {
            navigate({
              screen: "connections",
              connection: id,
              applicationFilter: null,
            });
            setQuery("");
            setProtocol("all");
          }}
        />
      ) : (
        <div className="empty">
          <Activity size={28} />
          <h2>No active connections</h2>
          <p>The selected application is no longer active in this capture.</p>
          <button
            className="button"
            onClick={() => navigate({ application: null })}
          >
            Select an active application
          </button>
        </div>
      )}
    </div>
  );

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
          <PanelDialog
            title="Appearance settings"
            onClose={() => setSettings(false)}
          >
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
              <label>
                Scrollbars
                <Select
                  label="Scrollbars"
                  value={scrollbars}
                  onChange={setScrollbars}
                  options={[
                    { value: "comfortable", label: "Comfortable (12px)" },
                    { value: "system", label: "System default" },
                  ]}
                />
              </label>
              <label>
                Connection rows
                <Select
                  label="Connection rows"
                  value={density}
                  onChange={setDensity}
                  options={[
                    { value: "comfortable", label: "Comfortable" },
                    { value: "compact", label: "Compact" },
                  ]}
                />
              </label>
            </section>
          </PanelDialog>
        )}
        {captureSettings && (
          <PanelDialog
            title="Capture settings"
            onClose={() => setCaptureSettings(false)}
          >
            {captureNotice}
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
                    { value: "", label: "Automatic" },
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
                <RefreshCw
                  size={16}
                  className={interfaceLoading ? "spin" : ""}
                />
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
              <MacosHelper active={active || busy} />
              <WindowsHelper />
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
          </PanelDialog>
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
        {!captureSettings && captureNotice}
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
            onClick={togglePaused}
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
          <div className="workbench">
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
              <div
                className="table-scroll scroll-region"
                ref={connectionScroll}
                onScroll={(event) => {
                  if (event.currentTarget.clientHeight > 0)
                    connectionScrollTop.current = event.currentTarget.scrollTop;
                }}
              >
                {selectedConnection &&
                  !filtered.some((c) => c.id === selectedConnection) && (
                    <div className="detached-inspector">
                      <p className="inspector-note">
                        Selected connection is outside the current list.
                      </p>
                      <Inspector
                        connection={connection}
                        onClose={() => navigate({ connection: null })}
                      />
                    </div>
                  )}
                <ConnectionTable
                  filtered={filtered}
                  sort={sort}
                  setSort={setSort}
                  selectedConnection={selectedConnection}
                  onSelect={(connection) => navigate({ connection })}
                />
                {!filtered.length && (
                  <Empty
                    active={active}
                    filtered={Boolean(
                      applicationFilter || query || protocol !== "all",
                    )}
                  />
                )}
              </div>
              <div className="list-footer">
                <span>
                  {filtered.length.toLocaleString()} connections
                  {query && " matching search"}
                </span>
              </div>
            </section>
          </div>
        ) : (
          <section
            aria-label="Applications"
            className="app-layout app-list scroll-region"
            ref={appList}
            onScroll={(event) => {
              if (event.currentTarget.clientHeight > 0)
                appScrollTop.current = event.currentTarget.scrollTop;
            }}
          >
            <button
              className="app-row all-traffic-row"
              aria-pressed={selectedApplication === null}
              aria-expanded={selectedApplication === null && applicationOpen}
              onClick={() => {
                setApplicationOpen(
                  selectedApplication === null ? !applicationOpen : true,
                );
                navigate({
                  application: null,
                  connection: null,
                });
              }}
            >
              <span className="app-icon">
                <Activity size={20} />
              </span>
              <span className="app-name">
                <strong>All traffic</strong>
                <small>Current session · traffic and capture coverage</small>
              </span>
              <span className="app-disclosure" aria-hidden="true">
                {selectedApplication === null && applicationOpen ? (
                  <ChevronDown size={16} />
                ) : (
                  <ChevronRight size={16} />
                )}
              </span>
            </button>
            {selectedApplication === null && applicationDetails}
            <div className="section-caption">
              <button
                className="sort-heading"
                aria-label="Sort applications alphabetically"
                aria-pressed={appSort === "name"}
                onClick={() => {
                  setAppSort("name");
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
                }}
              >
                Download rate {appSort === "download" && "↓"}
              </button>
            </div>
            {apps.map((a) => (
              <Fragment key={a.key}>
                <button
                  className="app-row"
                  aria-pressed={a.key === app?.key}
                  aria-expanded={a.key === app?.key && applicationOpen}
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
                    });
                  }}
                  onClick={() => {
                    setApplicationOpen(
                      a.key === selectedApplication ? !applicationOpen : true,
                    );
                    navigate({
                      application: a.key,
                      connection: null,
                    });
                  }}
                >
                  <ApplicationIcon app={a} />
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
                      {a.connections.length} connections · {a.pids.length} PIDs
                      · {a.hosts} {a.hosts === 1 ? "host" : "hosts"}
                    </small>
                  </span>
                  <span className="app-rate">{bytes(a.rx, true)}</span>
                  <span className="app-disclosure" aria-hidden="true">
                    {a.key === app?.key && applicationOpen ? (
                      <ChevronDown size={16} />
                    ) : (
                      <ChevronRight size={16} />
                    )}
                  </span>
                </button>
                {a.key === app?.key && applicationDetails}
              </Fragment>
            ))}
            {selectedApplication !== null && !app && applicationDetails}
            {!apps.length && <Empty active={active} />}
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
