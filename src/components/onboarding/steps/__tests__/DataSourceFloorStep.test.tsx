/**
 * BACKLOG-1821 — Tests for the DataSourceFloorStep recovery screen.
 *
 * Asserts:
 *  - the floor step's queue predicates gate completion correctly;
 *  - non-shaming texts-only copy is present;
 *  - the "Connect email" CTA dispatches a source-connecting action (never
 *    NAVIGATE_NEXT), and the "Set up texts" CTA navigates back;
 *  - the BACKLOG-2007 "Request IT approval" pointer is present.
 *
 * @module onboarding/steps/__tests__/DataSourceFloorStep.test
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import DataSourceFloorStep, { Content, meta } from "../DataSourceFloorStep";
import type { OnboardingContext, StepAction } from "../../types";

jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

function makeContext(overrides: Partial<OnboardingContext> = {}): OnboardingContext {
  return {
    platform: "windows",
    phoneType: "iphone",
    emailConnected: false,
    connectedEmail: null,
    emailSkipped: true,
    driverSkipped: true,
    driverSetupComplete: false,
    permissionsGranted: false,
    termsAccepted: true,
    emailProvider: null,
    authProvider: "google",
    isNewUser: true,
    isDatabaseInitialized: true,
    userId: "u1",
    isUserVerifiedInLocalDb: true,
    isResumedFromFdaRelaunch: false,
    ...overrides,
  };
}

function renderStep(
  onAction: (a: StepAction) => void = jest.fn(),
  ctx: Partial<OnboardingContext> = {},
) {
  return render(<Content context={makeContext(ctx)} onAction={onAction} />);
}

describe("DataSourceFloorStep meta (BACKLOG-1821)", () => {
  it("has the correct id and a non-empty platforms array", () => {
    expect(meta.id).toBe("data-source-floor");
    expect(Array.isArray(meta.platforms)).toBe(true);
    expect(meta.platforms!.length).toBeGreaterThan(0);
  });

  it("hides Continue, is not skippable, and cannot proceed (no bypass)", () => {
    expect(meta.navigation?.hideContinue).toBe(true);
    expect(meta.skip).toBeUndefined();
    expect(meta.canProceed?.(makeContext())).toBe(false);
  });

  it("is applicable ONLY when the floor is unmet", () => {
    // Zero sources → applicable.
    expect(meta.isApplicable?.(makeContext())).toBe(true);
    // A source exists → non-applicable (skipped).
    expect(meta.isApplicable?.(makeContext({ emailConnected: true }))).toBe(false);
    expect(meta.isApplicable?.(makeContext({ driverSetupComplete: true }))).toBe(false);
  });

  it("is complete the instant a source connects", () => {
    expect(meta.isComplete?.(makeContext())).toBe(false);
    expect(meta.isComplete?.(makeContext({ emailConnected: true }))).toBe(true);
  });
});

describe("DataSourceFloorStep content (BACKLOG-1821)", () => {
  it("renders the floor screen with a heading", () => {
    renderStep();
    expect(screen.getByTestId("onboarding-data-source-floor")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /connect at least one source/i }),
    ).toBeInTheDocument();
  });

  it("shows NON-shaming texts-only reassurance copy", () => {
    const { container } = renderStep();
    const text = container.textContent ?? "";
    expect(text).toMatch(/text messages alone are enough/i);
    expect(text).toMatch(/fully supported/i);
    // Must not frame texts-only as lesser/degraded.
    expect(text).not.toMatch(/only text|just text messages is not enough|incomplete/i);
  });

  it("Connect email CTA dispatches CONNECT_EMAIL_START (a source action), not NAVIGATE_NEXT", () => {
    const onAction = jest.fn();
    renderStep(onAction, { authProvider: "google" });

    fireEvent.click(screen.getByTestId("onboarding-floor-connect-email"));

    expect(onAction).toHaveBeenCalledWith({
      type: "CONNECT_EMAIL_START",
      payload: { provider: "google" },
    });
    // Never advances the queue directly — that would bypass the floor.
    expect(onAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "NAVIGATE_NEXT" }),
    );
  });

  it("uses the Microsoft provider label + payload when authProvider is microsoft", () => {
    const onAction = jest.fn();
    renderStep(onAction, { authProvider: "microsoft" });

    // The email CTA button (not the IT-approval note which also mentions Outlook).
    expect(
      screen.getByTestId("onboarding-floor-connect-email").textContent,
    ).toMatch(/Connect Outlook/i);
    fireEvent.click(screen.getByTestId("onboarding-floor-connect-email"));
    expect(onAction).toHaveBeenCalledWith({
      type: "CONNECT_EMAIL_START",
      payload: { provider: "microsoft" },
    });
  });

  it("Set up texts CTA navigates BACK (goToPrevious), never NAVIGATE_NEXT", () => {
    const onAction = jest.fn();
    renderStep(onAction);

    fireEvent.click(screen.getByTestId("onboarding-floor-setup-texts"));

    expect(onAction).toHaveBeenCalledWith({ type: "NAVIGATE_BACK" });
    expect(onAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "NAVIGATE_NEXT" }),
    );
  });

  it("shows the BACKLOG-2007 Request IT approval pointer", () => {
    renderStep();
    const note = screen.getByTestId("onboarding-floor-it-approval-note");
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(/request it approval/i);
    expect(note.textContent).toMatch(/administrator approval/i);
  });

  it("tailors the texts hint for Android users", () => {
    renderStep(jest.fn(), { phoneType: "android" });
    expect(screen.getByText(/keepr companion app/i)).toBeInTheDocument();
  });

  it("registers as a valid OnboardingStep (meta + Content)", () => {
    expect(DataSourceFloorStep.meta.id).toBe("data-source-floor");
    expect(typeof DataSourceFloorStep.Content).toBe("function");
  });
});
