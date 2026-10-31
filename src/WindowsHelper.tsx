import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

export function WindowsHelper() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void invoke<boolean>("windows_capture_helper").then((value) => {
      if (!cancelled) setAvailable(value === true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (!available) return null;
  return (
    <div className="geoip-settings" aria-label="Windows capture helper">
      <div>
        <strong>Windows capture permissions</strong>
        <p>Starting capture asks for administrator approval for the capture engine. The desktop stays unprivileged.</p>
        <small>The helper exits when capture stops. Restarting capture asks for approval again.</small>
      </div>
    </div>
  );
}
