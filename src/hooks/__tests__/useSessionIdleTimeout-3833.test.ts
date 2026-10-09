/**
 * BACKLOG-3833: renderer half of the session idle timeout.
 * - user input reports activity to main at most once per minute
 * - main's idle sign-out runs the normal logout flow, no reload needed
 */
import { renderHook, act } from "@testing-library/react";
import { useSessionIdleTimeout, IDLE_SIGN_OUT_MESSAGE } from "../useIdleSessionExpiry";
import { USER_ACTIVITY_EVENTS } from "../useUserActivityHeartbeat";

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const SEC = 1000;

describe("useSessionIdleTimeout (BACKLOG-3833)", () => {
  let reportUserActivity: jest.Mock;
  let expiredListener: (() => void) | null;
  let unsubscribe: jest.Mock;
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse("2026-10-08T12:00:00Z"));
    reportUserActivity = jest.fn().mockResolvedValue(undefined);
    expiredListener = null;
    unsubscribe = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).api = {
      auth: {
        reportUserActivity,
        onIdleSessionExpired: (cb: () => void) => {
          expiredListener = cb;
          return unsubscribe;
        },
      },
    };
    alertSpy = jest.spyOn(window, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
    jest.useRealTimers();
  });

  const press = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));

  it("sends at most one activity IPC per minute, with no arguments", () => {
    const onExpired = jest.fn().mockResolvedValue(undefined);
    renderHook(() => useSessionIdleTimeout({ isAuthenticated: true, onExpired }));

    // 20 key presses over 59 s -> one report
    for (let i = 0; i < 20; i++) {
      press();
      jest.advanceTimersByTime(2.95 * SEC);
    }
    expect(reportUserActivity).toHaveBeenCalledTimes(1);
    expect(reportUserActivity).toHaveBeenCalledWith();

    // One minute after the first report, input reports again
    jest.advanceTimersByTime(1.1 * SEC);
    press();
    expect(reportUserActivity).toHaveBeenCalledTimes(2);

    // Continuous input for 10 more minutes -> at most one per minute
    for (let s = 0; s < 600; s++) {
      press();
      jest.advanceTimersByTime(SEC);
    }
    expect(reportUserActivity.mock.calls.length).toBeLessThanOrEqual(2 + 10);
    expect(reportUserActivity.mock.calls.length).toBeGreaterThanOrEqual(2 + 9);
  });

  it.each(USER_ACTIVITY_EVENTS.map((t) => [t]))("%s counts as user input", (type) => {
    const onExpired = jest.fn().mockResolvedValue(undefined);
    renderHook(() => useSessionIdleTimeout({ isAuthenticated: true, onExpired }));
    window.dispatchEvent(new Event(type));
    expect(reportUserActivity).toHaveBeenCalledTimes(1);
  });

  it("reports nothing while signed out", () => {
    const onExpired = jest.fn().mockResolvedValue(undefined);
    renderHook(() => useSessionIdleTimeout({ isAuthenticated: false, onExpired }));
    press();
    expect(reportUserActivity).not.toHaveBeenCalled();
    expect(expiredListener).toBeNull();
  });

  it("main's idle sign-out runs the logout flow without a reload", async () => {
    const onExpired = jest.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() =>
      useSessionIdleTimeout({ isAuthenticated: true, onExpired }),
    );
    expect(expiredListener).not.toBeNull();
    await act(async () => {
      expiredListener!();
      expiredListener!(); // a duplicate notice signs out once
    });
    expect(alertSpy).toHaveBeenCalledWith(IDLE_SIGN_OUT_MESSAGE);
    expect(onExpired).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
