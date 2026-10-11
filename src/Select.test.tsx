// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Select } from "./Select";
afterEach(cleanup);
const options = [
  { value: "all", label: "All protocols" },
  { value: "https", label: "HTTPS" },
  { value: "quic", label: "QUIC" },
];
it("supports keyboard selection, typeahead and Escape without committing a highlighted option", () => {
  const onChange = vi.fn();
  render(
    <Select
      label="Protocol"
      value="all"
      options={options}
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("combobox", { name: "Protocol" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyDown(trigger, { key: "End" });
  expect(
    document.getElementById(trigger.getAttribute("aria-activedescendant")!)
      ?.textContent,
  ).toBe("QUIC");
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.keyDown(trigger, { key: "h" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("https");
  expect(document.activeElement).toBe(trigger);
});
it("selects with the pointer and dismisses on outside interaction or Tab", () => {
  const onChange = vi.fn();
  render(
    <Select
      label="Protocol"
      value="https"
      options={options}
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("combobox");
  fireEvent.click(trigger);
  expect(
    screen.getByRole("option", { name: "HTTPS" }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("option", { name: "QUIC" }));
  expect(onChange).toHaveBeenCalledWith("quic");
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.keyDown(trigger, { key: "Tab" });
  expect(screen.queryByRole("listbox")).toBeNull();
});
it("closes when disabled and safely handles disappearing options", () => {
  const props = { label: "Protocol", value: "all", options, onChange: vi.fn() };
  const { rerender } = render(<Select {...props} />);
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "End" });
  rerender(<Select {...props} options={[options[0]]} />);
  expect(
    document.getElementById(
      screen.getByRole("combobox").getAttribute("aria-activedescendant")!,
    )?.textContent,
  ).toBe("All protocols");
  rerender(<Select {...props} disabled />);
  expect(screen.queryByRole("listbox")).toBeNull();
});
