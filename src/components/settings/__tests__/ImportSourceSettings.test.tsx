/**
 * Tests for ImportSourceSettings.tsx (TASK-1742, BACKLOG-1447)
 *
 * Covers:
 * - Platform-specific rendering (macOS shows all 3 options, non-macOS shows 2)
 * - Loading and saving import source preference
 * - Radio button selection and state management
 * - iPhone sync instructions visibility
 * - Android companion option visibility and pairing UI
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
    window.api.preferences.get.mockResolvedValue({
      success: true,
      preferences: {},
    });

    window.api.preferences.update.mockResolvedValue({
      success: true,
    });
  });

  describe("Platform Rendering", () => {
    it("should render on macOS with all three options", async () => {
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("macOS Messages + Contacts")).toBeInTheDocument();
      });

      expect(screen.getByText("iPhone Sync")).toBeInTheDocument();
      expect(screen.getByText("Android Companion")).toBeInTheDocument();
    });

    it("should render on non-macOS with iPhone Sync and Android Companion only", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("iPhone Sync")).toBeInTheDocument();
      });

      expect(screen.queryByText("macOS Messages + Contacts")).not.toBeInTheDocument();
      expect(screen.getByText("Android Companion")).toBeInTheDocument();
    });

    it("should show description text", async () => {
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(
          screen.getByText("Choose where to import your messages and contacts from.")
        ).toBeInTheDocument();
      });
    });
  });

  describe("Loading State", () => {
    it("should show loading spinner while fetching preference", async () => {
      // Create a promise that won't resolve immediately
      let resolvePreference: (value: unknown) => void;
      window.api.preferences.get.mockImplementation(
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
          name: /macos messages \+ contacts/i,
        });
        expect(macosRadio).toBeChecked();
      });
    });

    it("should load saved macos-native preference", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "macos-native" },
        },
      });

      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        const macosRadio = screen.getByRole("radio", {
          name: /macos messages \+ contacts/i,
        });
        expect(macosRadio).toBeChecked();
      });
    });

    it("should load saved iphone-sync preference", async () => {
      window.api.preferences.get.mockResolvedValue({
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

    it("should load saved android-companion preference", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "android-companion" },
        },
      });

      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        const androidRadio = screen.getByRole("radio", {
          name: /android companion/i,
        });
        expect(androidRadio).toBeChecked();
      });
    });

    it("should handle preference load error gracefully", async () => {
      window.api.preferences.get.mockRejectedValue(new Error("Network error"));

      render(<ImportSourceSettings userId={mockUserId} />);

      // Should still render with default (macos-native)
      await waitFor(() => {
        const macosRadio = screen.getByRole("radio", {
          name: /macos messages \+ contacts/i,
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
          screen.getByText("macOS Messages + Contacts")
        ).toBeInTheDocument();
        expect(screen.getByText("iPhone Sync")).toBeInTheDocument();
        expect(screen.getByText("Android Companion")).toBeInTheDocument();
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

    it("should update selection when Android Companion is clicked", async () => {
      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("Android Companion")).toBeInTheDocument();
      });

      const androidRadio = screen.getByRole("radio", {
        name: /android companion/i,
      });
      await user.click(androidRadio);

      expect(androidRadio).toBeChecked();
    });

    it("should update selection when macOS Messages is clicked", async () => {
      // Start with iphone-sync selected
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "iphone-sync" },
        },
      });

      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("macOS Messages + Contacts")).toBeInTheDocument();
      });

      const macosRadio = screen.getByRole("radio", {
        name: /macos messages \+ contacts/i,
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

    it("should save preference when selection changes to android-companion", async () => {
      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("Android Companion")).toBeInTheDocument();
      });

      const androidRadio = screen.getByRole("radio", {
        name: /android companion/i,
      });
      await user.click(androidRadio);

      expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
        messages: { source: "android-companion" },
      });
    });

    it("should save preference when selection changes to macos-native", async () => {
      // Start with iphone-sync selected
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "iphone-sync" },
        },
      });

      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(
          screen.getByText("macOS Messages + Contacts")
        ).toBeInTheDocument();
      });

      const macosRadio = screen.getByRole("radio", {
        name: /macos messages \+ contacts/i,
      });
      await user.click(macosRadio);

      expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
        messages: { source: "macos-native" },
      });
    });

    it("should handle save error gracefully (revert selection)", async () => {
      window.api.preferences.update.mockRejectedValue(new Error("Save failed"));

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
          name: /macos messages \+ contacts/i,
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
        expect(screen.getByText("macOS Messages + Contacts")).toBeInTheDocument();
      });

      expect(screen.queryByText("To use iPhone Sync:")).not.toBeInTheDocument();
    });

    it("should show iPhone instructions when iphone-sync is selected", async () => {
      window.api.preferences.get.mockResolvedValue({
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

  describe("Android Companion Details (BACKLOG-1447 / BACKLOG-2289)", () => {
    // BACKLOG-2289: the ad-hoc inline pair button + QR modal were removed from
    // this component. Pairing now happens ONLY through the guided AndroidSyncSetup
    // wizard (single entry point), so this component keeps device management only.
    it("should NOT render an inline pair button when android-companion is selected", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "android-companion" },
        },
      });

      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(
          screen.getByText(/use the guided setup below to pair your android phone/i)
        ).toBeInTheDocument();
      });

      // No ad-hoc pairing entry point remains here.
      expect(
        screen.queryByRole("button", { name: /pair android phone|pair new device/i })
      ).not.toBeInTheDocument();
    });

    it("should show a guided-setup hint when no devices are paired", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "android-companion" },
        },
      });

      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(
          screen.getByText("No devices paired yet. Use the guided setup below to pair your Android phone.")
        ).toBeInTheDocument();
      });
    });

    it("should show paired devices when devices are paired", async () => {
      window.api.preferences.get.mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "android-companion" },
        },
      });

      window.api.pairing.getStatus.mockResolvedValue({
        success: true,
        status: {
          isPaired: true,
          devices: [{
            deviceId: "device-1",
            deviceName: "Samsung Galaxy S24",
            secret: "test-secret",
            pairedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
          }],
        },
      });

      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("Samsung Galaxy S24")).toBeInTheDocument();
      });

      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });

    it("should NOT show Android details when another source is selected", async () => {
      render(<ImportSourceSettings userId={mockUserId} />);

      // Wait for loading to complete (radio buttons visible)
      await waitFor(() => {
        expect(screen.getByText("macOS Messages + Contacts")).toBeInTheDocument();
      });

      // The Android device-management block (and its guided-setup hint) only
      // renders for the android-companion source.
      expect(
        screen.queryByText(/use the guided setup below to pair your android phone/i)
      ).not.toBeInTheDocument();
    });
  });

  describe("Disabled State", () => {
    it("should disable radio buttons while saving", async () => {
      // Make the update take a while
      let resolveUpdate: (value: unknown) => void;
      window.api.preferences.update.mockImplementation(
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
        expect(screen.getByText("macOS Messages + Contacts")).toBeInTheDocument();
      });

      // The selected option's label should have the blue border styling
      const macosLabel = screen.getByText("macOS Messages + Contacts").closest("label");
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
      const macosLabel = screen.getByText("macOS Messages + Contacts").closest("label");
      expect(macosLabel).not.toHaveClass("border-blue-500");
    });

    it("should show green border on Android Companion when selected", async () => {
      const user = userEvent.setup();
      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText("Android Companion")).toBeInTheDocument();
      });

      const androidRadio = screen.getByRole("radio", {
        name: /android companion/i,
      });
      await user.click(androidRadio);

      // Android label should have green border
      const androidLabel = screen.getByText("Android Companion").closest("label");
      expect(androidLabel).toHaveClass("border-green-500");
    });
  });
});
