/**
 * BACKLOG-3156 stage A — THE THREE SECTIONS SIT IN THE SAME ORDER.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * Emails, Messages and Contacts do the same three things and, until this
 * change, looked like three products doing them. The founder-approved design
 * fixes the ORDER — Sources, then Import Preferences, then Stored on this
 * computer, then the actions — and the order is the only part of it a test can
 * hold still. Every block here already existed in some arrangement; nothing but
 * position and labelling changed, so a suite that asserted the blocks were
 * PRESENT would have passed before the change and would pass after any future
 * reshuffle. Position is the claim, so position is what is asserted.
 *
 * Contacts has no import preferences to set and therefore no block 2. The order
 * is the consistent thing across the three sections, not the block count.
 *
 * ===========================================================================
 * MUTATION (run before trusting a green)
 * ===========================================================================
 * Swap any two adjacent blocks in the component — e.g. move the Emails
 * "Stored on this computer" card above the "Import Preferences" card — and the
 * matching test goes red. Verified for all three sections on the commit that
 * added this file.
 */

import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EmailSettings } from "../EmailSettings";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";
import { AndroidMessagesSettings } from "../AndroidMessagesSettings";
import { ContactsSettings } from "../ContactsSettings";
import { PlatformProvider } from "../../../contexts/PlatformContext";

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

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ queue: [], isRunning: false, requestSync: jest.fn() }),
}));

jest.mock("../../../services", () => ({
  /**
   * BACKLOG-3208: the macOS Messages panel now asks whether Full Disk Access is
   * usable before it offers an import, through the same service abstraction it
   * already uses for preferences. Granted is this suite's premise — nothing
   * here is about the permission notice. Its own suite is
   * `MacOSMessagesImportSettings.fdaRecovery-3208.test.tsx`.
   */
  systemService: {
    checkMessagesPermission: jest
      .fn()
      .mockResolvedValue({ success: true, data: { hasPermission: true } }),
    openFullDiskAccessSettings: jest.fn().mockResolvedValue({ success: true }),
    relaunchApp: jest
      .fn()
      .mockResolvedValue({ success: true, data: { relaunched: true } }),
  },
  settingsService: {
    getPreferences: jest.fn().mockResolvedValue({ success: true, data: {} }),
    updatePreferences: jest.fn().mockResolvedValue({ success: true }),
  },
  authService: {
    googleConnectMailbox: jest.fn(),
    microsoftConnectMailbox: jest.fn(),
    googleDisconnectMailbox: jest.fn(),
    microsoftDisconnectMailbox: jest.fn(),
    onMailboxConnected: jest.fn(() => () => {}),
  },
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/**
 * `Node.DOCUMENT_POSITION_FOLLOWING === 4`. Asserted pairwise down the list so a
 * failure names WHICH neighbour moved, rather than reporting "the order is
 * wrong" for any of several possible swaps.
 */
function expectInOrder(testIds: string[]): void {
  const nodes = testIds.map((id) => {
    const el = screen.getByTestId(id);
    expect(el).toBeInTheDocument();
    return [id, el] as const;
  });
  for (let i = 0; i < nodes.length - 1; i++) {
    const [beforeId, before] = nodes[i];
    const [afterId, after] = nodes[i + 1];
    expect(
      `${beforeId} then ${afterId}: ${
        (before.compareDocumentPosition(after) & 4) !== 0
      }`,
    ).toBe(`${beforeId} then ${afterId}: true`);
  }
}

const originalApi = window.api;

afterEach(() => {
  Object.defineProperty(window, "api", {
    value: originalApi,
    writable: true,
    configurable: true,
  });
});

describe("BACKLOG-3156 — Emails", () => {
  beforeEach(() => {
    Object.defineProperty(window, "api", {
      value: {
        ...originalApi,
        system: {
          ...originalApi?.system,
          checkAllConnections: jest.fn().mockResolvedValue({
            success: true,
            google: { connected: true, email: "agent@example.com" },
            microsoft: { connected: false },
          }),
        },
        transactions: {
          precacheEmails: jest.fn(),
          cancelPrecacheEmails: jest.fn(),
          onPrecacheProgress: () => () => {},
        },
      },
      writable: true,
      configurable: true,
    });
  });

  it("runs Sources → Import Preferences → actions", async () => {
    render(<EmailSettings userId="u" initialPreferences={undefined as never} />);
    await waitFor(() =>
      expect(screen.getByTestId("emails-block-actions")).toBeInTheDocument(),
    );

    expectInOrder([
      "emails-block-sources",
      "emails-block-preferences",
      "emails-block-actions",
    ]);
  });

  /**
   * BACKLOG-3158 owns the per-provider cached-email count. Until it lands there
   * is no number to put in a "Stored on this computer" grid — the block was
   * built, rendered three em-dashes, and was removed on the founder's call
   * because that reads as broken software.
   *
   * This asserts the ABSENCE, so the block cannot come back unannounced. It is
   * not a permanent rule: whoever lands BACKLOG-3158 deletes this test in the
   * same commit that restores the block with its data, and the deletion is the
   * announcement.
   */
  it("has no Stored on this computer block until BACKLOG-3158 supplies the count", async () => {
    render(<EmailSettings userId="u" initialPreferences={undefined as never} />);
    await waitFor(() =>
      expect(screen.getByTestId("emails-block-actions")).toBeInTheDocument(),
    );

    expect(screen.queryByTestId("emails-block-stored")).not.toBeInTheDocument();
    expect(screen.queryByText("Stored on this computer")).not.toBeInTheDocument();
    // The em-dash placeholder specifically: its return is the failure mode this
    // guards, and it would not be caught by the testid check alone if the block
    // came back under a different wrapper.
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  /**
   * SR found an `<h4>Import Emails</h4>` sitting directly above the `Import
   * Emails` button — the same words twice in one column. Stage A dropped the
   * heading; STAGE B moved the prose it headed into the `?` popup and deleted
   * the card, so the resting page now says "Import Emails" exactly once and the
   * description is one `mouseDown` away rather than one line away.
   *
   * Both halves are asserted, because either alone passes on a mistake: the
   * count alone passes if the prose was simply DELETED, and the popup check
   * alone passes if the card was left on the page as well.
   */
  it("does not print the primary's name twice in the same column", async () => {
    render(<EmailSettings userId="u" initialPreferences={undefined as never} />);
    await waitFor(() =>
      expect(screen.getByTestId("emails-block-actions")).toBeInTheDocument(),
    );

    // Exactly one thing on the resting page says "Import Emails", and it is the
    // button.
    const hits = screen.getAllByText("Import Emails");
    expect(hits).toHaveLength(1);
    expect(hits[0].tagName).toBe("BUTTON");
    // …and the prose is not on the page beside it any more.
    expect(screen.queryByTestId("recache-description")).not.toBeInTheDocument();
    expect(screen.queryByText(/Fetches new mail/i)).not.toBeInTheDocument();

    // It is in the popup, unchanged in what it claims.
    fireEvent.mouseDown(screen.getByTestId("emails-import-info-button"));
    expect(screen.getByTestId("recache-description")).toHaveTextContent(
      /Fetches new mail/i,
    );
  });

  /**
   * The section heading and the dropdown label are renames this change makes,
   * and NOTHING read either string before it. "Email Connections" appeared in
   * one `describe()` name and in comments; the cache-duration control had no
   * label at all, only a bare select. A rename nobody reads is a rename that
   * drifts back, which is the shape of defect BACKLOG-3029 filed against this
   * very panel's sibling.
   */
  it("is called Emails, and its history control carries a label outside the border", async () => {
    render(<EmailSettings userId="u" initialPreferences={undefined as never} />);
    await waitFor(() =>
      expect(screen.getByTestId("emails-block-preferences")).toBeInTheDocument(),
    );

    expect(
      screen.getByRole("heading", { level: 3, name: "Emails" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Email Connections")).not.toBeInTheDocument();

    // The label is plain text OUTSIDE the control…
    const label = screen.getByText("Import emails from");
    expect(label.tagName).toBe("SPAN");
    expect(label.closest("select")).toBeNull();
    // …and the value reads the way both Messages filters read.
    expect(screen.getByDisplayValue("Last 3 months")).toBeInTheDocument();
  });

  it("puts the actions outside every card, primary before destructive", async () => {
    render(<EmailSettings userId="u" initialPreferences={undefined as never} />);
    const actions = await screen.findByTestId("emails-block-actions");

    // Bare on the page: no card ancestor between the actions and the section.
    expect(actions.closest(".bg-gray-50.rounded-lg")).toBeNull();
    // …and no heading of its own.
    expect(actions.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();

    const primary = screen.getByTestId("recache-emails");
    const destructive = screen.getByTestId("force-recache-emails");
    expect(primary).toHaveTextContent("Import Emails");
    expect(primary.compareDocumentPosition(destructive) & 4).toBeTruthy();
  });
});

describe("BACKLOG-3156 — Messages", () => {
  beforeEach(() => {
    (window.api.messages.getImportStatus as jest.Mock).mockResolvedValue({
      success: true,
      messageCount: 0,
      lastImportAt: null,
    });
    (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
      success: true,
      effectiveCutoffISO: null,
      source: "lookback-pref",
      lookbackMonths: 3,
    });
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
      success: true,
      count: 10,
      filteredCount: 10,
    });
  });

  it("macOS: Import Preferences precedes the actions", async () => {
    render(
      <PlatformProvider>
        <MacOSMessagesImportSettings userId="u" enabled />
      </PlatformProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("messages-block-actions")).toBeInTheDocument(),
    );

    expectInOrder(["messages-block-preferences", "messages-block-actions"]);
  });

  it("macOS: the actions sit outside the card, primary before destructive", async () => {
    render(
      <PlatformProvider>
        <MacOSMessagesImportSettings userId="u" enabled />
      </PlatformProvider>,
    );
    const actions = await screen.findByTestId("messages-block-actions");

    expect(actions.closest(".bg-gray-50.rounded-lg")).toBeNull();
    expect(actions.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();

    const primary = screen.getByRole("button", { name: "Import Messages" });
    const destructive = screen.getByRole("button", { name: "Force Re-import" });
    expect(primary.compareDocumentPosition(destructive) & 4).toBeTruthy();
  });

  it("Android: Import Preferences precedes the actions, which sit outside the card", async () => {
    render(<AndroidMessagesSettings userId="u" />);
    await waitFor(() =>
      expect(screen.getByTestId("android-block-actions")).toBeInTheDocument(),
    );

    expectInOrder(["android-block-preferences", "android-block-actions"]);

    const actions = screen.getByTestId("android-block-actions");
    expect(actions.closest(".bg-gray-50.rounded-lg")).toBeNull();
    expect(actions.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();
  });
});

describe("BACKLOG-3156 — Contacts", () => {
  beforeEach(() => {
    Object.defineProperty(window, "api", {
      value: {
        ...originalApi,
        system: { ...originalApi?.system, platform: "darwin" },
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
  });

  const renderContacts = () =>
    render(
      <PlatformProvider>
        <ContactsSettings
          userId="u"
          initialPreferences={{ phone_type: "iphone", contactSources: { direct: {} } } as never}
          isMicrosoftConnected={true}
          isGoogleConnected={false}
        />
      </PlatformProvider>,
    );

  it("runs Sources → Stored on this computer → actions (no preferences block to place)", async () => {
    renderContacts();
    await waitFor(() =>
      expect(screen.getByTestId("contacts-block-actions")).toBeInTheDocument(),
    );

    expectInOrder([
      "contacts-block-sources",
      "contacts-block-stored",
      "contacts-block-actions",
    ]);
    expect(screen.queryByTestId("contacts-block-preferences")).not.toBeInTheDocument();
  });

  it("puts the actions outside the card, primary before destructive", async () => {
    renderContacts();
    const actions = await screen.findByTestId("contacts-block-actions");

    expect(actions.closest(".bg-gray-50.rounded-lg")).toBeNull();
    expect(actions.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();

    const primary = screen.getByText("Import Contacts");
    const destructive = screen.getByRole("button", { name: "Force Re-import" });
    expect(primary.compareDocumentPosition(destructive) & 4).toBeTruthy();
  });
});
