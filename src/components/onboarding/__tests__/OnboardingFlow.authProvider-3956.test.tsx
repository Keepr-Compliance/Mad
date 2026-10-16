/**
 * BACKLOG-3956 C2/C3 — the provider OnboardingFlow hands the onboarding queue,
 * and the contact-source preferences the step would write from it.
 *
 * C2: an unknown provider (AuthContext null) must reach the step as null and
 *     write Outlook OFF and Google OFF. Before the fix `?? "google"` turned it
 *     into a Google sign-in (Google on); a `?? "microsoft"` default would turn
 *     Outlook on. Both are wrong and both must go red here — run once per path
 *     (machine path and legacy path build the context separately).
 * C3: "azure" (the raw Supabase value for a Microsoft sign-in) reaches the
 *     step as "microsoft" and writes Outlook ON, Google OFF.
 *
 * Harness mirrors OnboardingFlow.fdaSkipSeed.test.tsx (queue options captured).
 */
import React from "react";
import { render, waitFor } from "@testing-library/react";
import { OnboardingFlow } from "../OnboardingFlow";
import { buildDirectContactSourcePrefs } from "../steps/ContactSourceStep";
import type { AppStateMachine } from "../../../appCore/state/types";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isWindows: true, isMacOS: false, isLinux: false, platform: "windows" }),
}));

jest.mock("../../../appCore/state/machine/selectors", () => ({
  selectPhoneType: () => "iphone",
  selectHasEmailConnectedNullable: () => false,
  selectHasPermissionsNullable: () => true,
  selectIsDatabaseInitialized: () => true,
}));

jest.mock("../../../appCore/state/machine/debug", () => ({
  logAllFlags: jest.fn(),
  logStateChange: jest.fn(),
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../sentryOnboarding", () => ({
  reportDriverStillMissingAtCompletion: jest.fn(),
}));

jest.mock("../shell/OnboardingShell", () => ({
  OnboardingShell: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="onboarding-shell">{children}</div>
  ),
}));
jest.mock("../shell/ProgressIndicator", () => ({ ProgressIndicator: () => null }));
jest.mock("../shell/NavigationButtons", () => ({ NavigationButtons: () => null }));

let capturedAppState: { authProvider: "google" | "microsoft" | null } | null = null;
jest.mock("../queue/useOnboardingQueue", () => ({
  useOnboardingQueue: (opts: { appState: { authProvider: "google" | "microsoft" | null } }) => {
    capturedAppState = opts.appState;
    return {
      visibleEntries: [],
      activeEntry: undefined,
      activeStep: undefined,
      currentIndex: 0,
      isComplete: false,
      context: {},
      goToNext: jest.fn(),
      goToPrevious: jest.fn(),
      handleAction: jest.fn(),
      handleSkip: jest.fn(),
      isFirstStep: true,
      canSkip: false,
      isNextDisabled: false,
      isViewingPastStep: false,
    };
  },
}));

/** true = machine path (OnboardingFlow.tsx machine branch); false = legacy. */
let useMachine = true;
jest.mock("../../../appCore/state/machine", () => ({
  useOptionalMachineState: () =>
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    useMachine
      ? {
          state: { status: "onboarding" as const, user: { id: "u1", email: "user@example.com" } },
          dispatch: jest.fn(),
        }
      : null,
}));

function makeApp(authProvider: string | null): AppStateMachine {
  return {
    selectedPhoneType: "iphone",
    hasEmailConnected: false,
    currentUser: { id: "u1", email: "user@example.com" },
    pendingOnboardingData: null,
    hasPermissions: true,
    hasSecureStorageSetup: true,
    needsDriverSetup: false,
    needsTermsAcceptance: false,
    pendingOAuthData: null,
    authProvider,
    isNewUserFlow: true,
    isDatabaseInitialized: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function installWindowApi() {
  (window as unknown as { api: unknown }).api = {
    system: {
      consumeOnboardingResumeMarker: jest.fn().mockResolvedValue({ resumeStep: null }),
    },
    user: {
      getPhoneTypeCloud: jest.fn().mockResolvedValue({ success: true, phoneType: "iphone" }),
    },
    preferences: {
      get: jest.fn().mockResolvedValue({ success: true, preferences: {} }),
    },
  };
}

async function providerFor(authProvider: string | null) {
  render(<OnboardingFlow app={makeApp(authProvider)} />);
  await waitFor(() => expect(capturedAppState).not.toBeNull());
  return capturedAppState!.authProvider;
}

/** What the contact-source step writes on Continue-without-changes / Skip. */
function prefsFor(authProvider: "google" | "microsoft" | null) {
  return buildDirectContactSourcePrefs({ platform: "windows", phoneType: "iphone", authProvider });
}

// The legacy branch (machineState null) has no control here: OnboardingFlow
// returns null at OnboardingFlow.tsx:157 before OnboardingFlowInner mounts
// whenever machineState is null, so that branch cannot run. It gets the same
// narrowing for consistency only. Verified: rendering with a null machineState
// never reached useOnboardingQueue (4 of 4 timed out waiting for it).
describe("OnboardingFlow authProvider — machine path (BACKLOG-3956)", () => {
  beforeEach(() => {
    capturedAppState = null;
    useMachine = true;
    installWindowApi();
  });

  it("C2: unknown provider reaches the step as null — Outlook OFF and Google OFF", async () => {
    const provider = await providerFor(null);
    expect(provider).toBeNull();
    const prefs = prefsFor(provider);
    expect(prefs.outlookContacts).toBe(false);
    expect(prefs.googleContacts).toBe(false);
  });

  it("C2: an email sign-in is not a mailbox provider — null, both off", async () => {
    const provider = await providerFor("email");
    expect(provider).toBeNull();
    const prefs = prefsFor(provider);
    expect(prefs.outlookContacts).toBe(false);
    expect(prefs.googleContacts).toBe(false);
  });

  it("C3: azure reaches the step as microsoft — Outlook ON, Google OFF", async () => {
    const provider = await providerFor("azure");
    expect(provider).toBe("microsoft");
    expect(prefsFor(provider)).toEqual({
      outlookContacts: true,
      googleContacts: false,
      iphoneContacts: true,
    });
  });

  it("C6: google stays google — Outlook OFF, Google ON", async () => {
    const provider = await providerFor("google");
    expect(provider).toBe("google");
    const prefs = prefsFor(provider);
    expect(prefs.outlookContacts).toBe(false);
    expect(prefs.googleContacts).toBe(true);
  });
});
