// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ApplicationIcon } from "./ApplicationIcon";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const png = "data:image/png;base64,iVBORw0KGgo=";
const app = { name: "Firefox", executable: "/Applications/Firefox.app/Contents/MacOS/firefox", pids: [42] };

describe("native application icons", () => {
  it("shares a lookup between list and details, including capture refreshes", async () => {
    vi.mocked(invoke).mockResolvedValue(png);
    const { container, rerender } = render(<><ApplicationIcon app={app} /><ApplicationIcon app={app} large /></>);
    await waitFor(() => expect(container.querySelectorAll("img").length).toBe(2));
    expect(invoke).toHaveBeenCalledExactlyOnceWith("application_icon", {
      executable: app.executable, name: "Firefox", pids: [],
    });
    rerender(<ApplicationIcon app={{ ...app, pids: [43, 44] }} />);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")?.alt).toBe("");
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("uses stable live PIDs when the executable is unavailable", async () => {
    vi.mocked(invoke).mockResolvedValue(png);
    const process = { name: "no-path", executable: null, pids: [22, 11] };
    const { container, rerender } = render(<ApplicationIcon app={process} />);
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(invoke).toHaveBeenCalledExactlyOnceWith("application_icon", {
      executable: null, name: "no-path", pids: [11, 22],
    });
    rerender(<ApplicationIcon app={{ ...process, pids: [11, 22] }} />);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([null, "https://example.com/icon.png", "invalid"])("keeps the fallback for unsupported responses: %s", async (response) => {
    vi.mocked(invoke).mockResolvedValue(response);
    const { container } = render(<ApplicationIcon app={{ ...app, name: `response-${response}` }} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("keeps the fallback if the native bridge fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("unavailable"));
    const { container } = render(<ApplicationIcon app={{ ...app, name: "bridge-failure" }} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(container.querySelector("img")).toBeNull();
  });

  it("discards results after switching applications", async () => {
    let resolve!: (icon: string) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
    const { container, rerender } = render(<ApplicationIcon app={{ ...app, name: "previous" }} />);
    vi.mocked(invoke).mockResolvedValue(null);
    rerender(<ApplicationIcon app={{ name: "next", executable: "/bin/next", pids: [1] }} />);
    resolve(png);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not query native icons for unattributed traffic or browser previews", () => {
    const { rerender } = render(<ApplicationIcon app={{ name: "Unattributed", executable: null, pids: [] }} />);
    vi.mocked(isTauri).mockReturnValueOnce(false);
    rerender(<ApplicationIcon app={{ ...app, name: "preview" }} />);
    expect(invoke).not.toHaveBeenCalled();
  });
});
