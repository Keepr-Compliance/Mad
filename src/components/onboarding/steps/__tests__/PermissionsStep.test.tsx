/**
 * Tests for PermissionsStep (BACKLOG-1842)
 *
 * The bug: granting Full Disk Access (FDA) during onboarding force-quits/
 * relaunches the app (macOS restarts an app whose FDA entitlement is toggled),
 * and the step used to start the data-sync the instant it detected the grant —
 * so that sync was interrupted mid-flight.
 *
 * The fix REORDERS the flow: the step NEVER starts a sync. When FDA is granted
 * after the user engaged the flow, it relaunches cleanly (window.api.system
 * .relaunchApp) and the fresh process runs the sync via useAutoRefresh. When FDA
 * is already granted at mount (returning user / E2E), it just advances — no
 * relaunch (no loop).
 *
 * These tests lock in that reorder and the resume-skip contract.
 *
 * @module onboarding/steps/__tests__/PermissionsStep.test
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import PermissionsStep, { Content } from "../PermissionsStep";
import type { OnboardingContext } from "../../types";
import { syncOrchestrator } from "../../../../services/SyncOrchestratorService";
import {
  hasMessagesImportTriggered,
  resetMessagesImportTrigger,
} from "../../../../utils/syncFlags";

// Polyfill window.scrollTo for jsdom (BACKLOG-1842 visual-polish round: the
// manual-add detour resets scroll to the top on open — see the
// scrollableAncestor/window.scrollTo effect in PermissionsStep.tsx). jsdom's
// window.scrollTo logs a noisy "not implemented" error when called; same
// polyfill pattern as Settings.test.tsx's Element.prototype.scrollTo.
window.scrollTo = jest.fn();

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
  isDatabaseInitialized: true,
  platform: "macos",
  userId: "test-user-123",
  isUserVerifiedInLocalDb: false,
  isResumedFromFdaRelaunch: false,
  ...overrides,
});

describe("PermissionsStep (BACKLOG-1842)", () => {
  let requestSyncSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMessagesImportTrigger();

    // Guard against the bug at its source: the step must NEVER ask the
    // orchestrator to sync. Spy on the real singleton so ANY sync request
    // originating from this component is caught.
    requestSyncSpy = jest
      .spyOn(syncOrchestrator, "requestSync")
      .mockReturnValue({ started: false, needsConfirmation: false });

    // Default: FDA NOT granted (fresh onboarding user flipping the toggle).
    (window.api.system.checkPermissions as jest.Mock).mockResolvedValue({
      hasPermission: false,
    });
    (window.api.system.triggerFullDiskAccess as jest.Mock).mockResolvedValue({
      granted: false,
    });
    (window.api.system.openSystemSettings as jest.Mock).mockResolvedValue({
      success: true,
    });
    (window.api.system.relaunchApp as jest.Mock).mockResolvedValue({
      relaunched: true,
    });
  });

  afterEach(() => {
    requestSyncSpy.mockRestore();
  });

  // ==========================================================================
  // META — resume-skip contract
  // ==========================================================================
  describe("meta", () => {
    it("has correct meta.id and is macOS-only", () => {
      expect(PermissionsStep.meta.id).toBe("permissions");
      expect(PermissionsStep.meta.platforms).toEqual(["macos"]);
    });

    it("is SKIPPED once permissions are granted (resume-skip contract)", () => {
      // After the FDA-grant relaunch, startup checkPermissions() reports granted
      // → permissionsGranted true → this step is skipped so onboarding resumes.
      expect(
        PermissionsStep.meta.shouldShow(
          createMockContext({ permissionsGranted: true })
        )
      ).toBe(false);
      // Still shows while unknown/false.
      expect(
        PermissionsStep.meta.shouldShow(
          createMockContext({ permissionsGranted: false })
        )
      ).toBe(true);
    });

    // BACKLOG-1842 (v12 redesign, SR-review follow-up): "Skip for now"
    // (see "safety sheet" describe block below) dispatches NAVIGATE_NEXT,
    // which the queue handles via its OWN manuallyCompletedIds mechanism —
    // it must NEVER touch meta.isComplete. This direct invariant check
    // guards that contract at the source: isComplete is ALWAYS and ONLY
    // permissionsGranted === true, regardless of any skip action. A future
    // change that wired "skip" through isComplete instead (breaking the
    // resume-skip contract, since a skipped-but-not-granted user would then
    // incorrectly skip the step on a later real launch) would fail this test
    // even though every UI-level test would still pass.
    it("isComplete is ALWAYS permissionsGranted===true — skip must never flip it (invariant)", () => {
      expect(
        PermissionsStep.meta.isComplete(createMockContext({ permissionsGranted: true }))
      ).toBe(true);
      expect(
        PermissionsStep.meta.isComplete(createMockContext({ permissionsGranted: false }))
      ).toBe(false);
      expect(
        PermissionsStep.meta.isComplete(createMockContext({ permissionsGranted: undefined }))
      ).toBe(false);
    });
  });

  // ==========================================================================
  // REORDER — sync must NEVER start in the doomed (pre-relaunch) process
  // ==========================================================================
  describe("reorder: no sync starts in this process", () => {
    it("does NOT request a sync when FDA becomes granted after the user engaged the flow (Check permissions relaunches instead)", async () => {
      const onAction = jest.fn();
      render(<Content context={createMockContext()} onAction={onAction} />);

      // User opens System Settings (engages the FDA flow this session).
      await act(async () => {
        fireEvent.click(
          screen.getByTestId("onboarding-permissions-open-settings")
        );
      });

      // Now the check detects FDA as granted (toggle flipped).
      (window.api.system.checkPermissions as jest.Mock).mockResolvedValue({
        hasPermission: true,
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("onboarding-permissions-check"));
      });

      // THE REGRESSION LOCK: the step never asks the orchestrator to sync, and
      // never marks the session import flag. Sync is owned by useAutoRefresh in
      // the fresh process after relaunch. The successful check DOES relaunch
      // (that's the whole point of the merged "Check permissions" button).
      expect(requestSyncSpy).not.toHaveBeenCalled();
      expect(hasMessagesImportTriggered()).toBe(false);
      expect(window.api.system.relaunchApp).toHaveBeenCalledTimes(1);
    });

    it("does NOT request a sync even when FDA is already granted at mount", async () => {
      (window.api.system.checkPermissions as jest.Mock).mockResolvedValue({
        hasPermission: true,
      });
      const onAction = jest.fn();
      render(<Content context={createMockContext()} onAction={onAction} />);

      // Already-granted at mount advances onboarding but never syncs here.
      await waitFor(() =>
        expect(onAction).toHaveBeenCalledWith({ type: "PERMISSION_GRANTED" })
      );
      expect(requestSyncSpy).not.toHaveBeenCalled();
      expect(window.api.system.relaunchApp).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // RELAUNCH — user-initiated via the single "Check permissions" button
  // ==========================================================================
  describe("relaunch", () => {
    it("relaunches when the user clicks Check permissions and the grant is detected", async () => {
      const onAction = jest.fn();
      render(<Content context={createMockContext()} onAction={onAction} />);

      // Open System Settings so the Check permissions button is revealed.
      await act(async () => {
        fireEvent.click(
          screen.getByTestId("onboarding-permissions-open-settings")
        );
      });

      (window.api.system.checkPermissions as jest.Mock).mockResolvedValue({
        hasPermission: true,
      });

      const checkBtn = await screen.findByTestId(
        "onboarding-permissions-check"
      );
      await act(async () => {
        fireEvent.click(checkBtn);
      });

      expect(window.api.system.relaunchApp).toHaveBeenCalledTimes(1);
      // Never a sync on the way out.
      expect(requestSyncSpy).not.toHaveBeenCalled();
    });

    it("does NOT show the Check permissions button before the user engages the FDA flow", () => {
      // triggerFullDiskAccess on mount rejects → hasTriggeredFDA stays false.
      (window.api.system.triggerFullDiskAccess as jest.Mock).mockRejectedValue(
        new Error("no access")
      );
      render(
        <Content context={createMockContext()} onAction={jest.fn()} />
      );
      expect(
        screen.queryByTestId("onboarding-permissions-check")
      ).not.toBeInTheDocument();
    });

    it("does NOT relaunch when Check permissions is clicked and the grant is still not detected", async () => {
      const onAction = jest.fn();
      render(<Content context={createMockContext()} onAction={onAction} />);

      await act(async () => {
        fireEvent.click(
          screen.getByTestId("onboarding-permissions-open-settings")
        );
      });

      // checkPermissions still resolves hasPermission: false (default mock).
      const checkBtn = await screen.findByTestId(
        "onboarding-permissions-check"
      );
      await act(async () => {
        fireEvent.click(checkBtn);
      });

      expect(window.api.system.relaunchApp).not.toHaveBeenCalled();
      expect(
        screen.getByText(/Permission not detected/i)
      ).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // BACKLOG-2173 (launch-blocker fix): the background poll must relaunch too,
  // not just the "Check permissions" button — this was the dead-end bug.
  // "Finishing setup…" (hasFullDiskAccess === true) must NEVER be a terminal
  // state reached without a relaunch having been triggered.
  // ==========================================================================
  describe("poll-triggered relaunch (BACKLOG-2173)", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("relaunches exactly once when the background poll (not the button) detects the grant", async () => {
      const onAction = jest.fn();
      render(<Content context={createMockContext()} onAction={onAction} />);

      // User opens System Settings — this starts the 2s poll (hasTriggeredFDA).
      await act(async () => {
        fireEvent.click(
          screen.getByTestId("onboarding-permissions-open-settings")
        );
      });

      // The toggle flips while the user is still in System Settings — the
      // NEXT poll tick (not a button click) is what detects the grant.
      (window.api.system.checkPermissions as jest.Mock).mockResolvedValue({
        hasPermission: true,
      });

      await act(async () => {
        jest.advanceTimersByTime(2000);
        // Flush the async checkPermissions() microtask queued by the interval.
        await Promise.resolve();
        await Promise.resolve();
      });

      // The dead-end bug: previously the poll flipped hasFullDiskAccess to
      // true (rendering "Finishing setup…") but NEVER called relaunchApp,
      // hanging forever. It must now relaunch — and exactly once, even
      // though the interval keeps ticking every 2s until it's cleared.
      expect(window.api.system.relaunchApp).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(window.api.system.relaunchApp).toHaveBeenCalledTimes(1);
    });

    it("'Finishing setup…' is never shown as a terminal state without a relaunch call", async () => {
      const onAction = jest.fn();
      render(<Content context={createMockContext()} onAction={onAction} />);

      await act(async () => {
        fireEvent.click(
          screen.getByTestId("onboarding-permissions-open-settings")
        );
      });

      (window.api.system.checkPermissions as jest.Mock).mockResolvedValue({
        hasPermission: true,
      });

      await act(async () => {
        jest.advanceTimersByTime(2000);
        await Promise.resolve();
        await Promise.resolve();
      });

      // The "Permission Granted / Finishing setup…" screen is showing...
      expect(screen.getByText("Permission Granted")).toBeInTheDocument();
      expect(
        screen.getByText(/Finishing setup/i)
      ).toBeInTheDocument();
      // ...and it is NOT a dead end: a relaunch was triggered to get past it.
      expect(window.api.system.relaunchApp).toHaveBeenCalledTimes(1);
    });

    it("does not race a poll hit and a manual 'Check permissions' click into two relaunches", async () => {
      const onAction = jest.fn();
      render(<Content context={createMockContext()} onAction={onAction} />);

      await act(async () => {
        fireEvent.click(
          screen.getByTestId("onboarding-permissions-open-settings")
        );
      });

      (window.api.system.checkPermissions as jest.Mock).mockResolvedValue({
        hasPermission: true,
      });

      const checkBtn = await screen.findByTestId(
        "onboarding-permissions-check"
      );

      // Fire the poll tick and the button click "simultaneously".
      await act(async () => {
        jest.advanceTimersByTime(2000);
        fireEvent.click(checkBtn);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(window.api.system.relaunchApp).toHaveBeenCalledTimes(1);
    });

    // Paired UI nit, same BACKLOG-2173: founder asked to drop the green card
    // background/border on the "Permission Granted" state — keep just the
    // checkmark + text.
    it("does not wrap the 'Permission Granted' state in a green card background/border", async () => {
      (window.api.system.checkPermissions as jest.Mock).mockResolvedValue({
        hasPermission: true,
      });
      render(<Content context={createMockContext()} onAction={jest.fn()} />);

      const heading = await screen.findByText("Permission Granted");
      const card = heading.closest("div.text-center");
      expect(card).not.toBeNull();
      expect(card).not.toHaveClass("bg-green-50");
      expect(card).not.toHaveClass("border-2");
      expect(card).not.toHaveClass("border-green-300");
      // Checkmark + text still present.
      expect(screen.getByText(/Full Disk Access is enabled/i)).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // BACKLOG-1842 (v12 screen-fidelity fix): the screen must visually match
  // the founder-approved mock (fda-screen-options.html, Screen 1) — title,
  // safety link, 3 numbered steps, exactly one "Check permissions" button —
  // and must NOT still carry the old verbose screen's copy/buttons.
  // ==========================================================================
  describe("v12 screen fidelity", () => {
    it("renders the v12 title and subtitle", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);
      expect(screen.getByText("One toggle to go")).toBeInTheDocument();
      expect(screen.getByText("Enable Full Disk Access")).toBeInTheDocument();
    });

    it("renders the safety link directly under the title", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);
      expect(
        screen.getByTestId("onboarding-permissions-safety-link")
      ).toHaveTextContent("Why does Keepr need this — and is it safe?");
    });

    it("renders the 3 clean numbered steps from the mock, with circle badges instead of leading 'N.' text", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);
      // BACKLOG-1842 (visual-polish round): the leading "N." text prefix is
      // gone — the number now lives in a circle badge to the left of the title.
      // Scoped to <p> since the "Open System Settings" button (now moved under
      // step 1) renders the same words as its own text content.
      expect(screen.getByText("Open System Settings", { selector: "p" })).toBeInTheDocument();
      expect(
        screen.getByText("We’ll take you straight to the right pane.")
      ).toBeInTheDocument();
      expect(screen.getByText("Flip the Keepr toggle on")).toBeInTheDocument();
      expect(
        screen.getByText(/Approve.*Keepr restarts automatically/)
      ).toBeInTheDocument();
      expect(screen.queryByText(/^1\.\s/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^2\.\s/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^3\.\s/)).not.toBeInTheDocument();

      // The badges themselves render the bare numbers 1, 2, 3.
      expect(screen.getByText("1")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });

    // BACKLOG-1842 (hanging-indent fix): the header block (title/subtitle/
    // safety link) and every step's text must share ONE left edge, with the
    // numbered circles sitting in a gutter to the LEFT of that shared axis
    // (a hanging indent) — not the header flush-left while step text is
    // indented past its circle. Asserted via the shared layout classes
    // rather than pixel positions: the header carries the same `pl-9`
    // (36px) offset that each step's badge+gap (w-6 + gap-3 = 36px) already
    // produces for its text column.
    it("aligns the header block and every step's text to one shared left edge (hanging indent)", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);

      const header = screen.getByTestId("onboarding-permissions-header");
      expect(header).toHaveClass("pl-9");

      const step1Title = screen.getByText("Open System Settings", { selector: "p" });
      const step1Item = step1Title.closest("li");
      expect(step1Item).toHaveClass("flex", "gap-3");

      const step2Item = screen.getByText("Flip the Keepr toggle on").closest("li");
      const step3Item = screen
        .getByText(/Approve.*Keepr restarts automatically/)
        .closest("li");
      expect(step2Item).toHaveClass("flex", "gap-3");
      expect(step3Item).toHaveClass("flex", "gap-3");

      // The circle badges (1, 2, 3) are their own flex children BEFORE the
      // text column — i.e. outdented into the gutter, not inline with it.
      const badge1 = screen.getByText("1");
      const textColumn1 = step1Title.closest("div.flex-1");
      expect(textColumn1).not.toBeNull();
      expect(step1Item).toContainElement(badge1);
      expect(textColumn1).not.toContainElement(badge1);
    });

    // BACKLOG-1842 (visual-polish round, founder-directed): "Open System
    // Settings" moved directly under step 1's text; "Check permissions"
    // stays at the bottom.
    it("renders 'Open System Settings' directly under step 1, not at the bottom", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);
      const step1Title = screen.getByText("Open System Settings", { selector: "p" });
      const openSettingsButton = screen.getByTestId("onboarding-permissions-open-settings");
      // Both live inside the same step-1 <li> — the button's container is a
      // sibling/descendant close to the title, not a separate section at the
      // end of the screen.
      const step1Item = step1Title.closest("li");
      expect(step1Item).not.toBeNull();
      expect(step1Item).toContainElement(openSettingsButton);
    });

    // BACKLOG-1842 (visual-polish round, founder-directed): the "not listed?
    // add manually" link moved inside step 2, after "It'll look exactly like
    // this:" and before the Settings-window graphic.
    it("renders the 'not listed? add manually' link inside step 2, before the Settings-window graphic", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);
      const step2Title = screen.getByText("Flip the Keepr toggle on");
      const manualAddLink = screen.getByTestId("onboarding-permissions-manual-add-link");
      const step2Item = step2Title.closest("li");
      expect(step2Item).not.toBeNull();
      expect(step2Item).toContainElement(manualAddLink);

      const settingsGraphic = screen.getByTestId("fda-settings-window-graphic");
      expect(step2Item).toContainElement(settingsGraphic);

      // Ordering: the link's DOM position precedes the graphic's.
      const linkPrecedesGraphic = Boolean(
        manualAddLink.compareDocumentPosition(settingsGraphic) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      expect(linkPrecedesGraphic).toBe(true);
    });

    it("renders the ported Settings-window and Touch ID graphics inline", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);
      expect(
        screen.getByTestId("fda-settings-window-graphic")
      ).toBeInTheDocument();
      expect(screen.getByTestId("fda-auth-dialog-graphic")).toBeInTheDocument();
    });

    it("does NOT render the deleted old-screen copy", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);
      expect(screen.queryByText(/How to grant permission/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Your privacy matters/i)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Keepr will restart to finish setup/i)
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Permissions Required/i)).not.toBeInTheDocument();
    });

    // BACKLOG-1842 (visual-polish round): the "↲ this one" callout is gone —
    // the highlighted Keepr row makes it clear which row matters on its own.
    it("does NOT render the '↲ this one' callout on the Settings-window graphic", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);
      expect(screen.queryByText(/this one/i)).not.toBeInTheDocument();
    });

    it("has exactly one 'Check permissions' button and no 'Restart Keepr' button", async () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("onboarding-permissions-open-settings"));
      });

      const checkButtons = await screen.findAllByText(/Check permissions/i);
      expect(checkButtons).toHaveLength(1);
      expect(screen.queryByText(/Restart Keepr/i)).not.toBeInTheDocument();
    });

    it("renders exactly the primary 'Open System Settings' and secondary 'Check permissions' buttons", async () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);
      expect(
        screen.getByTestId("onboarding-permissions-open-settings")
      ).toHaveTextContent("Open System Settings");

      await act(async () => {
        fireEvent.click(
          screen.getByTestId("onboarding-permissions-open-settings")
        );
      });

      expect(
        await screen.findByTestId("onboarding-permissions-check")
      ).toHaveTextContent(/Check permissions/i);
    });
  });

  // ==========================================================================
  // BACKLOG-1842 (v12 redesign): safety sheet + skip escape hatch
  // ==========================================================================
  describe("safety sheet (v12 redesign)", () => {
    it("opens the safety sheet from the 'why does Keepr need this' link", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);

      expect(screen.queryByTestId("fda-safety-lets-go")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("onboarding-permissions-safety-link"));
      expect(screen.getByTestId("fda-safety-lets-go")).toBeInTheDocument();
      expect(screen.getByTestId("fda-safety-skip")).toBeInTheDocument();
    });

    it("'Let's go' closes the sheet and returns to the 3-step instructions", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);

      fireEvent.click(screen.getByTestId("onboarding-permissions-safety-link"));
      fireEvent.click(screen.getByTestId("fda-safety-lets-go"));

      expect(screen.queryByTestId("fda-safety-lets-go")).not.toBeInTheDocument();
      expect(
        screen.getByTestId("onboarding-permissions-open-settings")
      ).toBeInTheDocument();
    });

    // BACKLOG-1842 (whitespace fix, round 2): the real cause of the dead
    // whitespace BELOW the card on desktop was ResponsiveModal's base `h-full`
    // stretching the card to the full app-viewport height at every breakpoint.
    // The card must now size to its CONTENT at sm+ (`sm:h-auto` overrides the
    // base `h-full`) so it hugs its content, centered by the overlay, while
    // `sm:max-h-[90vh]` + `overflow-y-auto` keep a tall card scrollable. The
    // max-sm full-screen presentation (base `h-full`, untouched by the sm:
    // overrides) still works.
    it("sizes the safety sheet card to its content on desktop (sm:h-auto), not the full viewport height", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);
      fireEvent.click(screen.getByTestId("onboarding-permissions-safety-link"));

      const letsGoButton = screen.getByTestId("fda-safety-lets-go");
      // ResponsiveModal's panel is the flex-column ancestor carrying the
      // FdaSafetySheet's panelClassName
      // ("max-w-lg sm:h-auto sm:max-h-[90vh] p-6 justify-start overflow-y-auto").
      const panel = letsGoButton.closest(".justify-start");
      expect(panel).not.toBeNull();
      // Content-height on desktop — overrides the base h-full that caused the
      // stretched card + dead whitespace below.
      expect(panel).toHaveClass("sm:h-auto");
      // Tall cards still scroll within the viewport instead of clipping.
      expect(panel).toHaveClass("sm:max-h-[90vh]");
      expect(panel).toHaveClass("overflow-y-auto");
      // Content flows from the top (so a scrolling card reads top-first), not
      // vertically centered.
      expect(panel).toHaveClass("justify-start");
      expect(panel).not.toHaveClass("justify-center");
      // Width unchanged from the prior round.
      expect(panel).toHaveClass("max-w-lg");
    });

    it("'Skip for now' dispatches NAVIGATE_NEXT — the first escape hatch this step has had", () => {
      const onAction = jest.fn();
      render(<Content context={createMockContext()} onAction={onAction} />);

      fireEvent.click(screen.getByTestId("onboarding-permissions-safety-link"));
      fireEvent.click(screen.getByTestId("fda-safety-skip"));

      expect(onAction).toHaveBeenCalledWith({ type: "NAVIGATE_NEXT" });
      // Sheet closes on skip too.
      expect(screen.queryByTestId("fda-safety-lets-go")).not.toBeInTheDocument();
    });

    it("does not show the safety link once FDA is already granted", async () => {
      (window.api.system.checkPermissions as jest.Mock).mockResolvedValue({
        hasPermission: true,
      });
      render(<Content context={createMockContext()} onAction={jest.fn()} />);

      await waitFor(() => {
        expect(
          screen.queryByTestId("onboarding-permissions-safety-link")
        ).not.toBeInTheDocument();
      });
    });
  });

  // ==========================================================================
  // BACKLOG-1842 (v12 redesign): manual-add detour
  // ==========================================================================
  describe("manual-add detour (v12 redesign)", () => {
    it("opens the detour screen and can navigate back", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);

      fireEvent.click(screen.getByTestId("onboarding-permissions-manual-add-link"));
      expect(screen.getByText("Manually add Keepr.")).toBeInTheDocument();
      expect(screen.getByTestId("fda-app-picker-graphic")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("onboarding-permissions-detour-back"));
      expect(
        screen.queryByText("Manually add Keepr.")
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("onboarding-permissions-open-settings")
      ).toBeInTheDocument();
    });

    // BACKLOG-1842 (hanging-indent/polish round, founder-directed): the
    // "Quick fix · ~30 seconds" eyebrow above the detour heading is gone.
    it("does NOT render the 'Quick fix' eyebrow above the detour heading", () => {
      render(<Content context={createMockContext()} onAction={jest.fn()} />);
      fireEvent.click(screen.getByTestId("onboarding-permissions-manual-add-link"));
      expect(screen.queryByText(/Quick fix/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/~30 seconds/i)).not.toBeInTheDocument();
    });

    // BACKLOG-1842 (visual-polish round): the detour previously opened
    // scrolled partway down (clipping step 1) when the onboarding shell's
    // scroll container was scrolled before the user clicked "Add it
    // manually". Reset scroll to the top the moment the detour activates.
    it("resets scroll to the top when the detour becomes active", () => {
      (window.scrollTo as jest.Mock).mockClear();
      render(<Content context={createMockContext()} onAction={jest.fn()} />);

      expect(window.scrollTo).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("onboarding-permissions-manual-add-link"));

      // jsdom reports 0 for scrollHeight/clientHeight on every element, so the
      // scrollable-ancestor walk never finds a match here and the effect
      // falls back to window.scrollTo — exercising the same fallback path a
      // real DOM without an `overflow-y-auto` ancestor would take.
      expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    });
  });

  // ==========================================================================
  // BACKLOG-1842 (v12 redesign): telemetry (Sentry breadcrumbs/messages)
  // ==========================================================================
  describe("telemetry (v12 redesign)", () => {
    it("fires fda_step_viewed on mount", async () => {
      const Sentry = await import("@sentry/electron/renderer");
      render(<Content context={createMockContext()} onAction={jest.fn()} />);

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "onboarding.fda",
          message: "fda_step_viewed",
        })
      );
    });

    it("fires fda_settings_opened when Open System Settings is clicked", async () => {
      const Sentry = await import("@sentry/electron/renderer");
      render(<Content context={createMockContext()} onAction={jest.fn()} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId("onboarding-permissions-open-settings"));
      });

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({ message: "fda_settings_opened" })
      );
    });

    it("fires fda_skipped as a boundary event (breadcrumb + captureMessage)", async () => {
      const Sentry = await import("@sentry/electron/renderer");
      render(<Content context={createMockContext()} onAction={jest.fn()} />);

      fireEvent.click(screen.getByTestId("onboarding-permissions-safety-link"));
      fireEvent.click(screen.getByTestId("fda-safety-skip"));

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({ message: "fda_skipped" })
      );
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        "FDA funnel: fda_skipped",
        expect.objectContaining({
          tags: expect.objectContaining({ fda_event: "fda_skipped" }),
        })
      );
    });
  });
});
