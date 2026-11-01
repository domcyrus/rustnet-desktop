// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Inspector } from "./Inspector";
import {
  connectionFixture,
  richConnectionFixture,
  viewFixture,
} from "./test-fixtures";
import { parseView } from "./model";

afterEach(cleanup);
it("shows all three metadata groups together without a nested scroll pane", () => {
  const { container } = render(
    <Inspector connection={richConnectionFixture()} onClose={() => {}} />,
  );
  for (const name of [
    "Connection and traffic",
    "Process details",
    "Protocol details",
  ])
    expect(screen.getByRole("region", { name })).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(container.querySelector(".scroll-region")).toBeNull();
  expect(screen.getByRole("heading", { name: "Network context" })).toBeTruthy();
  expect(container.textContent).toContain("Packets received");
  expect(container.textContent).toContain("Captured DNS");
  expect(screen.getByText("/usr/lib/firefox/firefox")).toBeTruthy();
  expect(screen.getByText(/socket present when capture started/)).toBeTruthy();
  expect(container.querySelector(".process-lineage")?.textContent).toMatch(
    /systemd.*gnome-shell.*Firefox/,
  );
  expect(screen.getByText("TLS 1.3")).toBeTruthy();
  expect(screen.getByText("32.77 kB (raw, scale unknown)")).toBeTruthy();
});
it("hides unobserved metadata until requested and preserves disclosure during live updates", () => {
  const connection = connectionFixture();
  const { rerender } = render(
    <Inspector connection={connection} onClose={() => {}} />,
  );
  expect(screen.queryByText("Parent PID")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Show unobserved fields" }),
  );
  expect(screen.getByText("Parent PID")).toBeTruthy();
  rerender(
    <Inspector
      connection={{ ...connection, state: "CLOSING" }}
      onClose={() => {}}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Hide unobserved fields" }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Hide unobserved fields" }),
  );
  expect(screen.queryByText("Parent PID")).toBeNull();
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
