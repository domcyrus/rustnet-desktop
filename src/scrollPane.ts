/** Keep scrolling keys in the active pane, including when a toolbar owns focus. */
export function scrollPane(event: KeyboardEvent, pane: HTMLElement | null) {
  if (
    !pane ||
    event.defaultPrevented ||
    event.altKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey
  )
    return false;
  if (
    event.target instanceof Element &&
    event.target.closest(
      'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"], [role="slider"], [role="separator"]',
    )
  )
    return false;
  const page = Math.max(40, pane.clientHeight * 0.85);
  const maximum = Math.max(0, pane.scrollHeight - pane.clientHeight);
  let top: number;
  switch (event.key) {
    case "ArrowDown":
      top = pane.scrollTop + 40;
      break;
    case "ArrowUp":
      top = pane.scrollTop - 40;
      break;
    case "PageDown":
      top = pane.scrollTop + page;
      break;
    case "PageUp":
      top = pane.scrollTop - page;
      break;
    case "Home":
      top = 0;
      break;
    case "End":
      top = maximum;
      break;
    default:
      return false;
  }
  event.preventDefault();
  pane.scrollTop = Math.max(0, Math.min(maximum, top));
  return true;
}
