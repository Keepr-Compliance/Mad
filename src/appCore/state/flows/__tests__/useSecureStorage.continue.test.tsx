/**
 * BACKLOG-3321 control C4: the secure-storage Continue opens the database when
 * the machine has not recorded it open during onboarding.
 *
 * The onboarding state is PRODUCED by the reducer from the closed pre-auth
 * route (AUTH_PRE_VALIDATED offline_grace_expired with main reporting the DB
 * closed -> LOGIN_SUCCESS -> USER_DATA_LOADED not-finished), not hand-written.
 * LOGIN_SUCCESS is transcribed from useLoginHandlers.ts dispatchLoginSuccess
 * (hasIPhone always false, isNewUser present). The IPC result shape is
 * `system:initialize-secure-storage` -> `{ success, available, platform }`.
 */
import React from "react";
import { renderHook, act } from "@testing-library/react";
import { useSecureStorage } from "../useSecureStorage";
import { AppStateProvider } from "../../machine/AppStateContext";
import { appStateReducer } from "../../machine/reducer";
import { INITIAL_APP_STATE } from "../../machine/types";
import type { AppState, PlatformInfo, User } from "../../machine/types";

const mockInit = jest.fn();
jest.mock("@/services", () => ({
  systemService: { initializeSecureStorage: (...a: unknown[]) => mockInit(...a) },
  settingsService: { setPhoneType: jest.fn() },
}));
jest.mock("../../machine/utils/featureFlags", () => ({
  isNewStateMachineEnabled: jest.fn().mockReturnValue(true),
}));
jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const user: User = { id: "user-123", email: "test@example.com", displayName: "Test User" };
const mac: PlatformInfo = { isMacOS: true, isWindows: false, hasIPhone: false };

function step(s: AppState, a: unknown): AppState {
  return appStateReducer(s, a as never);
}

function closedOnboarding(): AppState {
  let s = step(INITIAL_APP_STATE, { type: "STORAGE_CHECKED", hasKeyStore: true });
  s = step(s, { type: "AUTH_PRE_VALIDATED", valid: false, reason: "offline_grace_expired", database: "not-initialized" });
  s = step(s, { type: "LOGIN_SUCCESS", user, platform: mac, isNewUser: false });
  s = step(s, {
    type: "USER_DATA_LOADED",
    user,
    platform: mac,
    data: {
      phoneType: null,
      hasCompletedEmailOnboarding: false,
      hasEmailConnected: false,
      hasRecordedEmailProvider: false,
      needsDriverSetup: false,
      fda: "not-asked",
      setup: "not-finished",
      contactSourceAnswered: false,
    },
  });
  return s;
}

const options = {
  isWindows: false,
  isMacOS: true,
  pendingOAuthData: null,
  pendingOnboardingData: { termsAccepted: false, phoneType: null, emailProvider: null, emailConnected: false },
  isAuthenticated: true,
  login: jest.fn(),
  onPendingOAuthClear: jest.fn(),
  onPendingOnboardingClear: jest.fn(),
  onPhoneTypeSet: jest.fn(),
  onEmailOnboardingComplete: jest.fn(),
  onNewUserFlowSet: jest.fn(),
  onNeedsDriverSetup: jest.fn(),
};

function wrapper(initialState: AppState) {
  return ({ children }: { children: React.ReactNode }) => (
    <AppStateProvider initialState={initialState}>{children}</AppStateProvider>
  );
}

beforeEach(() => {
  mockInit.mockReset();
  mockInit.mockResolvedValue({ success: true, available: true, platform: "darwin" });
});

describe("BACKLOG-3321 C4: secure-storage Continue on the closed route", () => {
  it("opens the database exactly once and records it open", async () => {
    const start = closedOnboarding();
    expect(start.status).toBe("onboarding");
    const { result } = renderHook(() => useSecureStorage(options), { wrapper: wrapper(start) });
    expect(result.current.isDatabaseInitialized).toBe(false);

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.initializeSecureStorage();
    });

    // Call count first: a missing open is the defect this control exists for.
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(ok).toBe(true);
    expect(result.current.isDatabaseInitialized).toBe(true);
  });

  it("a failed open returns false and reads closed", async () => {
    mockInit.mockResolvedValue({ success: false, available: false, platform: "darwin", error: "denied" });
    const { result } = renderHook(() => useSecureStorage(options), { wrapper: wrapper(closedOnboarding()) });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.initializeSecureStorage();
    });

    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(ok).toBe(false);
    expect(result.current.isDatabaseInitialized).toBe(false);
  });

  it("does not open during loading/initializing-db (the orchestrator owns that open)", async () => {
    const s = step(step(INITIAL_APP_STATE, { type: "STORAGE_CHECKED", hasKeyStore: true }), {
      type: "AUTH_PRE_VALIDATED",
      valid: true,
    });
    expect(s).toMatchObject({ status: "loading", phase: "initializing-db" });
    const { result } = renderHook(() => useSecureStorage(options), { wrapper: wrapper(s) });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.initializeSecureStorage();
    });

    expect(mockInit).toHaveBeenCalledTimes(0);
    expect(ok).toBe(true);
  });

  it("does not open when onboarding already has the database open", async () => {
    let s = step(INITIAL_APP_STATE, { type: "STORAGE_CHECKED", hasKeyStore: true });
    s = step(s, { type: "AUTH_PRE_VALIDATED", valid: true });
    s = step(s, { type: "DB_INIT_COMPLETE", success: true });
    s = step(s, { type: "AUTH_LOADED", user: null, isNewUser: false, platform: mac });
    s = step(s, { type: "LOGIN_SUCCESS", user, platform: mac, isNewUser: false });
    s = step(s, {
      type: "USER_DATA_LOADED",
      user,
      platform: mac,
      data: {
        phoneType: null,
        hasCompletedEmailOnboarding: false,
        hasEmailConnected: false,
        hasRecordedEmailProvider: false,
        needsDriverSetup: false,
        fda: "not-asked",
        setup: "not-finished",
        contactSourceAnswered: false,
      },
    });
    expect(s.status).toBe("onboarding");
    const { result } = renderHook(() => useSecureStorage(options), { wrapper: wrapper(s) });
    expect(result.current.isDatabaseInitialized).toBe(true);

    await act(async () => {
      await result.current.initializeSecureStorage();
    });

    expect(mockInit).toHaveBeenCalledTimes(0);
  });
});
