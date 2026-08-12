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
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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

    it("shows 'Next Steps' ABOVE the QR and drops the blue broker-portal box (BACKLOG-2325/2327)", async () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      // The blue broker-portal download box is removed.
      expect(
        screen.queryByText(/Download the Keepr Companion app from your organization/i)
      ).not.toBeInTheDocument();

      // BACKLOG-2327: the pair-screen heading is "Next Steps" (the prior download
      // screen already uses "How It Works" — no repeat).
      expect(screen.queryByText("How It Works")).not.toBeInTheDocument();
      const nextSteps = screen.getByText("Next Steps");
      expect(nextSteps).toBeInTheDocument();

      // Reveal the QR; the instructions still precede it in the DOM.
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /Show QR Code/i }));
      const qr = await screen.findByAltText("Pairing QR Code");

      expect(
        nextSteps.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it("drops the redundant 'Install the Keepr Companion app' step and lists the same-WiFi precondition (BACKLOG-2327)", () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      // The install step is gone (the prior download screen already covers it).
      expect(
        screen.queryByText(/Install the Keepr Companion app on your Android phone/i)
      ).not.toBeInTheDocument();

      // The same-WiFi-network precondition is now an explicit step, and the
      // scan + secure-sync steps remain.
      expect(
        screen.getByText(/Make sure both devices are on the same WiFi network/i)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Tap "Show QR Code" below and scan it with the app/i)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Your messages will sync securely over WiFi/i)
      ).toBeInTheDocument();
    });

    it("orders the Next Steps with the same-WiFi precondition FIRST, then Show QR Code (BACKLOG-2330)", () => {
      render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

      // BACKLOG-2330: founder wants the WiFi precondition ensured BEFORE scanning,
      // so step 1 is the WiFi check and step 2 is "Tap Show QR Code below".
      const steps = screen.getAllByRole("listitem");
      expect(steps).toHaveLength(3);
      expect(steps[0]).toHaveTextContent(/Make sure both devices are on the same WiFi network/i);
      expect(steps[1]).toHaveTextContent(/Tap "Show QR Code" below and scan it with the app/i);
      expect(steps[2]).toHaveTextContent(/Your messages will sync securely over WiFi/i);
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

    // -----------------------------------------------------------------------
    // BACKLOG-2327: the post-pair success state ("Android Phone Connected!")
    // now offers an explicit "Done" and states that sync is automatic. The
    // paired state is driven by the step's own 3s status poll, so these use
    // fake timers to advance to the "Connected" branch.
    // -----------------------------------------------------------------------
    describe("post-pair success state (BACKLOG-2327)", () => {
      const POLL_MS = 3000;

      beforeEach(() => {
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
      });

      // Reveal the QR (starts the poll + sync server), then advance one poll
      // with a paired status so the step flips to its "Connected" branch.
      const driveToPaired = async () => {
        jest.mocked(window.api.pairing.getStatus).mockResolvedValue({
          success: true,
          status: {
            isPaired: true,
            devices: [
              {
                deviceId: "d1",
                deviceName: "Pixel 8",
                secret: "s",
                pairedAt: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
              },
            ],
          },
        });
        fireEvent.click(screen.getByRole("button", { name: /Show QR Code/i }));
        // Resolve generateQR + startServer so the poll interval is registered.
        await act(async () => {
          await jest.advanceTimersByTimeAsync(0);
        });
        // Fire one poll → the step detects the pair and flips to "Connected".
        await act(async () => {
          await jest.advanceTimersByTimeAsync(POLL_MS);
        });
      };

      it("shows a primary 'Done' that emits ANDROID_SYNC_DONE to finish the wizard", async () => {
        const onAction = jest.fn();
        render(<Content context={makeContext()} onAction={onAction} variant="settings" />);

        await driveToPaired();
        expect(screen.getByText("Android Phone Connected!")).toBeInTheDocument();

        const doneBtn = screen.getByRole("button", { name: /^Done$/i });
        expect(doneBtn).toBeInTheDocument();

        fireEvent.click(doneBtn);
        expect(onAction).toHaveBeenCalledWith({ type: "ANDROID_SYNC_DONE" });
      });

      it("states that messages now sync AUTOMATICALLY over WiFi", async () => {
        render(<Content context={makeContext()} onAction={jest.fn()} variant="settings" />);

        await driveToPaired();

        // Sub-header states auto-sync…
        expect(
          screen.getByText(/Messages now sync automatically over WiFi/i)
        ).toBeInTheDocument();
        // …as does the success box, with the same-network reminder.
        expect(
          screen.getByText(/keep both\s+devices on the same network/i)
        ).toBeInTheDocument();
        // The stale passive copy is gone.
        expect(
          screen.queryByText(/will sync SMS messages over your local WiFi network/i)
        ).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // BACKLOG-2348: Windows-only pre-warn before the OS network-permission
  // (firewall) prompt that fires when the sync server binds the LAN IP. Shown
  // only when the app has no inbound allow rule yet; already-allowed (and
  // non-Windows) users go straight to the QR.
  // -------------------------------------------------------------------------
  describe("Windows network-permission pre-warn (BACKLOG-2348)", () => {
    it("shows the pre-warn (and does NOT start the server) when firewall is not yet allowed", async () => {
      jest.mocked(window.api.localSync.checkFirewallAllowed).mockResolvedValue({
        allowed: false,
        checked: true,
      });
      const user = userEvent.setup();
      render(
        <Content
          context={makeContext({ platform: "windows" })}
          onAction={jest.fn()}
          variant="settings"
        />
      );

      await user.click(screen.getByRole("button", { name: /Show QR Code/i }));

      // The pre-warn appears…
      expect(
        await screen.findByText(/Windows will ask for network permission/i)
      ).toBeInTheDocument();
      // …and the server has NOT started yet (waiting on acknowledgement).
      expect(window.api.localSync.startServer).not.toHaveBeenCalled();
      expect(screen.queryByAltText("Pairing QR Code")).not.toBeInTheDocument();
    });

    it("starts the server after the user acknowledges the pre-warn", async () => {
      jest.mocked(window.api.localSync.checkFirewallAllowed).mockResolvedValue({
        allowed: false,
        checked: true,
      });
      const user = userEvent.setup();
      render(
        <Content
          context={makeContext({ platform: "windows" })}
          onAction={jest.fn()}
          variant="settings"
        />
      );

      await user.click(screen.getByRole("button", { name: /Show QR Code/i }));
      await user.click(await screen.findByRole("button", { name: /^Continue$/i }));

      const qr = await screen.findByAltText("Pairing QR Code");
      expect(qr).toBeInTheDocument();
      await waitFor(() => {
        expect(window.api.localSync.startServer).toHaveBeenCalled();
      });
    });

    it("shows the pre-warn (renderer safe-default) when the firewall check itself rejects", async () => {
      jest.mocked(window.api.localSync.checkFirewallAllowed).mockRejectedValue(
        new Error("IPC failure")
      );
      const user = userEvent.setup();
      render(
        <Content
          context={makeContext({ platform: "windows" })}
          onAction={jest.fn()}
          variant="settings"
        />
      );

      await user.click(screen.getByRole("button", { name: /Show QR Code/i }));

      // Even when the check throws, we explain rather than silently start the server.
      expect(
        await screen.findByText(/Windows will ask for network permission/i)
      ).toBeInTheDocument();
      expect(window.api.localSync.startServer).not.toHaveBeenCalled();
    });

    it("skips the pre-warn and goes straight to the QR when firewall is already allowed", async () => {
      jest.mocked(window.api.localSync.checkFirewallAllowed).mockResolvedValue({
        allowed: true,
        checked: true,
      });
      const user = userEvent.setup();
      render(
        <Content
          context={makeContext({ platform: "windows" })}
          onAction={jest.fn()}
          variant="settings"
        />
      );

      await user.click(screen.getByRole("button", { name: /Show QR Code/i }));

      expect(await screen.findByAltText("Pairing QR Code")).toBeInTheDocument();
      expect(
        screen.queryByText(/Windows will ask for network permission/i)
      ).not.toBeInTheDocument();
    });

    it("does not run the firewall check on non-Windows (macOS goes straight to the QR)", async () => {
      const user = userEvent.setup();
      render(
        <Content
          context={makeContext({ platform: "macos" })}
          onAction={jest.fn()}
          variant="settings"
        />
      );

      await user.click(screen.getByRole("button", { name: /Show QR Code/i }));

      expect(await screen.findByAltText("Pairing QR Code")).toBeInTheDocument();
      expect(window.api.localSync.checkFirewallAllowed).not.toHaveBeenCalled();
    });

    it("cancelling the pre-warn dismisses it without starting the server", async () => {
      jest.mocked(window.api.localSync.checkFirewallAllowed).mockResolvedValue({
        allowed: false,
        checked: true,
      });
      const user = userEvent.setup();
      render(
        <Content
          context={makeContext({ platform: "windows" })}
          onAction={jest.fn()}
          variant="settings"
        />
      );

      await user.click(screen.getByRole("button", { name: /Show QR Code/i }));
      await user.click(await screen.findByRole("button", { name: /^Cancel$/i }));

      await waitFor(() => {
        expect(
          screen.queryByText(/Windows will ask for network permission/i)
        ).not.toBeInTheDocument();
      });
      expect(window.api.localSync.startServer).not.toHaveBeenCalled();
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
