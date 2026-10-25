import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { errorText } from "./useCapture";

interface HelperState {
  status: string;
  can_register: boolean;
  message: string;
}

export function MacosHelper({ active }: { active: boolean }) {
  const [state, setState] = useState<HelperState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    async function refresh() {
      try {
        const next = await invoke<HelperState | null>("macos_helper", { action: "status" });
        if (!cancelled) { setState(next); setError(null); }
      } catch (reason) {
        if (!cancelled) setError(errorText(reason));
      }
    }
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.removeEventListener("focus", refresh); };
  }, []);

  async function manage(action: string) {
    setBusy(true);
    try {
      setState(await invoke<HelperState>("macos_helper", { action }));
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!state && !error) return null;
  return (
    <div className="geoip-settings" aria-label="macOS capture helper">
      <div>
        <strong>macOS process attribution</strong>
        <p>{state?.message}</p>
        <small>
          Capture opens with administrator privileges through the approved helper
          or sudo development mode; the desktop stays unprivileged. Choose Automatic for PKTAP. Explicit
          interfaces use ordinary capture.
        </small>
        {error && <p role="alert">{error}</p>}
      </div>
      {state?.can_register && (
        <>
          {state.status === "not_registered" && (
            <button className="button" disabled={busy || active} onClick={() => void manage("register")}>
              Enable capture helper
            </button>
          )}
          {state.status === "requires_approval" && (
            <button className="button" disabled={busy} onClick={() => void manage("settings")}>
              Open System Settings
            </button>
          )}
          <button className="button" disabled={busy} onClick={() => void manage("status")}>
            Recheck helper status
          </button>
          {["enabled", "requires_approval"].includes(state.status) && (
            <button className="button" disabled={busy || active} onClick={() => void manage("unregister")}>
              Remove capture helper
            </button>
          )}
        </>
      )}
    </div>
  );
}
