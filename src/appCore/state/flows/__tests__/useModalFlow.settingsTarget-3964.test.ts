/**
 * BACKLOG-3964: openSettings(target) keeps its target (it used to drop it).
 */
import { act, renderHook } from "@testing-library/react";
import { useModalFlow } from "../useModalFlow";
import { screenNameFor } from "../../../../utils/currentScreenName";

describe("useModalFlow settings target (BACKLOG-3964)", () => {
  it("openSettings(target) opens Settings and stores the target", () => {
    const { result } = renderHook(() => useModalFlow());
    act(() => result.current.openSettings("settings-security"));
    expect(result.current.modalState.showSettings).toBe(true);
    expect(result.current.modalState.settingsTarget).toBe("settings-security");
  });

  it("clearSettingsTarget keeps Settings open; closeSettings clears both", () => {
    const { result } = renderHook(() => useModalFlow());
    act(() => result.current.openSettings("settings-about"));
    act(() => result.current.clearSettingsTarget());
    expect(result.current.modalState).toMatchObject({ showSettings: true, settingsTarget: null });
    act(() => result.current.openSettings("settings-about"));
    act(() => result.current.closeSettings());
    expect(result.current.modalState).toMatchObject({ showSettings: false, settingsTarget: null });
  });

  it("no target, or a non-string passed through from an onClick, is no target", () => {
    const { result } = renderHook(() => useModalFlow());
    act(() => result.current.openSettings());
    expect(result.current.modalState.settingsTarget).toBeNull();
    act(() => (result.current.openSettings as (x: unknown) => void)({ type: "click" }));
    expect(result.current.modalState.settingsTarget).toBeNull();
  });

  it("opening at a target does not close any other popup", () => {
    const { result } = renderHook(() => useModalFlow());
    act(() => result.current.openTransactions());
    act(() => result.current.openSettings("settings-email"));
    act(() => result.current.closeSettings());
    expect(result.current.modalState.showTransactions).toBe(true);
  });

  it("the target is not read as an open popup by screen-name telemetry", () => {
    const { result } = renderHook(() => useModalFlow());
    act(() => result.current.openSettings("settings-email"));
    expect(screenNameFor("dashboard", result.current.modalState as unknown as Record<string, unknown>)).toBe(
      screenNameFor("dashboard", { showSettings: true }),
    );
  });
});
