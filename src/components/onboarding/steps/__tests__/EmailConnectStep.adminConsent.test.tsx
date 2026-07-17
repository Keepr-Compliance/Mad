/**
 * BACKLOG-2007: Tests for the org admin-consent block flow in EmailConnectStep.
 *
 * When a Microsoft mailbox connect is blocked because the tenant admin has not
 * consented to Keepr, the main process flags `adminConsentRequired`, which
 * useEmailHandlers re-emits as an `email-admin-consent-blocked` window event.
 * EmailConnectStep listens for it and renders a "Request IT approval" panel.
 */

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Content } from "../EmailConnectStep";
import type { OnboardingContext, StepAction } from "../../types";
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
  authProvider: "microsoft",
  isNewUser: true,
  isDatabaseInitialized: true,
  platform: "macos",
  userId: "u1",
  ...overrides,
});

function renderStep(onAction: (a: StepAction) => void = jest.fn()) {
  return render(<Content context={createMockContext()} onAction={onAction} />);
}

describe("EmailConnectStep admin-consent block (BACKLOG-2007)", () => {
  it("does not show the IT-approval panel by default", () => {
    renderStep();
    expect(
      screen.queryByTestId("onboarding-email-admin-consent"),
    ).not.toBeInTheDocument();
  });

  it("shows the Request IT approval panel after an admin-consent block event", () => {
    renderStep();

    act(() => {
      emitEmailAdminConsentBlocked({
        provider: "microsoft",
        error: "AADSTS90094: admin consent required",
      });
    });

    expect(
      screen.getByTestId("onboarding-email-admin-consent"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("onboarding-email-request-it-approval"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Microsoft 365/i)).toBeInTheDocument();
  });

  it("copies an approval request to the clipboard when the button is clicked", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderStep();
    act(() => {
      emitEmailAdminConsentBlocked({ provider: "microsoft" });
    });

    await act(async () => {
      fireEvent.click(
        screen.getByTestId("onboarding-email-request-it-approval"),
      );
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toMatch(/administrator approval/i);
  });

  it("clears the block when the user retries connecting that provider", () => {
    const onAction = jest.fn();
    renderStep(onAction);

    act(() => {
      emitEmailAdminConsentBlocked({ provider: "microsoft" });
    });
    expect(
      screen.getByTestId("onboarding-email-admin-consent"),
    ).toBeInTheDocument();

    // Microsoft is the primary provider (authProvider: "microsoft") — retry it.
    fireEvent.click(screen.getByTestId("onboarding-email-connect-primary"));

    expect(onAction).toHaveBeenCalledWith({
      type: "CONNECT_EMAIL_START",
      payload: { provider: "microsoft" },
    });
    expect(
      screen.queryByTestId("onboarding-email-admin-consent"),
    ).not.toBeInTheDocument();
  });
});
