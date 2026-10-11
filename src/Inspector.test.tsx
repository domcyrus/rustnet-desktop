// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Inspector } from "./Inspector";
import { richConnectionFixture, viewFixture } from "./test-fixtures";
import { parseView } from "./model";

let spacious = false;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe() {
        this.callback([
          { contentRect: { width: spacious ? 1300 : 400, height: 800 } },
        ]);
      }
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  spacious = false;
});
const show = () =>
  render(
    <Inspector
      connection={richConnectionFixture()}
      expanded
      onExpand={() => {}}
      onClose={() => {}}
    />,
  );
it("shows the same rich record together in a spacious inspector", () => {
  spacious = true;
  const { container } = show();
  for (const label of [
    "Network context",
    "Process",
    "Protocol",
    "Transport health",
    "TLS Version",
    "Parent PID",
    "Packets received",
    "Captured DNS",
    "user:user",
    "83.97 kB",
    "(raw, scale unknown)",
  ]) {
    expect(container.textContent).toContain(label);
  }
  expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
  expect(container.querySelector(".process-lineage")?.textContent).toMatch(
    /systemd.*gnome-shell.*Firefox/,
  );
});
it("keeps all metadata reachable through compact tabs", () => {
  show();
  expect(screen.getByRole("heading", { name: "Network context" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Process" }));
  expect(screen.getByText("/usr/lib/firefox/firefox")).toBeTruthy();
  expect(screen.getByText(/socket present when capture started/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Protocol" }));
  expect(screen.getByText("TLS 1.3")).toBeTruthy();
  expect(screen.getByText("32.77 kB (raw, scale unknown)")).toBeTruthy();
});
it("validates rich snapshots and rejects malformed nested metadata", () => {
  const view = viewFixture();
  view.snapshot!.connections = [richConnectionFixture()];
  expect(parseView(view)).toBe(view);
  for (const override of [
    { protocol_details: [{ label: "SNI", value: {}, warning: false }] },
    {
      process: {
        ...richConnectionFixture().process,
        lineage: { ancestors: [{}], truncated: false },
      },
    },
    {
      tcp_health: {
        ...richConnectionFixture().tcp_health,
        local_receive_window: { bytes: 123, scale_known: "yes" },
      },
    },
    { geoip: { asn: "invalid" } },
    { network_context: { local_mac: { mac: {} } } },
  ]) {
    const malformed = structuredClone(view);
    Object.assign(malformed.snapshot!.connections[0], override);
    expect(() => parseView(malformed)).toThrow("Invalid connection details");
  }
});
