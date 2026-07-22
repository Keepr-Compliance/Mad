/**
 * Tests for the Secure Storage (macOS Keychain) onboarding step.
 *
 * Focus: the step previews the real macOS keychain Touch ID prompt, so the
 * user recognizes it when it appears.
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
    it("renders only the Touch ID mockup", () => {
      render(
        <SecureStorageContent
          context={createMockContext()}
          onAction={jest.fn()}
        />
      );

      // Touch ID form is the sole graphic shown.
      expect(
        screen.getByTestId("keychain-touchid-graphic")
      ).toBeInTheDocument();
      // Password form graphic is no longer rendered.
      expect(
        screen.queryByTestId("keychain-dialog-graphic")
      ).not.toBeInTheDocument();
    });

    it("shows the keychain Touch ID prompt copy on the Touch ID variant", () => {
      render(
        <SecureStorageContent
          context={createMockContext()}
          onAction={jest.fn()}
        />
      );

      // Touch ID variant reuses the FDA auth-dialog visual with keychain copy.
      expect(
        screen.getByText(/Touch ID or enter the .*keychain password to allow this/i)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/system prompt like this/i)
      ).toBeInTheDocument();
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
