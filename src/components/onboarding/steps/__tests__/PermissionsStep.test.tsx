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
import type { OnboardingContext, StepAction } from "../../types";
import { syncOrchestrator } from "../../../../services/SyncOrchestratorService";
import {
  hasMessagesImportTriggered,
  resetMessagesImportTrigger,
} from "../../../../utils/syncFlags";

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
  });

  // ==========================================================================
  // REORDER — sync must NEVER start in the doomed (pre-relaunch) process
  // ==========================================================================
  describe("reorder: no sync starts in this process", () => {
    it("does NOT request a sync when FDA becomes granted after the user engaged the flow", async () => {
      const onAction = jest.fn();
      render(<Content context={createMockContext()} onAction={onAction} />);

      // User opens System Settings (engages the FDA flow this session).
      await act(async () => {
        fireEvent.click(
          screen.getByTestId("onboarding-permissions-open-settings")
        );
      });

      // Now the poll detects FDA as granted (toggle flipped).
      (window.api.system.checkPermissions as jest.Mock).mockResolvedValue({
        hasPermission: true,
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("onboarding-permissions-check"));
      });

      // THE REGRESSION LOCK: the step never asks the orchestrator to sync, and
      // never marks the session import flag. Sync is owned by useAutoRefresh in
      // the fresh process after relaunch.
      expect(requestSyncSpy).not.toHaveBeenCalled();
      expect(hasMessagesImportTriggered()).toBe(false);
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
  // RELAUNCH — user-initiated, deterministic
  // ==========================================================================
  describe("relaunch", () => {
    it("relaunches when the user clicks Restart Keepr after engaging the flow", async () => {
      const onAction = jest.fn();
      render(<Content context={createMockContext()} onAction={onAction} />);

      // Open System Settings so the Restart button is revealed.
      await act(async () => {
        fireEvent.click(
          screen.getByTestId("onboarding-permissions-open-settings")
        );
      });

      const restartBtn = await screen.findByTestId(
        "onboarding-permissions-restart"
      );
      await act(async () => {
        fireEvent.click(restartBtn);
      });

      expect(window.api.system.relaunchApp).toHaveBeenCalledTimes(1);
      // Never a sync on the way out.
      expect(requestSyncSpy).not.toHaveBeenCalled();
    });

    it("does NOT show the Restart button before the user engages the FDA flow", () => {
      // triggerFullDiskAccess on mount rejects → hasTriggeredFDA stays false.
      (window.api.system.triggerFullDiskAccess as jest.Mock).mockRejectedValue(
        new Error("no access")
      );
      render(
        <Content context={createMockContext()} onAction={jest.fn()} />
      );
      expect(
        screen.queryByTestId("onboarding-permissions-restart")
      ).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // WARN — restart expectation copy
  // ==========================================================================
  describe("warn copy", () => {
    it("warns the user that granting FDA restarts Keepr", () => {
      render(
        <Content context={createMockContext()} onAction={jest.fn()} />
      );
      const warning = screen.getByTestId(
        "onboarding-permissions-restart-warning"
      );
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveTextContent(/restart/i);
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
      expect(screen.getByText("Add Keepr to the list yourself")).toBeInTheDocument();
      expect(screen.getByTestId("fda-app-picker-graphic")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("onboarding-permissions-detour-back"));
      expect(
        screen.queryByText("Add Keepr to the list yourself")
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("onboarding-permissions-open-settings")
      ).toBeInTheDocument();
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
