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
 * The discriminating pair, at this layer:
 *   - flag present -> `ready`
 *   - flag absent  -> `onboarding` (the app still asks)
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
    checkEmailOnboarding: jest.fn(),
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
  mockApi.auth.checkEmailOnboarding.mockResolvedValue({ success: true, completed: true });
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
  return <div data-testid="status">{state.status}</div>;
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
  it("reads onboarding.fdaSkipped and routes the user to ready instead of onboarding", async () => {
    mockApi.preferences.get.mockResolvedValue({
      success: true,
      preferences: {
        onboarding: { fdaSkipped: true, fdaSkippedAt: 1_700_000_000_000 },
      },
    });

    const status = await renderAndSettle();

    expect(mockApi.preferences.get).toHaveBeenCalledWith(baseUser.id);
    expect(status).toBe("ready");
  });

  it("CONTROL: with no flag on record the same user goes to onboarding — the app still asks", async () => {
    mockApi.preferences.get.mockResolvedValue({ success: true, preferences: {} });

    const status = await renderAndSettle();

    expect(status).toBe("onboarding");
  });

  it("CONTROL: a preferences bag whose `onboarding` key holds only the 1842 resume marker is not a skip", async () => {
    mockApi.preferences.get.mockResolvedValue({
      success: true,
      preferences: { onboarding: { resumeStep: null, resumeSavedAt: 1_699_000_000_000 } },
    });

    const status = await renderAndSettle();

    expect(status).toBe("onboarding");
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
  });

  it("a preferences read failure degrades to asking again, never to skipping", async () => {
    mockApi.preferences.get.mockRejectedValue(new Error("supabase unreachable"));

    const status = await renderAndSettle();

    expect(status).toBe("onboarding");
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

/**
 * BACKLOG-3293 — the seam that carries the MAIN-PROCESS answer to the router.
 *
 * The suite above cannot observe that seam: its `beforeEach` mocks
 * `checkAllConnections -> google connected`, so BOTH operands of the OR at
 * LoadingOrchestrator.tsx:684 are true and `checkEmailOnboarding`'s answer is
 * masked. The cases below disconnect the mailbox so the handler's answer is the
 * only thing left deciding — which is exactly the founder's reproduced state:
 * Full Disk Access declined and on record, iPhone picked, no mailbox. He
 * reached the dashboard, quit, relaunched, and was sent back to onboarding
 * because the main-process handler discarded the persisted flag.
 */
describe("LoadingOrchestrator Phase 4 — the handler's answer reaches the router (BACKLOG-3293)", () => {
  /** The founder's state: FDA declined and on record, iPhone, NO mailbox. */
  function founderState() {
    mockApi.system.checkAllConnections.mockResolvedValue({
      success: true,
      google: { connected: false },
      microsoft: { connected: false },
    });
    mockApi.preferences.get.mockResolvedValue({
      success: true,
      preferences: {
        onboarding: { fdaSkipped: true, fdaSkippedAt: 1_700_000_000_000 },
      },
    });
  }

  it("a user who answered the email step with no mailbox connected reaches ready", async () => {
    founderState();
    mockApi.auth.checkEmailOnboarding.mockResolvedValue({
      success: true,
      completed: true,
    });

    const status = await renderAndSettle();

    expect(status).toBe("ready");
  });

  it("CONTROL: the pre-fix handler answer (completed=false) sends the same user to onboarding", async () => {
    // This is what the founder hit, twice. It proves the seam actually carries
    // the handler's answer rather than the connection OR: with the mailbox
    // disconnected, `completed` is the only operand left.
    //
    // `success: true` is deliberate and transcribed from the handler, not
    // invented: the pre-fix handler RETURNED successfully and answered
    // completed=false (`return { success: true, completed }`). `success: false`
    // is the failure path — a different cause, covered by the case below — and
    // using it here would flip two variables against the positive case instead
    // of isolating `completed`, which is the one this control is about.
    founderState();
    mockApi.auth.checkEmailOnboarding.mockResolvedValue({
      success: true,
      completed: false,
    });

    const status = await renderAndSettle();

    expect(status).toBe("onboarding");
  });

  it("a connected mailbox still rescues the user when the handler call itself fails", async () => {
    // After BACKLOG-3293 a live token makes `completed` true on its own
    // (`checkGoogleConnection` in connectionStatusService.ts reads the same
    // oauth_tokens row the handler does), so the `|| hasEmailConnected` operand
    // of `hasCompletedEmailOnboarding` is redundant on a normal launch. Its
    // ONLY remaining job is the handler's failure paths — the `.catch` on the
    // checkEmailOnboarding call in LoadingOrchestrator, and the transient
    // DB-not-ready return in `handleCheckEmailOnboarding` — both of which
    // answer completed=false for a user who DOES have a mailbox. Nothing else
    // pins that operand, and it is the last thing between a transient
    // main-process hiccup and a mailbox-having user dropped into onboarding.
    mockApi.preferences.get.mockResolvedValue({
      success: true,
      preferences: {
        onboarding: { fdaSkipped: true, fdaSkippedAt: 1_700_000_000_000 },
      },
    });
    mockApi.auth.checkEmailOnboarding.mockResolvedValue({
      success: false,
      completed: false,
    });
    // `beforeEach` leaves google connected — that is the operand under test.

    const status = await renderAndSettle();

    expect(status).toBe("ready");
  });
});
