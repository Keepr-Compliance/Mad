/**
 * Tests for Settings.tsx
 * Covers settings UI, email connections, and preferences
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Settings from "../Settings";
import { PlatformProvider } from "../../contexts/PlatformContext";
import { NotificationProvider } from "../../contexts/NotificationContext";

// Polyfill Element.scrollTo for jsdom (SettingsTabBar uses it)
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = jest.fn();
}

// Mock the useLicense hook (still used by some sub-components)
jest.mock("@/contexts/LicenseContext", () => ({
  useLicense: jest.fn(() => ({
    licenseType: "individual" as const,
    hasAIAddon: true,
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  })),
}));

// TASK-2159: Mock the useFeatureGate hook (Settings + FeatureGate now use this)
const mockIsAllowed = jest.fn().mockReturnValue(true); // Default: all features allowed
jest.mock("@/hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: mockIsAllowed,
    features: {},
    loading: false,
    hasInitialized: true,
    refresh: jest.fn(),
  }),
}));

// TASK-2056: Mock the useNetwork hook for offline testing
const mockUseNetwork = jest.fn(() => ({
  isOnline: true,
  isChecking: false,
  lastOnlineAt: new Date(),
  lastOfflineAt: null,
  connectionError: null,
  checkConnection: jest.fn().mockResolvedValue(true),
  clearError: jest.fn(),
  setConnectionError: jest.fn(),
}));
jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => mockUseNetwork(),
}));

// Wrap Settings in PlatformProvider for tests
const renderSettings = async (props: { onClose: () => void; userId: string }) => {
  const result = render(
    <NotificationProvider>
      <PlatformProvider>
        <Settings {...props} />
      </PlatformProvider>
    </NotificationProvider>
  );
  // Wait for preferences to load (spinner to disappear) before returning
  await waitFor(() => {
    expect(screen.queryByText("Loading settings...")).not.toBeInTheDocument();
  });
  return result;
};

describe("Settings", () => {
  const mockUserId = "user-123";
  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mocks
    window.api.system.checkAllConnections.mockResolvedValue({
      success: true,
      google: { connected: false },
      microsoft: { connected: false },
    });
    window.api.preferences.get.mockResolvedValue({
      success: true,
      preferences: {
        export: { defaultFormat: "combined-pdf" },
      },
    });
    window.api.preferences.update.mockResolvedValue({ success: true });
    window.api.auth.googleConnectMailbox.mockResolvedValue({ success: true });
    window.api.auth.microsoftConnectMailbox.mockResolvedValue({
      success: true,
    });
    window.api.auth.googleDisconnectMailbox.mockResolvedValue({
      success: true,
    });
    window.api.auth.microsoftDisconnectMailbox.mockResolvedValue({
      success: true,
    });
    window.api.onGoogleMailboxConnected.mockReturnValue(jest.fn());
    window.api.onMicrosoftMailboxConnected.mockReturnValue(jest.fn());
    window.api.onGoogleMailboxDisconnected.mockReturnValue(jest.fn());
    window.api.onMicrosoftMailboxDisconnected.mockReturnValue(jest.fn());

    // Messages mocks for MacOSMessagesImportSettings component
    window.api.messages.onImportProgress.mockReturnValue(jest.fn());
    window.api.messages.importMacOSMessages.mockResolvedValue({
      success: true,
      messagesImported: 0,
      messagesSkipped: 0,
      duration: 100,
    });

    // LLM mocks for LLMSettings component
    window.api.llm.getConfig.mockResolvedValue({
      success: true,
      data: {
        hasOpenAIKey: false,
        hasAnthropicKey: false,
        consentGiven: true,
        usePlatformAllowance: true,
        enableAutoDetect: false,
        enableRoleExtraction: false,
      },
    });
    window.api.llm.getUsage.mockResolvedValue({
      success: true,
      data: {
        tokensThisMonth: 0,
        platformAllowance: 10000,
        platformUsed: 0,
      },
    });

    // Update mocks for GeneralSettings (Check for Updates button)
    window.api.update.checkForUpdates = jest.fn().mockResolvedValue({ updateAvailable: false });

    // Security mocks for SecuritySettings
    window.api.auth.getActiveDevices = jest.fn().mockResolvedValue({ success: true, devices: [] });
    window.api.auth.signOutAllDevices = jest.fn().mockResolvedValue({ success: true });

    // Email re-cache mock for EmailSettings (BACKLOG-1362)
    window.api.transactions.precacheEmails = jest.fn().mockResolvedValue({ success: true, emailsFetched: 0, emailsStored: 0 });

    // Preferences save mock (used by settingsService.savePreferences)
    window.api.preferences.save = jest.fn().mockResolvedValue({ success: true });
  });

  describe("Rendering", () => {
    it("should render settings modal with title", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Responsive layout renders both mobile and desktop headers
      expect(screen.getAllByText("Settings").length).toBeGreaterThanOrEqual(1);
    });

    it("should show all settings sections", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getAllByText("General").length).toBeGreaterThanOrEqual(1);
      });

      expect(screen.getAllByText("Email").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Security").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("AI Settings")).toBeInTheDocument();
      expect(screen.getAllByText("Data & Privacy").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("About").length).toBeGreaterThanOrEqual(1);
    });

    it("should show copyright", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getByText(/© 2026 Blue Spaces LLC/)).toBeInTheDocument();
    });
  });

  describe("Email Connections", () => {
    it("should show Gmail connection status", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Gmail")).toBeInTheDocument();
      });

      expect(screen.getAllByText("Not Connected").length).toBeGreaterThan(0);
    });

    it("should show Outlook connection status", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Outlook")).toBeInTheDocument();
      });
    });

    it("should show connected status when Gmail is connected", async () => {
      window.api.system.checkAllConnections.mockResolvedValue({
        success: true,
        google: { connected: true, email: "user@gmail.com" },
        microsoft: { connected: false },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
      });

      expect(screen.getByText("user@gmail.com")).toBeInTheDocument();
    });

    it("should show connected status when Outlook is connected", async () => {
      window.api.system.checkAllConnections.mockResolvedValue({
        success: true,
        google: { connected: false },
        microsoft: { connected: true, email: "user@outlook.com" },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
      });

      expect(screen.getByText("user@outlook.com")).toBeInTheDocument();
    });

    it("should show loading state while checking connections", async () => {
      window.api.system.checkAllConnections.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000)),
      );

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getAllByText("Checking...").length).toBeGreaterThan(0);
    });

    it("should call connect Gmail when button is clicked", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Gmail")).toBeInTheDocument();
      });

      const connectGmailButton = screen.getByRole("button", {
        name: /connect gmail/i,
      });
      await userEvent.click(connectGmailButton);

      expect(window.api.auth.googleConnectMailbox).toHaveBeenCalledWith(
        mockUserId,
      );
    });

    it("should call connect Outlook when button is clicked", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Outlook")).toBeInTheDocument();
      });

      const connectOutlookButton = screen.getByRole("button", {
        name: /connect outlook/i,
      });
      await userEvent.click(connectOutlookButton);

      expect(window.api.auth.microsoftConnectMailbox).toHaveBeenCalledWith(
        mockUserId,
      );
    });

    it("should show disconnect button when already connected", async () => {
      window.api.system.checkAllConnections.mockResolvedValue({
        success: true,
        google: { connected: true, email: "user@gmail.com" },
        microsoft: { connected: false },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /disconnect gmail/i }),
        ).toBeInTheDocument();
      });

      const disconnectButton = screen.getByRole("button", {
        name: /disconnect gmail/i,
      });
      expect(disconnectButton).toBeEnabled();
    });

    it("should call disconnect Gmail when disconnect button is clicked", async () => {
      window.api.system.checkAllConnections.mockResolvedValue({
        success: true,
        google: { connected: true, email: "user@gmail.com" },
        microsoft: { connected: false },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /disconnect gmail/i }),
        ).toBeInTheDocument();
      });

      const disconnectButton = screen.getByRole("button", {
        name: /disconnect gmail/i,
      });
      await userEvent.click(disconnectButton);

      expect(window.api.auth.googleDisconnectMailbox).toHaveBeenCalledWith(
        mockUserId,
      );
    });

    it("should call disconnect Outlook when disconnect button is clicked", async () => {
      window.api.system.checkAllConnections.mockResolvedValue({
        success: true,
        google: { connected: false },
        microsoft: { connected: true, email: "user@outlook.com" },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /disconnect outlook/i }),
        ).toBeInTheDocument();
      });

      const disconnectButton = screen.getByRole("button", {
        name: /disconnect outlook/i,
      });
      await userEvent.click(disconnectButton);

      expect(window.api.auth.microsoftDisconnectMailbox).toHaveBeenCalledWith(
        mockUserId,
      );
    });

    // BACKLOG-2142: distinguish the THREE states — connected / expired
    // (broken token) / not-connected — so a broken token is not misread as
    // "disconnected". The render keys off the typed error.type discriminator
    // (no message string-matching). Existing mocks above only exercised the
    // connected/not-connected pair.
    describe("broken-token state (BACKLOG-2142)", () => {
      it("shows 'Session Expired' + a Reconnect button for a TOKEN_REFRESH_FAILED Gmail token", async () => {
        window.api.system.checkAllConnections.mockResolvedValue({
          success: true,
          google: {
            connected: false,
            email: "user@gmail.com",
            error: {
              type: "TOKEN_REFRESH_FAILED",
              userMessage:
                "Your Gmail connection expired. Reconnect to keep capturing email.",
              action: "Reconnect",
            },
          },
          microsoft: { connected: false },
        });

        await renderSettings({ userId: mockUserId, onClose: mockOnClose });

        await waitFor(() => {
          expect(screen.getByText("Session Expired")).toBeInTheDocument();
        });
        // Distinct from "Connect" — offers Reconnect directly.
        expect(
          screen.getByRole("button", { name: /reconnect gmail/i }),
        ).toBeInTheDocument();
        // The expired-connection userMessage is surfaced.
        expect(
          screen.getByText(
            "Your Gmail connection expired. Reconnect to keep capturing email.",
          ),
        ).toBeInTheDocument();
      });

      it("shows 'Connection Issue' for a CONNECTION_CHECK_FAILED Outlook token", async () => {
        window.api.system.checkAllConnections.mockResolvedValue({
          success: true,
          google: { connected: false },
          microsoft: {
            connected: false,
            email: "user@outlook.com",
            error: {
              type: "CONNECTION_CHECK_FAILED",
              userMessage: "Could not verify Outlook connection",
              action: "Check your Outlook connection",
            },
          },
        });

        await renderSettings({ userId: mockUserId, onClose: mockOnClose });

        await waitFor(() => {
          expect(screen.getByText("Connection Issue")).toBeInTheDocument();
        });
        expect(
          screen.getByRole("button", { name: /reconnect outlook/i }),
        ).toBeInTheDocument();
      });

      it("still shows 'Not Connected' + Connect for a NOT_CONNECTED provider (no reconnect)", async () => {
        window.api.system.checkAllConnections.mockResolvedValue({
          success: true,
          google: {
            connected: false,
            error: { type: "NOT_CONNECTED", userMessage: "Gmail is not connected" },
          },
          microsoft: { connected: false },
        });

        await renderSettings({ userId: mockUserId, onClose: mockOnClose });

        await waitFor(() => {
          expect(screen.getByText("Gmail")).toBeInTheDocument();
        });
        expect(screen.getAllByText("Not Connected").length).toBeGreaterThan(0);
        // A never-connected provider offers Connect, NOT Reconnect.
        expect(
          screen.getByRole("button", { name: /connect gmail/i }),
        ).toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: /reconnect gmail/i }),
        ).not.toBeInTheDocument();
        expect(screen.queryByText("Session Expired")).not.toBeInTheDocument();
      });
    });
  });

  describe("Export Settings", () => {
    it("should show export format section with card buttons", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Format")).toBeInTheDocument();
      });

      // Card buttons should be present
      expect(screen.getByText("One PDF")).toBeInTheDocument();
      expect(screen.getByText("Audit Package")).toBeInTheDocument();
      expect(screen.getByText("Summary PDF")).toBeInTheDocument();
    });

    it("should show all export format options", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Format")).toBeInTheDocument();
      });

      // Check all format card buttons are available
      expect(screen.getByText("One PDF")).toBeInTheDocument();
      expect(screen.getByText("Audit Package")).toBeInTheDocument();
      expect(screen.getByText("Summary PDF")).toBeInTheDocument();
    });

    it("should load saved export format preference", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "folder" },
        },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // The "Audit Package" button (value "folder") should be the active one (purple bg)
      await waitFor(() => {
        const auditBtn = screen.getByText("Audit Package").closest("button");
        expect(auditBtn).toHaveClass("bg-purple-500");
      });
    });

    it("should save export format when changed", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Format")).toBeInTheDocument();
      });

      // Click the "Summary PDF" button (value "pdf")
      const summaryBtn = screen.getByText("Summary PDF").closest("button")!;
      await userEvent.click(summaryBtn);

      expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
        export: { defaultFormat: "pdf" },
      });
    });

    it("should show loading spinner while loading preferences", async () => {
      window.api.preferences.get.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000)),
      );

      render(
        <NotificationProvider>
          <PlatformProvider>
            <Settings userId={mockUserId} onClose={mockOnClose} />
          </PlatformProvider>
        </NotificationProvider>
      );

      expect(screen.getByText("Loading settings...")).toBeInTheDocument();
    });
  });

  describe("General Settings", () => {
    it("should show notifications toggle as enabled and toggleable", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getByText("Notifications")).toBeInTheDocument();
      expect(
        screen.getByText(/show desktop notifications/i),
      ).toBeInTheDocument();

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /desktop notifications/i,
        });
        expect(toggle).not.toBeDisabled();
      });
    });

    it("should default notifications to ON", async () => {
      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /desktop notifications/i,
        });
        expect(toggle).toHaveAttribute("aria-checked", "true");
      });
    });

    it("should load saved notification preference (OFF)", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          notifications: { enabled: false },
        },
      });

      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /desktop notifications/i,
        });
        expect(toggle).toHaveAttribute("aria-checked", "false");
      });
    });

    it("should load saved notification preference (ON)", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          notifications: { enabled: true },
        },
      });

      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /desktop notifications/i,
        });
        expect(toggle).toHaveAttribute("aria-checked", "true");
      });
    });

    it("should toggle notifications and save preference", async () => {
      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(
          screen.getByRole("switch", { name: /desktop notifications/i }),
        ).toBeInTheDocument();
      });

      const toggle = screen.getByRole("switch", {
        name: /desktop notifications/i,
      });
      await userEvent.click(toggle);

      expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
        notifications: { enabled: false },
      });
    });

    it("should render Test Notification button", async () => {
      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Test Notification")).toBeInTheDocument();
      });
    });

    it("should call notification.send when Test Notification is clicked", async () => {
      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Test Notification")).toBeInTheDocument();
      });

      const testButton = screen.getByRole("button", {
        name: /test notification/i,
      });
      await userEvent.click(testButton);

      expect(window.api.notification.send).toHaveBeenCalledWith(
        "Test Notification",
        "Desktop notifications are working correctly."
      );
    });

    it("should disable Test Notification button when notifications are OFF", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          notifications: { enabled: false },
        },
      });

      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const testButton = screen.getByRole("button", {
          name: /test notification/i,
        });
        expect(testButton).toBeDisabled();
      });
    });

  });

  describe("Auto-Download Updates Toggle", () => {
    it("should show auto-download updates toggle", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Auto-download Updates")).toBeInTheDocument();
      });

      expect(
        screen.getByText(/automatically download new software updates/i),
      ).toBeInTheDocument();
    });

    it("should default to off (disabled)", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /auto-download updates/i,
        });
        expect(toggle).toHaveAttribute("aria-checked", "false");
      });
    });

    it("should load saved auto-download preference", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          updates: { autoDownload: true },
        },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /auto-download updates/i,
        });
        expect(toggle).toHaveAttribute("aria-checked", "true");
      });
    });

    it("should toggle auto-download and save preference", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(
          screen.getByRole("switch", { name: /auto-download updates/i }),
        ).toBeInTheDocument();
      });

      const toggle = screen.getByRole("switch", {
        name: /auto-download updates/i,
      });
      await userEvent.click(toggle);

      expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
        updates: { autoDownload: true },
      });
    });

    it("should show loading spinner while loading preferences", async () => {
      window.api.preferences.get.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000)),
      );

      render(
        <NotificationProvider>
          <PlatformProvider>
            <Settings userId={mockUserId} onClose={mockOnClose} />
          </PlatformProvider>
        </NotificationProvider>
      );

      expect(screen.getByText("Loading settings...")).toBeInTheDocument();
    });
  });

  describe("Data & Privacy", () => {
    it("should show clear all data button (disabled)", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getByText("Clear All Data")).toBeInTheDocument();
      expect(screen.getByText(/delete all local data/i)).toBeInTheDocument();
    });

    it("should show reindex database button", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getByText("Reindex Database")).toBeInTheDocument();
      expect(
        screen.getByText(/optimize database performance/i),
      ).toBeInTheDocument();
    });

    it("should call reindexDatabase when button is clicked", async () => {
      // Mock window.confirm to return true (user confirms)
      const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);

      window.api.system.reindexDatabase.mockResolvedValue({
        success: true,
        indexesRebuilt: 14,
        durationMs: 150,
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const reindexButton = screen
        .getByText("Reindex Database")
        .closest("button");
      expect(reindexButton).not.toBeDisabled();

      await userEvent.click(reindexButton!);

      expect(window.api.system.reindexDatabase).toHaveBeenCalled();

      confirmSpy.mockRestore();
    });

    it("should show success message after reindex", async () => {
      // Mock window.confirm to return true (user confirms)
      const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);

      window.api.system.reindexDatabase.mockResolvedValue({
        success: true,
        indexesRebuilt: 14,
        durationMs: 150,
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const reindexButton = screen
        .getByText("Reindex Database")
        .closest("button");
      await userEvent.click(reindexButton!);

      // TASK-2150: Reindex now goes through orchestrator, so the success message
      // is simplified (detailed result data like indexesRebuilt is not surfaced)
      await waitFor(() => {
        expect(
          screen.getByText(/database optimized successfully/i),
        ).toBeInTheDocument();
      });

      confirmSpy.mockRestore();
    });

    it("should show error message when reindex fails", async () => {
      // Mock window.confirm to return true (user confirms)
      const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);

      window.api.system.reindexDatabase.mockResolvedValue({
        success: false,
        indexesRebuilt: 0,
        durationMs: 50,
        error: "Database is locked",
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const reindexButton = screen
        .getByText("Reindex Database")
        .closest("button");
      await userEvent.click(reindexButton!);

      await waitFor(() => {
        expect(screen.getByText(/database is locked/i)).toBeInTheDocument();
      });

      confirmSpy.mockRestore();
    });
  });

  describe("About Section", () => {
    it("should show action links", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getByText("View Release Notes")).toBeInTheDocument();
      expect(screen.getByText("Privacy Policy")).toBeInTheDocument();
      expect(screen.getByText("Terms of Service")).toBeInTheDocument();
    });
  });

  describe("Close Modal", () => {
    it("should call onClose when close button is clicked", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const closeButton = screen
        .getAllByRole("button")
        .find((btn) => btn.querySelector('svg path[d*="M6 18L18 6"]'));

      if (closeButton) {
        await userEvent.click(closeButton);
        expect(mockOnClose).toHaveBeenCalled();
      }
    });

    it("should call onClose when done button is clicked", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const doneButton = screen.getByRole("button", { name: /done/i });
      await userEvent.click(doneButton);

      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe("API Integration", () => {
    it("should check connections on mount", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(window.api.system.checkAllConnections).toHaveBeenCalledWith(
          mockUserId,
        );
      });
    });

    it("should load preferences on mount", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(window.api.preferences.get).toHaveBeenCalledWith(mockUserId);
      });
    });

    it("should have all required APIs available", async () => {
      expect(window.api.system.checkAllConnections).toBeDefined();
      expect(window.api.preferences.get).toBeDefined();
      expect(window.api.preferences.update).toBeDefined();
      expect(window.api.auth.googleConnectMailbox).toBeDefined();
      expect(window.api.auth.microsoftConnectMailbox).toBeDefined();
      expect(window.api.auth.googleDisconnectMailbox).toBeDefined();
      expect(window.api.auth.microsoftDisconnectMailbox).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    it("should handle connection check failure gracefully", async () => {
      window.api.system.checkAllConnections.mockResolvedValue({
        success: false,
        error: "Network error",
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Should still render without crashing (responsive layout has mobile + desktop headers)
      await waitFor(() => {
        expect(screen.getAllByText("Settings").length).toBeGreaterThanOrEqual(1);
      });
    });

    it("should handle preferences load failure gracefully", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: false,
        error: "Failed to load preferences",
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Should still render with default values — "One PDF" (combined-pdf) should be active
      await waitFor(() => {
        const onePdfBtn = screen.getByText("One PDF").closest("button");
        expect(onePdfBtn).toHaveClass("bg-purple-500");
      });
    });

    it("should handle preferences update failure gracefully", async () => {
      window.api.preferences.update.mockResolvedValue({
        success: false,
        error: "Failed to save preferences",
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Format")).toBeInTheDocument();
      });

      // Click a different format button
      const summaryBtn = screen.getByText("Summary PDF").closest("button")!;
      await userEvent.click(summaryBtn);

      // Should not crash, preference update fails silently
      expect(window.api.preferences.update).toHaveBeenCalled();
    });
  });

  describe("Accessibility", () => {
    it("should have accessible form controls", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Format")).toBeInTheDocument();
      });

      // Export format buttons should be accessible
      const onePdfBtn = screen.getByText("One PDF").closest("button");
      const auditBtn = screen.getByText("Audit Package").closest("button");
      const summaryBtn = screen.getByText("Summary PDF").closest("button");
      expect(onePdfBtn).toBeInTheDocument();
      expect(auditBtn).toBeInTheDocument();
      expect(summaryBtn).toBeInTheDocument();
    });

    it("should have accessible buttons", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument();
    });
  });

  describe("AI Settings Feature Gating (BACKLOG-462, TASK-2159)", () => {
    it("should show AI Settings section when ai_detection feature is allowed", async () => {
      mockIsAllowed.mockReturnValue(true); // All features allowed

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("AI Settings")).toBeInTheDocument();
      });
    });

    it("should hide AI Settings section when ai_detection feature is not allowed", async () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        // AI Settings should NOT be visible
        expect(screen.queryByText("AI Settings")).not.toBeInTheDocument();
      });
    });

    it("should show AI Settings when ai_detection feature is allowed regardless of license type", async () => {
      mockIsAllowed.mockReturnValue(true); // All features allowed

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("AI Settings")).toBeInTheDocument();
      });
    });
  });

  // BACKLOG-1937: merged iPhone Sync category + gray-out gating
  describe("iPhone Sync Category (BACKLOG-1937)", () => {
    it("should show an 'iPhone Sync' tab and no longer a 'Sync' tab", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // New tab present (label appears in the tab bar + the category <h3>)
      expect(screen.getAllByText("iPhone Sync").length).toBeGreaterThanOrEqual(1);
      // Old standalone "Sync" tab gone
      expect(screen.queryByText("Sync")).not.toBeInTheDocument();
    });

    it("should render the iPhone Sync category section anchor", async () => {
      const { container } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(container.querySelector("#settings-iphone-sync")).toBeInTheDocument();
      // Old anchor removed
      expect(container.querySelector("#settings-sync")).not.toBeInTheDocument();
    });

    it("should NOT render the iPhone USB toggle inside the Messages section", async () => {
      const { container } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const messagesSection = container.querySelector("#settings-messages");
      expect(messagesSection).toBeInTheDocument();
      // The USB toggle now lives only in the iPhone Sync category
      expect(messagesSection?.textContent).not.toContain("iPhone Sync (USB)");
    });

    it("should gray out and disable the toggle when import source is macOS native (not iPhone)", async () => {
      // Default test platform is macOS; no saved source → defaults to macos-native
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("iPhone Sync (USB)")).toBeInTheDocument();
      });

      // Hint shown
      expect(
        screen.getByText(/available when your import source is set to iphone/i),
      ).toBeInTheDocument();

      // Toggle disabled
      const toggle = screen.getByRole("switch", {
        name: /enable iphone sync over usb/i,
      });
      expect(toggle).toBeDisabled();
    });

    it("should gray out when import source is android-companion", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          messages: { source: "android-companion" },
        },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(
          screen.getByText(/available when your import source is set to iphone/i),
        ).toBeInTheDocument();
      });

      const toggle = screen.getByRole("switch", {
        name: /enable iphone sync over usb/i,
      });
      expect(toggle).toBeDisabled();
    });

    it("should enable the toggle and hide the hint when import source is iPhone", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          messages: { source: "iphone-sync" },
        },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /enable iphone sync over usb/i,
        });
        expect(toggle).not.toBeDisabled();
      });

      // Hint should NOT be shown when active
      expect(
        screen.queryByText(/available when your import source is set to iphone/i),
      ).not.toBeInTheDocument();
    });
  });

  // TASK-2056: Offline action blocking tests
  describe("Offline Action Blocking (TASK-2056)", () => {
    beforeEach(() => {
      // Set network to offline
      mockUseNetwork.mockReturnValue({
        isOnline: false,
        isChecking: false,
        lastOnlineAt: null,
        lastOfflineAt: new Date(),
        connectionError: null,
        checkConnection: jest.fn().mockResolvedValue(false),
        clearError: jest.fn(),
        setConnectionError: jest.fn(),
      });
    });

    afterEach(() => {
      // Reset to online
      mockUseNetwork.mockReturnValue({
        isOnline: true,
        isChecking: false,
        lastOnlineAt: new Date(),
        lastOfflineAt: null,
        connectionError: null,
        checkConnection: jest.fn().mockResolvedValue(true),
        clearError: jest.fn(),
        setConnectionError: jest.fn(),
      });
    });

    it("should disable Check for Updates button when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const checkButton = screen.getByRole("button", { name: /check for updates/i });
        expect(checkButton).toBeDisabled();
      });
    });

    it("should show 'You are offline' tooltip on Check for Updates when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const checkButton = screen.getByRole("button", { name: /check for updates/i });
        expect(checkButton).toHaveAttribute("title", "You are offline");
      });
    });

    it("should disable Sign Out All Devices button when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const signOutButton = screen.getByRole("button", { name: /sign out all devices/i });
        expect(signOutButton).toBeDisabled();
      });
    });

    it("should show 'You are offline' tooltip on Sign Out All Devices when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const signOutButton = screen.getByRole("button", { name: /sign out all devices/i });
        expect(signOutButton).toHaveAttribute("title", "You are offline");
      });
    });

    it("should disable Connect Gmail button when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const connectButton = screen.getByRole("button", { name: /connect gmail/i });
        expect(connectButton).toBeDisabled();
        expect(connectButton).toHaveAttribute("title", "You are offline");
      });
    });

    it("should disable Connect Outlook button when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const connectButton = screen.getByRole("button", { name: /connect outlook/i });
        expect(connectButton).toBeDisabled();
        expect(connectButton).toHaveAttribute("title", "You are offline");
      });
    });

    it("should re-enable buttons when back online", async () => {
      const { rerender } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Verify buttons are disabled
      await waitFor(() => {
        const checkButton = screen.getByRole("button", { name: /check for updates/i });
        expect(checkButton).toBeDisabled();
      });

      // Go back online
      mockUseNetwork.mockReturnValue({
        isOnline: true,
        isChecking: false,
        lastOnlineAt: new Date(),
        lastOfflineAt: null,
        connectionError: null,
        checkConnection: jest.fn().mockResolvedValue(true),
        clearError: jest.fn(),
        setConnectionError: jest.fn(),
      });

      rerender(
        <NotificationProvider>
          <PlatformProvider>
            <Settings userId={mockUserId} onClose={mockOnClose} />
          </PlatformProvider>
        </NotificationProvider>
      );

      await waitFor(() => {
        const checkButton = screen.getByRole("button", { name: /check for updates/i });
        expect(checkButton).not.toBeDisabled();
        expect(checkButton).not.toHaveAttribute("title", "You are offline");
      });
    });

    it("should keep local-only operations enabled when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Reindex is a local-only operation, should remain enabled
      await waitFor(() => {
        const reindexButton = screen.getByText("Reindex Database").closest("button");
        expect(reindexButton).not.toBeDisabled();
      });

      // Done button should remain enabled
      const doneButton = screen.getByRole("button", { name: /done/i });
      expect(doneButton).not.toBeDisabled();
    });
  });
});
