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

jest.mock("../../../services/supportAccessService", () => {
  const actual = jest.requireActual("../../../services/supportAccessService");
  return {
    ...actual,
    getSnapshot: () => mockGetSnapshot(),
    captureNow: () => mockCaptureNow(),
    grantAccess: jest.fn(),
    revokeAccess: jest.fn(),
    sendReport: jest.fn(),
    deleteReport: jest.fn(),
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
        /record of what the app did on this mac/i,
      );
      expect(confirmation).not.toHaveTextContent(
        /names and phone numbers will be sent/i,
      );
    });
  });
});
