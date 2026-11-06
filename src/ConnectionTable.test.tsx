// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ConnectionTable } from "./ConnectionTable";
import { connectionFixture } from "./test-fixtures";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const png = "data:image/png;base64,iVBORw0KGgo=";
it("shares native icons across live connections while preserving row selection", async () => {
  vi.mocked(invoke).mockResolvedValue(png);
  const a = connectionFixture(),
    b = connectionFixture({ id: "second" });
  const onSelect = vi.fn();
  const { container } = render(
    <ConnectionTable
      filtered={[a, b]}
      sort="process"
      setSort={vi.fn()}
      selectedConnection={null}
      onSelect={onSelect}
    />,
  );
  await waitFor(() =>
    expect(container.querySelectorAll("tbody img")).toHaveLength(2),
  );
  expect(invoke).toHaveBeenCalledExactlyOnceWith("application_icon", {
    executable: "/usr/bin/firefox",
    name: "Firefox",
    pids: [],
  });
  fireEvent.click(
    screen.getAllByRole("button", {
      name: "Inspect Firefox connection to example.org",
    })[0],
  );
  expect(onSelect).toHaveBeenCalledWith(a.id);
});
it("uses a live PID only for active connections and never for retained closed rows", async () => {
  vi.mocked(invoke).mockResolvedValue(png);
  const live = connectionFixture({
    process: { name: "NoPathApp", executable: null, pid: 77 },
  });
  const closed = connectionFixture({
    id: "closed",
    historic: true,
    process: { name: "ClosedApp", executable: null, pid: 88 },
  });
  render(
    <ConnectionTable
      filtered={[live, closed]}
      sort="process"
      setSort={vi.fn()}
      selectedConnection={null}
      onSelect={vi.fn()}
    />,
  );
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(invoke).toHaveBeenCalledWith("application_icon", {
    executable: null,
    name: "NoPathApp",
    pids: [77],
  });
  expect(invoke).toHaveBeenCalledWith("application_icon", {
    executable: null,
    name: "ClosedApp",
    pids: [],
    historical: true,
  });
});
