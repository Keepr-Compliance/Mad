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
          name: /macos messages \+ contacts/i,
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
          name: /macos messages \+ contacts/i,
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

    it("should load saved android-companion preference", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
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
      jest.mocked(window.api.preferences.get).mockRejectedValue(new Error("Network error"));

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
      jest.mocked(window.api.preferences.get).mockResolvedValue({
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

  describe("Android Companion Details (BACKLOG-1447 / BACKLOG-2289)", () => {
    // BACKLOG-2289: the ad-hoc inline pair button + QR modal were removed from
    // this component. Pairing now happens ONLY through the guided AndroidSyncSetup
    // wizard (single entry point), so this component keeps device management only.
    it("should NOT render an inline pair button when android-companion is selected", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "android-companion" },
        },
      });

      render(<ImportSourceSettings userId={mockUserId} />);

      await waitFor(() => {
        expect(screen.getByText(/no devices paired yet/i)).toBeInTheDocument();
      });

      // No ad-hoc inline QR/pairing entry point remains here — connecting now
      // goes through the guided wizard CTA (see next test).
      expect(
        screen.queryByRole("button", { name: /pair android phone|pair new device/i })
      ).not.toBeInTheDocument();
    });

    it("should show a 'Connect your Android phone' CTA wired to the guided wizard when no devices are paired (BACKLOG-2347)", async () => {
      // BACKLOG-2544 — THE RACE IS NOW RUN ON EVERY EXECUTION, DELIBERATELY.
      //
      // This component makes TWO independent async loads. On a fast machine
      // both settle in one tick and the race never happens; on macOS CI it
      // sometimes did, and the test failed there and nowhere else — on the same
      // commit that passed elsewhere.
      //
      // Delaying the second load by one tick is what a slower runner does for
      // free. Injecting it here makes the condition DETERMINISTIC: the test can
      // no longer pass by being lucky, and a future change that reintroduces
      // the race fails immediately rather than four merges later.
      jest.mocked(window.api.pairing.getStatus).mockImplementation(
        () => new Promise((r) => setTimeout(() => r({ success: true, devices: [] }), 0)) as never,
      );
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "android-companion" },
        },
      });

      const onConnectAndroid = jest.fn();
      render(
        <ImportSourceSettings userId={mockUserId} onConnectAndroid={onConnectAndroid} />
      );

      /**
       * BACKLOG-2544 — WAIT FOR THE SECOND LOAD BEFORE TOUCHING ANYTHING.
       *
       * This component makes TWO independent async loads: the preference, and
       * then the Android pairing/sync status. The test used to find the button
       * as soon as the FIRST resolved and click it — so on a slower machine the
       * second could land in between, re-render, and leave the click on a
       * detached node. The handler never fired and the assertion failed, on
       * macOS CI only, on the same commit that passed elsewhere.
       *
       * Reproduced deterministically by delaying the second load by one tick,
       * which is what a slower runner does for free. `Loading devices…` is the
       * component's own marker for that load being in flight, so waiting for it
       * to clear waits for the exact thing that was racing.
       *
       * `queryBy` + `waitFor`, not `waitForElementToBeRemoved`: the marker may
       * never render at all when both loads settle in one tick, and that must
       * not be an error.
       */
      // TWO waits, in this order, and the order is the fix.
      //
      // Waiting only for `Loading devices…` to be ABSENT passes instantly —
      // `androidLoading` starts false, so at that moment the second load has
      // not begun. Established by running it: the button was found and then
      // detached before the very next line.
      //
      // So: wait for the second load to have STARTED, then for it to have
      // FINISHED. Only then is the tree stable enough to touch.
      await waitFor(() => expect(window.api.pairing.getStatus).toHaveBeenCalled());
      await waitFor(() => {
        expect(screen.queryByText(/loading devices/i)).not.toBeInTheDocument();
      });

      const user = userEvent.setup();
      const cta = await screen.findByRole("button", {
        name: /connect your android phone/i,
      });
      expect(cta).toBeInTheDocument();

      await user.click(cta);
      await waitFor(() => expect(onConnectAndroid).toHaveBeenCalledTimes(1));
    });

    it("should show paired devices when devices are paired", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          messages: { source: "android-companion" },
        },
      });

      jest.mocked(window.api.pairing.getStatus).mockResolvedValue({
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

      // The Android device-management block (and its connect CTA) only
      // renders for the android-companion source.
      expect(
        screen.queryByRole("button", { name: /connect your android phone/i })
      ).not.toBeInTheDocument();
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
