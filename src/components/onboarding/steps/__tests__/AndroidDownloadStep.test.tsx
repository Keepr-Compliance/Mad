/**
 * Tests for AndroidDownloadStep — focused on the BACKLOG-2289 `variant` branch.
 *
 * The step is reused inside the Settings Android Sync wizard with
 * `variant='settings'`, which must disable the first-run 60s auto-advance while
 * leaving the default onboarding behavior (variant='onboarding') unchanged.
 */

import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import AndroidDownloadStep from "../AndroidDownloadStep";
import type { OnboardingContext } from "../../types/context";

// Deterministic QR generation (avoids jsdom canvas).
jest.mock("qrcode", () => ({
  __esModule: true,
  default: {
    toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,mock"),
  },
}));

const Content = AndroidDownloadStep.Content;

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

describe("AndroidDownloadStep", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe("settings variant (BACKLOG-2289)", () => {
    it("does NOT auto-advance after 60s", async () => {
      jest.useFakeTimers();
      const onAction = jest.fn();

      render(<Content context={makeContext()} onAction={onAction} variant="settings" />);

      await act(async () => {
        jest.advanceTimersByTime(65_000);
      });

      expect(onAction).not.toHaveBeenCalled();
    });

    it("hides the auto-continue countdown text", async () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      // Wait for the QR image to appear (the countdown lives next to it).
      await screen.findByAltText("Download QR Code");

      expect(screen.queryByText(/Auto-continuing/i)).not.toBeInTheDocument();
    });

    it("still renders the install actions", async () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      expect(
        screen.getByRole("button", { name: /I've Installed It/i })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Skip — I already have it/i })
      ).toBeInTheDocument();
    });
  });

  describe("onboarding variant (default, unchanged)", () => {
    it("auto-advances (NAVIGATE_NEXT) after 60s", async () => {
      jest.useFakeTimers();
      const onAction = jest.fn();

      render(<Content context={makeContext()} onAction={onAction} />);

      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });

      expect(onAction).toHaveBeenCalledWith({ type: "NAVIGATE_NEXT" });
    });

    it("shows the auto-continue countdown text", async () => {
      render(<Content context={makeContext()} onAction={jest.fn()} />);

      expect(await screen.findByText(/Auto-continuing in \d+s/)).toBeInTheDocument();
    });
  });

  describe("declutter & reorder (BACKLOG-2325)", () => {
    it("drops the 'Download Link' pill, the 'Scan this QR code…' copy, and the broker-portal footnote", async () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      // QR (and thus the whole step body) has rendered.
      await screen.findByAltText("Download QR Code");

      expect(screen.queryByText("Download Link")).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Scan this QR code with your Android phone/i)
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/download the companion app later from your broker portal/i)
      ).not.toBeInTheDocument();
    });

    it("renders the 'Installation Steps' box ABOVE the QR code", async () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      const steps = screen.getByText("Installation Steps");
      const qr = await screen.findByAltText("Download QR Code");

      // Installation Steps precedes the QR in document order.
      expect(
        steps.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it("renders the QR with the lighter/average border (BACKLOG-2325)", async () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      const qr = await screen.findByAltText("Download QR Code");
      expect(qr).toHaveClass("w-40"); // ~15% smaller than the old w-48
      expect(qr.closest("div")).toHaveClass("border", "border-gray-200");
    });

    it("keeps the primary 'I've Installed It' action functional", async () => {
      const onAction = jest.fn();
      render(<Content context={makeContext()} onAction={onAction} variant="settings" />);

      fireEvent.click(screen.getByRole("button", { name: /I've Installed It/i }));
      expect(onAction).toHaveBeenCalledWith({ type: "NAVIGATE_NEXT" });
    });
  });
});
