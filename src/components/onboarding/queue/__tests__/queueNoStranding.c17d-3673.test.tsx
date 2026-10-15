/**
 * BACKLOG-3673 C17d — the REAL queue ends setup on its own (no reducer release
 * needed): users who used to leave at the email step now run data-sync and
 * reach onComplete exactly once. Baseline control (green before and after).
 */
import fs from "fs";
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
const log: Record<string, unknown> = {};
afterAll(() => { if (process.env.C17_OUT) fs.writeFileSync(process.env.C17_OUT, JSON.stringify(log, null, 1)); });

it.each([
  ["windows", "Win+Android, email connected", st({})],
  ["windows", "Win+Android, email skipped", st({ emailConnected: false, connectedEmail: null, emailProvider: null, emailSkipped: true })],
  ["macos", "Mac+iPhone, FDA granted, email connected", st({ phoneType: "iphone", hasPermissions: true })],
] as const)("%s %s: Continue through the real queue reaches onComplete, after data-sync", (plat, name, appState) => {
  mockPlatform = { platform: plat };
  const onComplete = jest.fn();
  const { result } = renderHook(() => useOnboardingQueue({ appState, onComplete }));
  const seen: string[] = [];
  for (let i = 0; i < 15 && onComplete.mock.calls.length === 0; i++) {
    seen.push(result.current.activeStep?.meta.id ?? "(none)");
    act(() => { result.current.goToNext(); });
  }
  log[`${plat} ${name}`] = { visible: result.current.visibleEntries.map((e) => `${e.step.meta.id}(${e.status})`), seen, onComplete: onComplete.mock.calls.length };
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(seen).toContain("data-sync");
});
