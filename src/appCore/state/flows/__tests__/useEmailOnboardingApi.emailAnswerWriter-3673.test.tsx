/**
 * BACKLOG-3673 C14 (closes BACKLOG-3338's missing writer) + C12's email half.
 *
 * C14  Connecting a mailbox DURING SETUP records the account's email-step answer
 *      (users.email_onboarding_completed_at via auth:complete-email-onboarding)
 *      -- once. Before this only Skip recorded it, so an account that connected
 *      was asked the email step again on every new computer.
 *      Skip then connect, or connect twice, still records it once.
 *      Connecting from Settings (status `ready`) records nothing here.
 * C12  Neither email path writes the "setup finished" record.
 *
 * Real AppStateProvider + reducer + useEmailOnboardingApi; authService mocked
 * (as in useEmailOnboardingApi.machine.test.tsx).
 */
import React from "react";
import { renderHook, act } from "@testing-library/react";
import { useEmailOnboardingApi } from "../useEmailOnboardingApi";
import { AppStateProvider } from "../../machine/AppStateContext";
import { useAppState } from "../../machine/useAppState";
import type { AppState, OnboardingState, ReadyState } from "../../machine/types";

jest.mock("../../machine/utils/featureFlags", () => ({ isNewStateMachineEnabled: jest.fn(() => true) }));
const mockCompleteEmailOnboarding = jest.fn();
jest.mock("@/services", () => ({
  authService: { completeEmailOnboarding: (...a: unknown[]) => mockCompleteEmailOnboarding(...a) },
}));

const USER = { id: "u-3673", email: "user@example.com" };
const WIN = { isMacOS: false, isWindows: true, hasIPhone: false };

const inSetup: OnboardingState = {
  status: "onboarding", step: "email-connect", user: USER, platform: WIN,
  completedSteps: ["phone-type"], fda: "not-applicable", hasEmailConnected: false,
  selectedPhoneType: "android",
};
const onDashboard: ReadyState = {
  status: "ready", user: USER, platform: WIN,
  userData: {
    phoneType: "android", hasCompletedEmailOnboarding: true, hasEmailConnected: false,
    needsDriverSetup: false, fda: "not-applicable", setup: "finished",
  },
};

const mockCompleteAccountSetup = jest.fn();

function mount(initial: AppState) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AppStateProvider initialState={initial}>{children}</AppStateProvider>
  );
  return renderHook(() => ({ api: useEmailOnboardingApi({ userId: USER.id }), app: useAppState() }), { wrapper });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCompleteEmailOnboarding.mockResolvedValue({ success: true });
  (window as unknown as { api: unknown }).api = { user: { completeAccountSetup: mockCompleteAccountSetup } };
});

describe("C14 — the connect path records the email-step answer once", () => {
  it("connect during setup -> recorded once, for the setup user", async () => {
    const { result } = mount(inSetup);
    await act(async () => { result.current.api.setHasEmailConnected(true, USER.email, "google"); });
    expect(mockCompleteEmailOnboarding).toHaveBeenCalledTimes(1);
    expect(mockCompleteEmailOnboarding).toHaveBeenCalledWith(USER.id);
    // and connecting never leaves setup (C17)
    expect(result.current.app.state.status).toBe("onboarding");
  });

  it("connect twice -> still once", async () => {
    const { result } = mount(inSetup);
    await act(async () => { result.current.api.setHasEmailConnected(true, USER.email, "google"); });
    await act(async () => { result.current.api.setHasEmailConnected(true, USER.email, "microsoft"); });
    expect(mockCompleteEmailOnboarding).toHaveBeenCalledTimes(1);
  });

  it("skip then connect -> once (skip already recorded it)", async () => {
    const { result } = mount(inSetup);
    await act(async () => { await result.current.api.completeEmailOnboarding(); });
    await act(async () => { result.current.api.setHasEmailConnected(true, USER.email, "google"); });
    expect(mockCompleteEmailOnboarding).toHaveBeenCalledTimes(1);
  });

  it("connect from Settings (ready) records nothing here", async () => {
    const { result } = mount(onDashboard);
    await act(async () => { result.current.api.setHasEmailConnected(true, USER.email, "google"); });
    expect(mockCompleteEmailOnboarding).not.toHaveBeenCalled();
    expect(result.current.app.state.status).toBe("ready");
  });

  it("a failed record is logged, never blocks the connect", async () => {
    mockCompleteEmailOnboarding.mockRejectedValue(new Error("offline"));
    const { result } = mount(inSetup);
    await act(async () => {
      result.current.api.setHasEmailConnected(true, USER.email, "google");
      await Promise.resolve();
    });
    if (result.current.app.state.status !== "onboarding") throw new Error("expected onboarding");
    expect(result.current.app.state.hasEmailConnected).toBe(true);
  });
});

describe("C12 — neither email path writes the setup-finished record", () => {
  it("connect and skip never call completeAccountSetup", async () => {
    const { result } = mount(inSetup);
    await act(async () => { result.current.api.setHasEmailConnected(true, USER.email, "google"); });
    await act(async () => { await result.current.api.completeEmailOnboarding(); });
    expect(mockCompleteAccountSetup).not.toHaveBeenCalled();
  });
});
