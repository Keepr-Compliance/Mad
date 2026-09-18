/**
 * BACKLOG-3281 — useEmailHandlers must END a failed mailbox-connect attempt.
 *
 * ===========================================================================
 * WHAT THIS SUITE IS FOR
 * ===========================================================================
 * The onboarding Connect button clears its "Connecting..." state only when the
 * flow reports a terminal outcome. Before this change `useEmailHandlers`
 * reported exactly one — success — so every failure the main process can emit
 * left the button spinning and disabled permanently.
 *
 * Two things have to be true and neither implies the other:
 *
 *   1. Every failure shape the main process can send reaches the renderer bus
 *      as a connect-failed event (this file), and
 *   2. the component acts on that event (EmailConnectStep.connectFailure-3281).
 *
 * This suite therefore drives the REAL IPC payloads through the hook's
 * `onMailboxConnected` callback and listens on the REAL window bus. The event
 * utilities are deliberately NOT mocked: a mocked emitter would make the
 * branch-ordering control below assert against the mock instead of the bus.
 *
 * ===========================================================================
 * THE PAYLOAD FIXTURES ARE TRANSCRIBED, NOT INVENTED
 * ===========================================================================
 * All five are copied from the emitters at `develop` @ a6fe128aa. `git grep -n
 * '"google:mailbox-connected"\|"microsoft:mailbox-connected"' -- electron`
 * returns six emitters; the two success ones are covered separately below.
 *
 *   P1  electron/handlers/googleAuthHandlers.ts:758-761
 *   P2  electron/handlers/googleAuthHandlers.ts:837-840      <- the 5-min timeout
 *   P3  electron/handlers/microsoftAuthHandlers.ts:643-646
 *   P4a electron/handlers/microsoftAuthHandlers.ts:726-730, adminConsentRequired false
 *   P4b electron/handlers/microsoftAuthHandlers.ts:726-730, adminConsentRequired true
 *
 * P4a and P4b are the SAME emitter. `adminConsentRequired` is computed at
 * microsoftAuthHandlers.ts:703 as `isAdminConsentError(error)`, so that emitter
 * produces both shapes — and the Microsoft five-minute timeout is P4a, not P4b.
 * Testing only P4b would leave the founder's actual Outlook case uncovered.
 *
 * ===========================================================================
 * MUTATIONS (planted against the committed tree, confirmed red BY NAME, then
 * reverted — see the PR body)
 * ===========================================================================
 *  C3   drop `emitEmailConnectFailed` from the Google pre-flight `!result.success`
 *  C3   drop `emitEmailConnectFailed` from the Microsoft pre-flight `!result.success`
 *  C2b  swap the Microsoft listener's admin-consent and generic branches
 */

import { renderHook, act } from "@testing-library/react";
import { useEmailHandlers } from "../useEmailHandlers";
import type { UseEmailHandlersOptions } from "../useEmailHandlers";
import { EMAIL_CONNECT_FAILED } from "../../../../utils/emailConnectFailedEvents";
import type { EmailConnectFailedEventDetail } from "../../../../utils/emailConnectFailedEvents";
import { EMAIL_ADMIN_CONSENT_BLOCKED } from "../../../../utils/emailAdminConsentEvents";
import type { EmailAdminConsentEventDetail } from "../../../../utils/emailAdminConsentEvents";

type ConnectionResult = {
  success: boolean;
  email?: string;
  error?: string;
  adminConsentRequired?: boolean;
};

const authService = {
  googleConnectMailbox: jest.fn(),
  microsoftConnectMailbox: jest.fn(),
  onMailboxConnected: jest.fn(),
};

jest.mock("@/services", () => ({
  get authService() {
    return authService;
  },
}));

jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Payload fixtures — transcribed verbatim from the emitters cited above.
// ---------------------------------------------------------------------------
const P1: ConnectionResult = {
  success: false,
  error: "Failed to save credentials. Please try logging in again.",
};
const P2: ConnectionResult = {
  success: false,
  error: "OAuth authentication timed out after 5 minutes",
};
const P3: ConnectionResult = {
  success: false,
  error: "Failed to save credentials. Please try logging in again.",
};
const P4a: ConnectionResult = {
  success: false,
  error: "OAuth authentication timed out after 5 minutes",
  adminConsentRequired: false,
};
const P4b: ConnectionResult = {
  success: false,
  error: "AADSTS65001: The user or administrator has not consented to use the application",
  adminConsentRequired: true,
};

const setHasEmailConnected = jest.fn();
const setPendingOnboardingData = jest.fn();

const defaultOptions = (): UseEmailHandlersOptions => ({
  currentUserId: "u1",
  currentUserEmail: "u1@example.com",
  isMacOS: true,
  isWindows: false,
  selectedPhoneType: "iphone",
  needsDriverSetup: false,
  hasPermissions: true,
  setPendingOnboardingData:
    setPendingOnboardingData as unknown as UseEmailHandlersOptions["setPendingOnboardingData"],
  setHasEmailConnected,
  setCurrentStep: jest.fn(),
  completeEmailOnboarding: jest.fn().mockResolvedValue(undefined),
});

/** Listens on the real window bus — no mocked emitter. */
function spyOnBus() {
  const failed: EmailConnectFailedEventDetail[] = [];
  const adminConsent: EmailAdminConsentEventDetail[] = [];
  const onFailed = (e: Event) =>
    failed.push((e as CustomEvent<EmailConnectFailedEventDetail>).detail);
  const onAdmin = (e: Event) =>
    adminConsent.push((e as CustomEvent<EmailAdminConsentEventDetail>).detail);
  window.addEventListener(EMAIL_CONNECT_FAILED, onFailed);
  window.addEventListener(EMAIL_ADMIN_CONSENT_BLOCKED, onAdmin);
  return {
    failed,
    adminConsent,
    stop: () => {
      window.removeEventListener(EMAIL_CONNECT_FAILED, onFailed);
      window.removeEventListener(EMAIL_ADMIN_CONSENT_BLOCKED, onAdmin);
    },
  };
}

/** Captures the callback the hook registers, so a payload can be delivered. */
function captureListener(): { fire: (r: ConnectionResult) => void; cleanup: jest.Mock } {
  const cleanup = jest.fn();
  let cb: ((r: ConnectionResult) => void) | undefined;
  authService.onMailboxConnected.mockImplementation(
    (_provider: string, callback: (r: ConnectionResult) => void) => {
      cb = callback;
      return cleanup;
    },
  );
  return {
    fire: (r) => {
      if (!cb) throw new Error("no mailbox-connected listener was registered");
      cb(r);
    },
    cleanup,
  };
}

describe("useEmailHandlers connect failure (BACKLOG-3281)", () => {
  let bus: ReturnType<typeof spyOnBus>;

  beforeEach(() => {
    jest.clearAllMocks();
    authService.onMailboxConnected.mockReturnValue(() => {});
    bus = spyOnBus();
  });

  afterEach(() => {
    bus.stop();
  });

  // =========================================================================
  // C3 — path 1: the pre-flight IPC result resolves success:false.
  // Terminal on arrival: the flow never started, so no mailbox-connected event
  // will ever come. Both providers — the Google listener has no `else` at all,
  // which makes it the easier of the two to forget.
  // =========================================================================
  describe("C3 — pre-flight failure is terminal on arrival", () => {
    it("Google: emits connect-failed and registers NO listener", async () => {
      authService.googleConnectMailbox.mockResolvedValue({
        success: false,
        error: "No valid user session",
      });

      const { result } = renderHook(() => useEmailHandlers(defaultOptions()));
      await act(async () => {
        await result.current.handleStartGoogleEmailConnect();
      });

      expect(bus.failed).toEqual([
        { provider: "google", error: "No valid user session" },
      ]);
      expect(authService.onMailboxConnected).not.toHaveBeenCalled();
    });

    it("Microsoft: emits connect-failed and registers NO listener", async () => {
      authService.microsoftConnectMailbox.mockResolvedValue({
        success: false,
        error: "No valid user session",
      });

      const { result } = renderHook(() => useEmailHandlers(defaultOptions()));
      await act(async () => {
        await result.current.handleStartMicrosoftEmailConnect();
      });

      expect(bus.failed).toEqual([
        { provider: "microsoft", error: "No valid user session" },
      ]);
      expect(authService.onMailboxConnected).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // C1 (hook half) — path 2: every failure payload the main process can emit
  // reaches the bus. The component half is in
  // EmailConnectStep.connectFailure-3281.test.tsx.
  // =========================================================================
  describe("C1 — every emittable failure payload reaches the bus", () => {
    it.each([
      ["P1 googleAuthHandlers.ts:758-761", "google" as const, P1],
      ["P2 googleAuthHandlers.ts:837-840 (5-minute timeout)", "google" as const, P2],
      ["P3 microsoftAuthHandlers.ts:643-646", "microsoft" as const, P3],
      [
        "P4a microsoftAuthHandlers.ts:726-730 (5-minute timeout, adminConsentRequired false)",
        "microsoft" as const,
        P4a,
      ],
    ])("%s", async (_label, provider, payload) => {
      const connect =
        provider === "google"
          ? authService.googleConnectMailbox
          : authService.microsoftConnectMailbox;
      connect.mockResolvedValue({ success: true });
      const listener = captureListener();

      const { result } = renderHook(() => useEmailHandlers(defaultOptions()));
      await act(async () => {
        await (provider === "google"
          ? result.current.handleStartGoogleEmailConnect()
          : result.current.handleStartMicrosoftEmailConnect());
      });
      act(() => listener.fire(payload));

      expect(bus.failed).toEqual([{ provider, error: payload.error }]);
      // A terminated flow also stops listening.
      expect(listener.cleanup).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // C2b — the BACKLOG-2007 admin-consent branch must keep winning. The generic
  // branch is a THIRD branch ordered after it; merging or reordering them would
  // remove the "Request IT approval" flow, or show both surfaces at once.
  // =========================================================================
  describe("C2b — the admin-consent branch still wins (BACKLOG-2007)", () => {
    it("P4b routes to admin-consent ONLY, never to the generic failure bus", async () => {
      authService.microsoftConnectMailbox.mockResolvedValue({ success: true });
      const listener = captureListener();

      const { result } = renderHook(() => useEmailHandlers(defaultOptions()));
      await act(async () => {
        await result.current.handleStartMicrosoftEmailConnect();
      });
      act(() => listener.fire(P4b));

      expect(bus.adminConsent).toEqual([
        { provider: "microsoft", error: P4b.error },
      ]);
      expect(bus.failed).toEqual([]);
    });

    it("Google never reaches the admin-consent branch — it has no such classification", async () => {
      // `adminConsentRequired` has exactly one producer in the tree,
      // microsoftAuthHandlers.ts:703. Even if a Google payload somehow carried
      // it, Google's listener has no admin-consent branch, so it stays generic.
      authService.googleConnectMailbox.mockResolvedValue({ success: true });
      const listener = captureListener();

      const { result } = renderHook(() => useEmailHandlers(defaultOptions()));
      await act(async () => {
        await result.current.handleStartGoogleEmailConnect();
      });
      act(() =>
        listener.fire({ ...P2, adminConsentRequired: true } as ConnectionResult),
      );

      expect(bus.failed).toEqual([{ provider: "google", error: P2.error }]);
      expect(bus.adminConsent).toEqual([]);
    });
  });

  // =========================================================================
  // C2 (hook half) — the success path is unshadowed by the new branch.
  // =========================================================================
  describe("C2 — success is unshadowed", () => {
    it.each([["google" as const], ["microsoft" as const]])(
      "%s: a success connects and emits no failure",
      async (provider) => {
        const connect =
          provider === "google"
            ? authService.googleConnectMailbox
            : authService.microsoftConnectMailbox;
        connect.mockResolvedValue({ success: true });
        const listener = captureListener();

        const { result } = renderHook(() => useEmailHandlers(defaultOptions()));
        await act(async () => {
          await (provider === "google"
            ? result.current.handleStartGoogleEmailConnect()
            : result.current.handleStartMicrosoftEmailConnect());
        });
        act(() => listener.fire({ success: true, email: "user@example.com" }));

        expect(setHasEmailConnected).toHaveBeenCalledWith(
          true,
          "user@example.com",
          provider,
        );
        expect(bus.failed).toEqual([]);
      },
    );

    /**
     * BACKLOG-3286 — NOT fixed here, pinned so the choice is visible.
     *
     * `success: true` with no email matches no branch, on either provider. The
     * new branch is `else if (!connectionResult.success)` rather than a bare
     * `else` precisely so this case is NOT reported to the user as a failure:
     * `saveOAuthToken` has already written `mailbox_connected: 1` by the time
     * that event is sent, so calling it a failure would contradict the database
     * and invite a retry of a connection that exists. It stays honestly stuck
     * until the producer is fixed.
     */
    it.each([["google" as const], ["microsoft" as const]])(
      "%s: a success with no email is NOT reported as a failure (BACKLOG-3286)",
      async (provider) => {
        const connect =
          provider === "google"
            ? authService.googleConnectMailbox
            : authService.microsoftConnectMailbox;
        connect.mockResolvedValue({ success: true });
        const listener = captureListener();

        const { result } = renderHook(() => useEmailHandlers(defaultOptions()));
        await act(async () => {
          await (provider === "google"
            ? result.current.handleStartGoogleEmailConnect()
            : result.current.handleStartMicrosoftEmailConnect());
        });
        act(() => listener.fire({ success: true }));

        expect(bus.failed).toEqual([]);
        expect(bus.adminConsent).toEqual([]);
        expect(setHasEmailConnected).not.toHaveBeenCalled();
      },
    );
  });
});
