/**
 * SR (2026-10-04): the Sync Android modal's start ("link" from Settings'
 * Link / Relink or keepr://link) is modal state set WHEN it opens — never a
 * module flag — so it can't leak into a later dashboard open, and StrictMode's
 * double initializer can't consume it.
 *
 * Mutations: the start not reset on close; a dashboard open keeping "link";
 * an event passed by onClick read as "link" → red.
 */
import { act, renderHook } from "@testing-library/react";
import { useModalFlow } from "../useModalFlow";

describe("the Sync Android modal's start", () => {
  it("Settings' Link opens at the link step; closed without linking, a dashboard open is the normal step", () => {
    const { result } = renderHook(() => useModalFlow());
    expect(result.current.modalState.androidSyncStart).toBe("default");
    act(() => result.current.openAndroidSync("link"));
    expect(result.current.modalState.showAndroidSync).toBe(true);
    expect(result.current.modalState.androidSyncStart).toBe("link");
    act(() => result.current.closeAndroidSync());
    expect(result.current.modalState.androidSyncStart).toBe("default");
    act(() => result.current.openAndroidSync());
    expect(result.current.modalState.androidSyncStart).toBe("default");
  });

  it("a dashboard open replaces a link start even without a close in between; an onClick event is never 'link'", () => {
    const { result } = renderHook(() => useModalFlow());
    act(() => result.current.openAndroidSync("link"));
    act(() => (result.current.openAndroidSync as (x: unknown) => void)({ type: "click" }));
    expect(result.current.modalState.androidSyncStart).toBe("default");
  });
});
