/**
 * BACKLOG-3673 — setup is left only by ONBOARDING_QUEUE_DONE (SR condition 1).
 *
 * C17a: execution sweep — every onboarding state in the grid x every member of
 *       the AppAction union (parsed from types.ts, so a new action cannot be
 *       missed). The set of actions that move onboarding -> ready must be
 *       exactly {ONBOARDING_QUEUE_DONE}, and every state that stays in
 *       onboarding must map to an onboarding route (else AppRouter shows the
 *       loading screen forever -- wrong fix W1).
 * C17b: real AppStateProvider + real useEmailOnboardingApi / usePermissionsFlow:
 *       connecting email, skipping email, and granting FDA never open the
 *       dashboard.
 */
import React from "react";
import fs from "fs";
import path from "path";
import { renderHook, act } from "@testing-library/react";
import { appStateReducer } from "../reducer";
import { deriveAppStep } from "../derivation/navigationDerivation";
import { isOnboardingStep } from "../../../routing/routeConfig";
import { AppStateProvider } from "../AppStateContext";
import { useAppState } from "../useAppState";
import { useEmailOnboardingApi } from "../../flows/useEmailOnboardingApi";
import { usePermissionsFlow } from "../../flows/usePermissionsFlow";
import * as featureFlags from "../utils/featureFlags";
import type { AppState, OnboardingState, OnboardingStep, PlatformInfo, AppAction } from "../types";
import type { FdaState } from "../fdaState";

jest.mock("../utils/featureFlags", () => ({ isNewStateMachineEnabled: jest.fn(() => true) }));

const USER = { id: "u-1", email: "user@example.com" };
const MAC: PlatformInfo = { isMacOS: true, isWindows: false, hasIPhone: false };
const WIN: PlatformInfo = { isMacOS: false, isWindows: true, hasIPhone: false };
const STEPS: OnboardingStep[] = [
  "phone-type", "secure-storage", "account-verification", "contact-source",
  "email-connect", "data-sync", "permissions", "apple-driver", "android-coming-soon",
];
const LEGACY = ["phone-type", "secure-storage", "email-connect", "permissions", "apple-driver"] as const;

function subsets<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let m = 0; m < 1 << xs.length; m++) out.push(xs.filter((_, i) => m & (1 << i)));
  return out;
}

function grid(): OnboardingState[] {
  const states: OnboardingState[] = [];
  const combos: Array<[PlatformInfo, FdaState[]]> = [
    [MAC, ["granted", "declined", "not-asked", undefined as unknown as FdaState]],
    [WIN, ["not-applicable"]],
  ];
  for (const [platform, fdas] of combos)
    for (const fda of fdas)
      for (const phone of ["iphone", "android", undefined] as const)
        for (const hasEmailConnected of [true, false])
          for (const completed of subsets(LEGACY))
            states.push({
              status: "onboarding", step: "phone-type", user: USER, platform,
              completedSteps: [...completed], fda, hasEmailConnected, selectedPhoneType: phone,
            } as OnboardingState);
  return states;
}

function actions(platform: PlatformInfo): AppAction[] {
  const a: AppAction[] = [];
  a.push({ type: "STORAGE_CHECKED", hasKeyStore: true, isDbInitialized: true } as unknown as AppAction);
  a.push({ type: "AUTH_PRE_VALIDATED" } as unknown as AppAction);
  a.push({ type: "KEYCHAIN_CONFIRMED" } as unknown as AppAction);
  a.push({ type: "DB_INIT_STARTED" } as unknown as AppAction);
  a.push({ type: "DB_INIT_COMPLETE", success: true } as unknown as AppAction);
  for (const isNewUser of [true, false]) {
    a.push({ type: "AUTH_LOADED", user: USER, isNewUser, platform });
    a.push({ type: "LOGIN_SUCCESS", user: USER, isNewUser, platform });
  }
  for (const setup of ["finished", "not-finished", "unknown"] as const)
    a.push({ type: "USER_DATA_LOADED", data: { phoneType: "android", hasCompletedEmailOnboarding: true, hasEmailConnected: true, needsDriverSetup: false, fda: "granted", setup } } as unknown as AppAction);
  for (const step of STEPS) {
    for (const phoneType of ["iphone", "android", undefined] as const)
      a.push({ type: "ONBOARDING_STEP_COMPLETE", step, phoneType });
  }
  a.push({ type: "ONBOARDING_QUEUE_DONE" });
  a.push({ type: "FDA_GRANTED" } as AppAction);
  a.push({ type: "PHONE_TYPE_RESET" });
  a.push({ type: "RESUME_MARKER_APPLIED", phoneType: "iphone" });
  a.push({ type: "EMAIL_CONNECTED", email: "user@example.com", provider: "google" });
  a.push({ type: "EMAIL_DISCONNECTED", provider: "google" });
  a.push({ type: "START_EMAIL_SETUP" });
  a.push({ type: "APP_READY" });
  a.push({ type: "LOGOUT" });
  a.push({ type: "ERROR", error: { code: "UNKNOWN_ERROR", message: "x" } as never, recoverable: true });
  a.push({ type: "RETRY" });
  a.push({ type: "INIT_STAGE_RECEIVED", payload: { stage: "x" } });
  return a;
}

describe("C17a — the set of actions that move onboarding -> dashboard", () => {
  it("sweep covers every action type declared in types.ts", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "types.ts"), "utf8");
    const union = src.slice(src.indexOf("export type AppAction ="), src.indexOf(";", src.indexOf("export type AppAction =")));
    const ifaceNames = [...union.matchAll(/\|\s*(\w+)/g)].map((m) => m[1]);
    const declared = ifaceNames.map((n) => {
      const m = new RegExp(`export interface ${n}\\s*\\{[^}]*?type:\\s*"([A-Z_]+)"`, "s").exec(src);
      if (!m) throw new Error(`no type literal for ${n}`);
      return m[1];
    });
    const swept = new Set<string>(actions(MAC).map((x) => x.type));
    // 21 since BACKLOG-3673 removed ONBOARDING_SKIP (it had no dispatcher).
    expect(declared.length).toBe(21);
    expect(declared.filter((d) => !swept.has(d))).toEqual([]);
  });

  it("only ONBOARDING_QUEUE_DONE leaves onboarding for ready; onboarding results stay on an onboarding route", () => {
    const leavers = new Map<string, number>();
    const badRoute: string[] = [];
    const detail = new Map<string, number>();
    let n = 0;
    for (const s of grid()) {
      for (const act0 of actions(s.platform)) {
        // single action, and ERROR->RETRY pair
        const chains: AppAction[][] = [[act0]];
        if (act0.type === "ERROR") chains.push([act0, { type: "RETRY" }]);
        for (const chain of chains) {
          let out: AppState = s;
          for (const x of chain) out = appStateReducer(out, x as Parameters<typeof appStateReducer>[1]);
          n++;
          const key = chain.map((x) => x.type).join(">");
          if (out.status === "ready") {
            leavers.set(key, (leavers.get(key) ?? 0) + 1);
            const st = (chain[0] as { step?: string }).step;
            const dkey = key + (st ? ":" + st : "");
            detail.set(dkey, (detail.get(dkey) ?? 0) + 1);
          }
          if (out.status === "onboarding" && !isOnboardingStep(deriveAppStep(out)))
            badRoute.push(`${key}:${(out as OnboardingState).step}`);
        }
      }
    }
    if (process.env.C17_OUT) fs.writeFileSync(process.env.C17_OUT, JSON.stringify({ n, states: grid().length, leavers: [...leavers.entries()], detail: [...detail.entries()], badRoute: [...new Set(badRoute)] }, null, 1));
    expect(n).toBeGreaterThan(10000);
    expect([...leavers.keys()].sort()).toEqual(["ONBOARDING_QUEUE_DONE"]);
    expect([...new Set(badRoute)]).toEqual([]);
  });
});

describe("C17b — real provider + real hooks: finishing the email or FDA step never opens the dashboard", () => {
  beforeEach(() => {
    (featureFlags.isNewStateMachineEnabled as jest.Mock).mockReturnValue(true);
    (window as unknown as { api: unknown }).api = {
      auth: { completeEmailOnboarding: jest.fn().mockResolvedValue({ success: true }) },
      system: {
        checkAllPermissions: jest.fn().mockResolvedValue({ success: true, allGranted: true }),
        checkAppLocation: jest.fn().mockResolvedValue({ shouldPrompt: false, appPath: "/Applications/Keepr.app" }),
      },
    };
  });

  const cases: Array<[string, OnboardingState]> = [
    ["Windows + Android, phone-type done", {
      status: "onboarding", step: "email-connect", user: USER, platform: WIN,
      completedSteps: ["phone-type"], fda: "not-applicable", hasEmailConnected: false, selectedPhoneType: "android",
    }],
    ["macOS, FDA granted, phone-type + secure-storage done", {
      status: "onboarding", step: "email-connect", user: USER, platform: MAC,
      completedSteps: ["phone-type", "secure-storage"], fda: "granted", hasEmailConnected: false, selectedPhoneType: "iphone",
    }],
  ];

  function mount(initial: OnboardingState) {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AppStateProvider initialState={initial}>{children}</AppStateProvider>
    );
    return renderHook(
      () => {
        const app = useAppState();
        const email = useEmailOnboardingApi({ userId: undefined });
        const perms = usePermissionsFlow({
          isWindows: initial.platform.isWindows,
          onSetShowMoveAppPrompt: () => {},
          onSetCurrentStep: () => {},
          stateMachineDispatch: app.dispatch,
        });
        return { app, email, perms };
      },
      { wrapper },
    );
  }

  it.each(cases)("%s: machine EMAIL_CONNECTED (connect path) keeps status onboarding", async (_n, initial) => {
    const { result } = mount(initial);
    await act(async () => {
      result.current.email.setHasEmailConnected(true, "user@example.com", "google");
    });
    expect(result.current.app.state.status).toBe("onboarding");
  });

  it.each(cases)("%s: completeEmailOnboarding (skip path) keeps status onboarding", async (_n, initial) => {
    const { result } = mount(initial);
    await act(async () => {
      await result.current.email.completeEmailOnboarding();
    });
    expect(result.current.app.state.status).toBe("onboarding");
  });

  it("macOS: permissions granted in the FDA step keeps status onboarding (data-source floor still to run)", async () => {
    const initial: OnboardingState = {
      status: "onboarding", step: "permissions", user: USER, platform: MAC,
      completedSteps: ["phone-type", "secure-storage", "email-connect"], fda: "not-asked",
      hasEmailConnected: false, selectedPhoneType: "iphone",
    };
    const { result } = mount(initial);
    await act(async () => {
      result.current.perms.handlePermissionsGranted();
    });
    expect(result.current.app.state.status).toBe("onboarding");
  });
});
