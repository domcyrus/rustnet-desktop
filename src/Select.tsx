import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

type Option = { value: string; label: string };
export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({
    visibility: "hidden",
  });
  const prefix = useRef({ text: "", time: 0 });
  const selected = options.findIndex((option) => option.value === value);
  const index = Math.min(highlighted, options.length - 1);
  const visible = open && !disabled && options.length > 0;
  function show() {
    setHighlighted(Math.max(0, selected));
    prefix.current = { text: "", time: 0 };
    setOpen(true);
  }
  function choose(next: number) {
    if (options[next]) onChange(options[next].value);
    setOpen(false);
    trigger.current?.focus();
  }
  useLayoutEffect(() => {
    if (!visible) return;
    function place() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upward =
        below < Math.min(280, options.length * 38 + 12) && above > below;
      const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 16);
      setPosition({
        position: "fixed",
        width,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: upward ? undefined : rect.bottom + 6,
        bottom: upward ? window.innerHeight - rect.top + 6 : undefined,
        maxHeight: Math.max(40, Math.min(320, upward ? above : below)),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [visible, options.length]);
  useEffect(() => {
    if (!visible) return;
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !trigger.current?.contains(target) &&
        !popup.current?.contains(target)
      )
        setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [visible]);
  useEffect(() => {
    if (visible)
      document
        .getElementById(`${id}-${index}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [id, index, visible]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  function keydown(event: KeyboardEvent<HTMLButtonElement>) {
    const key = event.key;
    if (key === "Tab") {
      setOpen(false);
      return;
    }
    if (key === "Escape" && visible) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)) {
      event.preventDefault();
      event.stopPropagation();
      if (!visible) {
        show();
        if (key === "End") setHighlighted(options.length - 1);
        return;
      }
      if (key === "Enter" || key === " ") {
        choose(index);
        return;
      }
      setHighlighted(
        key === "Home"
          ? 0
          : key === "End"
            ? options.length - 1
            : Math.max(
                0,
                Math.min(
                  options.length - 1,
                  index + (key === "ArrowDown" ? 1 : -1),
                ),
              ),
      );
      return;
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      const text =
        (now - prefix.current.time < 700 ? prefix.current.text : "") +
        key.toLowerCase();
      prefix.current = { text, time: now };
      const found = options.findIndex((option) =>
        option.label.toLowerCase().startsWith(text),
      );
      if (!visible) setOpen(true);
      if (found >= 0) setHighlighted(found);
    }
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={visible}
        aria-controls={visible ? id : undefined}
        aria-activedescendant={visible ? `${id}-${index}` : undefined}
        disabled={disabled}
        onClick={() => (visible ? setOpen(false) : show())}
        onKeyDown={keydown}
        onBlur={(event) => {
          if (!popup.current?.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        <span>{options[selected]?.label || value || "Select…"}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {visible &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="listbox"
            aria-label={label}
            className="select-popup"
            style={position}
          >
            {options.map((option, i) => (
              <div
                key={option.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={option.value === value}
                className={`select-option ${i === index ? "highlighted" : ""}`}
                onPointerMove={() => setHighlighted(i)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(i)}
              >
                <span>{option.label}</span>
                {option.value === value && (
                  <Check size={15} aria-hidden="true" />
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
