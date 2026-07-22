/**
 * Tests for the Secure Storage (macOS Keychain) onboarding step.
 *
 * Focus: the step previews BOTH forms of the real macOS keychain prompt
 * (password + Touch ID) side by side, so the user recognizes whichever their
 * Mac shows.
 *
 * @module onboarding/steps/__tests__/SecureStorageStep.test
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import SecureStorageStep, {
  SecureStorageContent,
} from "../SecureStorageStep";
import type { OnboardingContext } from "../../types";

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
  userId: null,
  isUserVerifiedInLocalDb: false,
  isResumedFromFdaRelaunch: false,
  ...overrides,
});

describe("SecureStorageStep", () => {
  it("is a macOS-only step", () => {
    expect(SecureStorageStep.meta.platforms).toEqual(["macos"]);
  });

  describe("keychain prompt previews", () => {
    it("renders BOTH the password and Touch ID mockups side by side", () => {
      render(
        <SecureStorageContent
          context={createMockContext()}
          onAction={jest.fn()}
        />
      );

      // Password form (pre-existing graphic).
      expect(
        screen.getByTestId("keychain-dialog-graphic")
      ).toBeInTheDocument();
      // Touch ID form (new graphic).
      expect(
        screen.getByTestId("keychain-touchid-graphic")
      ).toBeInTheDocument();
    });

    it("shows the Touch ID prompt copy on the fingerprint variant", () => {
      render(
        <SecureStorageContent
          context={createMockContext()}
          onAction={jest.fn()}
        />
      );

      expect(
        screen.getByText("Use Touch ID to allow this")
      ).toBeInTheDocument();
      expect(screen.getByText(/depending on your Mac/i)).toBeInTheDocument();
    });

    it("does not render the keychain previews while waiting for authorization", () => {
      render(
        <SecureStorageContent
          context={createMockContext()}
          onAction={jest.fn()}
          isLoading
        />
      );

      expect(
        screen.queryByTestId("keychain-dialog-graphic")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("keychain-touchid-graphic")
      ).not.toBeInTheDocument();
    });
  });
});
