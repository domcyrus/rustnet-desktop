import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Blocks, CircleHelp } from "lucide-react";
import type { Application } from "./model";

type IconRequest = { executable: string | null; name: string; pids: number[] };
const icons = new Map<
  string,
  { promise: Promise<string | null>; expires: number }
>();

function loadIcon(key: string): Promise<string | null> {
  const cached = icons.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const request: IconRequest = JSON.parse(key);
  const entry = {
    expires: Infinity,
    promise: invoke<string | null>("application_icon", request)
      .then((icon) =>
        typeof icon === "string" && icon.startsWith("data:image/png;base64,")
          ? icon
          : null,
      )
      .catch(() => null)
      .then((icon) => {
        entry.expires = Date.now() + (icon ? 300_000 : 30_000);
        return icon;
      }),
  };
  icons.delete(key);
  icons.set(key, entry);
  // Bound memory while sharing in-flight lookups between the list and details.
  if (icons.size > 256) icons.delete(icons.keys().next().value!);
  return entry.promise;
}

export function ApplicationIcon({
  app,
  large = false,
}: {
  app: Pick<Application, "executable" | "name" | "pids">;
  large?: boolean;
}) {
  const key = JSON.stringify({
    executable: app.executable || null,
    name: app.name,
    pids: app.executable ? [] : [...app.pids].sort((a, b) => a - b).slice(0, 32),
  });
  const [loaded, setLoaded] = useState<{ key: string; icon: string | null }>();
  const icon = loaded?.key === key ? loaded.icon : null;
  const unattributed = app.name === "Unattributed";

  useEffect(() => {
    if (!isTauri() || unattributed) return;
    let cancelled = false;
    void loadIcon(key).then((icon) => {
      if (!cancelled) setLoaded({ key, icon });
    });
    return () => {
      cancelled = true;
    };
  }, [key, unattributed]);

  return (
    <span
      className={`app-icon${large ? " large" : ""}${icon ? " native" : ""}`}
      aria-hidden="true"
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          draggable={false}
          onError={() => setLoaded({ key, icon: null })}
        />
      ) : unattributed ? (
        <CircleHelp size={large ? 23 : 20} />
      ) : (
        <Blocks size={large ? 23 : 20} />
      )}
    </span>
  );
}
