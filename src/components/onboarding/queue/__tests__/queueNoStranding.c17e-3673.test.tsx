/**
 * BACKLOG-3673 C17e (SR delta N1) — stranding cases C17d does not cover. Two
 * of them complete ONLY through the queue's isComplete flag (no onComplete
 * call); C17f pins that OnboardingFlow acts on it.
 */
import { renderHook, act } from "@testing-library/react";
import { useOnboardingQueue } from "../useOnboardingQueue";
import type { OnboardingAppState } from "../useOnboardingQueue";

let mockPlatform: { platform: "windows" | "macos" } = { platform: "windows" };
jest.mock("../../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ platform: mockPlatform.platform, isWindows: mockPlatform.platform === "windows", isMacOS: mockPlatform.platform === "macos", isLinux: false }),
}));
jest.mock("../../../../utils/logger", () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

function st(o: Partial<OnboardingAppState>): OnboardingAppState {
  return { phoneType: "android", emailConnected: true, connectedEmail: "user@example.com", emailProvider: "google",
    hasPermissions: false, hasSecureStorage: true, driverSetupComplete: true, termsAccepted: true, authProvider: "google",
    isNewUser: true, isDatabaseInitialized: true, userId: "u1", isUserVerifiedInLocalDb: true, emailSkipped: false,
    driverSkipped: false, isResumedFromFdaRelaunch: false, ...o };
}

it("Mac+iPhone, email skipped, FDA 'skip for now': floor is last; connecting email on the floor completes the queue (effect path, no goToNext)", () => {
  mockPlatform = { platform: "macos" };
  const onComplete = jest.fn();
  let appState = st({ phoneType: "iphone", emailConnected: false, connectedEmail: null, emailProvider: null, emailSkipped: true, hasPermissions: false, driverSetupComplete: false });
  const { result, rerender } = renderHook(({ s }) => useOnboardingQueue({ appState: s, onComplete }), { initialProps: { s: appState } });
  const seen: string[] = [];
  for (let i = 0; i < 15 && result.current.activeStep?.meta.id !== "data-source-floor"; i++) {
    seen.push(result.current.activeStep?.meta.id ?? "(none)");
    act(() => { result.current.goToNext(); });
  }
  expect(result.current.activeStep?.meta.id).toBe("data-source-floor");
  expect(result.current.isComplete).toBe(false);
  expect(onComplete).not.toHaveBeenCalled();
  appState = { ...appState, emailConnected: true, connectedEmail: "user@example.com", emailProvider: "google" };
  rerender({ s: appState });
  expect(result.current.isComplete).toBe(true);
  expect(onComplete).not.toHaveBeenCalled(); // completion must come from OnboardingFlow's isComplete effect
});

it("finished-on-this-computer user with no record (resume marker seeds contact-source + data-sync): queue is complete at mount", () => {
  mockPlatform = { platform: "windows" };
  const onComplete = jest.fn();
  const { result } = renderHook(() => useOnboardingQueue({ appState: st({}), onComplete, initialManuallyCompletedIds: ["contact-source", "data-sync"] }));
  expect(result.current.isComplete).toBe(true);
});

it("half-finished new computer (Windows, phone known, email skipped in cloud, local DB not yet verified): reaches onComplete after data-sync", () => {
  mockPlatform = { platform: "windows" };
  const onComplete = jest.fn();
  let s = st({ emailConnected: false, connectedEmail: null, emailProvider: null, emailSkipped: true, isUserVerifiedInLocalDb: false });
  const { result, rerender } = renderHook(({ s }) => useOnboardingQueue({ appState: s, onComplete }), { initialProps: { s } });
  expect(result.current.activeStep?.meta.id).toBe("account-verification");
  s = { ...s, isUserVerifiedInLocalDb: true }; rerender({ s });
  const seen: string[] = [];
  for (let i = 0; i < 15 && onComplete.mock.calls.length === 0; i++) {
    seen.push(result.current.activeStep?.meta.id ?? "(none)");
    act(() => { result.current.goToNext(); });
  }
  expect(seen).toContain("data-sync");
  expect(onComplete).toHaveBeenCalledTimes(1);
});
