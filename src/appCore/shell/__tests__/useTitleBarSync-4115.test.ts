/**
 * BACKLOG-4115 PR-3: visibility x source x step (sweep iii / x), the Q2 flip,
 * the click targets, and B6 through the real wiring (no Android poll unless
 * the Android pill is visible).
 */
import { renderHook, act } from "@testing-library/react";
import { useTitleBarSync, pillVisible, PILL_ON_EVERY_SCREEN } from "../useTitleBarSync";
import { rcsImportService } from "../../../services/rcsImportService";
import { ANDROID_PILL_POLL_MS } from "../../../hooks/useAndroidSyncState";
import { IPHONE_STATES, EXT_BASE, LISTENING } from "./syncPillFixtures";
import type { AppStateMachine, AppStep } from "../../state/types";
import type { ImportSource } from "../../../services/settingsService";

let mockSource: ImportSource | null = "macos-native";
jest.mock("../../../hooks/useImportSource", () => ({ useImportSource: () => mockSource }));
jest.mock("../../../contexts/PlatformContext", () => ({ usePlatform: () => ({ isMacOS: true, isWindows: false }) }));
let mockIPhone: unknown = null;
let mockEnabled = true;
jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useOptionalIPhoneSyncContext: () => mockIPhone,
  useIPhoneSyncEnabled: () => ({ enabled: mockEnabled, setIphoneSyncEnabled: async () => {}, applyImportSource: () => {} }),
}));
jest.mock("../../../services/rcsImportService", () => ({
  rcsImportService: { getExtensionState: jest.fn(), getStatus: jest.fn(), getJob: jest.fn(), onJobProgress: jest.fn() },
}));
const svc = rcsImportService as jest.Mocked<typeof rcsImportService>;

const makeApp = (step: AppStep = "dashboard", showSettings = false): AppStateMachine =>
  ({
    currentStep: step,
    isAuthenticated: true,
    currentUser: { id: "user-1", email: "a@example.com" },
    modalState: { showSettings },
    openIPhoneSync: jest.fn(),
    openAndroidSync: jest.fn(),
  }) as unknown as AppStateMachine;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockSource = "macos-native";
  mockIPhone = { ...IPHONE_STATES.notConnected.sync };
  mockEnabled = true;
  svc.getExtensionState.mockResolvedValue({ success: true, data: EXT_BASE });
  svc.getStatus.mockResolvedValue({ success: true, data: LISTENING });
  svc.getJob.mockResolvedValue({ success: true, data: null });
  svc.onJobProgress.mockReturnValue(() => {});
});
afterEach(() => jest.useRealTimers());

describe("pill by source on the dashboard (default visibility)", () => {
  it.each([
    ["macos-native", null],
    [null, null],
    ["iphone-sync", "iphone"],
    ["android-messages-web", "android"],
    ["android-companion", "android"],
  ] as const)("source %s -> %s", (source, device) => {
    mockSource = source;
    const { result } = renderHook(() => useTitleBarSync(makeApp()));
    expect(result.current.pill?.device ?? null).toBe(device);
  });

  it("iphone-sync without the provider -> no pill", () => {
    mockSource = "iphone-sync";
    mockIPhone = null;
    const { result } = renderHook(() => useTitleBarSync(makeApp()));
    expect(result.current.pill).toBeNull();
  });

  it("iphone-sync with detection off -> the B2 pill", () => {
    mockSource = "iphone-sync";
    mockEnabled = false;
    const { result } = renderHook(() => useTitleBarSync(makeApp()));
    expect(result.current.pill?.tooltip).toBe("iPhone sync is off in Settings");
  });
});

describe("clicks open the same flows as the old tiles", () => {
  it("iPhone -> openIPhoneSync", () => {
    mockSource = "iphone-sync";
    const app = makeApp();
    const { result } = renderHook(() => useTitleBarSync(app));
    result.current.onClick();
    expect(app.openIPhoneSync).toHaveBeenCalledTimes(1);
    expect(app.openAndroidSync).not.toHaveBeenCalled();
  });
  it.each(["android-messages-web", "android-companion"] as const)("%s -> openAndroidSync() with no argument", (source) => {
    mockSource = source;
    const app = makeApp();
    const { result } = renderHook(() => useTitleBarSync(app));
    result.current.onClick();
    expect(app.openAndroidSync).toHaveBeenCalledTimes(1);
    expect((app.openAndroidSync as jest.Mock).mock.calls[0]).toEqual([]);
  });
});

describe("Q2: where the pill lives", () => {
  it("defaults to dashboard only (PM D1)", () => {
    expect(PILL_ON_EVERY_SCREEN).toBe(false);
  });
  it.each(["phone-type-selection", "permissions", "error"] as AppStep[])("default: step %s -> no pill", (step) => {
    mockSource = "iphone-sync";
    const { result } = renderHook(() => useTitleBarSync(makeApp(step)));
    expect(result.current.pill).toBeNull();
  });
  it("default: the Settings page (dashboard step underneath) -> no pill", () => {
    mockSource = "iphone-sync";
    const { result } = renderHook(() => useTitleBarSync(makeApp("dashboard", true)));
    expect(result.current.pill).toBeNull();
  });
  it("flipped: the Settings page and the error screen show the pill", () => {
    mockSource = "iphone-sync";
    expect(renderHook(() => useTitleBarSync(makeApp("dashboard", true), true)).result.current.pill?.device).toBe("iphone");
    expect(renderHook(() => useTitleBarSync(makeApp("error"), true)).result.current.pill?.device).toBe("iphone");
  });
  it("flipped: onboarding, loading and signed-out show none", () => {
    const user = {} as never;
    const ms = { showSettings: false };
    expect(pillVisible({ currentStep: "phone-type-selection", isAuthenticated: true, currentUser: user, modalState: ms }, true)).toBe(false);
    expect(pillVisible({ currentStep: "loading", isAuthenticated: true, currentUser: user, modalState: ms }, true)).toBe(false);
    expect(pillVisible({ currentStep: "dashboard", isAuthenticated: false, currentUser: null, modalState: ms }, true)).toBe(false);
    expect(pillVisible({ currentStep: "dashboard", isAuthenticated: true, currentUser: user, modalState: ms }, true)).toBe(true);
  });
});

describe("B6 through the wiring: the Android poll runs only for the visible Android pill", () => {
  const polls = async (source: ImportSource | null, step: AppStep) => {
    mockSource = source;
    const { unmount } = renderHook(() => useTitleBarSync(makeApp(step)));
    await act(async () => {
      jest.advanceTimersByTime(ANDROID_PILL_POLL_MS * 3 + 1);
      await Promise.resolve();
    });
    const n = svc.getExtensionState.mock.calls.length;
    unmount();
    return n;
  };
  it.each([
    ["iphone-sync", "dashboard", 0],
    ["macos-native", "dashboard", 0],
    ["android-companion", "dashboard", 0],
    ["android-messages-web", "permissions", 0],
  ] as const)("%s on %s -> %i reads", async (source, step, n) => {
    expect(await polls(source, step as AppStep)).toBe(n);
  });
  it("android-messages-web on the dashboard -> >= 2 reads", async () => {
    expect(await polls("android-messages-web", "dashboard")).toBeGreaterThanOrEqual(2);
  });
});
