/**
 * Tests for ContactSourceStep (TASK-2098)
 *
 * Covers:
 * - Meta configuration (hideContinue, platforms, skip)
 * - Platform-specific rendering (both sources on macOS, only Outlook on Windows)
 * - Saving preferences on Continue click
 * - Skipping defaults to macOS Contacts enabled, others disabled
 *
 * @module onboarding/steps/__tests__/ContactSourceStep.test
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ContactSourceStep from "../ContactSourceStep";
import type { OnboardingContext } from "../../types";

// Mock the platform context
jest.mock("../../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

import { usePlatform } from "../../../../contexts/PlatformContext";

// Mock context for testing
const createMockContext = (
  overrides: Partial<OnboardingContext> = {}
): OnboardingContext => ({
  phoneType: null,
  emailConnected: false,
  connectedEmail: null,
  emailSkipped: false,
  driverSkipped: false,
  driverSetupComplete: false,
  permissionsGranted: false,
  termsAccepted: true,
  emailProvider: null,
  authProvider: "google",
  isNewUser: true,
  isDatabaseInitialized: false,
  platform: "macos",
  userId: "test-user-123",
  isUserVerifiedInLocalDb: false,
  isResumedFromFdaRelaunch: false,
  ...overrides,
});

describe("ContactSourceStep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: macOS platform
    (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

    // Default: preferences API mocks
    window.api.preferences.update.mockResolvedValue({ success: true });
  });

  // =========================================================================
  // META TESTS
  // =========================================================================

  describe("meta", () => {
    it("has correct meta.id", () => {
      expect(ContactSourceStep.meta.id).toBe("contact-source");
    });

    it("supports both platforms", () => {
      expect(ContactSourceStep.meta.platforms).toContain("macos");
      expect(ContactSourceStep.meta.platforms).toContain("windows");
    });

    it("hides shell Continue button (custom Continue inside component)", () => {
      expect(ContactSourceStep.meta.navigation?.hideContinue).toBe(true);
    });

    it("shows back button", () => {
      expect(ContactSourceStep.meta.navigation?.showBack).toBe(true);
    });

    it("has skip enabled with descriptive label", () => {
      expect(ContactSourceStep.meta.skip?.enabled).toBe(true);
      expect(ContactSourceStep.meta.skip?.label).toBeDefined();
    });
  });

  // =========================================================================
  // PLATFORM RENDERING TESTS
  // =========================================================================

  describe("Content - macOS", () => {
    it("renders macOS Contacts and Outlook on macOS with Microsoft auth", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ authProvider: "microsoft" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.getByText("macOS Contacts App")).toBeInTheDocument();
      expect(screen.getByText("Outlook / Microsoft 365")).toBeInTheDocument();
    });

    it("renders macOS Contacts and Outlook on macOS with Google auth (TASK-2305 universal visibility)", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ authProvider: "google" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.getByText("macOS Contacts App")).toBeInTheDocument();
      // TASK-2305: Outlook is now visible for ALL users regardless of auth provider
      expect(screen.getByText("Outlook / Microsoft 365")).toBeInTheDocument();
    });

    it("renders heading text", () => {
      render(
        <ContactSourceStep.Content
          context={createMockContext()}
          onAction={jest.fn()}
        />
      );

      expect(
        screen.getByText("Where do you save your contacts?")
      ).toBeInTheDocument();
    });
  });

  describe("Content - Windows", () => {
    it("renders Outlook on Windows with Microsoft auth", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ platform: "windows", authProvider: "microsoft" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.queryByText("macOS Contacts App")).not.toBeInTheDocument();
      expect(screen.getByText("Outlook / Microsoft 365")).toBeInTheDocument();
    });

    it("renders Outlook on Windows with Google auth (TASK-2305 universal visibility)", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ platform: "windows", authProvider: "google" })}
          onAction={jest.fn()}
        />
      );

      // TASK-2305: Outlook is now visible for ALL users regardless of auth provider
      expect(screen.getByText("Outlook / Microsoft 365")).toBeInTheDocument();
    });

    it("renders iPhone Contacts when phone type is iPhone", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ platform: "windows", phoneType: "iphone" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.getByText("iPhone Contacts")).toBeInTheDocument();
    });

    it("does not render iPhone Contacts when phone type is Android", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ platform: "windows", phoneType: "android" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.queryByText("iPhone Contacts")).not.toBeInTheDocument();
    });

    it("renders Google Contacts as selectable for Google auth users (TASK-2303)", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ platform: "windows", authProvider: "google" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.getByText("Google Contacts")).toBeInTheDocument();
      // TASK-2303: Google Contacts is no longer "Coming Soon" — it's a selectable source
      expect(screen.queryByText("Coming Soon")).not.toBeInTheDocument();
    });

    it("renders Google Contacts for Microsoft auth users (TASK-2305 removed authProvider filter)", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: false });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ platform: "windows", authProvider: "microsoft" })}
          onAction={jest.fn()}
        />
      );

      // Google Contacts is now visible for ALL users regardless of auth provider
      expect(screen.getByText("Google Contacts")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // ANDROID-SPECIFIC RENDERING (BACKLOG-1466)
  // =========================================================================

  describe("Content - Android phone type", () => {
    it("renders Android Phone Contacts when phone type is android", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ phoneType: "android" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.getByText("Android Phone Contacts")).toBeInTheDocument();
    });

    it("hides macOS Contacts when phone type is android", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ phoneType: "android" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.queryByText("macOS Contacts App")).not.toBeInTheDocument();
    });

    it("does not render Android Phone Contacts when phone type is iphone", () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });

      render(
        <ContactSourceStep.Content
          context={createMockContext({ phoneType: "iphone" })}
          onAction={jest.fn()}
        />
      );

      expect(screen.queryByText("Android Phone Contacts")).not.toBeInTheDocument();
    });

    it("pre-selects Android Contacts and Google Contacts for Android users", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });
      const onAction = jest.fn();

      render(
        <ContactSourceStep.Content
          context={createMockContext({ phoneType: "android", authProvider: "google" })}
          onAction={onAction}
        />
      );

      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        expect(window.api.preferences.update).toHaveBeenCalledWith(
          "test-user-123",
          {
            contactSources: {
              direct: {
                outlookContacts: false,
                googleContacts: true,
                androidContacts: true,
              },
            },
          }
        );
      });
    });
  });

  // =========================================================================
  // SAVE PREFERENCES TESTS
  // =========================================================================

  describe("Content - Continue saves preferences", () => {
    it("saves preferences on Continue click", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });
      const onAction = jest.fn();

      render(
        <ContactSourceStep.Content
          context={createMockContext({ authProvider: "microsoft" })}
          onAction={onAction}
        />
      );

      // Click Continue
      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        // SSO-aware defaults: Microsoft SSO -> outlookContacts: true, googleContacts: false
        // All sources visible regardless of auth provider (TASK-2305)
        expect(window.api.preferences.update).toHaveBeenCalledWith(
          "test-user-123",
          {
            contactSources: {
              direct: {
                macosContacts: true,
                outlookContacts: true,
                googleContacts: false,
              },
            },
          }
        );
      });

      // Should navigate next after saving
      await waitFor(() => {
        expect(onAction).toHaveBeenCalledWith({ type: "NAVIGATE_NEXT" });
      });
    });

    it("saves deselected source as false", async () => {
      (usePlatform as jest.Mock).mockReturnValue({ isMacOS: true });
      const onAction = jest.fn();

      render(
        <ContactSourceStep.Content
          context={createMockContext({ authProvider: "microsoft" })}
          onAction={onAction}
        />
      );

      // Deselect macOS Contacts by clicking it (it starts selected)
      fireEvent.click(screen.getByText("macOS Contacts App"));

      // Click Continue
      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        // macOS Contacts deselected, but SSO-aware defaults keep outlookContacts: true (Microsoft SSO)
        expect(window.api.preferences.update).toHaveBeenCalledWith(
          "test-user-123",
          {
            contactSources: {
              direct: {
                macosContacts: false,
                outlookContacts: true,
                googleContacts: false,
              },
            },
          }
        );
      });
    });

    it("proceeds without saving when no userId in context", async () => {
      const onAction = jest.fn();

      render(
        <ContactSourceStep.Content
          context={createMockContext({ userId: null })}
          onAction={onAction}
        />
      );

      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        expect(onAction).toHaveBeenCalledWith({ type: "NAVIGATE_NEXT" });
      });

      // Should NOT have called preferences.update
      expect(window.api.preferences.update).not.toHaveBeenCalled();
    });

    it("continues even if preferences save fails (fail-open)", async () => {
      window.api.preferences.update.mockRejectedValue(
        new Error("Save failed")
      );
      const onAction = jest.fn();

      render(
        <ContactSourceStep.Content
          context={createMockContext()}
          onAction={onAction}
        />
      );

      fireEvent.click(screen.getByText("Continue"));

      // Should still navigate next despite error
      await waitFor(() => {
        expect(onAction).toHaveBeenCalledWith({ type: "NAVIGATE_NEXT" });
      });
    });
  });
});
