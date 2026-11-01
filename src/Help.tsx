import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export type HelpContext =
  "applications" | "connections" | "inspector" | "capture";
const topics: Record<HelpContext, [string, string][]> = {
  applications: [
    [
      "All traffic and coverage",
      "All traffic is the default application selection. It shows tracked download/upload rates and session totals. Capture coverage splits original captured frame bytes into attributed applications, unknown applications and bytes outside tracked connections. Ownership is recorded at packet processing time and is not revised later. Totals survive connection expiry. The outside gap includes pending, skipped and queue-dropped traffic; packets never delivered by the backend have no measurable byte total. Show breakdown graph compares captured and attributed rates. All desktop live rates use the same two-second window and connection byte counters. Captured-frame coverage and session totals use separate frame counters; Show raw peaks displays interval rates. The sample count reflects real observations, not interpolated points.",
    ],
    [
      "Applications and hosts",
      "Applications group connections by executable and process name. PIDs are contributing processes. Hosts are unique remote IP addresses, regardless of port. Unattributed means the engine could not identify a process.",
    ],
    [
      "Rates and totals",
      "Download and upload use a two-second average, matching the header and All traffic. Totals include active and retained closed connections, not lifetime traffic. They can decrease when old connections are discarded.",
    ],
    [
      "Traffic history",
      "Every application's last 60 seconds are collected during capture, even before you select it. Freeze view pauses the display while capture, history collection, and recording continue.",
    ],
    [
      "Explore connections",
      "Click an application for its traffic overview; double-click it to open Connections filtered to that application. Select a destination for a quick summary, or double-click to open its inline inspector. Click Download rate to sort by live traffic; alphabetical order keeps the list steady.",
    ],
  ],
  connections: [
    [
      "Find and sort",
      "Search by process, PID, hostname, address, port, or protocol. Space-separated words must all match. Double-clicking an application applies an exact application filter; Clear filter removes it. History counts follow that application filter. Column headings change sorting. Sorting by rate can move rows as traffic changes.",
    ],
    [
      "Inspect a connection",
      "Click anywhere on a row for inline details. Click again or Collapse to close. The list and details share one scroll area. Arrow Up/Down, Page Up/Page Down and Home/End scroll it, including when a button has focus. Appearance offers comfortable or compact rows and comfortable or system scrollbars.",
    ],
    [
      "Closed connections",
      "History (t) shows retained closed connections and their count. Byte totals remain available, but old rates are excluded from live traffic. Idle rows soften after halfway through the engine timeout, with a countdown to archival. Traffic resumes at full visibility.",
    ],
    [
      "Traffic overview",
      "Open Applications and select All traffic for the overall graph and capture coverage. Connection rates cover active tracked connections visible to capture, not necessarily every byte on an interface.",
    ],
  ],
  inspector: [
    [
      "Overview",
      "Endpoints contain an IP address and port. Receiving and Sending are current rates; Received and Sent are accumulated bytes for this connection. Packet counts, service, VLANs and network context come from the same capture engine as the terminal UI. MAC addresses are observed on-link; location needs GeoIP data.",
    ],
    [
      "Process",
      "The process name, PID/parent PID, user/group, executable, ancestry and match information describe attribution. Startup snapshot means a socket present at capture startup still matches the validated process identity. Unavailable means no value was observed or accessible, not that no process exists.",
    ],
    [
      "Protocol and names",
      "Protocol fields include observed TLS/SNI/ALPN and other application metadata. Transport health includes measured RTT, TCP retransmits, ACKs and receive windows; raw windows have unknown scaling when the handshake was missed. Name evidence distinguishes names observed in application traffic from names inferred from captured DNS. Encrypted application payloads are not decrypted.",
    ],
    [
      "Inline details",
      "Wide windows show Connection & traffic, Process, and Protocol & transport together in three columns. Narrow windows stack the groups. Show unobserved fields reveals missing metadata. Details share the list scrollbar; Collapse returns focus to the connection row.",
    ],
  ],
  capture: [
    [
      "GeoIP databases",
      "Choose GeoIP folder to use local GeoLite2-Country.mmdb, GeoLite2-ASN.mmdb and GeoLite2-City.mmdb files. The folder is remembered; restart capture to apply changes. Automatic discovery searches the engine's working directory and standard user/system folders, which can differ from a terminal launch. Missing databases or lookup results appear as Unavailable.",
    ],
    [
      "Capture source",
      "The dot in the capture-source button indicates live capture. Open that button for capture settings and Stop capture. Freeze view only pauses the display; capture and recording continue. Automatic uses PKTAP on macOS when the privileged helper is approved or sudo development mode is active; otherwise it chooses one interface. Linux offers All interfaces (any) when supported. An explicit interface limits capture to that source and disables PKTAP. Apply and restart ends the current session and starts a new one.",
    ],
    [
      "macOS capture helper",
      "In a signed, notarized macOS app, enable the capture helper and approve it in System Settings > General > Login Items & Extensions. Recheck status, choose Automatic and start capture. The interface remains unprivileged, and the engine drops root after opening capture. Stop capture before removing the helper. For unsigned development, run node scripts/desktop-sudo.mjs in a terminal. It builds and tests in isolation before asking for authentication, then starts the desktop with embedded assets. Choose Automatic. Only the capture engine uses sudo; release builds require the signed helper. Other development and ad-hoc launches use ordinary BPF capture with lsof attribution. ChmodBPF does not grant PKTAP access.",
    ],
    [
      "Recording",
      "Enable Record PCAPNG before starting and choose an unused filename. Recording starts with capture and cannot recover earlier packets. Stop capture to finish writing the file.",
    ],
    [
      "Capture health",
      "The sidebar shows sandbox status and packet counters. Dropped packets combine capture, interface, and processing drops. A nonzero count means the capture may be incomplete.",
    ],
  ],
};
const titles = {
  applications: "Applications",
  connections: "Connections",
  inspector: "Connection inspector",
  capture: "Capture settings",
};
export function Help({
  context,
  onClose,
}: {
  context: HelpContext;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="help-dialog"
      aria-labelledby="help-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="help-heading">
        <h2 id="help-title">{titles[context]} help</h2>
        <button
          autoFocus
          className="icon-button"
          aria-label="Close help"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="help-body scroll-region">
        <dl className="help-topics">
          {topics[context].map(([title, text]) => (
            <div key={title}>
              <dt>{title}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
        <h3>Mouse navigation</h3>
        <dl className="help-shortcuts">
          <div>
            <dt>
              <kbd>↑</kbd> / <kbd>↓</kbd>
            </dt>
            <dd>Scroll the current content pane</dd>
          </div>
          <div>
            <dt>
              <kbd>Page Up</kbd> / <kbd>Page Down</kbd>
            </dt>
            <dd>Scroll one page; Home/End jump to either end</dd>
          </div>
          <div>
            <dt>Back button</dt>
            <dd>Return to the previous view or selection.</dd>
          </div>
          <div>
            <dt>Forward button</dt>
            <dd>Revisit the view or selection you went back from.</dd>
          </div>
        </dl>
        <h3>Keyboard shortcuts</h3>
        <dl className="help-shortcuts">
          <div>
            <dt>
              <kbd>↑</kbd> / <kbd>↓</kbd>
            </dt>
            <dd>Scroll the current content pane</dd>
          </div>
          <div>
            <dt>
              <kbd>Page Up</kbd> / <kbd>Page Down</kbd>
            </dt>
            <dd>Scroll one page; Home/End jump to either end</dd>
          </div>
          <div>
            <dt>
              <kbd>h</kbd>
            </dt>
            <dd>Open or close help for this view</dd>
          </div>
          <div>
            <dt>
              <kbd>/</kbd>
            </dt>
            <dd>Find connections</dd>
          </div>
          {(context === "connections" || context === "inspector") && (
            <>
              <div>
                <dt>
                  <kbd>g</kbd> / <kbd>G</kbd>
                </dt>
                <dd>First / last filtered connection</dd>
              </div>
              <div>
                <dt>
                  <kbd>Ctrl+f</kbd> / <kbd>Ctrl+b</kbd>
                </dt>
                <dd>Next / previous page of connections</dd>
              </div>
            </>
          )}
          {(context === "connections" || context === "inspector") && (
            <div>
              <dt>
                <kbd>t</kbd>
              </dt>
              <dd>Show / hide historic connections</dd>
            </div>
          )}
          <div>
            <dt>
              <kbd>Alt+←</kbd> / <kbd>Alt+→</kbd>
            </dt>
            <dd>Back / forward through navigation history</dd>
          </div>
          <div>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>Close help, details, or settings</dd>
          </div>
        </dl>
        <p className="help-note">
          Letter shortcuts are inactive while typing or using dropdowns.
        </p>
      </div>
    </dialog>
  );
}
