/**
 * Tests for SupportAccessSettings.tsx (BACKLOG-2430, BACKLOG-2428)
 *
 * Two claims, both about what the screen tells a user:
 *
 *  - A capture that failed is shown. Before this the failure threw at a timer
 *    where nothing caught it, so the panel kept counting down over an empty
 *    report list — indistinguishable from a quiet machine. Someone could grant
 *    access for seven days and send nothing without ever being told.
 *  - The grant screen no longer offers, badges or warns about a scope that
 *    names an individual, because there is no longer such a scope.
 *
 * Wrapped in StrictMode per repo convention (StrictMode is ON in main.tsx).
 * The renderer service is mocked — components never call window.api directly.
 */

import React, { StrictMode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// --- Mocks -----------------------------------------------------------------

const mockGetSnapshot = jest.fn();
const mockCaptureNow = jest.fn();
const mockDeleteReport = jest.fn();

jest.mock("../../../services/supportAccessService", () => {
  const actual = jest.requireActual("../../../services/supportAccessService");
  return {
    ...actual,
    getSnapshot: () => mockGetSnapshot(),
    captureNow: () => mockCaptureNow(),
    grantAccess: jest.fn(),
    revokeAccess: jest.fn(),
    sendReport: jest.fn(),
    deleteReport: (id: string) => mockDeleteReport(id),
  };
});

const mockNotifyError = jest.fn();
const mockNotifySuccess = jest.fn();
jest.mock("@/hooks/useNotification", () => ({
  useNotification: () => ({
    notify: {
      error: (...args: unknown[]) => mockNotifyError(...args),
      success: (...args: unknown[]) => mockNotifySuccess(...args),
      warning: jest.fn(),
      info: jest.fn(),
    },
    dismiss: jest.fn(),
    dismissAll: jest.fn(),
  }),
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { SupportAccessSettings } from "../SupportAccessSettings";

// --- Fixtures --------------------------------------------------------------

const NOW = Date.parse("2026-08-02T23:55:00.000Z");

const SCOPES = [
  {
    id: "message-import" as const,
    label: "Text message import",
    description: "Chats found, messages read.",
  },
  {
    id: "contact-resolution" as const,
    label: "Matching numbers to names",
    description: "Lookups attempted, and how many resolved.",
  },
];

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      active: true,
      consent: {
        id: "consent-1",
        grantedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
        durationId: "7d" as const,
        appVersion: "2.27.0",
        disclosureId: "support-access-disclosure-v3",
        disclosureHash: "hash",
        disclosureText: "Wording.",
        scopes: ["message-import" as const],
      },
      msRemaining: 7 * 24 * 60 * 60 * 1000,
      history: [],
      everGranted: true,
    },
    reports: [],
    durations: [{ id: "7d" as const, label: "7 days", ms: 604800000 }],
    defaultDurationId: "7d" as const,
    scopes: SCOPES,
    defaultScopes: ["message-import" as const],
    disclosure: { id: "support-access-disclosure-v3", text: "Wording.", hash: "h" },
    retentionDays: 30,
    captureFailure: null,
    ...overrides,
  };
}

describe("SupportAccessSettings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("a capture that failed", () => {
    it("says support is receiving nothing, and why", async () => {
      mockGetSnapshot.mockResolvedValue(
        snapshot({
          captureFailure: {
            reason: "scheduled",
            at: new Date(NOW).toISOString(),
            message:
              "[KeychainGate] Cannot encrypt - keychain access not yet allowed.",
          },
        }),
      );

      render(
        <StrictMode>
          <SupportAccessSettings />
        </StrictMode>,
      );

      const alert = await screen.findByTestId("support-capture-failure");
      expect(alert).toHaveTextContent(/support is receiving nothing/i);
      expect(alert).toHaveTextContent(/keychain access not yet allowed/i);
      // The window is still open — the user has to be able to tell that the
      // countdown and the collection are two different facts.
      expect(
        screen.getByRole("button", { name: /turn off now/i }),
      ).toBeInTheDocument();
    });

    it("shows nothing when captures are working", async () => {
      mockGetSnapshot.mockResolvedValue(snapshot());

      render(
        <StrictMode>
          <SupportAccessSettings />
        </StrictMode>,
      );

      // Positive control for the negative assertion: the panel did render.
      await screen.findByText(/support access is on until/i);
      expect(
        screen.queryByTestId("support-capture-failure"),
      ).not.toBeInTheDocument();
    });

    it("still surfaces a manual failure through the toast", async () => {
      mockGetSnapshot.mockResolvedValue(snapshot());
      mockCaptureNow.mockRejectedValue(new Error("secure storage unavailable"));

      render(
        <StrictMode>
          <SupportAccessSettings />
        </StrictMode>,
      );

      fireEvent.click(
        await screen.findByRole("button", { name: /capture a report now/i }),
      );

      await waitFor(() => {
        expect(mockNotifyError).toHaveBeenCalledWith(
          expect.stringMatching(/secure storage unavailable/i),
        );
      });
      expect(mockNotifySuccess).not.toHaveBeenCalled();
    });
  });

  /**
   * BACKLOG-2428. A window can now end because every area it covered was
   * removed from the app. The user turned support access on and it is off
   * again through no action of theirs, so noticing the banner has gone must
   * not be how they find out.
   */
  describe("a window ended because its scopes were removed", () => {
    function endedSnapshot(endedReason: string) {
      const base = snapshot();
      return snapshot({
        state: {
          ...base.state,
          active: false,
          msRemaining: 0,
          consent: {
            ...base.state.consent,
            scopes: [],
            endedAt: new Date(NOW).toISOString(),
            endedReason,
          },
        },
      });
    }

    it("tells the user why it is off", async () => {
      mockGetSnapshot.mockResolvedValue(endedSnapshot("scopes-unavailable"));

      render(
        <StrictMode>
          <SupportAccessSettings />
        </StrictMode>,
      );

      const notice = await screen.findByTestId("support-scopes-unavailable");
      expect(notice).toHaveTextContent(/no longer part of keepr/i);
      expect(notice).toHaveTextContent(/turn it back on/i);
    });

    it("says nothing when the window was simply revoked", async () => {
      mockGetSnapshot.mockResolvedValue(endedSnapshot("revoked"));

      render(
        <StrictMode>
          <SupportAccessSettings />
        </StrictMode>,
      );

      // Positive control: the off-state panel really did render.
      await screen.findByText(/support access is off/i);
      expect(
        screen.queryByTestId("support-scopes-unavailable"),
      ).not.toBeInTheDocument();
    });

    it("says nothing while a window is still open", async () => {
      mockGetSnapshot.mockResolvedValue(snapshot());

      render(
        <StrictMode>
          <SupportAccessSettings />
        </StrictMode>,
      );

      await screen.findByText(/support access is on until/i);
      expect(
        screen.queryByTestId("support-scopes-unavailable"),
      ).not.toBeInTheDocument();
    });
  });

  describe("the grant screen", () => {
    async function openGrantPanel() {
      mockGetSnapshot.mockResolvedValue(
        snapshot({
          state: { ...snapshot().state, active: false },
        }),
      );

      render(
        <StrictMode>
          <SupportAccessSettings />
        </StrictMode>,
      );

      fireEvent.click(
        await screen.findByRole("button", { name: /turn on support access/i }),
      );
    }

    it("offers no scope badged as naming an individual", async () => {
      await openGrantPanel();

      // Positive control: the scope list really did render.
      expect(await screen.findByText("Text message import")).toBeInTheDocument();
      expect(screen.getByText("Matching numbers to names")).toBeInTheDocument();

      // BACKLOG-2428: the badge and the amber warning it gated are gone with
      // the only scope that ever set the flag.
      expect(screen.queryByText(/names an individual/i)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/records one contact's name and number/i),
      ).not.toBeInTheDocument();
    });

    it("no longer asks the user to confirm their contacts will be sent", async () => {
      await openGrantPanel();

      const confirmation = await screen.findByText(/i understand that/i);
      expect(confirmation).toHaveTextContent(
        /record of what the app did on this computer/i,
      );
      expect(confirmation).toHaveTextContent(
        // Not vague-and-true. This is the sentence a user is guaranteed to
        // read, because ticking it is the affirmative action, so it names the
        // residual PII route the hashed disclosure body deliberately keeps.
        /error messages that can occasionally include a name/i,
      );
      expect(confirmation).toHaveTextContent(/counts and outcomes/i);
      expect(confirmation).not.toHaveTextContent(
        /names and phone numbers will be sent/i,
      );
    });
  });

  /**
   * BACKLOG-3443. Support access is not Mac-only — the great majority of
   * recorded syncs come from Windows — and this panel told every user their
   * reports sat on "this Mac". Six user-visible strings said it, in four
   * different render states, so one render cannot reach them all: each state
   * is driven here separately.
   */
  describe("the platform word", () => {
    const UNSENT_REPORT = {
      id: "report-1",
      capturedAt: new Date(NOW).toISOString(),
      reason: "scheduled" as const,
      byteSize: 2048,
      rawByteSize: 8192,
      scopes: ["message-import" as const],
      covers: "Text message import",
      state: "pending" as const,
      truncated: false,
      truncatedBytes: 0,
      consentId: "consent-1",
      localDeleteInDays: 12,
    };

    function offSnapshot(overrides: Record<string, unknown> = {}) {
      const base = snapshot();
      return snapshot({
        state: { ...base.state, active: false, msRemaining: 0 },
        ...overrides,
      });
    }

    it("says 'this computer' in the off-state explainer", async () => {
      mockGetSnapshot.mockResolvedValue(offSnapshot());

      render(
        <StrictMode>
          <SupportAccessSettings />
        </StrictMode>,
      );

      // Positive control: the off-state panel really did render.
      const explainer = await screen.findByText(/if keepr support asks you/i);
      expect(explainer).toHaveTextContent(
        /the app is doing on this computer for a period you choose/i,
      );
      expect(explainer).not.toHaveTextContent(/\bmac\b/i);
    });

    it("says 'this computer' on the line the user has to tick", async () => {
      mockGetSnapshot.mockResolvedValue(offSnapshot());

      render(
        <StrictMode>
          <SupportAccessSettings />
        </StrictMode>,
      );

      fireEvent.click(
        await screen.findByRole("button", { name: /turn on support access/i }),
      );

      const confirmation = await screen.findByText(/i understand that/i);
      expect(confirmation).toHaveTextContent(
        /record of what the app did on this computer/i,
      );
      expect(confirmation).not.toHaveTextContent(/\bmac\b/i);
    });

    it("says 'this computer' where the reports are listed", async () => {
      mockGetSnapshot.mockResolvedValue(
        offSnapshot({ reports: [UNSENT_REPORT] }),
      );

      render(
        <StrictMode>
          <SupportAccessSettings />
        </StrictMode>,
      );

      const blurb = await screen.findByText(/everything captured on/i);
      expect(blurb).toHaveTextContent(
        /everything captured on this computer, waiting to go and already sent/i,
      );
      expect(blurb).toHaveTextContent(/as from this computer/i);
      expect(blurb).not.toHaveTextContent(/\bmac\b/i);

      // The unsent row carries its own local deadline, and said "this Mac".
      const countdown = screen.getByText(/deleted from this computer in/i);
      expect(countdown).toHaveTextContent(
        /deleted from this computer in 12 days/i,
      );
    });

    it("says 'this computer' in the toast after a delete", async () => {
      mockGetSnapshot.mockResolvedValue(
        offSnapshot({ reports: [UNSENT_REPORT] }),
      );
      mockDeleteReport.mockResolvedValue({ deleted: true, reports: [] });

      render(
        <StrictMode>
          <SupportAccessSettings />
        </StrictMode>,
      );

      fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

      await waitFor(() => {
        expect(mockNotifySuccess).toHaveBeenCalledWith(
          "Report deleted from this computer and from Keepr",
        );
      });
      expect(mockNotifyError).not.toHaveBeenCalled();
    });
  });
});
