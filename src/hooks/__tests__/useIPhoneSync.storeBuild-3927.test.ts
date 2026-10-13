/**
 * BACKLOG-3927 (Microsoft Store build): useIPhoneSync records the Apple
 * Devices state on every path that shows the guide, re-checks while no iPhone
 * is connected (bounded interval + window focus), and a sync attempted before
 * Apple Devices is ready shows the Store text, never "Click Install below".
 *
 * checkApple fixtures mirror what checkAppleDrivers returns when its probe ran
 * (electron/services/appleDriverService.ts): isInstalled / serviceRunning /
 * installedVia plus appleDevices.state.
 */
import { renderHook, act } from "@testing-library/react";
import {
  useIPhoneSync,
  STORE_RECHECK_INTERVAL_MS,
  STORE_RECHECK_MAX,
  STORE_FOCUS_THROTTLE_MS,
} from "../useIPhoneSync";

let mockPlatform = { isWindows: true, isMacOS: false, isLinux: false, platform: "windows" };
jest.mock("../../contexts/PlatformContext", () => ({
  usePlatform: () => mockPlatform,
}));

type State = "not-installed" | "not-running" | "msi-service-stopped" | "usb-driver-missing" | "ready";
const driverStatus = (state: State) => ({
  isInstalled: state !== "not-installed",
  serviceRunning: state === "ready" || state === "usb-driver-missing",
  version: null,
  error: null,
  installedVia: state === "not-installed" ? null : "apple-devices",
  appleDevices: { state },
});

function setupApi(store: boolean, first: State) {
  const checkApple = jest.fn().mockResolvedValue(driverStatus(first));
  (window as unknown as { api: unknown }).api = {
    system: store ? { isStoreBuild: true } : {},
    device: {
      startDetection: jest.fn(),
      stopDetection: jest.fn(),
      onConnected: jest.fn(() => jest.fn()),
      onDisconnected: jest.fn(() => jest.fn()),
    },
    drivers: { checkApple, installApple: jest.fn() },
  };
  return checkApple;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockPlatform = { isWindows: true, isMacOS: false, isLinux: false, platform: "windows" };
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("useIPhoneSync — Store build (BACKLOG-3927)", () => {
  it("mount: records the state and sets driverMissing", async () => {
    setupApi(true, "not-running");
    const { result } = renderHook(() => useIPhoneSync(true));
    await flush();
    expect(result.current.appleDevicesState).toBe("not-running");
    expect(result.current.driverMissing).toBe(true);
  });

  it("SR U5: sync attempted before Apple Devices is ready -> Store text, never 'Click Install below'; state recorded", async () => {
    const checkApple = setupApi(true, "ready");
    const { result } = renderHook(() => useIPhoneSync(true));
    await flush();
    expect(result.current.appleDevicesState).toBe("ready");
    checkApple.mockResolvedValue(driverStatus("usb-driver-missing"));
    await act(async () => {
      await result.current.startSync();
    });
    expect(result.current.driverMissing).toBe(true);
    expect(result.current.userError?.title).toBe("Apple Devices isn't ready yet");
    expect(JSON.stringify(result.current.userError)).not.toMatch(/Click Install below/i);
    // The sync-attempt path records the state the guide renders.
    expect(result.current.appleDevicesState).toBe("usb-driver-missing");
  });

  it("plug-after-mount: the bounded re-check picks up a state change while not connected", async () => {
    const checkApple = setupApi(true, "ready");
    const { result } = renderHook(() => useIPhoneSync(true));
    await flush();
    act(() => result.current.setConnectScreenActive(true));
    expect(result.current.driverMissing).toBe(false);
    checkApple.mockResolvedValue(driverStatus("usb-driver-missing"));
    await act(async () => {
      jest.advanceTimersByTime(STORE_RECHECK_INTERVAL_MS);
    });
    await flush();
    expect(result.current.appleDevicesState).toBe("usb-driver-missing");
    expect(result.current.driverMissing).toBe(true);
  });

  it(`re-check is bounded: at most ${STORE_RECHECK_MAX} interval probes per visit`, async () => {
    const checkApple = setupApi(true, "ready");
    const { result } = renderHook(() => useIPhoneSync(true));
    await flush();
    act(() => result.current.setConnectScreenActive(true));
    await flush();
    const afterMount = checkApple.mock.calls.length;
    for (let i = 0; i < STORE_RECHECK_MAX + 10; i++) {
      await act(async () => {
        jest.advanceTimersByTime(STORE_RECHECK_INTERVAL_MS);
      });
      await flush();
    }
    expect(checkApple.mock.calls.length - afterMount).toBe(STORE_RECHECK_MAX);
  });

  it("window focus re-checks", async () => {
    const checkApple = setupApi(true, "ready");
    const { result } = renderHook(() => useIPhoneSync(true));
    await flush();
    act(() => result.current.setConnectScreenActive(true));
    // Move the clock past the throttle window without firing the interval.
    jest.setSystemTime(Date.now() + STORE_FOCUS_THROTTLE_MS + 1);
    checkApple.mockResolvedValue(driverStatus("not-installed"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(result.current.appleDevicesState).toBe("not-installed");
  });
});

describe("useIPhoneSync — re-check is tied to the Connect screen (SR round 3)", () => {
  const advance = async (ms: number) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
    await flush();
  };

  it("no probe at all (interval or focus) while the Connect screen is not shown", async () => {
    const checkApple = setupApi(true, "ready");
    renderHook(() => useIPhoneSync(true));
    await flush();
    const afterMount = checkApple.mock.calls.length;
    await advance(STORE_RECHECK_INTERVAL_MS * 5);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(checkApple.mock.calls.length).toBe(afterMount);
  });

  it("no probe runs after the Connect screen closes (interval and focus)", async () => {
    const checkApple = setupApi(true, "ready");
    const { result } = renderHook(() => useIPhoneSync(true));
    await flush();
    act(() => result.current.setConnectScreenActive(true));
    await advance(STORE_RECHECK_INTERVAL_MS);
    act(() => result.current.setConnectScreenActive(false));
    await flush();
    const afterClose = checkApple.mock.calls.length;
    await advance(STORE_RECHECK_INTERVAL_MS * 5);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(checkApple.mock.calls.length).toBe(afterClose);
  });

  it("focus spam yields at most one probe per throttle window", async () => {
    const checkApple = setupApi(true, "ready");
    const { result } = renderHook(() => useIPhoneSync(true));
    await flush();
    act(() => result.current.setConnectScreenActive(true));
    const before = checkApple.mock.calls.length;
    const spam = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await act(async () => {
          window.dispatchEvent(new Event("focus"));
        });
        await flush();
      }
    };
    // Inside the window opened by the mount probe: nothing.
    await spam(25);
    expect(checkApple.mock.calls.length - before).toBe(0);
    // Window elapsed (clock jump, interval not fired): spam -> exactly one.
    jest.setSystemTime(Date.now() + STORE_FOCUS_THROTTLE_MS + 1);
    await spam(25);
    expect(checkApple.mock.calls.length - before).toBe(1);
    // Next window: one more.
    jest.setSystemTime(Date.now() + STORE_FOCUS_THROTTLE_MS + 1);
    await spam(25);
    expect(checkApple.mock.calls.length - before).toBe(2);
  });

  it("SR S14: re-check stops once the iPhone connects (no probe on interval or focus)", async () => {
    const checkApple = setupApi(true, "ready");
    let onConnected: ((d: unknown) => void) | undefined;
    (window as unknown as { api: { device: { onConnected: jest.Mock } } }).api.device.onConnected = jest.fn(
      (cb: (d: unknown) => void) => {
        onConnected = cb;
        return jest.fn();
      },
    );
    const { result } = renderHook(() => useIPhoneSync(true));
    await flush();
    act(() => result.current.setConnectScreenActive(true));
    await advance(STORE_RECHECK_INTERVAL_MS);
    expect(onConnected).toBeDefined();
    act(() => onConnected!({ name: "iPhone", udid: "u", productType: "iPhone", productVersion: "17", serialNumber: "s", isConnected: true }));
    await flush();
    expect(result.current.isConnected).toBe(true);
    const afterConnect = checkApple.mock.calls.length;
    await advance(STORE_RECHECK_INTERVAL_MS * 5);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(checkApple.mock.calls.length).toBe(afterConnect);
  });
});

describe("useIPhoneSync — website build has no re-check loop (BACKLOG-3927)", () => {
  it("one check on mount, none on the interval", async () => {
    const checkApple = setupApi(false, "ready");
    renderHook(() => useIPhoneSync(true));
    await flush();
    const afterMount = checkApple.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(STORE_RECHECK_INTERVAL_MS * 3);
    });
    await flush();
    expect(checkApple.mock.calls.length).toBe(afterMount);
  });
});
