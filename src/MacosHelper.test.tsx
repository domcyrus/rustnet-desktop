// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { MacosHelper } from "./MacosHelper";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("macOS helper approval", () => {
  it("supports registration, approval refresh and removal without changing capture", async () => {
    let state = { status: "not_registered", can_register: true, message: "Enable helper" };
    vi.mocked(invoke).mockImplementation(async (_command, options) => {
      const action = (options as { action: string }).action;
      if (action === "register") state = { ...state, status: "requires_approval", message: "Approval required" };
      if (action === "unregister") state = { ...state, status: "not_registered", message: "Enable helper" };
      return state;
    });
    render(<MacosHelper active={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable capture helper" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open System Settings" }));
    expect(invoke).toHaveBeenCalledWith("macos_helper", { action: "settings" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Recheck helper status" }).hasAttribute("disabled")).toBe(false));
    state = { ...state, status: "enabled", message: "PKTAP ready" };
    fireEvent.click(screen.getByRole("button", { name: "Recheck helper status" }));
    await screen.findByText("PKTAP ready");
    fireEvent.click(screen.getByRole("button", { name: "Remove capture helper" }));
    await screen.findByRole("button", { name: "Enable capture helper" });
    expect(vi.mocked(invoke).mock.calls.every(([command]) => command === "macos_helper")).toBe(true);
  });

  it("blocks removal during capture and surfaces registration errors", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: "enabled", can_register: true, message: "Enabled" });
    const { rerender } = render(<MacosHelper active={true} />);
    const remove = await screen.findByRole("button", { name: "Remove capture helper" });
    expect(remove.hasAttribute("disabled")).toBe(true);
    rerender(<MacosHelper active={false} />);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Authorization denied"));
    fireEvent.click(remove);
    expect((await screen.findByRole("alert")).textContent).toBe("Authorization denied");
  });

  it("shows sudo development mode without offering helper registration", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: "dev_sudo", can_register: false, message: "Sudo development mode: authenticate in the terminal" });
    render(<MacosHelper active={false} />);
    await screen.findByText("Sudo development mode: authenticate in the terminal");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/desktop stays unprivileged/)).toBeTruthy();
  });

  it("hides controls on other platforms and for unsigned builds", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: "unavailable", can_register: false, message: "Signed app required" });
    render(<MacosHelper active={false} />);
    await screen.findByText("Signed app required");
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    vi.mocked(invoke).mockResolvedValue(null);
    render(<MacosHelper active={false} />);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText("macOS capture helper")).toBeNull();
  });
});
