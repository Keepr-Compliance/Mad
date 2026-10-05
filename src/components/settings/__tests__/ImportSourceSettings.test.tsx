/**
 * Tests for ImportSourceSettings.tsx (TASK-1742, BACKLOG-1447)
 *
 * Covers:
 * - Platform-specific rendering (macOS shows all 3 options, non-macOS shows 2)
 * - Loading and saving import source preference
 * - Radio button selection and state management
 * - iPhone sync instructions visibility
 * - SR C6 (founder): no Android Companion option; a stored
 *   "android-companion" shows as Google Messages and is not rewritten
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ImportSourceSettings } from "../ImportSourceSettings";

// Mock the platform context
jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

import { usePlatform } from "../../../contexts/PlatformContext";

describe("ImportSourceSettings", () => {
  const mockUserId = "user-123";

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: macOS platform
    (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

    // Default: no saved preference (macos-native will be default)
    jest.mocked(window.api.preferences.get).mockResolvedValue({
      success: true,
      preferences: {},
    });

    jest.mocked(window.api.preferences.update).mockResolvedValue({
      success: true,
    });
  });

  describe("Platform Rendering", () => {
    it("should render on macOS with all three options", async () => {
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("macOS Messages")).toBeInTheDocument();
      });

      expect(screen.getByText("iPhone Sync")).toBeInTheDocument();
      expect(screen.getByText("Android: Google Messages")).toBeInTheDocument();
      expect(screen.getAllByRole("radio")).toHaveLength(3);
    });

    it("should render on non-macOS with iPhone Sync and Google Messages only", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("iPhone Sync")).toBeInTheDocument();
      });

      expect(screen.queryByText("macOS Messages")).not.toBeInTheDocument();
      expect(screen.getByText("Android: Google Messages")).toBeInTheDocument();
    });

    // SR C6 (founder). Mutations: the Companion radio back, or the
    // "Recommended" pill back → red.
    it("offers no Android Companion and no Recommended pill", async () => {
      const { container } = render(<ImportSourceSettings userId={mockUserId} />);
      await screen.findByText("macOS Messages");
      expect(container.querySelector('input[value="android-companion"]')).not.toBeInTheDocument();
      expect(container.textContent).not.toMatch(/Companion|Recommended/);
    });

    it("should show description text", async () => {
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(
          screen.getByText("Choose where to import your text messages from.")
        ).toBeInTheDocument();
      });
    });

    /**
     * BACKLOG-2523 regression guard.
     *
     * This panel writes `messages.source` and NOTHING else. Contact sources are
     * the independent `contactSources.direct.*` checkboxes under
     * Settings > Contacts (BACKLOG-2477 decoupled them; see the comment on
     * SyncOrchestratorService.getContactsSyncPreferences). Any copy here that
     * mentions contacts is therefore a false claim about the user's own data —
     * it either promises a contacts effect this screen does not have, or scares
     * a user off switching message sources for fear of disturbing contacts.
     *
     * This asserts the ABSENCE of the whole class, not the presence of the
     * three strings that happened to be wrong on 2026-08-05. It is deliberately
     * the strong form (/contact/i, unqualified): the panel renders no such word
     * today, so any reintroduction reddens this immediately.
     */
    it("never claims the Import Source panel governs contacts", async () => {
      const { container } = render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("macOS Messages")).toBeInTheDocument();
      });

      expect(container.textContent).not.toMatch(/contact/i);
    });
  });

  describe("Loading State", () => {
    it("should show loading spinner while fetching preference", async () => {
      // Create a promise that won't resolve immediately
      let resolvePreference: (
        value: Awaited<ReturnType<typeof window.api.preferences.get>>
      ) => void;
      jest.mocked(window.api.preferences.get).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePreference = resolve;
          })
      );

      render(<ImportSourceSettings userId={mockUserId} />);

      // Should show spinner
      const spinner = document.querySelector(".animate-spin");
      expect(spinner).toBeInTheDocument();

      // Resolve the promise
      await waitFor(() => {
        resolvePreference!({ success: true, preferences: {} });
      });
    });

    it("should hide loading spinner after preference loads", async () => {
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        const spinner = document.querySelector(".animate-spin");
        expect(spinner).not.toBeInTheDocument();
      });
    });
  });

  describe("Preference Loading", () => {
    it("should default to macos-native when no preference saved", async () => {
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        const macosRadio = screen.getByRole("radio", {
          name: /macos messages/i,
        });
        expect(macosRadio).toBeChecked();
      });
    });

    it("should load saved macos-native preference", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "macos-native" },
        },
      });

      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        const macosRadio = screen.getByRole("radio", {
          name: /macos messages/i,
        });
        expect(macosRadio).toBeChecked();
      });
    });

    it("should load saved iphone-sync preference", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "iphone-sync" },
        },
      });

      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        const iphoneRadio = screen.getByRole("radio", {
          name: /iphone sync/i,
        });
        expect(iphoneRadio).toBeChecked();
      });
    });

    // SR C6. Mutation: shownImportSource bypassed → no radio checked → red.
    it("a saved android-companion preference shows as Google Messages, and is not rewritten", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "android-companion" },
        },
      });

      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByRole("radio", { name: /android: google messages/i })).toBeChecked();
      });
      expect(window.api.preferences.update).not.toHaveBeenCalled();
    });

    it("should handle preference load error gracefully", async () => {
      jest.mocked(window.api.preferences.get).mockRejectedValue(new Error("Network error"));

      render(<ImportSourceSettings userId={mockUserId} />);

      // Should still render with default (macos-native)
      await waitFor(() => {
        const macosRadio = screen.getByRole("radio", {
          name: /macos messages/i,
        });
        expect(macosRadio).toBeChecked();
      });
    });
  });

  describe("Radio Selection", () => {
    it("should show all import source options on macOS", async () => {
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(
          screen.getByText("macOS Messages")
        ).toBeInTheDocument();
        expect(screen.getByText("iPhone Sync")).toBeInTheDocument();
        expect(screen.getByText("Android: Google Messages")).toBeInTheDocument();
      });
    });

    it("should update selection when iPhone Sync is clicked", async () => {
      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("iPhone Sync")).toBeInTheDocument();
      });

      const iphoneRadio = screen.getByRole("radio", {
        name: /iphone sync/i,
      });
      await user.click(iphoneRadio);

      expect(iphoneRadio).toBeChecked();
    });

    it("should update selection when macOS Messages is clicked", async () => {
      // Start with iphone-sync selected
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "iphone-sync" },
        },
      });

      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("macOS Messages")).toBeInTheDocument();
      });

      const macosRadio = screen.getByRole("radio", {
        name: /macos messages/i,
      });
      await user.click(macosRadio);

      expect(macosRadio).toBeChecked();
    });
  });

  describe("Preference Saving", () => {
    it("should save preference when selection changes to iphone-sync", async () => {
      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("iPhone Sync")).toBeInTheDocument();
      });

      const iphoneRadio = screen.getByRole("radio", {
        name: /iphone sync/i,
      });
      await user.click(iphoneRadio);

      expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
        messages: { source: "iphone-sync" },
      });
    });

    // BACKLOG-3659. Mutation: drop the Google Messages radio → red.
    it("should save preference when selection changes to Android: Google Messages", async () => {
      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);
      const radio = await screen.findByRole("radio", { name: /android: google messages/i });
      await user.click(radio);
      expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
        messages: { source: "android-messages-web" },
      });
    });

    it("should save preference when selection changes to macos-native", async () => {
      // Start with iphone-sync selected
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "iphone-sync" },
        },
      });

      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(
          screen.getByText("macOS Messages")
        ).toBeInTheDocument();
      });

      const macosRadio = screen.getByRole("radio", {
        name: /macos messages/i,
      });
      await user.click(macosRadio);

      expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
        messages: { source: "macos-native" },
      });
    });

    it("should handle save error gracefully (revert selection)", async () => {
      jest.mocked(window.api.preferences.update).mockRejectedValue(new Error("Save failed"));

      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("iPhone Sync")).toBeInTheDocument();
      });

      const iphoneRadio = screen.getByRole("radio", {
        name: /iphone sync/i,
      });

      // Click to change to iphone-sync (should fail and revert)
      await user.click(iphoneRadio);

      // Wait for revert
      await waitFor(() => {
        const macosRadio = screen.getByRole("radio", {
          name: /macos messages/i,
        });
        expect(macosRadio).toBeChecked();
      });
    });
  });

  describe("iPhone Instructions", () => {
    it("should NOT show iPhone instructions when macos-native is selected", async () => {
      render(<ImportSourceSettings userId={mockUserId} />);

      // Wait for loading to complete (radio buttons visible)
      await waitFor(() => {
        expect(screen.getByText("macOS Messages")).toBeInTheDocument();
      });

      expect(screen.queryByText("To use iPhone Sync:")).not.toBeInTheDocument();
    });

    it("should show iPhone instructions when iphone-sync is selected", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "iphone-sync" },
        },
      });

      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("To use iPhone Sync:")).toBeInTheDocument();
      });

      // Check for instruction steps
      expect(
        screen.getByText(/Connect your iPhone to this Mac via USB/)
      ).toBeInTheDocument();
      expect(
        screen.getByText("Trust this computer on your iPhone if prompted")
      ).toBeInTheDocument();
    });

    it("should show iPhone instructions after selecting iphone-sync", async () => {
      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("iPhone Sync")).toBeInTheDocument();
      });

      // Initially no instructions
      expect(screen.queryByText("To use iPhone Sync:")).not.toBeInTheDocument();

      // Click iPhone Sync
      const iphoneRadio = screen.getByRole("radio", {
        name: /iphone sync/i,
      });
      await user.click(iphoneRadio);

      // Now instructions should appear
      await waitFor(() => {
        expect(screen.getByText("To use iPhone Sync:")).toBeInTheDocument();
      });
    });
  });

  describe("Disabled State", () => {
    it("should disable radio buttons while saving", async () => {
      // Make the update take a while
      let resolveUpdate: (
        value: Awaited<ReturnType<typeof window.api.preferences.update>>
      ) => void;
      jest.mocked(window.api.preferences.update).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveUpdate = resolve;
          })
      );

      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("iPhone Sync")).toBeInTheDocument();
      });

      const iphoneRadio = screen.getByRole("radio", {
        name: /iphone sync/i,
      });

      // Click to trigger save
      await user.click(iphoneRadio);

      // Radio buttons should be disabled during save
      expect(iphoneRadio).toBeDisabled();

      // Resolve the save
      await waitFor(() => {
        resolveUpdate!({ success: true });
      });
    });
  });

  describe("Visual Styling", () => {
    it("should show selected styling on the selected option", async () => {
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("macOS Messages")).toBeInTheDocument();
      });

      // The selected option's label should have the blue border styling
      const macosLabel = screen.getByText("macOS Messages").closest("label");
      expect(macosLabel).toHaveClass("border-blue-500");
    });

    it("should update styling when selection changes", async () => {
      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("iPhone Sync")).toBeInTheDocument();
      });

      const iphoneRadio = screen.getByRole("radio", {
        name: /iphone sync/i,
      });
      await user.click(iphoneRadio);

      // iPhone Sync label should now have blue border
      const iphoneLabel = screen.getByText("iPhone Sync").closest("label");
      expect(iphoneLabel).toHaveClass("border-blue-500");

      // macOS label should not have blue border
      const macosLabel = screen.getByText("macOS Messages").closest("label");
      expect(macosLabel).not.toHaveClass("border-blue-500");
    });

    it("should show the indigo border on Google Messages when selected", async () => {
      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      const gmRadio = await screen.findByRole("radio", { name: /android: google messages/i });
      await user.click(gmRadio);

      expect(screen.getByText("Android: Google Messages").closest("label")).toHaveClass("border-indigo-500");
    });
  });
});
