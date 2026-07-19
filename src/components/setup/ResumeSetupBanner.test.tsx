/**
 * ResumeSetupBanner + useResumeSetup tests (BACKLOG-1709 / BACKLOG-1711)
 *
 * Verifies the floor-aware "Resume setup" affordance:
 *   - appears iff the user is in `ready` AND below the data-source floor,
 *   - resume dispatches the START_EMAIL_SETUP path (goToEmailOnboarding),
 *   - dismissal is session-only (driven by showSetupPromptDismissed),
 *   - floor-satisfied users (incl. texts-only) never see it.
 *
 * All renders are wrapped in <React.StrictMode> (StrictMode is ON app-wide),
 * so double-invocation of render/effects is exercised.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResumeSetupBanner } from "./ResumeSetupBanner";
import type { AppState, ReadyState } from "../../appCore/state/types";
import type { AppStateMachine } from "../../appCore/state/types";

// The hook reads the raw machine state via useOptionalMachineState. We drive it
// from a module-level variable so each test can set the posture, then use the
// REAL selectSetupIncomplete (not mocked) to exercise the floor end-to-end.
let mockState: AppState;

jest.mock("../../appCore/state/machine", () => ({
  useOptionalMachineState: () => ({
    state: mockState,
    dispatch: jest.fn(),
  }),
}));

function renderStrict(ui: React.ReactElement) {
  return render(<React.StrictMode>{ui}</React.StrictMode>);
}

/** Minimal AppStateMachine stub — only the fields useResumeSetup reads. */
function makeApp(overrides: Partial<AppStateMachine> = {}): AppStateMachine {
  return {
    showSetupPromptDismissed: false,
    goToEmailOnboarding: jest.fn(),
    handleDismissSetupPrompt: jest.fn(),
    ...overrides,
  } as unknown as AppStateMachine;
}

/** Ready state below the floor: no email, no FDA, no phone selected. */
const zeroSourceReady: ReadyState = {
  status: "ready",
  user: { id: "u", email: "u@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: true },
  userData: {
    phoneType: null,
    hasCompletedEmailOnboarding: true,
    hasEmailConnected: false,
    needsDriverSetup: false,
    hasPermissions: false,
  },
};

describe("ResumeSetupBanner / useResumeSetup", () => {
  it("appears when in ready AND below the data-source floor", () => {
    mockState = zeroSourceReady;
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.getByTestId("resume-setup-banner")).toBeInTheDocument();
  });

  it("does NOT appear for a texts-only (macOS FDA) user — no shaming of texts-only completion", () => {
    mockState = {
      ...zeroSourceReady,
      userData: { ...zeroSourceReady.userData, hasPermissions: true },
    };
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();
  });

  it("does NOT appear when a mailbox is connected", () => {
    mockState = {
      ...zeroSourceReady,
      userData: { ...zeroSourceReady.userData, hasEmailConnected: true },
    };
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();
  });

  it("does NOT appear in a non-ready state (onboarding renders its own flow)", () => {
    mockState = {
      status: "onboarding",
      step: "email-connect",
      user: { id: "u", email: "u@example.com" },
      platform: { isMacOS: true, isWindows: false, hasIPhone: true },
      completedSteps: [],
    } as AppState;
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();
  });

  it("resume dispatches the START_EMAIL_SETUP re-entry (goToEmailOnboarding)", () => {
    mockState = zeroSourceReady;
    const goToEmailOnboarding = jest.fn();
    renderStrict(
      <ResumeSetupBanner app={makeApp({ goToEmailOnboarding })} />
    );
    fireEvent.click(screen.getByRole("button", { name: /resume setup/i }));
    expect(goToEmailOnboarding).toHaveBeenCalledTimes(1);
  });

  it("dismissal is session-only: hidden once showSetupPromptDismissed is set", () => {
    mockState = zeroSourceReady;
    const handleDismissSetupPrompt = jest.fn();

    // First render: banner visible, dismiss wired to the session-only handler.
    const { unmount } = renderStrict(
      <ResumeSetupBanner app={makeApp({ handleDismissSetupPrompt })} />
    );
    fireEvent.click(screen.getByTitle(/dismiss/i));
    expect(handleDismissSetupPrompt).toHaveBeenCalledTimes(1);
    unmount();

    // Simulate the resulting session flag: banner suppressed for the rest of
    // the session even though the floor is still unmet.
    renderStrict(
      <ResumeSetupBanner app={makeApp({ showSetupPromptDismissed: true })} />
    );
    expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();
  });
});
