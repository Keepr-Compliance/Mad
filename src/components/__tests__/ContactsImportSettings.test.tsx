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
import { ContactsImportSettings } from "../settings/MacOSContactsImportSettings";
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

  describe("backward compatibility", () => {
    it("should export MacOSContactsImportSettings as alias", async () => {
      const { MacOSContactsImportSettings } = await import(
        "../settings/MacOSContactsImportSettings"
      );
      expect(MacOSContactsImportSettings).toBe(ContactsImportSettings);
    });
  });
});
