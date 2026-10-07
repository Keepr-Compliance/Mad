/**
 * useImportSource — import-source resolution tests
 *
 * BACKLOG-2408. Onboarding used to write the messages import source only when
 * the user answered "Android". Choosing "iPhone" wrote nothing, so those users
 * resolved through the platform default here — making "chose iPhone"
 * indistinguishable from "never asked".
 *
 * These tests pin BOTH halves of the contract:
 *   1. Onboarding now writes a preference for either answer, and the value it
 *      writes is the value that is read back afterwards (round-trip).
 *   2. An install with NO preference still resolves through the platform
 *      default, unchanged. The default is a fallback, not dead code — the
 *      entire installed base predates the write and still depends on it.
 *
 * The round-trip tests drive the real `usePhoneTypeApi` write path and the real
 * `useImportSource` read path against ONE shared in-memory preference store, so
 * a mismatch between what onboarding writes and what the dashboard reads fails
 * here rather than in production.
 *
 * @module hooks/__tests__/useImportSource.test
 */

import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useImportSource } from "../useImportSource";
import { usePhoneTypeApi } from "../../appCore/state/flows/usePhoneTypeApi";
import { AppStateProvider } from "../../appCore/state/machine/AppStateContext";
import type { AppState, OnboardingState } from "../../appCore/state/machine/types";
import * as featureFlags from "../../appCore/state/machine/utils/featureFlags";

// ---------------------------------------------------------------------------
// Platform (the source of the default under test)
// ---------------------------------------------------------------------------
let mockIsMacOS = true;

jest.mock("../../contexts/PlatformContext", () => ({
  usePlatform: () => ({
    isMacOS: mockIsMacOS,
    isWindows: !mockIsMacOS,
    isLinux: false,
  }),
}));

// ---------------------------------------------------------------------------
// One shared in-memory preference store, standing in for Supabase
// user_preferences. `null` models an install that has never written one.
// ---------------------------------------------------------------------------
type PrefStore = { messages?: { source?: string }; phone_type?: string } | null;
let mockPrefs: PrefStore = null;
// The local onboarding phone type (`user:get-phone-type` → users_local).
// BACKLOG-3418: read when no known source is stored.
let mockLocalPhoneType: "iphone" | "android" | null = null;
const mockGetPhoneType = jest.fn(async () => ({
  success: true,
  data: mockLocalPhoneType,
}));

const mockGetPreferences = jest.fn(async () => ({
  success: true,
  data: mockPrefs ?? {},
}));

const mockUpdatePreferences = jest.fn(
  async (_userId: string, partial: Record<string, unknown>) => {
    mockPrefs = { ...(mockPrefs ?? {}), ...partial };
    return { success: true };
  }
);

const mockSetPhoneType = jest.fn(async () => ({ success: true }));
const mockSetPhoneTypeCloud = jest.fn(async () => ({ success: true }));

// Both specifiers are backed by the SAME jest.fn()s, so the writer
// (usePhoneTypeApi, which imports the barrel) and the reader (useImportSource,
// which imports the module directly) genuinely share one store. The arrow
// wrappers dereference at call time, which is what makes this legal inside a
// hoisted jest.mock factory.
jest.mock("../../services/settingsService", () => ({
  settingsService: {
    getPreferences: (...a: unknown[]) => mockGetPreferences(...(a as [])),
    updatePreferences: (...a: unknown[]) =>
      mockUpdatePreferences(...(a as [string, Record<string, unknown>])),
    setPhoneType: (...a: unknown[]) => mockSetPhoneType(...(a as [])),
    setPhoneTypeCloud: (...a: unknown[]) => mockSetPhoneTypeCloud(...(a as [])),
    getPhoneType: (...a: unknown[]) => mockGetPhoneType(...(a as [])),
  },
}));
jest.mock("@/services", () => ({
  settingsService: {
    getPreferences: (...a: unknown[]) => mockGetPreferences(...(a as [])),
    updatePreferences: (...a: unknown[]) =>
      mockUpdatePreferences(...(a as [string, Record<string, unknown>])),
    setPhoneType: (...a: unknown[]) => mockSetPhoneType(...(a as [])),
    setPhoneTypeCloud: (...a: unknown[]) => mockSetPhoneTypeCloud(...(a as [])),
    getPhoneType: (...a: unknown[]) => mockGetPhoneType(...(a as [])),
  },
}));

jest.mock("../../appCore/state/machine/utils/featureFlags", () => ({
  isNewStateMachineEnabled: jest.fn(),
}));

const USER_ID = "test-user";

const onboardingPhoneTypeMac: OnboardingState = {
  status: "onboarding",
  step: "phone-type",
  user: { id: USER_ID, email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: false },
  completedSteps: [],
};

const onboardingPhoneTypeWindows: OnboardingState = {
  ...onboardingPhoneTypeMac,
  platform: { isMacOS: false, isWindows: true, hasIPhone: true },
};

const wrapperFor =
  (initialState: AppState) =>
  ({ children }: { children: React.ReactNode }) => (
    <AppStateProvider initialState={initialState}>{children}</AppStateProvider>
  );

/** Run the real onboarding write path for the given answer and platform. */
async function completePhoneTypeStep(
  state: OnboardingState,
  answer: "iphone" | "android"
): Promise<void> {
  const { result } = renderHook(
    () => usePhoneTypeApi({ userId: USER_ID, isWindows: state.platform.isWindows }),
    { wrapper: wrapperFor(state) }
  );

  await act(async () => {
    await result.current.savePhoneType(answer);
  });
}

/** Read the import source the way the dashboard does. */
async function readImportSource(): Promise<string | null> {
  const { result } = renderHook(() => useImportSource(USER_ID, false));
  const stored = mockPrefs?.messages?.source;

  // BACKLOG-2487: gate on the value being read, not on a sibling that happens
  // earlier. `toHaveBeenCalled()` is already true SYNCHRONOUSLY inside the
  // hook's effect, and flushing one microtask afterwards does not guarantee
  // the hook's own `.then` has run and committed — so `result.current` could
  // still hold the platform seed. That gap is the flake.
  await waitFor(() => {
    // The hook genuinely consulted storage — it is not short-circuiting.
    expect(mockGetPreferences).toHaveBeenCalledWith(USER_ID);
    if (stored !== undefined) {
      // Storage holds a source, so the hook MUST have applied it before the
      // caller is allowed to read. If it never does, this times out and the
      // suite goes red — the property is still proven here, not assumed.
      expect(result.current).toBe(stored);
    }
  });

  if (stored === undefined) {
    // Nothing stored, so the hook keeps its platform seed and there is no
    // value change to wait for. Settle the read anyway, so "unchanged" is a
    // resolved outcome rather than an unfinished one.
    // BACKLOG-3418: the hook now also reads the phone type when nothing is
    // stored — settle that too before reading the result.
    await act(async () => {
      await Promise.all(
        mockGetPreferences.mock.results.map((r) => r.value as Promise<unknown>),
      );
    });
    await waitFor(() => expect(mockGetPhoneType).toHaveBeenCalled());
    await act(async () => {
      await Promise.all(
        mockGetPhoneType.mock.results.map((r) => r.value as Promise<unknown>),
      );
    });
  }

  return result.current;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrefs = null;
  mockLocalPhoneType = null;
  mockIsMacOS = true;
  (featureFlags.isNewStateMachineEnabled as jest.Mock).mockReturnValue(true);
});

describe("useImportSource — existing installs with no stored preference", () => {
  // BACKLOG-2408 explicitly does NOT remove this fallback. Nothing guaranteed
  // the preference was written before this change, so every existing user is
  // still carried by the default. These two tests are the regression guard.
  it("resolves to macos-native on macOS when no preference is stored", async () => {
    mockIsMacOS = true;

    const source = await readImportSource();

    expect(source).toBe("macos-native");
    // It did consult storage and found nothing — it is not short-circuiting.
    expect(mockGetPreferences).toHaveBeenCalledWith(USER_ID);
    expect(mockPrefs).toBeNull();
  });

  // BACKLOG-3418 (founder 2026-10-07, pm_comments 66f5b114): rewritten
  // deliberately. Off macOS a user who chose nothing has NO source — the
  // Dashboard hides "Import from iPhone", matching iPhone detection (off).
  it("resolves to null off macOS when no preference and no phone type are stored", async () => {
    mockIsMacOS = false;

    const source = await readImportSource();

    expect(source).toBeNull();
    expect(mockGetPhoneType).toHaveBeenCalledWith(USER_ID);
    expect(mockPrefs).toBeNull();
  });

  // BACKLOG-3418 (SR C-1): the 4 production Windows iPhone users with a phone
  // type and no stored source keep the button (detection stays ON for them).
  it("resolves to iphone-sync off macOS from a LOCAL iPhone phone type", async () => {
    mockIsMacOS = false;
    mockLocalPhoneType = "iphone";

    expect(await readImportSource()).toBe("iphone-sync");
  });

  it("resolves to iphone-sync off macOS from the CLOUD phone_type when local is empty", async () => {
    mockIsMacOS = false;
    mockPrefs = { phone_type: "iphone" };

    expect(await readImportSource()).toBe("iphone-sync");
  });

  it("stays macos-native on macOS with an iPhone phone type and nothing stored (Mac unchanged)", async () => {
    mockIsMacOS = true;
    mockLocalPhoneType = "iphone";

    expect(await readImportSource()).toBe("macos-native");
  });
});

describe("useImportSource — a stored preference wins over the default", () => {
  it("returns the stored source even when it contradicts the platform default", async () => {
    // Stored value and platform default deliberately disagree, so a passing
    // assertion can only mean the stored value was actually used.
    mockIsMacOS = true; // default would be macos-native
    mockPrefs = { messages: { source: "iphone-sync" } };

    expect(await readImportSource()).toBe("iphone-sync");
  });

  it("returns android-companion for an Android user on macOS", async () => {
    mockIsMacOS = true;
    mockPrefs = { messages: { source: "android-companion" } };

    expect(await readImportSource()).toBe("android-companion");
  });
});

describe("BACKLOG-2408: onboarding round-trip — the answer is written and read back", () => {
  it("writes a source when the user answers iPhone, and reads that value back", async () => {
    mockIsMacOS = true;

    await completePhoneTypeStep(onboardingPhoneTypeMac, "iphone");

    // The preference now EXISTS — this is the defect being fixed. Before the
    // change, answering iPhone left mockPrefs null.
    expect(mockPrefs).not.toBeNull();
    expect(mockPrefs?.messages?.source).toBe("macos-native");
    expect(await readImportSource()).toBe("macos-native");
  });

  it("writes iphone-sync when a Windows user answers iPhone, and reads it back from storage", async () => {
    // Write as a Windows user...
    mockIsMacOS = false;
    await completePhoneTypeStep(onboardingPhoneTypeWindows, "iphone");
    expect(mockPrefs?.messages?.source).toBe("iphone-sync");

    // ...then read with the macOS default in force. If the result is still
    // iphone-sync it came from the stored preference, not the default — which
    // is precisely what was unverifiable before this change.
    mockIsMacOS = true;
    expect(await readImportSource()).toBe("iphone-sync");
  });

  // BACKLOG-3659 (f1103c1da): an Android answer now defaults to Google
  // Messages (the extension), the recommended Android source.
  it("writes android-messages-web when the user answers Android", async () => {
    mockIsMacOS = true;

    await completePhoneTypeStep(onboardingPhoneTypeMac, "android");

    expect(mockPrefs?.messages?.source).toBe("android-messages-web");
    expect(await readImportSource()).toBe("android-messages-web");
  });

  it("leaves no answer unrecorded: both options produce a stored source", async () => {
    for (const answer of ["iphone", "android"] as const) {
      mockPrefs = null;
      mockIsMacOS = true;

      await completePhoneTypeStep(onboardingPhoneTypeMac, answer);

      // Re-widened: the `mockPrefs = null` above narrows the module-level `let`
      // to `null`, and TS cannot see that the awaited step reassigns it.
      expect((mockPrefs as PrefStore)?.messages?.source).toEqual(
        expect.any(String),
      );
    }
  });

  it("does not change the source an iPhone user ends up on (behaviour preserved)", async () => {
    // The value onboarding now writes must equal the value the platform default
    // produced before it was written — on both platforms. Any divergence here
    // would silently move an existing population.
    // BACKLOG-3418: "an iPhone user" without the source write is one whose
    // phone type says iPhone (onboarding records it too) — that, not "nothing
    // at all", is the population this guards (859445f9 §5: 4 such accounts).
    for (const isMac of [true, false]) {
      mockIsMacOS = isMac;

      mockPrefs = null;
      mockLocalPhoneType = "iphone";
      const withoutWrite = await readImportSource();
      mockLocalPhoneType = null;

      mockPrefs = null;
      await completePhoneTypeStep(
        isMac ? onboardingPhoneTypeMac : onboardingPhoneTypeWindows,
        "iphone"
      );
      const withWrite = await readImportSource();

      expect(withWrite).toBe(withoutWrite);
    }
  });
});
