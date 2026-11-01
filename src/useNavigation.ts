import { useCallback, useEffect, useRef, useState } from "react";

export type Navigation = {
  screen: "applications" | "connections";
  connection: string | null;
  application: string | null;
  applicationFilter: { key: string; label: string } | null;
};

export function useNavigation(initialScreen: Navigation["screen"]) {
  const [navigation, setNavigation] = useState<Navigation>({
    screen: initialScreen,
    connection: null,
    application: null,
    applicationFilter: null,
  });
  const current = useRef(navigation);
  const owner = useRef(`rustnet-${Date.now()}-${Math.random()}`);
  const position = useRef(0);
  const end = useRef(0);
  const navigate = useCallback(
    (change: Partial<Navigation>, replace = false) => {
      const next = { ...current.current, ...change };
      if (
        Object.keys(next).every(
          (key) =>
            next[key as keyof Navigation] ===
            current.current[key as keyof Navigation],
        )
      )
        return;
      if (!replace) {
        position.current++;
        end.current = position.current;
      }
      window.history[replace ? "replaceState" : "pushState"](
        {
          rustnetNavigation: {
            owner: owner.current,
            position: position.current,
            view: next,
          },
        },
        "",
      );
      current.current = next;
      setNavigation(next);
    },
    [],
  );
  const back = useCallback(() => {
    if (document.querySelector("dialog[open]")) return;
    if (position.current > 0) window.history.back();
  }, []);
  const forward = useCallback(() => {
    if (document.querySelector("dialog[open]")) return;
    if (position.current < end.current) window.history.forward();
  }, []);
  useEffect(() => {
    window.history.replaceState(
      {
        rustnetNavigation: {
          owner: owner.current,
          position: 0,
          view: current.current,
        },
      },
      "",
    );
    function restore(event: PopStateEvent) {
      const entry = event.state?.rustnetNavigation;
      if (entry?.owner !== owner.current) return;
      position.current = entry.position;
      current.current = entry.view;
      setNavigation(entry.view);
    }
    function suppressNative(event: MouseEvent) {
      if (event.button === 3 || event.button === 4) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    function mouse(event: MouseEvent) {
      if (event.button === 3 || event.button === 4) {
        suppressNative(event);
        if (event.button === 3) back();
        else forward();
      }
    }
    function keyboard(event: KeyboardEvent) {
      if (
        event.altKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        if (event.key === "ArrowLeft") back();
        else forward();
      }
    }
    window.addEventListener("popstate", restore);
    window.addEventListener("mousedown", suppressNative, true);
    window.addEventListener("mouseup", mouse, true);
    window.addEventListener("auxclick", suppressNative, true);
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("mousedown", suppressNative, true);
      window.removeEventListener("mouseup", mouse, true);
      window.removeEventListener("auxclick", suppressNative, true);
      window.removeEventListener("keydown", keyboard);
    };
  }, [back, forward]);
  return { navigation, navigate, back };
}
