// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useNavigation } from "./useNavigation";

afterEach(cleanup);

it("restores application and expanded connection with mouse Back and Forward", async () => {
  const { result } = renderHook(() => useNavigation("applications"));
  act(() => result.current.navigate({ application: "firefox" }, true));
  act(() =>
    result.current.navigate({
      screen: "connections",
      connection: "socket-1",
      expanded: true,
    }),
  );
  fireEvent.mouseUp(window, { button: 3 });
  await waitFor(() =>
    expect(result.current.navigation.screen).toBe("applications"),
  );
  expect(result.current.navigation.application).toBe("firefox");
  expect(result.current.navigation.connection).toBeNull();
  fireEvent.mouseUp(window, { button: 4 });
  await waitFor(() =>
    expect(result.current.navigation.connection).toBe("socket-1"),
  );
  expect(result.current.navigation.expanded).toBe(true);
  fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
  await waitFor(() =>
    expect(result.current.navigation.screen).toBe("applications"),
  );
});
