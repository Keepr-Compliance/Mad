/**
 * BACKLOG-3210 (part 2) — the post-onboarding Full Disk Access explainer.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR
 * ---------------------------------------------------------------------------
 * 1. The sheet renders the SHARED instruction component, not a copy of it.
 *    Asserted through the test ids `PermissionsStep.test.tsx` also drives, so
 *    mutating `FdaInstructionSteps` once turns BOTH suites red. If only one
 *    goes red, they are not actually sharing.
 * 2. Every affordance of the onboarding screen is present, and the two whose
 *    MEANING changes outside the queue behave as decided (Skip is the exit;
 *    Check permissions does not relaunch).
 * 3. A grant takes the explainer down. Asserted with its inverse — a denial
 *    must LEAVE IT UP — because a change that simply hid the sheet would
 *    satisfy the first half on its own.
 * 4. Copy that is true only in onboarding is corrected here, and the
 *    correction is asserted. `FdaSafetySheet`'s defaults are asserted
 *    unchanged, because onboarding was not modified and that has to be a
 *    measurement rather than a claim.
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FdaHelpSheet } from "../FdaHelpSheet";
import { FdaSafetySheet } from "../../onboarding/steps/FdaSafetySheet";
import { FDA_SAFETY_LINK_COPY } from "../../onboarding/steps/fdaTelemetry";

const mockOpenFullDiskAccessSettings = jest.fn();
const mockCheckMessagesPermission = jest.fn();
jest.mock("../../../services", () => ({
  systemService: {
    openFullDiskAccessSettings: (...args: unknown[]) =>
      mockOpenFullDiskAccessSettings(...args),
    checkMessagesPermission: (...args: unknown[]) =>
      mockCheckMessagesPermission(...args),
  },
}));

const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

/** `checkMessagesPermission` is three-state; these are its three real shapes. */
const GRANTED = { success: true, data: { hasPermission: true } };
const DENIED = {
  success: true,
  data: { hasPermission: false, reason: "EPERM: operation not permitted" },
};
/** The check could not answer — NOT a denial and NOT a grant (BACKLOG-3208). */
const UNANSWERED = { success: true, data: { hasPermission: undefined } };

beforeEach(() => {
  jest.clearAllMocks();
  mockOpenFullDiskAccessSettings.mockResolvedValue({ success: true });
  mockCheckMessagesPermission.mockResolvedValue(DENIED);
});

describe("FdaHelpSheet renders the SHARED instructions (BACKLOG-3210 part 2)", () => {
  it("shows the step-by-step, not the consent sheet", () => {
    // The correction that produced this round: "Show me how" used to open
    // FdaSafetySheet, which explains that Keepr is safe and explains nothing
    // about how. The button's promise and its content now match.
    render(<FdaHelpSheet onClose={jest.fn()} />);

    expect(screen.getByTestId("fda-instruction-steps")).toBeInTheDocument();
    expect(screen.getByText("Flip the Keepr toggle on")).toBeInTheDocument();
    expect(
      screen.getByText(/It’ll look exactly like this/)
    ).toBeInTheDocument();
    // The consent sheet's headline must NOT be where a "Show me how" click lands.
    expect(
      screen.queryByText("Your messages stay on this Mac. Period.")
    ).not.toBeInTheDocument();
  });

  it("drives the SAME test ids the onboarding suite drives — the shared-component anchor", () => {
    // `PermissionsStep.test.tsx` asserts on these same ids. Mutating
    // `FdaInstructionSteps` therefore reds both suites, which is the only way
    // to prove one definition rather than two copies.
    render(<FdaHelpSheet onClose={jest.fn()} />);

    expect(
      screen.getByTestId("onboarding-permissions-open-settings")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("onboarding-permissions-manual-add-link")
    ).toBeInTheDocument();
  });

  it("carries all four affordances of the onboarding screen", () => {
    render(<FdaHelpSheet onClose={jest.fn()} />);

    expect(
      screen.getByTestId("onboarding-permissions-open-settings")
    ).toBeInTheDocument();
    expect(screen.getByTestId("fda-help-safety-link")).toBeInTheDocument();
    expect(
      screen.getByTestId("onboarding-permissions-manual-add-link")
    ).toBeInTheDocument();
    expect(screen.getByTestId("fda-help-check")).toBeInTheDocument();
  });

  it("does NOT carry the onboarding queue's own navigation", () => {
    // Continue / Back belong to the onboarding shell around the card and mean
    // nothing in a modal opened from Settings.
    render(<FdaHelpSheet onClose={jest.fn()} />);

    expect(
      screen.queryByRole("button", { name: /^Continue$/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Back$/ })
    ).not.toBeInTheDocument();
  });
});

describe("FdaHelpSheet — the macOS pane, still reachable from inside", () => {
  it("does NOT open System Settings just by being shown", () => {
    render(<FdaHelpSheet onClose={jest.fn()} />);
    expect(mockOpenFullDiskAccessSettings).not.toHaveBeenCalled();
  });

  it("STATE 6 — the step-1 button opens the pane, exactly once", async () => {
    render(<FdaHelpSheet onClose={jest.fn()} />);

    fireEvent.click(screen.getByTestId("onboarding-permissions-open-settings"));

    await waitFor(() =>
      expect(mockOpenFullDiskAccessSettings).toHaveBeenCalledTimes(1)
    );
  });

  it("stays open after opening the pane — the user needs it when they come back", async () => {
    const onClose = jest.fn();
    render(<FdaHelpSheet onClose={onClose} />);

    fireEvent.click(screen.getByTestId("onboarding-permissions-open-settings"));

    await waitFor(() =>
      expect(mockOpenFullDiskAccessSettings).toHaveBeenCalled()
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("fda-instruction-steps")).toBeInTheDocument();
  });

  it("runs the caller's follow-up after the pane opens", async () => {
    const onOpenedSettings = jest.fn();
    render(
      <FdaHelpSheet onClose={jest.fn()} onOpenedSettings={onOpenedSettings} />
    );

    fireEvent.click(screen.getByTestId("onboarding-permissions-open-settings"));

    await waitFor(() => expect(onOpenedSettings).toHaveBeenCalledTimes(1));
  });

  it("keeps the explainer up and logs when the pane will not open", async () => {
    mockOpenFullDiskAccessSettings.mockResolvedValue({
      success: false,
      error: "no handler",
    });
    const onClose = jest.fn();
    render(<FdaHelpSheet onClose={onClose} />);

    fireEvent.click(screen.getByTestId("onboarding-permissions-open-settings"));

    await waitFor(() => expect(mockLoggerError).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("fda-help-sheet")).toBeInTheDocument();
  });
});

describe("FdaHelpSheet — the manual-add detour and its return leg", () => {
  it("opens the manual-add steps and can come back", () => {
    render(<FdaHelpSheet onClose={jest.fn()} />);

    fireEvent.click(
      screen.getByTestId("onboarding-permissions-manual-add-link")
    );
    expect(screen.getByTestId("fda-manual-add-steps")).toBeInTheDocument();
    expect(screen.getByText("Manually add Keepr.")).toBeInTheDocument();

    // The return leg. Without it the detour is a dead-end — the exact shape
    // this whole batch of items exists to remove.
    fireEvent.click(screen.getByTestId("fda-help-manual-add-back"));
    expect(screen.getByTestId("fda-instruction-steps")).toBeInTheDocument();
  });
});

describe("FdaHelpSheet — the safety sheet is the EXIT, and it works here", () => {
  it("the safety link opens the consent sheet", () => {
    render(<FdaHelpSheet onClose={jest.fn()} />);

    fireEvent.click(screen.getByTestId("fda-help-safety-link"));

    expect(screen.getByTestId("fda-help-safety")).toBeInTheDocument();
    expect(
      screen.getByText("Your messages stay on this Mac. Period.")
    ).toBeInTheDocument();
  });

  it("Skip on the safety sheet CLOSES the explainer — this is the way out", () => {
    // The founder's stated reason for keeping this link: it is how a user who
    // cannot make the permission work gets out. Outside the onboarding queue
    // there is no step to advance past, so it dismisses through the caller's
    // own close, which means the caller knows it happened.
    const onClose = jest.fn();
    render(<FdaHelpSheet onClose={onClose} />);

    fireEvent.click(screen.getByTestId("fda-help-safety-link"));
    fireEvent.click(screen.getByTestId("fda-safety-skip"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the primary on the safety sheet returns to the steps, it does not exit", () => {
    const onClose = jest.fn();
    render(<FdaHelpSheet onClose={onClose} />);

    fireEvent.click(screen.getByTestId("fda-help-safety-link"));
    fireEvent.click(screen.getByTestId("fda-safety-lets-go"));

    expect(screen.getByTestId("fda-instruction-steps")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not point the user at a Settings pane that does not exist", () => {
    // Onboarding's footer says "Settings → Permissions". There is no such
    // pane; the way back is Settings → Messages.
    render(<FdaHelpSheet onClose={jest.fn()} />);
    fireEvent.click(screen.getByTestId("fda-help-safety-link"));

    expect(screen.getByText(/Settings → Messages/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Settings → Permissions/)
    ).not.toBeInTheDocument();
  });

  it("every way out reaches the caller's close — no silent dismissal", () => {
    // A modal with no exit outside onboarding would be the same dead-end class
    // as the bug this batch fixes, so each route is asserted to reach onClose.
    // ("fda-help-sheet" is the backdrop overlay; Skip is asserted above.)
    for (const route of ["fda-help-not-now", "fda-help-sheet"]) {
      const onClose = jest.fn();
      const { unmount } = render(<FdaHelpSheet onClose={onClose} />);
      fireEvent.click(screen.getByTestId(route));
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
    }
  });
});

describe("FdaHelpSheet — Check permissions, and dismissal on grant", () => {
  it("GRANTED — closes the explainer and tells the host to re-check", async () => {
    mockCheckMessagesPermission.mockResolvedValue(GRANTED);
    const onClose = jest.fn();
    const onPermissionGranted = jest.fn();
    render(
      <FdaHelpSheet
        onClose={onClose}
        onPermissionGranted={onPermissionGranted}
      />
    );

    fireEvent.click(screen.getByTestId("fda-help-check"));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // The host clears its own surface; the sheet does not reach into it.
    expect(onPermissionGranted).toHaveBeenCalledTimes(1);
  });

  it("DENIED — the explainer STAYS UP and says so", async () => {
    // The control that makes the test above real: a change that simply hid the
    // sheet would pass "granted -> closes" on its own.
    mockCheckMessagesPermission.mockResolvedValue(DENIED);
    const onClose = jest.fn();
    const onPermissionGranted = jest.fn();
    render(
      <FdaHelpSheet
        onClose={onClose}
        onPermissionGranted={onPermissionGranted}
      />
    );

    fireEvent.click(screen.getByTestId("fda-help-check"));

    expect(
      await screen.findByTestId("fda-help-check-failed")
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onPermissionGranted).not.toHaveBeenCalled();
    expect(screen.getByTestId("fda-instruction-steps")).toBeInTheDocument();
  });

  it("UNANSWERED — reported as not-detected on an explicit ask, never as a grant", async () => {
    // BACKLOG-3208's three-state contract. An unanswerable check must not close
    // the sheet: that would tell a user she is done when nothing established
    // that she is.
    mockCheckMessagesPermission.mockResolvedValue(UNANSWERED);
    const onClose = jest.fn();
    render(<FdaHelpSheet onClose={onClose} />);

    fireEvent.click(screen.getByTestId("fda-help-check"));

    expect(
      await screen.findByTestId("fda-help-check-failed")
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("a thrown check is not a grant either", async () => {
    mockCheckMessagesPermission.mockRejectedValue(new Error("ipc gone"));
    const onClose = jest.fn();
    render(<FdaHelpSheet onClose={onClose} />);

    fireEvent.click(screen.getByTestId("fda-help-check"));

    expect(
      await screen.findByTestId("fda-help-check-failed")
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("re-checks when the window regains focus and closes if the grant arrived", async () => {
    // Granting means leaving Keepr for System Settings, so coming back is
    // exactly when the answer may have changed.
    mockCheckMessagesPermission.mockResolvedValue(GRANTED);
    const onClose = jest.fn();
    render(<FdaHelpSheet onClose={onClose} />);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("a focus re-check that is still denied leaves the sheet up AND says nothing", async () => {
    // She did not ask. Accusing her of failing at something she did not attempt
    // would be worse than silence.
    mockCheckMessagesPermission.mockResolvedValue(DENIED);
    const onClose = jest.fn();
    render(<FdaHelpSheet onClose={onClose} />);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("fda-instruction-steps")).toBeInTheDocument();
    expect(
      screen.queryByTestId("fda-help-check-failed")
    ).not.toBeInTheDocument();
  });

  it("closes only once when focus events and a click all see the grant", async () => {
    mockCheckMessagesPermission.mockResolvedValue(GRANTED);
    const onClose = jest.fn();
    const onPermissionGranted = jest.fn();
    render(
      <FdaHelpSheet
        onClose={onClose}
        onPermissionGranted={onPermissionGranted}
      />
    );

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      fireEvent.click(screen.getByTestId("fda-help-check"));
    });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onPermissionGranted).toHaveBeenCalledTimes(1);
  });
});

describe("FdaHelpSheet — copy that is true only in onboarding is corrected here", () => {
  it("step 3 says to restart Keepr, and does NOT promise it happens by itself", () => {
    // Onboarding relaunches ITSELF on detecting the grant. From Settings or the
    // dashboard nothing restarts, and the Messages panel one inch below this
    // sheet says exactly that. The shared component takes this as a prop so the
    // two contexts can differ without either lying.
    render(<FdaHelpSheet onClose={jest.fn()} />);

    expect(
      screen.getByText(/then restart Keepr so the new access takes effect/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Keepr quits and reopens right back here/)
    ).not.toBeInTheDocument();
  });

  it("the manual-add detour does not promise to continue a setup that is finished", () => {
    render(<FdaHelpSheet onClose={jest.fn()} />);
    fireEvent.click(
      screen.getByTestId("onboarding-permissions-manual-add-link")
    );

    expect(
      screen.getByText(
        /Come back and restart Keepr so the new access takes effect/
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/continue your setup automatically/)
    ).not.toBeInTheDocument();
  });
});

/**
 * The onboarding call site passes only `onLetsGo` and `onSkip` and was not
 * modified. These are the control on that claim: every new prop is optional and
 * defaults to the old behaviour, onboarding's own restart copy included.
 */
describe("Onboarding's defaults are unchanged (BACKLOG-3210 part 2)", () => {
  it("FdaSafetySheet still renders the onboarding labels and footer", () => {
    render(<FdaSafetySheet onLetsGo={jest.fn()} onSkip={jest.fn()} />);

    expect(
      screen.getByRole("button", { name: "Let’s go" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Skip for now" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Turn it on any time in Settings → Permissions/)
    ).toBeInTheDocument();
  });

  it("FdaSafetySheet still routes a backdrop click to onLetsGo when no onClose is given", () => {
    const onLetsGo = jest.fn();
    const onSkip = jest.fn();
    const { container } = render(
      <FdaSafetySheet onLetsGo={onLetsGo} onSkip={onSkip} />
    );

    fireEvent.click(container.firstElementChild as Element);

    expect(onLetsGo).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("the safety link copy is the shared constant, not a second wording", () => {
    render(<FdaHelpSheet onClose={jest.fn()} />);
    expect(screen.getByTestId("fda-help-safety-link")).toHaveTextContent(
      FDA_SAFETY_LINK_COPY
    );
  });
});
