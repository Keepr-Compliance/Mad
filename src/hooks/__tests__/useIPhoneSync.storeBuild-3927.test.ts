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
    renderHook(() => useIPhoneSync(true));
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
    checkApple.mockResolvedValue(driverStatus("not-installed"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(result.current.appleDevicesState).toBe("not-installed");
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
