/**
 * BACKLOG-3349 — C12: the container asks main, and main's answer reaches the row.
 *
 * ---------------------------------------------------------------------------
 * Why a container test exists at all, when the row already has C9-C11
 * ---------------------------------------------------------------------------
 * C9-C11 hand the row a state directly. They prove the row DRAWS correctly and
 * nothing about where the state comes from — a build that never calls the
 * channel, or calls it and drops the answer, passes every one of them.
 *
 * This file is also the positive control for the fail-closed default added to
 * `tests/setup.js`. Thirteen settings suites run with `strictState` defaulting
 * to `'blocked'` and 246 of 246 tests stay green; that zero is only meaningful
 * if the default actually reaches the row, and the first case below is what
 * says it does.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ContactsSettings } from "../ContactsSettings";
import { PlatformProvider } from "../../../contexts/PlatformContext";

jest.mock("../../../services", () => ({
  settingsService: {
    updatePreferences: jest.fn().mockResolvedValue({ success: true }),
  },
}));

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ queue: [], isRunning: false, requestSync: jest.fn() }),
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

const originalApi = window.api;

const SWITCH_NAME = "Outlook emails auto-discover";

/**
 * The user has the switch ON and the mailbox connected — the one starting
 * state in which the plan is the only thing that can turn the row off. With
 * either of the other two terms false, every case here would pass for the
 * wrong reason.
 */
const PREFS = {
  phone_type: "iphone",
  contactSources: {
    direct: { macosContacts: true, outlookContacts: true },
    inferred: { outlookEmails: true },
  },
};

function renderSettings(strictState?: jest.Mock) {
  Object.defineProperty(window, "api", {
    value: {
      ...originalApi,
      system: { ...originalApi?.system, platform: "darwin" },
      featureGate: {
        ...originalApi?.featureGate,
        ...(strictState ? { strictState } : {}),
      },
      contacts: {
        getExternalSyncStatus: jest
          .fn()
          .mockResolvedValue({ success: true, lastSyncAt: null, contactCount: 0 }),
        syncOutlookContacts: jest.fn().mockResolvedValue({ success: true, count: 0 }),
        syncGoogleContacts: jest.fn().mockResolvedValue({ success: true, count: 0 }),
        syncExternal: jest.fn().mockResolvedValue({ success: true }),
        forceReimport: jest.fn().mockResolvedValue({ success: true, cleared: 0 }),
        getSourceStats: jest.fn().mockResolvedValue({ success: true, stats: {} }),
      },
    },
    writable: true,
    configurable: true,
  });

  return render(
    <PlatformProvider>
      <ContactsSettings
        userId="user-1"
        initialPreferences={PREFS as never}
        isMicrosoftConnected={true}
        isGoogleConnected={false}
        androidCompanionActive={false}
      />
    </PlatformProvider>,
  );
}

afterEach(() => {
  Object.defineProperty(window, "api", {
    value: originalApi,
    writable: true,
    configurable: true,
  });
  jest.clearAllMocks();
});

describe("C12 — the plan state the container reads reaches the Outlook emails row", () => {
  it("the fail-closed default in tests/setup.js really does reach the row", async () => {
    // No override: this is the shared default the other 13 settings suites run
    // under. If it stopped reaching the row, their green would stop meaning
    // anything and nothing else would notice.
    renderSettings();

    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH_NAME })).toBeDisabled();
    });
    const sw = screen.getByRole("switch", { name: SWITCH_NAME });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveAttribute("title", "Not available on your current plan");
    // BACKLOG-1717: TWO rows now carry this label — Outlook and Gmail are one
    // paid feature on one plan key, so they grey together. Before this item
    // only the Outlook row did, which read as "Gmail is included".
    expect(screen.getAllByText("(not in your plan)")).toHaveLength(2);
  });

  it("asks main for the email-inference key, once", async () => {
    const strictState = jest.fn().mockResolvedValue("blocked");
    renderSettings(strictState);

    await waitFor(() => expect(strictState).toHaveBeenCalled());
    expect(strictState).toHaveBeenCalledWith("email_contact_inference");
  });

  it("an ALLOWED answer leaves the user's own switch on and usable", async () => {
    // The mirror of the first case. Without it, every assertion above would
    // hold against a row that ignores the answer and is always disabled.
    const strictState = jest.fn().mockResolvedValue("allowed");
    renderSettings(strictState);

    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH_NAME })).toBeEnabled();
    });
    const sw = screen.getByRole("switch", { name: SWITCH_NAME });
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("(not in your plan)")).not.toBeInTheDocument();
  });

  it("an UNKNOWN answer disables the row without claiming anything about the plan", async () => {
    const strictState = jest.fn().mockResolvedValue("unknown");
    renderSettings(strictState);

    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH_NAME })).toBeDisabled();
    });
    expect(screen.getByRole("switch", { name: SWITCH_NAME })).toHaveAttribute(
      "title",
      "Can't check your plan right now"
    );
    expect(screen.queryByText("(not in your plan)")).not.toBeInTheDocument();
  });

  it("a REJECTED lookup is unknown, not blocked", async () => {
    const strictState = jest.fn().mockRejectedValue(new Error("ipc down"));
    renderSettings(strictState);

    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH_NAME })).toHaveAttribute(
        "title",
        "Can't check your plan right now"
      );
    });
    expect(screen.queryByText("(not in your plan)")).not.toBeInTheDocument();
  });
});
