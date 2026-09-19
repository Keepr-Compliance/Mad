/**
 * BACKLOG-3281 — the Connect button must LEAVE "Connecting...".
 *
 * ===========================================================================
 * WHAT THIS SUITE IS FOR
 * ===========================================================================
 * Reproduced 2026-09-11: press Connect, complete the browser consent, come back
 * to a button reading "Connecting..." — no error, no retry, no way out but
 * reloading the window.
 *
 * The claim this file pins is "the spinner ENDS", and it needs three assertions
 * that do not imply one another: the label changed back, the button is ENABLED
 * (a re-labelled but still-disabled button is no retry), and the user is told
 * something. A label-only assertion passes on a control nobody can press.
 *
 * The seam: this file drives the WINDOW event and asserts the component acts on
 * it. `useEmailHandlers.connectFailure-3281.test.tsx` drives the real IPC
 * payloads through the hook and asserts they reach that same bus. Neither half
 * alone proves IPC -> component; together they do, because both use the real
 * bus rather than a mocked emitter.
 *
 * ===========================================================================
 * THE ERROR STRINGS ARE TRANSCRIBED, NOT INVENTED
 * ===========================================================================
 * Copied from the emitters at `develop` @ a6fe128aa. The event carries the
 * main-process `error` through unchanged, so these are the strings a user sees.
 *
 *   P1  electron/handlers/googleAuthHandlers.ts:758-761
 *   P2  electron/handlers/googleAuthHandlers.ts:837-840      <- the 5-min timeout
 *   P3  electron/handlers/microsoftAuthHandlers.ts:643-646
 *   P4a electron/handlers/microsoftAuthHandlers.ts:726-730, adminConsentRequired false
 *
 * ===========================================================================
 * MUTATIONS (planted against the committed tree, confirmed red BY NAME, then
 * reverted — see the PR body)
 * ===========================================================================
 *  C1  remove the `useEmailConnectFailedListener` call from EmailConnectStep
 *  C2  empty the `context.emailConnected` effect body
 */

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Content } from "../EmailConnectStep";
import type { OnboardingContext, StepAction } from "../../types";
import { emitEmailConnectFailed } from "../../../../utils/emailConnectFailedEvents";
import { emitEmailAdminConsentBlocked } from "../../../../utils/emailAdminConsentEvents";

const createMockContext = (
  overrides: Partial<OnboardingContext> = {},
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
  isDatabaseInitialized: true,
  platform: "macos",
  userId: "u1",
  isUserVerifiedInLocalDb: false,
  isResumedFromFdaRelaunch: false,
  ...overrides,
});

/**
 * `authProvider` decides which card is primary, so each provider is driven
 * through the PRIMARY card and asserted by its own testid.
 */
function renderStep(
  authProvider: "google" | "microsoft",
  onAction: (a: StepAction) => void = jest.fn(),
) {
  return render(
    <Content
      context={createMockContext({ authProvider })}
      onAction={onAction}
    />,
  );
}

const PRIMARY = "onboarding-email-connect-primary";
const FAILURE = "onboarding-email-connect-failed";

/** Press Connect on the primary card and confirm the stuck state exists. */
function startConnecting(): HTMLElement {
  const button = screen.getByTestId(PRIMARY);
  fireEvent.click(button);
  expect(button).toHaveTextContent("Connecting...");
  expect(button).toBeDisabled();
  return button;
}

describe("EmailConnectStep connect failure (BACKLOG-3281)", () => {
  it("shows no failure line before anything fails", () => {
    renderStep("google");
    expect(screen.queryByTestId(FAILURE)).not.toBeInTheDocument();
  });

  // =========================================================================
  // C1 — the spinner ends on EVERY failure the main process can emit, not only
  // on the one the item happened to name.
  // =========================================================================
  describe("C1 — the spinner ends on every emittable failure payload", () => {
    it.each([
      [
        "P1 googleAuthHandlers.ts:758-761",
        "google" as const,
        "Failed to save credentials. Please try logging in again.",
        "Connect Gmail",
      ],
      [
        "P2 googleAuthHandlers.ts:837-840 (5-minute timeout)",
        "google" as const,
        "OAuth authentication timed out after 5 minutes",
        "Connect Gmail",
      ],
      [
        "P3 microsoftAuthHandlers.ts:643-646",
        "microsoft" as const,
        "Failed to save credentials. Please try logging in again.",
        "Connect Outlook",
      ],
      [
        "P4a microsoftAuthHandlers.ts:726-730 (5-minute timeout)",
        "microsoft" as const,
        "OAuth authentication timed out after 5 minutes",
        "Connect Outlook",
      ],
    ])("%s", (_label, provider, error, expectedLabel) => {
      renderStep(provider);
      const button = startConnecting();

      act(() => {
        emitEmailConnectFailed({ provider, error });
      });

      // The label came back...
      expect(button).toHaveTextContent(expectedLabel);
      expect(button).not.toHaveTextContent("Connecting...");
      // ...and the button is pressable again. Re-enabling IS the retry.
      expect(button).toBeEnabled();
      // ...and the user is told, by provider name and with the reason.
      const panel = screen.getByTestId(FAILURE);
      expect(panel).toHaveTextContent(
        provider === "google" ? "Couldn't connect Gmail" : "Couldn't connect Outlook",
      );
      expect(panel).toHaveTextContent(error);
    });

    it("still ends the spinner when the payload carries no error string", () => {
      renderStep("google");
      const button = startConnecting();

      act(() => {
        emitEmailConnectFailed({ provider: "google" });
      });

      expect(button).toHaveTextContent("Connect Gmail");
      expect(button).toBeEnabled();
      expect(screen.getByTestId(FAILURE)).toHaveTextContent(
        "The connection didn't complete.",
      );
    });

    it("retrying that provider clears the failure line", () => {
      const onAction = jest.fn();
      renderStep("google", onAction);
      startConnecting();
      act(() => {
        emitEmailConnectFailed({ provider: "google", error: "boom" });
      });
      expect(screen.getByTestId(FAILURE)).toBeInTheDocument();

      fireEvent.click(screen.getByTestId(PRIMARY));

      expect(onAction).toHaveBeenCalledWith({
        type: "CONNECT_EMAIL_START",
        payload: { provider: "google" },
      });
      expect(screen.queryByTestId(FAILURE)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // C2 — the success path is not shadowed by the new listener.
  // =========================================================================
  describe("C2 — success still clears the spinner", () => {
    /**
     * The effect has to be exercised on the card that does NOT become
     * connected. Pressing Connect on the provider that then succeeds proves
     * nothing about it: that card swaps to a Continue button on the context
     * change alone, so the effect could be deleted and the assertion would
     * still pass. (It was written that way first, and the mutation below stayed
     * green — the fixture was wrong, not the control.)
     *
     * Here the user presses Connect on the SECONDARY provider and the PRIMARY
     * one connects. The secondary card still renders its Connect button, so
     * `connectingProvider` is the only thing deciding whether it reads
     * "Connecting...", and only the effect clears it.
     */
    it("a success clears Connecting... on the OTHER provider's card", () => {
      const { rerender } = render(
        <Content
          context={createMockContext({ authProvider: "google" })}
          onAction={jest.fn()}
        />,
      );
      const secondary = screen.getByTestId("onboarding-email-connect-secondary");
      fireEvent.click(secondary);
      expect(secondary).toHaveTextContent("Connecting...");
      expect(secondary).toBeDisabled();

      rerender(
        <Content
          context={createMockContext({
            authProvider: "google",
            emailConnected: true,
            emailProvider: "google",
            connectedEmail: "user@example.com",
          })}
          onAction={jest.fn()}
        />,
      );

      // The primary card is now the connected one...
      expect(
        screen.getByTestId("onboarding-email-continue-primary"),
      ).toBeInTheDocument();
      // ...and the secondary card stopped spinning instead of hanging.
      const stillSecondary = screen.getByTestId(
        "onboarding-email-connect-secondary",
      );
      expect(stillSecondary).toHaveTextContent("Connect Outlook");
      expect(stillSecondary).toBeEnabled();
    });

    it("a later success retires an earlier provider's failure line", () => {
      // Fail Gmail, then connect Outlook. The stale "Couldn't connect Gmail"
      // must not sit beside a connected Outlook.
      const { rerender } = render(
        <Content
          context={createMockContext({ authProvider: "google" })}
          onAction={jest.fn()}
        />,
      );
      startConnecting();
      act(() => {
        emitEmailConnectFailed({ provider: "google", error: "boom" });
      });
      expect(screen.getByTestId(FAILURE)).toBeInTheDocument();

      rerender(
        <Content
          context={createMockContext({
            authProvider: "google",
            emailConnected: true,
            emailProvider: "microsoft",
            connectedEmail: "outlook-user@example.com",
          })}
          onAction={jest.fn()}
        />,
      );

      expect(screen.queryByTestId(FAILURE)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // C2b (render half) — the two surfaces do not collide. The branch-ordering
  // control that makes this fail is in the hook suite; this asserts the
  // component renders exactly one of them.
  // =========================================================================
  describe("C2b — the IT-approval surface is not doubled up (BACKLOG-2007)", () => {
    it("an admin-consent block shows the IT-approval panel and NO generic failure line", () => {
      renderStep("microsoft");
      const button = startConnecting();

      act(() => {
        emitEmailAdminConsentBlocked({
          provider: "microsoft",
          error: "AADSTS65001: admin consent required",
        });
      });

      expect(
        screen.getByTestId("onboarding-email-admin-consent"),
      ).toBeInTheDocument();
      expect(screen.queryByTestId(FAILURE)).not.toBeInTheDocument();
      // And that path clears the spinner too — BACKLOG-2007's own behaviour.
      expect(button).toHaveTextContent("Connect Outlook");
      expect(button).toBeEnabled();
    });
  });
});
