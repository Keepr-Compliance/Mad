/**
 * Tests for ContactsImportSettings component (TASK-1989)
 *
 * Tests unified contacts settings card:
 * - Source toggle switches (persisted via props)
 * - Source stats grid
 * - Import button respects enabled sources
 * - Outlook reconnect handling
 * - No sources available state
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  ContactsImportSettings,
  formatContactSyncCounts,
} from "../settings/MacOSContactsImportSettings";
import { PlatformProvider } from "../../contexts/PlatformContext";

// Mock useSyncOrchestrator
const mockRequestSync = jest.fn();
jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({
    queue: [],
    isRunning: false,
    requestSync: mockRequestSync,
  }),
}));

// Mock useNetwork (TASK-2056: added useNetwork to ContactsImportSettings)
jest.mock("../../contexts/NetworkContext", () => ({
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

// Store original window.api
const originalApi = window.api;

// Mock contacts API
const mockGetExternalSyncStatus = jest.fn().mockResolvedValue({
  success: true,
  lastSyncAt: null,
  contactCount: 0,
});
const mockSyncOutlookContacts = jest.fn().mockResolvedValue({
  success: true,
  count: 5,
});
const mockSyncGoogleContacts = jest.fn().mockResolvedValue({
  success: true,
  count: 3,
});
const mockGetSourceStats = jest.fn().mockResolvedValue({
  success: true,
  stats: { macos: 10, iphone: 0, outlook: 5 },
});

const mockOnToggleSource = jest.fn();

/** Default props for the unified component */
const defaultProps = {
  userId: "user-1",
  outlookContactsEnabled: true,
  macosContactsEnabled: true,
  gmailContactsEnabled: true,
  googleContactsEnabled: true,
  outlookEmailsInferred: false,
  gmailEmailsInferred: false,
  messagesInferred: false,
  loadingPreferences: false,
  onToggleSource: mockOnToggleSource,
};

/**
 * Helper to render with PlatformProvider with a specific platform
 */
function renderWithPlatform(
  ui: React.ReactElement,
  platform: string = "darwin",
) {
  Object.defineProperty(window, "api", {
    value: {
      ...originalApi,
      system: {
        ...originalApi?.system,
        platform,
      },
      contacts: {
        getExternalSyncStatus: mockGetExternalSyncStatus,
        syncOutlookContacts: mockSyncOutlookContacts,
        syncGoogleContacts: mockSyncGoogleContacts,
        syncExternal: jest.fn().mockResolvedValue({ success: true }),
        forceReimport: jest.fn().mockResolvedValue({ success: true, cleared: 0 }),
        getSourceStats: mockGetSourceStats,
      },
    },
    writable: true,
    configurable: true,
  });

  return render(<PlatformProvider>{ui}</PlatformProvider>);
}

beforeEach(() => {
  mockRequestSync.mockClear();
  mockGetExternalSyncStatus.mockClear();
  mockSyncOutlookContacts.mockClear();
  mockSyncGoogleContacts.mockClear();
  mockGetSourceStats.mockClear();
  mockOnToggleSource.mockClear();

  // Reset mocks to default success values
  mockGetExternalSyncStatus.mockResolvedValue({
    success: true,
    lastSyncAt: null,
    contactCount: 0,
  });
  mockSyncOutlookContacts.mockResolvedValue({
    success: true,
    count: 5,
  });
  mockSyncGoogleContacts.mockResolvedValue({
    success: true,
    count: 3,
  });
  mockGetSourceStats.mockResolvedValue({
    success: true,
    stats: { macos: 10, iphone: 0, outlook: 5 },
  });
});

afterEach(() => {
  Object.defineProperty(window, "api", {
    value: originalApi,
    writable: true,
    configurable: true,
  });
});

describe("ContactsImportSettings", () => {
  describe("macOS platform", () => {
    it("should render toggle switches and import button on macOS", () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} />,
        "darwin"
      );

      expect(screen.getByText("Contacts")).toBeInTheDocument();
      expect(screen.getByText("Import Contacts")).toBeInTheDocument();
      expect(screen.getByText("Force Re-import")).toBeInTheDocument();
      expect(screen.getByLabelText("macOS iPhone Contacts import")).toBeInTheDocument();
    });

    it("should render both macOS and Outlook toggles when Microsoft is connected", () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} isMicrosoftConnected={true} />,
        "darwin"
      );

      expect(screen.getByLabelText("macOS iPhone Contacts import")).toBeInTheDocument();
      expect(screen.getByLabelText("Outlook Contacts import")).toBeInTheDocument();
    });

    it("should trigger macOS contacts sync when Import Contacts is clicked", () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} />,
        "darwin"
      );

      fireEvent.click(screen.getByText("Import Contacts"));

      expect(mockRequestSync).toHaveBeenCalledWith(["contacts"], "user-1");
    });
  });

  describe("non-macOS platform (Windows)", () => {
    it("should not render macOS toggle on Windows", () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} />,
        "win32"
      );

      // On Windows without Microsoft connected, should show "no sources" message
      expect(
        screen.getByText(/Connect a Microsoft or Google account/)
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("macOS iPhone Contacts import")).not.toBeInTheDocument();
    });

    it("should render Outlook toggle on Windows when Microsoft connected", () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} isMicrosoftConnected={true} />,
        "win32"
      );

      expect(screen.getByLabelText("Outlook Contacts import")).toBeInTheDocument();
      expect(screen.queryByLabelText("macOS iPhone Contacts import")).not.toBeInTheDocument();
    });
  });

  describe("no sources available", () => {
    it("should show helpful message when no sources available (Windows, no Microsoft)", () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} isMicrosoftConnected={false} />,
        "win32"
      );

      expect(
        screen.getByText(/Connect a Microsoft or Google account/)
      ).toBeInTheDocument();
      expect(screen.getByText("Contacts")).toBeInTheDocument();
    });
  });

  describe("Outlook contacts import", () => {
    it("should trigger Outlook contacts sync via unified Import button", async () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} isMicrosoftConnected={true} macosContactsEnabled={false} />,
        "win32"
      );

      fireEvent.click(screen.getByText("Import Contacts"));

      await waitFor(() => {
        expect(mockSyncOutlookContacts).toHaveBeenCalledWith("user-1");
      });
    });

    it("should show success result after Outlook sync", async () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} isMicrosoftConnected={true} />,
        "win32"
      );

      fireEvent.click(screen.getByText("Import Contacts"));

      await waitFor(() => {
        expect(screen.getByText(/Outlook contacts synced/)).toBeInTheDocument();
      });
    });

    it("should show reconnect required warning when Contacts.Read scope is missing", async () => {
      mockSyncOutlookContacts.mockResolvedValue({
        success: false,
        reconnectRequired: true,
        error: "Contacts.Read scope not granted",
      });

      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} isMicrosoftConnected={true} />,
        "win32"
      );

      fireEvent.click(screen.getByText("Import Contacts"));

      await waitFor(() => {
        expect(
          screen.getByText(/disconnect and reconnect your Microsoft mailbox/)
        ).toBeInTheDocument();
      });
    });

    it("should show error message when Outlook sync fails", async () => {
      mockSyncOutlookContacts.mockResolvedValue({
        success: false,
        error: "Network error",
      });

      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} isMicrosoftConnected={true} />,
        "win32"
      );

      fireEvent.click(screen.getByText("Import Contacts"));

      await waitFor(() => {
        expect(screen.getByText(/Outlook sync failed: Network error/)).toBeInTheDocument();
      });
    });
  });

  describe("source toggle callbacks", () => {
    it("should call onToggleSource when Outlook toggle is clicked", () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} isMicrosoftConnected={true} />,
        "darwin"
      );

      fireEvent.click(screen.getByLabelText("Outlook Contacts import"));

      expect(mockOnToggleSource).toHaveBeenCalledWith("direct", "outlookContacts", true);
    });

    it("should call onToggleSource when macOS toggle is clicked", () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} />,
        "darwin"
      );

      fireEvent.click(screen.getByLabelText("macOS iPhone Contacts import"));

      expect(mockOnToggleSource).toHaveBeenCalledWith("direct", "macosContacts", true);
    });

    it("should call onToggleSource when Messages toggle is clicked", () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} />,
        "darwin"
      );

      fireEvent.click(screen.getByLabelText("Messages SMS auto-discover"));

      expect(mockOnToggleSource).toHaveBeenCalledWith("inferred", "messages", false);
    });
  });

  // BACKLOG-2142: a disabled import toggle (no email connection) must explain
  // itself on hover via a title, using the unified copy "Connect email to
  // enable import".
  describe("disabled import toggle tooltip (BACKLOG-2142)", () => {
    it("adds an explanatory title to the disabled Outlook Contacts toggle when Microsoft is not connected", () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} isMicrosoftConnected={false} />,
        "darwin"
      );

      const toggle = screen.getByLabelText("Outlook Contacts import");
      expect(toggle).toBeDisabled();
      expect(toggle).toHaveAttribute("title", "Connect email to enable import");
    });

    it("adds an explanatory title to the disabled Google Contacts toggle when Google is not connected", () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} isGoogleConnected={false} />,
        "darwin"
      );

      const toggle = screen.getByLabelText("Google Contacts import");
      expect(toggle).toBeDisabled();
      expect(toggle).toHaveAttribute("title", "Connect email to enable import");
    });

    it("removes the title once the provider is connected (control enabled)", () => {
      renderWithPlatform(
        <ContactsImportSettings {...defaultProps} isMicrosoftConnected={true} />,
        "darwin"
      );

      const toggle = screen.getByLabelText("Outlook Contacts import");
      expect(toggle).toBeEnabled();
      expect(toggle).not.toHaveAttribute("title");
    });
  });

  // BACKLOG-2388 (#95): Force Re-import must be gated behind an explicit
  // confirmation dialog; it must NOT fire the destructive wipe immediately.
  describe("Force Re-import confirmation (BACKLOG-2388 #95)", () => {
    it("does not run the wipe on the first click — it opens a confirm dialog", () => {
      renderWithPlatform(<ContactsImportSettings {...defaultProps} />, "darwin");

      fireEvent.click(screen.getByText("Force Re-import"));

      // Dialog is shown, sync NOT yet requested.
      expect(
        screen.getByTestId("contacts-force-reimport-confirm-modal")
      ).toBeInTheDocument();
      expect(mockRequestSync).not.toHaveBeenCalled();
    });

    it("aborts the wipe when Cancel is clicked", () => {
      renderWithPlatform(<ContactsImportSettings {...defaultProps} />, "darwin");

      fireEvent.click(screen.getByText("Force Re-import"));
      fireEvent.click(screen.getByText("Cancel"));

      expect(
        screen.queryByTestId("contacts-force-reimport-confirm-modal")
      ).not.toBeInTheDocument();
      expect(mockRequestSync).not.toHaveBeenCalledWith(
        ["contacts"],
        "user-1",
        { forceReimport: true }
      );
    });

    it("runs the force re-import only after the dialog is confirmed", () => {
      renderWithPlatform(<ContactsImportSettings {...defaultProps} />, "darwin");

      fireEvent.click(screen.getByText("Force Re-import"));
      fireEvent.click(screen.getByTestId("contacts-force-reimport-confirm"));

      expect(mockRequestSync).toHaveBeenCalledWith(["contacts"], "user-1", {
        forceReimport: true,
      });
      expect(
        screen.queryByTestId("contacts-force-reimport-confirm-modal")
      ).not.toBeInTheDocument();
    });

    it("warning copy makes no claim about unlinking transactions", () => {
      renderWithPlatform(<ContactsImportSettings {...defaultProps} />, "darwin");

      fireEvent.click(screen.getByText("Force Re-import"));

      const modal = screen.getByTestId("contacts-force-reimport-confirm-modal");
      expect(modal).toHaveTextContent(/attached to a transaction are kept/i);
      expect(modal).not.toHaveTextContent(/unlink/i);
    });
  });

  describe("backward compatibility", () => {
    it("should export MacOSContactsImportSettings as alias", async () => {
      const { MacOSContactsImportSettings } = await import(
        "../settings/MacOSContactsImportSettings"
      );
      expect(MacOSContactsImportSettings).toBe(ContactsImportSettings);
    });
  });
});

// BACKLOG-2388: unified sync-result copy. Presentation-only formatter shared by
// the macOS / Outlook / Google result banners so wording stays consistent and a
// re-import that adds nothing no longer reads "0 contacts imported".
describe("formatContactSyncCounts (BACKLOG-2388)", () => {
  it("returns the no-new-contacts line for an Outlook/Google zero count", () => {
    expect(formatContactSyncCounts({ imported: 0 })).toBe(
      "No new contacts were found."
    );
  });

  it("returns the no-new-contacts line for a macOS zero insert/delete", () => {
    expect(formatContactSyncCounts({ inserted: 0, deleted: 0 })).toBe(
      "No new contacts were found."
    );
  });

  it("keeps a lump imported count when non-zero (Outlook/Google)", () => {
    expect(formatContactSyncCounts({ imported: 5 })).toBe(
      "5 contacts imported."
    );
    expect(formatContactSyncCounts({ imported: 1 })).toBe(
      "1 contact imported."
    );
  });

  it("surfaces an updated count when reported", () => {
    expect(formatContactSyncCounts({ inserted: 0, deleted: 0, updated: 3 })).toBe(
      "No new contacts were found. 3 updated."
    );
    expect(formatContactSyncCounts({ inserted: 2, updated: 4 })).toBe(
      "2 new contacts added. 4 updated."
    );
  });

  it("renders added / removed / total detail for the macOS path", () => {
    expect(
      formatContactSyncCounts({ inserted: 2, deleted: 1, total: 10 })
    ).toBe("2 new contacts added. 1 removed. 10 total.");
  });

  it("returns an empty string when no counts are known (macOS orchestrator path)", () => {
    // The orchestrator reports completion without counts; we must NOT falsely
    // claim "No new contacts were found." in that case.
    expect(formatContactSyncCounts({})).toBe("");
  });

  it("does not claim 'no new' when contacts were removed but none added", () => {
    expect(formatContactSyncCounts({ inserted: 0, deleted: 3 })).toBe(
      "3 removed."
    );
  });
});
