/**
 * LoadingOrchestrator Phase 4 — reading the persisted FDA skip (BACKLOG-3212)
 *
 * This is the seam that makes the whole fix real end to end. Phase 4 reads the
 * Supabase preferences bag and hands `fdaSkipped` to USER_DATA_LOADED; the
 * reducer then decides onboarding vs ready. Without this read the reducer
 * change is inert, and both halves would still "pass" their own unit tests.
 *
 * FIXTURE PROVENANCE. The preferences object mocked here is the shape the REAL
 * `preferences:update` handler produces when PermissionsStep sends its skip
 * payload — asserted in preferenceHandlers.onboardingSkip.test.ts:
 *
 *   { onboarding: { fdaSkipped: true, fdaSkippedAt: <ms> } }
 *
 * wrapped by `preferences:get` as `{ success: true, preferences: {...} }`.
 * A near-miss key here (`preferences.fdaSkipped`, say) would make these tests
 * pass for the wrong reason, which is why the shape is transcribed rather than
 * invented — and why the "wrong shape" test below exists to pin it.
 *
 * The discriminating pair, at this layer (BACKLOG-3673: Full Disk Access no
 * longer routes; only the account record does, so the pair is observed on an
 * account still in setup):
 *   - flag present -> `permissions` seeded as answered (not asked again)
 *   - flag absent  -> `permissions` not seeded (the app still asks)
 *
 * The BACKLOG-3293 block that used to follow (the email-onboarding handler's
 * answer reaching the router) is gone with that handler; its successor is
 * LoadingOrchestrator.accountRecord-3673.test.tsx (C4: a "completed" email
 * answer and a connected mailbox never route).
 *
 * @module appCore/state/machine/LoadingOrchestrator.fdaSkip.test
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { LoadingOrchestrator } from "./LoadingOrchestrator";
import { AppStateProvider } from "./AppStateContext";
import { useAppState } from "./useAppState";
import { AuthProvider } from "../../../contexts/AuthContext";
import type { AppState } from "./types";

jest.mock("@sentry/electron/renderer", () => ({
  addBreadcrumb: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock("../../../components/support/SupportWidget", () => ({
  SupportWidget: () => null,
}));

jest.mock("../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

const mockApi = {
  auth: {
    getCurrentUser: jest.fn(),
    preValidateSession: jest.fn(),
  },
  system: {
    hasEncryptionKeyStore: jest.fn(),
    initializeSecureStorage: jest.fn(),
    onInitStage: jest.fn(),
    getInitStage: jest.fn(),
    checkAllConnections: jest.fn(),
    checkPermissions: jest.fn(),
  },
  user: {
    getPhoneType: jest.fn(),
    getAccountSetup: jest.fn(),
  },
  preferences: {
    get: jest.fn(),
  },
};

beforeAll(() => {
  (window as unknown as { api: typeof mockApi }).api = mockApi;
});

afterAll(() => {
  delete (window as unknown as { api?: typeof mockApi }).api;
});

const baseUser = { id: "user-1", email: "test@test.com" };
const macOS = { isMacOS: true, isWindows: false, hasIPhone: true };

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(window.navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });

  mockApi.system.hasEncryptionKeyStore.mockReturnValue(new Promise(() => {}));
  mockApi.system.initializeSecureStorage.mockReturnValue(new Promise(() => {}));
  mockApi.auth.getCurrentUser.mockReturnValue(new Promise(() => {}));
  mockApi.auth.preValidateSession.mockReturnValue(new Promise(() => {}));
  mockApi.system.onInitStage.mockReturnValue(jest.fn());
  mockApi.system.getInitStage.mockResolvedValue({ stage: "complete" });

  // A returning macOS user: phone type chosen, mailbox connected, email
  // onboarding done — everything EXCEPT Full Disk Access, which is not granted.
  mockApi.user.getPhoneType.mockResolvedValue({ success: true, phoneType: "iphone" });
  mockApi.system.checkAllConnections.mockResolvedValue({
    success: true,
    google: { connected: true },
    microsoft: { connected: false },
  });
  mockApi.system.checkPermissions.mockResolvedValue({
    hasPermission: false,
    fullDiskAccess: false,
  });
  // Default: nothing on record (a user who has never skipped).
  mockApi.preferences.get.mockResolvedValue({ success: true, preferences: {} });
  // BACKLOG-3673: this account has NOT finished setup (record empty), but has
  // answered contacts and the email step. Shape transcribed from
  // accountSetupHandlers.getAccountSetup.
  mockApi.user.getAccountSetup.mockResolvedValue({
    success: true,
    setup: "not-finished",
    emailStepAnswered: true,
    contactSourceAnswered: true,
  });
});

function loadingUserDataState(): AppState {
  return {
    status: "loading",
    phase: "loading-user-data",
    user: baseUser,
    platform: macOS,
  } as AppState;
}

/** Surfaces the resolved status so the routing decision is directly observable. */
function StatusProbe() {
  const { state } = useAppState();
  const seededPermissions =
    state.status === "onboarding" && state.completedSteps.includes("permissions");
  const fda = state.status === "onboarding" ? state.fda : undefined;
  return (
    <>
      <div data-testid="status">{state.status}</div>
      <div data-testid="permissions-seeded">{String(seededPermissions)}</div>
      <div data-testid="fda">{String(fda)}</div>
    </>
  );
}

async function renderAndSettle() {
  render(
    <AuthProvider>
      <AppStateProvider initialState={loadingUserDataState()}>
        <LoadingOrchestrator>
          <StatusProbe />
        </LoadingOrchestrator>
      </AppStateProvider>
    </AuthProvider>
  );

  await waitFor(
    () => {
      expect(screen.getByTestId("status")).toBeInTheDocument();
    },
    { timeout: 3000 }
  );
  return screen.getByTestId("status").textContent;
}

describe("LoadingOrchestrator Phase 4 — persisted FDA skip (BACKLOG-3212)", () => {
  it("reads onboarding.fdaSkipped and seeds permissions as answered (not asked again)", async () => {
    mockApi.preferences.get.mockResolvedValue({
      success: true,
      preferences: {
        onboarding: { fdaSkipped: true, fdaSkippedAt: 1_700_000_000_000 },
      },
    });

    const status = await renderAndSettle();

    expect(mockApi.preferences.get).toHaveBeenCalledWith(baseUser.id);
    expect(status).toBe("onboarding");
    expect(screen.getByTestId("fda").textContent).toBe("declined");
    expect(screen.getByTestId("permissions-seeded").textContent).toBe("true");
  });

  it("CONTROL: with no flag on record the same user is still asked", async () => {
    mockApi.preferences.get.mockResolvedValue({ success: true, preferences: {} });

    const status = await renderAndSettle();

    expect(status).toBe("onboarding");
    expect(screen.getByTestId("permissions-seeded").textContent).toBe("false");
  });

  it("CONTROL: a preferences bag whose `onboarding` key holds only the 1842 resume marker is not a skip", async () => {
    mockApi.preferences.get.mockResolvedValue({
      success: true,
      preferences: { onboarding: { resumeStep: null, resumeSavedAt: 1_699_000_000_000 } },
    });

    const status = await renderAndSettle();

    expect(status).toBe("onboarding");
    expect(screen.getByTestId("permissions-seeded").textContent).toBe("false");
  });

  it("CONTROL: the flag at the WRONG path does not count (pins the key this code reads)", async () => {
    // If the read were ever loosened to a top-level or differently-nested key,
    // this would flip to "ready" and the write side and read side would have
    // silently drifted apart.
    mockApi.preferences.get.mockResolvedValue({
      success: true,
      preferences: { fdaSkipped: true },
    });

    const status = await renderAndSettle();

    expect(status).toBe("onboarding");
    expect(screen.getByTestId("permissions-seeded").textContent).toBe("false");
  });

  it("a preferences read failure degrades to asking again, never to skipping", async () => {
    mockApi.preferences.get.mockRejectedValue(new Error("supabase unreachable"));

    const status = await renderAndSettle();

    expect(status).toBe("onboarding");
    expect(screen.getByTestId("permissions-seeded").textContent).toBe("false");
  });

  it("survives a preload bridge with no preferences namespace at all", async () => {
    // Older preload, or a partially-stubbed bridge. The read is built eagerly
    // inside a Promise.all, so an unguarded call here would reject the whole
    // batch and send an otherwise-fine user down the fallback path.
    const saved = mockApi.preferences;
    delete (mockApi as { preferences?: unknown }).preferences;
    try {
      const status = await renderAndSettle();
      expect(status).toBe("onboarding");
    } finally {
      (mockApi as { preferences?: unknown }).preferences = saved;
    }
  });
});
