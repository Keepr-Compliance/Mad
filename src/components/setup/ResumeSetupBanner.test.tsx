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
import { appStateReducer } from "../../appCore/state/machine/reducer";
import type { AppState, ReadyState } from "../../appCore/state/machine/types";
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
    fda: "not-asked",
    setup: "finished",
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
      userData: { ...zeroSourceReady.userData, fda: "granted" as const },
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

// =============================================================================
// BACKLOG-3888: a user who chose email (provider recorded) and has no mailbox
// =============================================================================


describe("BACKLOG-3888 — chose email, no mailbox connected", () => {
  /** Windows, iPhone with drivers: ABOVE the texts floor. */
  const choseEmailReady: ReadyState = {
    status: "ready",
    user: { id: "u", email: "u@example.com" },
    platform: { isMacOS: false, isWindows: true, hasIPhone: false },
    userData: {
      phoneType: "iphone",
      hasCompletedEmailOnboarding: true,
      hasEmailConnected: false,
      hasRecordedEmailProvider: true,
      needsDriverSetup: false,
      fda: "not-applicable",
      setup: "finished",
    },
  };

  it.each<["iphone" | "android" | null]>([["iphone"], ["android"], [null]])(
    "shows for phoneType %s",
    (phoneType) => {
      mockState = { ...choseEmailReady, userData: { ...choseEmailReady.userData, phoneType } };
      renderStrict(<ResumeSetupBanner app={makeApp()} />);
      expect(screen.getByTestId("resume-setup-banner")).toBeInTheDocument();
      // Same component, same copy, same action.
      expect(screen.getByText("Finish setting up Keepr")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /resume setup/i })).toBeInTheDocument();
    },
  );

  it("does NOT show for the same user with no recorded provider (texts-only is not nagged)", () => {
    mockState = {
      ...choseEmailReady,
      userData: { ...choseEmailReady.userData, hasRecordedEmailProvider: undefined },
    };
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();
  });

  it("does NOT show when a mailbox is connected", () => {
    mockState = { ...choseEmailReady, userData: { ...choseEmailReady.userData, hasEmailConnected: true } };
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();
  });

  it("does NOT show while a mailbox token is dead (amber Reconnect strip owns it)", () => {
    mockState = { ...choseEmailReady, userData: { ...choseEmailReady.userData, hasBrokenMailboxToken: true } };
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();
  });

  it("does NOT show in a loading state", () => {
    mockState = {
      status: "loading",
      phase: "loading-user-data",
      user: choseEmailReady.user,
      platform: choseEmailReady.platform,
    } as AppState;
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();
  });

  it("dismissed -> hidden for the session; a fresh session (flag reset) shows it again", () => {
    mockState = choseEmailReady;
    const handleDismissSetupPrompt = jest.fn();
    const first = renderStrict(<ResumeSetupBanner app={makeApp({ handleDismissSetupPrompt })} />);
    fireEvent.click(screen.getByTitle(/dismiss/i));
    expect(handleDismissSetupPrompt).toHaveBeenCalledTimes(1);
    first.unmount();

    const dismissed = renderStrict(<ResumeSetupBanner app={makeApp({ showSetupPromptDismissed: true })} />);
    expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();
    dismissed.unmount();

    // Restart: showSetupPromptDismissed is component-local state, false again.
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.getByTestId("resume-setup-banner")).toBeInTheDocument();
  });

  it("Resume setup re-enters at the email-connect step", () => {
    mockState = choseEmailReady;
    const goToEmailOnboarding = jest.fn();
    renderStrict(<ResumeSetupBanner app={makeApp({ goToEmailOnboarding })} />);
    fireEvent.click(screen.getByRole("button", { name: /resume setup/i }));
    expect(goToEmailOnboarding).toHaveBeenCalledTimes(1);

    // goToEmailOnboarding dispatches START_EMAIL_SETUP (useNavigationFlow.ts:121).
    const next = appStateReducer(choseEmailReady, { type: "START_EMAIL_SETUP" });
    expect(next.status).toBe("onboarding");
    expect(next.status === "onboarding" && next.step).toBe("email-connect");
    expect(next.status === "onboarding" && next.completedSteps).toContain("phone-type");
  });

  it("connecting a mailbox removes it (EMAIL_CONNECTED in ready)", () => {
    const connected = appStateReducer(choseEmailReady, {
      type: "EMAIL_CONNECTED",
      email: "u@example.com",
      provider: "microsoft",
    });
    mockState = connected;
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();
  });

  it("connect then disconnect the ONLY mailbox in-session -> banner returns", () => {
    const noRecord: ReadyState = {
      ...choseEmailReady,
      userData: { ...choseEmailReady.userData, hasRecordedEmailProvider: undefined, hasBrokenMailboxToken: true },
    };
    const connected = appStateReducer(noRecord, {
      type: "EMAIL_CONNECTED",
      email: "u@example.com",
      provider: "google",
    });
    const disconnected = appStateReducer(connected, { type: "EMAIL_DISCONNECTED", provider: "google" });
    mockState = disconnected;
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.getByTestId("resume-setup-banner")).toBeInTheDocument();
  });

  it("disconnecting ONE of two mailboxes keeps the user connected -> no banner", () => {
    const connected: ReadyState = {
      ...choseEmailReady,
      userData: { ...choseEmailReady.userData, hasEmailConnected: true },
    };
    const next = appStateReducer(connected, {
      type: "EMAIL_DISCONNECTED",
      provider: "google",
      anyStillConnected: true,
    });
    mockState = next;
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();
  });

  it("disconnecting the only mailbox while its token was dead -> banner without a restart", () => {
    const deadToken: ReadyState = {
      ...choseEmailReady,
      userData: { ...choseEmailReady.userData, hasEmailConnected: false, hasBrokenMailboxToken: true },
    };
    mockState = appStateReducer(deadToken, { type: "EMAIL_DISCONNECTED", provider: "microsoft" });
    renderStrict(<ResumeSetupBanner app={makeApp()} />);
    expect(screen.getByTestId("resume-setup-banner")).toBeInTheDocument();
  });
});
