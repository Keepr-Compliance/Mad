/**
 * Tests for AndroidComingSoonStep (the Android QR pairing step) — focused on the
 * BACKLOG-2289 `variant` branch.
 *
 * In `variant='settings'` (reused inside the Settings Android Sync wizard) the
 * onboarding-only affordances ("Go Back & Select iPhone", the "pair later from
 * Settings" footer) are hidden and the continue label reads for a Settings
 * context — while the QR/pairing logic (and its BACKLOG-2224 account-match, which
 * hashes context.userId) stays identical.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import AndroidComingSoonStep from "../AndroidComingSoonStep";
import type { OnboardingContext } from "../../types/context";

const Content = AndroidComingSoonStep.Content;

function makeContext(overrides: Partial<OnboardingContext> = {}): OnboardingContext {
  return {
    platform: "macos",
    phoneType: "android",
    emailConnected: undefined,
    connectedEmail: null,
    emailSkipped: false,
    driverSkipped: false,
    driverSetupComplete: false,
    permissionsGranted: undefined,
    termsAccepted: true,
    emailProvider: null,
    authProvider: "google",
    isNewUser: true,
    isDatabaseInitialized: true,
    userId: "user-1",
    isUserVerifiedInLocalDb: true,
    isResumedFromFdaRelaunch: false,
    ...overrides,
  };
}

describe("AndroidComingSoonStep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("settings variant (BACKLOG-2289)", () => {
    it("hides the 'Go Back & Select iPhone' affordance", () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      expect(
        screen.queryByRole("button", { name: /Go Back & Select iPhone/i })
      ).not.toBeInTheDocument();
    });

    it("hides the onboarding 'pair later from Settings' footer", () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      expect(
        screen.queryByText(/pair your Android phone later from Settings/i)
      ).not.toBeInTheDocument();
    });

    it("removes the primary skip/continue button in the Settings context (BACKLOG-2325)", () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      // The blue "Skip for now" / continue button is gone in the wizard — the
      // modal owns close/X and a live pair auto-advances (2323).
      expect(
        screen.queryByRole("button", { name: /^Skip for now$/i })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Continue with Email Only/i })
      ).not.toBeInTheDocument();
    });

    it("reveals the QR via a 'Show QR Code' button (BACKLOG-2325)", async () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      // The QR is not shown until the user asks for it.
      expect(screen.queryByAltText("Pairing QR Code")).not.toBeInTheDocument();
      const revealBtn = screen.getByRole("button", { name: /Show QR Code/i });
      expect(revealBtn).toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(revealBtn);

      // QR now renders with the lighter/average border (BACKLOG-2325).
      const qr = await screen.findByAltText("Pairing QR Code");
      expect(qr).toBeInTheDocument();
      expect(qr).toHaveClass("w-40");
      expect(qr.closest("div")).toHaveClass("border", "border-gray-200");
    });

    it("shows 'How It Works' ABOVE the QR and drops the blue broker-portal box (BACKLOG-2325)", async () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      // The blue broker-portal download box is removed.
      expect(
        screen.queryByText(/Download the Keepr Companion app from your organization/i)
      ).not.toBeInTheDocument();

      const howItWorks = screen.getByText("How It Works");
      expect(howItWorks).toBeInTheDocument();

      // Reveal the QR; the instructions still precede it in the DOM.
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /Show QR Code/i }));
      const qr = await screen.findByAltText("Pairing QR Code");

      expect(
        howItWorks.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it("preserves 2224 account-match: forwards a non-null userId to generateQR", async () => {
      const user = userEvent.setup();
      render(<Content context={makeContext({ userId: "desktop-user-42" })} onAction={jest.fn()} variant="settings" />);

      await user.click(screen.getByRole("button", { name: /Show QR Code/i }));

      await waitFor(() => {
        expect(window.api.pairing.generateQR).toHaveBeenCalledWith("desktop-user-42");
      });
      // The started sync server carries the same user id.
      await waitFor(() => {
        expect(window.api.localSync.startServer).toHaveBeenCalledWith(
          expect.objectContaining({ userId: "desktop-user-42" })
        );
      });
    });
  });

  describe("onboarding variant (default, unchanged)", () => {
    it("shows the 'Go Back & Select iPhone' affordance", () => {
      render(<Content context={makeContext()} onAction={jest.fn()} />);

      expect(
        screen.getByRole("button", { name: /Go Back & Select iPhone/i })
      ).toBeInTheDocument();
    });

    it("shows the onboarding footer and email-only continue label", () => {
      render(<Content context={makeContext()} onAction={jest.fn()} />);

      expect(
        screen.getByText(/pair your Android phone later from Settings/i)
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Skip & Continue with Email Only/i })
      ).toBeInTheDocument();
    });
  });
});
