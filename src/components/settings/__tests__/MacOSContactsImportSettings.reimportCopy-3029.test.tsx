/**
 * BACKLOG-3029 — THE FORCE RE-IMPORT COPY MAY NOT CLAIM IT CLEARS EVERY SOURCE.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * Scoping the wipe to the sources that will actually be refilled turned three
 * user-facing strings false in one commit — the button tooltip, the info
 * popover and the confirmation dialog all said every source is cleared. Nothing
 * went red, because no test read any of them.
 *
 * The dialog was already wrong before that: it named "Messages", which is not a
 * contact source at all, and it never mentioned the phone.
 *
 * That is worse than a stale comment. The dialog is on screen at the moment
 * someone decides whether to press the button, and it is the screen the founder
 * reads during the acceptance test for this very item — where the criterion is
 * that Android and a switched-off macOS SURVIVE. Copy promising the opposite
 * would make correct behaviour look like a failure.
 *
 * ===========================================================================
 * IT PINS THE CLAIMS, NOT THE PROSE
 * ===========================================================================
 * Asserting the exact sentences would freeze the wording and be rewritten by
 * the next person who improves it — a test that gets edited to match whatever
 * the code now says protects nothing.
 *
 * So these assert the two things that were FALSE (an every-source promise, and
 * "Messages" as a source) and the one thing that must be SAYABLE (the phone's
 * contacts are left alone). The words in between stay free to change.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ContactsImportSettings } from "../MacOSContactsImportSettings";
import { PlatformProvider } from "../../../contexts/PlatformContext";

const mockRequestSync = jest.fn();
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ queue: [], isRunning: false, requestSync: mockRequestSync }),
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

const defaultProps = {
  userId: "user-3029",
  outlookContactsEnabled: true,
  macosContactsEnabled: true,
  iphoneContactsEnabled: false,
  showIphoneContacts: false,
  androidContactsEnabled: true,
  androidContactsDeclared: true,
  androidCompanionActive: true,
  saveError: null,
  gmailContactsEnabled: true,
  googleContactsEnabled: true,
  outlookEmailsInferred: false,
  gmailEmailsInferred: false,
  messagesInferred: false,
  loadingPreferences: false,
  onToggleSource: jest.fn(),
};

function renderCard(): void {
  Object.defineProperty(window, "api", {
    value: {
      ...originalApi,
      system: { ...originalApi?.system, platform: "darwin" },
      contacts: {
        getExternalSyncStatus: jest
          .fn()
          .mockResolvedValue({ success: true, lastSyncAt: null, contactCount: 0 }),
        syncOutlookContacts: jest.fn().mockResolvedValue({ success: true, count: 5 }),
        syncGoogleContacts: jest.fn().mockResolvedValue({ success: true, count: 3 }),
        syncExternal: jest.fn().mockResolvedValue({ success: true }),
        forceReimport: jest.fn().mockResolvedValue({ success: true, cleared: 0 }),
        getSourceStats: jest
          .fn()
          .mockResolvedValue({ success: true, stats: { macos: 10, android_sync: 28, outlook: 7 } }),
      },
    },
    writable: true,
    configurable: true,
  });

  render(
    <PlatformProvider>
      <ContactsImportSettings {...defaultProps} />
    </PlatformProvider>,
  );
}

afterEach(() => {
  Object.defineProperty(window, "api", {
    value: originalApi,
    writable: true,
    configurable: true,
  });
});

/**
 * The promises that stopped being true. Each is a phrase a reader would take as
 * "nothing survives this button", which is now wrong.
 */
const EVERY_SOURCE_CLAIMS = [
  /every\s+(synced\s+)?source/i,
  /all\s+cached\s+contacts/i,
  /from\s+every\s+source/i,
  /all\s+sources/i,
];

function openConfirmDialog(): HTMLElement {
  fireEvent.click(screen.getByText("Force Re-import"));
  return screen.getByTestId("contacts-force-reimport-confirm-modal");
}

describe("Force Re-import copy describes what it actually does (BACKLOG-3029)", () => {
  it("PRECONDITION: the dialog opens and carries text to assert against", () => {
    // Without this the three absence assertions below would all pass on an
    // element that never rendered — the vacuous green this whole item is about.
    renderCard();
    const dialog = openConfirmDialog();

    expect(dialog).toBeInTheDocument();
    expect((dialog.textContent ?? "").length).toBeGreaterThan(80);
  });

  it("the dialog does not promise that every source is cleared", () => {
    renderCard();
    const text = openConfirmDialog().textContent ?? "";

    for (const claim of EVERY_SOURCE_CLAIMS) {
      expect(text).not.toMatch(claim);
    }
  });

  it("the dialog does not list Messages, which is not a contact source", () => {
    renderCard();
    const text = openConfirmDialog().textContent ?? "";

    expect(text).not.toMatch(/Messages/);
  });

  it("the dialog says the phone's contacts are left alone", () => {
    // The acceptance criterion, on the screen where the decision is made. This
    // is the assertion that would have caught the drift: the behaviour changed
    // and the copy did not follow it.
    renderCard();
    const text = openConfirmDialog().textContent ?? "";

    expect(text).toMatch(/phone/i);
  });

  it("the button tooltip does not promise that every source is cleared", () => {
    renderCard();
    const tooltip = screen.getByText("Force Re-import").getAttribute("title") ?? "";

    expect(tooltip.length).toBeGreaterThan(20);
    for (const claim of EVERY_SOURCE_CLAIMS) {
      expect(tooltip).not.toMatch(claim);
    }
  });

  it("the info popover does not promise that every source is cleared", () => {
    renderCard();
    fireEvent.mouseDown(screen.getByLabelText("Import info"));

    const popover = screen.getByText("Force Re-import", { selector: "p" }).parentElement;
    const text = popover?.textContent ?? "";

    expect(text).toMatch(/Force Re-import/);
    for (const claim of EVERY_SOURCE_CLAIMS) {
      expect(text).not.toMatch(claim);
    }
  });
});
