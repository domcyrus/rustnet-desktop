// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Chart } from "./Chart";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("traffic chart scale", () => {
  it("reveals small flows after a large burst without changing their values", () => {
    const points = [
      { time: 1000, rx: 300_000_000, tx: 0 },
      { time: 2000, rx: 5570, tx: 4740 },
    ];
    const { container } = render(<Chart points={points} label="Traffic" />);
    const latestY = () =>
      Number(
        container.querySelector(".rx-line")!.getAttribute("d")!.split(",").at(-1),
      );
    expect(latestY()).toBeGreaterThan(121);
    expect(screen.getByText(/Current traffic is below one pixel/)).toBeTruthy();
    const accessibleLabel = screen.getByRole("img").getAttribute("aria-label")!;
    fireEvent.click(screen.getByRole("button", { name: "Log scale" }));
    expect(latestY()).toBeLessThan(80);
    expect(screen.queryByText(/Current traffic is below one pixel/)).toBeNull();
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      accessibleLabel.replace("Linear", "Logarithmic"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Log scale" }));
    expect(latestY()).toBeGreaterThan(121);
  });

  it("keeps zero at the baseline and handles empty histories on log scale", () => {
    const { container, rerender } = render(<Chart points={[]} label="Traffic" />);
    fireEvent.click(screen.getByRole("button", { name: "Log scale" }));
    expect(screen.getByText("Waiting for capture")).toBeTruthy();
    rerender(<Chart points={[{ time: 1000, rx: 0, tx: 0 }]} label="Traffic" />);
    expect(container.querySelector(".rx-dot")!.getAttribute("cy")).toBe("122");
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    expect(screen.queryByText(/Current traffic is below one pixel/)).toBeNull();
  });
});
