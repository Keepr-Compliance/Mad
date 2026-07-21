/**
 * PermissionsStep - macOS Full Disk Access permissions screen
 *
 * Single-screen layout (BACKLOG-1842 v12 redesign, ported verbatim from the
 * founder-approved mock fda-screen-options.html "Screen 1 — the lean B
 * step") that guides macOS users through granting Full Disk Access via 3
 * numbered steps + the ported macOS "screenshot" graphics, with a "Why does
 * Keepr need this — and is it safe?" link opening the FdaSafetySheet, and a
 * single "Check permissions" action that verifies the grant and auto-
 * relaunches on success.
 *
 * BACKLOG-1842 — FDA grant force-quit / sync interruption:
 * macOS caches the sandbox FDA decision per-process at launch. When the user
 * flips the Full Disk Access toggle while Keepr is running, the OS force-quits/
 * relaunches the app (an app whose FDA entitlement is toggled is restarted), and
 * the running process never actually gains chat.db access until it relaunches.
 * Previously this step kicked off the data-sync the instant it *thought* FDA was
 * granted, so that sync was interrupted mid-flight by the OS restart.
 *
 * The fix REORDERS the flow so sync never starts in the doomed process:
 *   1. Guide the user to open System Settings and flip the toggle.
 *   2. Step 3's copy sets the expectation that granting FDA restarts Keepr.
 *   3. Relaunch cleanly (window.api.system.relaunchApp — the auto-relaunch that
 *      BACKLOG-1816's copy promised but never implemented). No data is wiped.
 *
 * After the relaunch the fresh process's startup checkPermissions() (in
 * LoadingOrchestrator Phase 4) reports FDA granted, so this step is skipped
 * (meta.shouldShow) and the data-sync runs cleanly on the dashboard via
 * useAutoRefresh — the documented "FDA already granted / returns after restart"
 * resume path. This step therefore NO LONGER triggers requestSync itself.
 *
 * @module onboarding/steps/PermissionsStep
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import type {
  OnboardingStep,
  OnboardingStepContentProps,
} from "../types";
import logger from '../../../utils/logger';
import { FdaSafetySheet } from "./FdaSafetySheet";
import {
  FdaSettingsWindowGraphic,
  FdaAuthDialogGraphic,
  FdaAppPickerGraphic,
} from "./FdaGraphics";
import { createFdaTelemetry, FDA_SAFETY_LINK_COPY } from "./fdaTelemetry";

/**
 * Checkmark icon for completed items
 */
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}

/**
 * Numbered circle badge for a step's leading number (BACKLOG-1842
 * visual-polish round). Mirrors the approved mock's `ol.steps li::before`
 * rule: a small filled indigo circle with the white bold number, sitting to
 * the left of the step's title. Replaces the old plain "N." text prefix.
 */
function StepBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-white text-xs font-bold flex items-center justify-center"
    >
      {n}
    </span>
  );
}

/**
 * PermissionsStep content component
 *
 * Single-screen layout with a checklist of permissions and auto-detection.
 * Users can open System Settings, grant permissions, and see the checklist
 * update in real-time without navigating between steps.
 */
export function Content({ context, onAction }: OnboardingStepContentProps) {
  const [hasFullDiskAccess, setHasFullDiskAccess] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  // BACKLOG-1842 (resume-at-step fix round): seeded true when resuming from
  // the FDA-grant relaunch — the user already engaged the FDA flow (opened
  // System Settings, clicked "Check permissions") before the relaunch, so
  // the relaunch-eligible state is available immediately on return rather
  // than requiring them to click "Open System Settings" again first.
  const [hasTriggeredFDA, setHasTriggeredFDA] = useState(
    () => context.isResumedFromFdaRelaunch
  );
  // BACKLOG-1842: true while the clean relaunch is in flight ("Check
  // permissions" button disabled, "Restarting..." shown). In packaged builds
  // the process exits before this matters; it guards the E2E/dev fallthrough
  // and double-clicks.
  const [isRelaunching, setIsRelaunching] = useState(false);
  // BACKLOG-2173: synchronous guard for relaunchForGrant, mirroring
  // isRelaunching. React state updates are not synchronous/immediately
  // visible to a closure created before the update — if the background poll
  // and a manual "Check permissions" click both resolve checkPermissions()
  // in the same microtask window, both can read the SAME stale
  // `isRelaunching === false` closure before either re-render lands, causing
  // a double relaunch. A ref is mutated synchronously and is safe against
  // that race; isRelaunching state stays for the UI (disabled button / label).
  const relaunchInFlightRef = useRef(false);

  // BACKLOG-1842: whether FDA was ALREADY granted when this step first mounted
  // (returning user, dev/E2E, or a stale-cache read). If so, the current
  // process already has working FDA — we must NOT relaunch (that would loop);
  // we just advance. We only relaunch when the grant appears AFTER the user
  // engaged the FDA flow this session (opened System Settings to flip it).
  const grantedAtMountRef = useRef(false);
  const mountCheckDoneRef = useRef(false);

  /**
   * BACKLOG-1842 (resume-at-step fix round): true once the user has checked
   * permissions and RETURNED to this step (via relaunch) with FDA still not
   * detected — either because the relaunch was suppressed (E2E/dev) or
   * because the grant genuinely didn't take (wrong copy of Keepr, toggle not
   * actually flipped, etc.). Shows the explicit "we still can't detect it"
   * message instead of silently looping the same instructions.
   */
  const [stillNotDetectedAfterRestart, setStillNotDetectedAfterRestart] = useState(false);

  // BACKLOG-1842 (v12 redesign): "Why does Keepr need this — and is it
  // safe?" slide-up sheet. One instance per Content mount, stable across
  // renders — telemetry helpers close over it via useCallback deps.
  const telemetryRef = useRef(createFdaTelemetry());
  const [showSafetySheet, setShowSafetySheet] = useState(false);
  // BACKLOG-1842 (v12 redesign): the "Don't see Keepr?" manual-add detour,
  // shown as a separate instructional panel replacing the main 3-step flow
  // (not a modal) — ported verbatim from the mock's "Shared" detour screen.
  const [showManualAddDetour, setShowManualAddDetour] = useState(false);
  // BACKLOG-1842 (visual-polish round): root element of the detour panel,
  // used to reset scroll to the top when the detour becomes active (see the
  // scroll-reset effect below).
  const detourRootRef = useRef<HTMLDivElement>(null);

  // BACKLOG-1842 (visual-polish round): the detour previously opened
  // scrolled partway down whenever the user had scrolled the onboarding
  // shell's scroll container before clicking "Add it manually" — the browser
  // preserves scroll position across the content swap, clipping the top of
  // the detour (step 1) until the user manually scrolled up. Reset scroll to
  // the top the moment the detour becomes active: walk up from the detour's
  // root node to the nearest scrollable ancestor (the app shell's
  // `overflow-y-auto` content area) and zero its scrollTop; fall back to
  // window.scrollTo for environments without that ancestor (tests, or a
  // future layout change).
  useEffect(() => {
    if (!showManualAddDetour) return;
    const root = detourRootRef.current;
    let scrollableAncestor: HTMLElement | null = null;
    let node = root?.parentElement ?? null;
    while (node) {
      const { overflowY } = window.getComputedStyle(node);
      if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
        scrollableAncestor = node;
        break;
      }
      node = node.parentElement;
    }
    if (scrollableAncestor) {
      scrollableAncestor.scrollTop = 0;
    } else {
      // Best-effort: jsdom (tests) doesn't implement window.scrollTo and
      // logs a "not implemented" console error if called directly.
      try {
        window.scrollTo(0, 0);
      } catch {
        // non-fatal
      }
    }
  }, [showManualAddDetour]);

  // Fire fda_step_viewed exactly once per mount.
  useEffect(() => {
    telemetryRef.current.stepViewed();
  }, []);

  const handleOpenSafetySheet = useCallback(() => {
    telemetryRef.current.safetyOpened();
    setShowSafetySheet(true);
  }, []);

  const handleSafetyLetsGo = useCallback(() => {
    telemetryRef.current.letsGo();
    setShowSafetySheet(false);
  }, []);

  // BACKLOG-1842 (v12 redesign, founder-directed product-behavior change):
  // the FIRST escape hatch this step has ever had. Continues onboarding
  // without FDA -- the existing data-source-floor step (BACKLOG-1821) is the
  // downstream safety net for a user who ends up with zero connected
  // sources; a user with email connected sails through. Reuses the queue's
  // existing manual-advance path (NAVIGATE_NEXT -> goToNext() marks this
  // step manuallyCompleted) rather than inventing a new completion
  // semantic -- permissions.meta.isComplete stays permissionsGranted===true
  // (unchanged contract for the resume-skip logic), this is purely a
  // "move on without granting" navigation, same mechanism ContactSourceStep
  // and DataSyncStep already use.
  const handleSkipForNow = useCallback(() => {
    telemetryRef.current.skipped();
    setShowSafetySheet(false);
    onAction({ type: "NAVIGATE_NEXT" });
  }, [onAction]);

  /**
   * BACKLOG-1842: Relaunch the app so the fresh process picks up the newly
   * granted Full Disk Access, then resumes onboarding/sync at the correct step.
   * NO sync is started here — sync is owned by useAutoRefresh post-relaunch.
   *
   * BACKLOG-1842 (resume-at-step fix round): persists the cloud resume marker
   * BEFORE relaunching, so the fresh process knows to resume onboarding at
   * `permissions` instead of replaying phone-type/contact-source/etc. See
   * permissionHandlers.ts save-onboarding-resume-marker for why this lives in
   * Supabase user_preferences rather than a local file (matches
   * phoneType/contactSources, which already live there and are already
   * readable before local DB init).
   *
   * BACKLOG-2173 (launch-blocker fix): this is now the ONLY relaunch trigger —
   * called from handleFdaGranted for every in-app detection path (poll AND the
   * "Check permissions" button), not just the button. The `relaunchInFlightRef`
   * guard immediately below makes it safe to call more than once (e.g. a poll
   * tick and a button click racing in the same microtask window): only the
   * first call proceeds, so "Finishing setup…" always leads to exactly one
   * self-relaunch and never dead-ends.
   */
  const relaunchForGrant = useCallback(async () => {
    if (relaunchInFlightRef.current) return;
    relaunchInFlightRef.current = true;
    setIsRelaunching(true);
    setStillNotDetectedAfterRestart(false);
    try {
      if (context.userId) {
        try {
          await window.api.system.saveOnboardingResumeMarker({ userId: context.userId });
        } catch (markerError) {
          // Best-effort: a marker failure must never block the relaunch. Worst
          // case the user replays onboarding from phone-type, same as before
          // this fix — not a regression, just a missed improvement.
          logger.warn("[PermissionsStep] saveOnboardingResumeMarker failed (non-fatal):", markerError);
        }
      }

      // In a packaged build the process exits inside this call; nothing after
      // runs. Under the E2E/dev harness the main-process handler is a no-op
      // (returns { relaunched: false }) so we simply re-enable the button.
      const result = await window.api.system.relaunchApp();
      if (!result?.relaunched) {
        logger.debug("[PermissionsStep] relaunchApp was suppressed (E2E/dev)");
        relaunchInFlightRef.current = false;
        setIsRelaunching(false);
        // E2E/dev: the process didn't actually exit, so "returning" is
        // immediate. If FDA still isn't detected, surface the explicit
        // message rather than leaving the user on the same instructions.
        if (!hasFullDiskAccess) {
          setStillNotDetectedAfterRestart(true);
        }
      }
    } catch (error) {
      logger.error("[PermissionsStep] relaunchApp failed:", error);
      relaunchInFlightRef.current = false;
      setIsRelaunching(false);
    }
    // Note: relaunchInFlightRef is a ref (read/written synchronously, not a
    // reactive dependency) — intentionally omitted, same as any other ref.
  }, [context.userId, hasFullDiskAccess]);

  /**
   * BACKLOG-1842: Handle the moment FDA is detected as granted.
   * - If it was already granted at mount → the current process has working FDA,
   *   so just advance onboarding (no restart, no loop).
   * - If the grant appeared after the user engaged the flow this session →
   *   the running process still can't reliably read chat.db (macOS caches the
   *   FDA/TCC decision per-process — well-documented behavior for Full Disk
   *   Access; a passing check here is not proof the access is durable for the
   *   rest of the process's lifetime), so relaunch.
   *
   * BACKLOG-2173 (launch-blocker fix): previously this branch relied SOLELY
   * on the user-initiated "Check permissions" button to call
   * relaunchForGrant() — but this handler is ALSO the background poll's
   * success path (the setInterval(checkPermissions, 2000) below), and the
   * poll never called relaunchForGrant() itself. That left a dead-end: the
   * poll flips hasFullDiskAccess to true (rendering the terminal-looking
   * "Permission Granted / Finishing setup…" state) with NO relaunch ever
   * triggered, so onboarding hung forever with no user-visible recourse short
   * of a manual quit+reopen. Fix: this handler now ALWAYS triggers the
   * relaunch itself for the non-mount-grant case, regardless of which path
   * detected it. relaunchForGrant's relaunchInFlightRef guard makes this safe even
   * if the poll and a manual button click race (only the first call
   * proceeds), so "Finishing setup…" always leads to exactly one
   * self-relaunch and never dead-ends.
   */
  const handleFdaGranted = useCallback(() => {
    setHasFullDiskAccess(true);
    setStillNotDetectedAfterRestart(false);
    telemetryRef.current.granted();
    if (grantedAtMountRef.current) {
      onAction({ type: "PERMISSION_GRANTED" });
      return;
    }
    // The grant appeared after the user engaged the FDA flow this session —
    // the running process still can't reliably read chat.db (cached deny).
    // Relaunch is the deterministic next step, whether detection came from
    // the background poll or the "Check permissions" button.
    void relaunchForGrant();
  }, [onAction, relaunchForGrant]);

  // Check permissions. Returns whether FDA is currently readable by THIS process.
  const checkPermissions = useCallback(async () => {
    logger.debug('[PermissionsStep] checkPermissions called');
    try {
      const result = await window.api.system.checkPermissions();
      logger.debug('[PermissionsStep] checkPermissions result:', result);
      if (result.hasPermission) {
        handleFdaGranted();
      }
      return result.hasPermission;
    } catch (error) {
      logger.error("[PermissionsStep] Error checking permissions:", error);
      return false;
    }
  }, [handleFdaGranted]);

  // Initial permission check on mount. Records whether FDA was ALREADY granted
  // (so a subsequent detection knows to advance vs relaunch).
  //
  // BACKLOG-1842 (resume-at-step fix round): if this mount IS the resume from
  // an FDA-grant relaunch (context.isResumedFromFdaRelaunch) and FDA is STILL
  // not detected, show the explicit "still can't detect it" message right
  // away instead of leaving the user back on the plain instructions with no
  // acknowledgment that a restart already happened.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.api.system.checkPermissions();
        if (cancelled) return;
        if (result.hasPermission) {
          // Already granted before the user did anything this session — the
          // current process has working FDA, so advance without relaunching.
          grantedAtMountRef.current = true;
          setHasFullDiskAccess(true);
          if (context.isResumedFromFdaRelaunch) {
            telemetryRef.current.relaunchResumed();
          } else {
            telemetryRef.current.enabledLater();
          }
          onAction({ type: "PERMISSION_GRANTED" });
        } else if (context.isResumedFromFdaRelaunch) {
          setStillNotDetectedAfterRestart(true);
        }
      } catch (error) {
        logger.error("[PermissionsStep] Mount permission check failed:", error);
      } finally {
        if (!cancelled) mountCheckDoneRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run once on mount (matches the FDA pre-list effect below).
  }, []);

  // Pre-list Keepr in the Full Disk Access pane before the user opens it.
  // triggerFullDiskAccess() reads ~/Library/Messages/chat.db, which makes macOS
  // add Keepr to the FDA list automatically. Doing this on mount means the app is
  // already present (just needs the toggle flipped) by the time System Settings
  // opens -- no "click the + button and find Keepr in Applications" step needed.
  // Best-effort: failure is non-fatal (the button handler retries the trigger).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await window.api.system.triggerFullDiskAccess();
        if (!cancelled) {
          setHasTriggeredFDA(true);
        }
      } catch (error) {
        logger.debug("[PermissionsStep] Pre-list FDA trigger on mount failed (non-fatal):", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-detect permission grants by polling every 2 seconds.
  // Starts after user has triggered FDA (opened System Settings).
  // BACKLOG-1842: this is now a cosmetic hint only — on a hit it flips
  // hasFullDiskAccess via handleFdaGranted; it never starts a sync and never
  // auto-relaunches on its own. macOS caches the FDA deny per-process, so this
  // poll may legitimately never flip in-process; the "Check permissions"
  // button (which relaunches on a successful check) is the deterministic path.
  useEffect(() => {
    if (hasTriggeredFDA && !hasFullDiskAccess) {
      const interval = setInterval(checkPermissions, 2000);
      // Stop polling after 5 minutes to avoid indefinite CPU usage
      const timeout = setTimeout(() => clearInterval(interval), 300000);
      return () => {
        clearInterval(interval);
        clearTimeout(timeout);
      };
    }
  }, [hasTriggeredFDA, hasFullDiskAccess, checkPermissions]);

  const handleOpenSystemSettings = async () => {
    telemetryRef.current.settingsOpened();
    try {
      // Trigger FDA attempt so the app appears in System Settings > Full Disk Access
      if (!hasTriggeredFDA) {
        await window.api.system.triggerFullDiskAccess();
        setHasTriggeredFDA(true);
      }
      await window.api.system.openSystemSettings();
    } catch (error) {
      logger.error("Error opening system settings:", error);
    }
  };

  const handleOpenManualAddDetour = useCallback(() => {
    telemetryRef.current.manualAddOpened();
    setShowManualAddDetour(true);
  }, []);

  const handleBackFromDetour = useCallback(() => {
    setShowManualAddDetour(false);
  }, []);

  // BACKLOG-1842 (v12 redesign): single "Check permissions" button — merges
  // the old separate "Check Permissions" / "Restart Keepr" buttons into one
  // verify-then-auto-relaunch-on-success action (per the approved mock's
  // "Check permissions" note). The running process can't see a fresh grant
  // (macOS caches the FDA decision per-process), so a successful check means
  // the toggle IS on and only a relaunch will make it take effect — there is
  // no reason to make the user click a second button for that.
  //
  // BACKLOG-2173: relaunch is no longer triggered explicitly here —
  // checkPermissions() -> handleFdaGranted() now triggers relaunchForGrant()
  // itself for every in-app detection path (poll included), so this handler
  // only needs to run the check and surface the "not detected" message.
  const handleCheckPermissions = async () => {
    logger.debug('[PermissionsStep] Check permissions button clicked');
    setIsChecking(true);
    setCheckFailed(false);
    try {
      const granted = await checkPermissions();
      telemetryRef.current.checkClicked(granted ? "granted" : "not_granted");
      if (granted) {
        // grantedAtMountRef is false here (the button is only reachable once
        // hasTriggeredFDA is true, i.e. the user engaged the flow this
        // session) — checkPermissions()/handleFdaGranted() already triggered
        // the relaunch. Just clear the checking spinner.
        setIsChecking(false);
        return;
      }
      setCheckFailed(true);
    } catch (error) {
      logger.error('[PermissionsStep] checkPermissions error:', error);
      telemetryRef.current.checkClicked("not_granted");
      setCheckFailed(true);
    }
    setIsChecking(false);
  };

  // BACKLOG-1842 (v12 redesign): the manual-add detour replaces the main
  // screen entirely (ported verbatim from the mock's "Shared" detour) rather
  // than overlaying it — it IS a distinct instructional screen, not a modal.
  if (showManualAddDetour) {
    return (
      <div className="max-w-2xl mx-auto" ref={detourRootRef}>
        <div className="text-center mb-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">
            Quick fix &middot; ~30 seconds
          </p>
          <h1 className="text-xl font-bold text-gray-900 mb-2">
            Add Keepr to the list yourself
          </h1>
        </div>

        <ol className="space-y-5 mb-6 text-sm text-gray-700">
          <li>
            <p className="font-semibold mb-1">
              1. Click the <strong>+</strong> under the Full Disk Access list
            </p>
            <FdaSettingsWindowGraphic keeprEnabled={false} highlightPlus />
          </li>
          <li>
            <p className="font-semibold mb-1">2. Approve with Touch ID or your password</p>
            <p className="text-xs text-gray-500 mb-2">Same prompt as before &mdash; that&rsquo;s macOS confirming it&rsquo;s really you.</p>
            <FdaAuthDialogGraphic showPasswordHint={false} />
          </li>
          <li>
            <p className="font-semibold mb-1">3. Pick Keepr in the window that opens</p>
            <p className="text-xs text-gray-500 mb-2">It&rsquo;s the indigo <strong>K</strong> in your Applications folder.</p>
            <FdaAppPickerGraphic />
          </li>
          <li>
            <p className="font-semibold mb-1">4. That&rsquo;s it &mdash; the toggle turns on by itself</p>
            <p className="text-xs text-gray-500 mb-2">Keepr appears in the list already enabled. Come back and Keepr will restart and continue your setup automatically.</p>
            <FdaSettingsWindowGraphic keeprEnabled />
          </li>
        </ol>

        <button
          type="button"
          onClick={handleBackFromDetour}
          data-testid="onboarding-permissions-detour-back"
          className="w-full bg-indigo-50 text-primary border border-indigo-200 py-2.5 px-6 rounded-lg font-semibold hover:bg-indigo-100 transition-colors"
        >
          &larr; Back &mdash; I&rsquo;ve added it
        </button>
      </div>
    );
  }

  // BACKLOG-1842 (v12 redesign): single screen matching the founder-approved
  // mock (fda-screen-options.html, "Screen 1 — the lean B step"). Title +
  // safety link + 3 numbered steps (with the ported macOS graphics inline)
  // + Open System Settings / Check permissions buttons. Copy below is ported
  // verbatim from the mock — do not paraphrase.
  return (
    <div className="max-w-2xl mx-auto">
      {showSafetySheet && (
        <FdaSafetySheet onLetsGo={handleSafetyLetsGo} onSkip={handleSkipForNow} />
      )}

      {!hasFullDiskAccess ? (
        <div>
          {/* Title */}
          <div className="mb-4">
            <h1 className="text-xl font-extrabold text-gray-900 mb-0.5 tracking-tight">
              One toggle to go
            </h1>
            <p className="text-base font-semibold text-gray-500">
              Enable Full Disk Access
            </p>
            <button
              type="button"
              onClick={handleOpenSafetySheet}
              data-testid="onboarding-permissions-safety-link"
              className="mt-3 text-xs font-semibold text-primary underline underline-offset-2"
            >
              {FDA_SAFETY_LINK_COPY}
            </button>
          </div>

          {/* 3 numbered steps — leading "N." text replaced with the mock's
              filled circle badge (ol.steps li::before: indigo circle, white
              number), sitting to the left of each step's title. */}
          <ol className="space-y-5 mb-6 text-sm text-gray-700">
            <li className="flex gap-3">
              <StepBadge n={1} />
              <div className="flex-1 min-w-0">
                <p className="font-bold text-gray-900 mb-1">Open System Settings</p>
                <p className="text-xs text-gray-500">
                  We&rsquo;ll take you straight to the right pane.
                </p>

                {/* BACKLOG-1842 (visual-polish, founder-directed): the primary
                    "Open System Settings" action moved here, directly under
                    step 1, instead of at the bottom with the other button. */}
                <button
                  onClick={handleOpenSystemSettings}
                  data-testid="onboarding-permissions-open-settings"
                  className="w-full mt-3 bg-primary text-white py-2.5 px-6 rounded-lg font-semibold hover:bg-blue-600 transition-colors flex items-center justify-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Open System Settings
                </button>
              </div>
            </li>
            <li className="flex gap-3">
              <StepBadge n={2} />
              <div className="flex-1 min-w-0">
                <p className="font-bold text-gray-900 mb-1">Flip the Keepr toggle on</p>
                <p className="text-xs text-gray-500 mb-2">It&rsquo;ll look exactly like this:</p>

                {/* BACKLOG-1842 (visual-polish, founder-directed): the "not
                    listed? add manually" link moved here — right after "It'll
                    look exactly like this:" and before the Settings-window
                    graphic, since that's where a user realizes Keepr isn't in
                    their list. */}
                <button
                  type="button"
                  onClick={handleOpenManualAddDetour}
                  data-testid="onboarding-permissions-manual-add-link"
                  className="block text-left text-xs font-semibold text-gray-400 underline underline-offset-2 mb-2"
                >
                  Keepr not in the list? Add it manually &rarr;
                </button>

                <FdaSettingsWindowGraphic keeprEnabled />
              </div>
            </li>
            <li className="flex gap-3">
              <StepBadge n={3} />
              <div className="flex-1 min-w-0">
                <p className="font-bold text-gray-900 mb-1">
                  Approve &mdash; then Keepr restarts automatically
                </p>
                <p className="text-xs text-gray-500 mb-2">
                  macOS will ask you to confirm with Touch ID or your password
                  &mdash; this exact prompt. Approve it; Keepr quits and reopens
                  right back here.
                </p>
                <FdaAuthDialogGraphic />
              </div>
            </li>
          </ol>

          {/* BACKLOG-1842 (resume-at-step fix round): explicit "still can't
              detect it" feedback — shown after the user returns from a
              relaunch and FDA is STILL not granted, instead of silently
              looping the same instructions with no acknowledgment. */}
          {stillNotDetectedAfterRestart && (
            <div
              className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3"
              data-testid="onboarding-permissions-still-not-detected"
            >
              <div className="flex items-start">
                <svg
                  className="w-5 h-5 text-red-600 mr-2 flex-shrink-0 mt-0.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <div className="text-sm text-red-800">
                  <p className="font-semibold">We still can&rsquo;t detect Full Disk Access.</p>
                  <p className="text-xs mt-1">
                    Double-check in System Settings &rsaquo; Privacy &amp; Security &rsaquo; Full Disk Access that{" "}
                    <strong>Keepr</strong> is listed and its toggle is <strong>on</strong>. It must be granted for
                    THIS copy of Keepr &mdash; if you have more than one Keepr build installed, the wrong one being
                    listed will not work. If Keepr isn&rsquo;t in the list at all, use the <strong>+</strong> button
                    to add it, then try again.
                  </p>
                </div>
              </div>
            </div>
          )}

          {checkFailed && (
            <p className="text-center text-xs text-red-600 font-medium mb-3">
              Permission not detected. Please follow the steps above and try again.
            </p>
          )}

          {/* BACKLOG-1842 (v12 redesign): single "Check permissions" button —
              verifies the grant and, on success, auto-relaunches. Shown once
              the user has engaged the FDA flow (opened System Settings).
              BACKLOG-1842 (visual-polish, founder-directed): stays here at
              the bottom — only the "Open System Settings" button moved up
              under step 1. */}
          {hasTriggeredFDA && (
            <button
              onClick={handleCheckPermissions}
              disabled={isChecking || isRelaunching}
              data-testid="onboarding-permissions-check"
              className="w-full mt-2.5 border border-gray-200 bg-white text-gray-500 py-2.5 px-6 rounded-lg text-sm font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {isRelaunching ? "Restarting..." : isChecking ? "Checking..." : "✓ Check permissions"}
            </button>
          )}
        </div>
      ) : (
        /* Permission granted state (BACKLOG-2173: founder-directed — dropped
           the green card background/border; keep just the checkmark + text). */
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-green-500 rounded-full mb-3">
            <CheckIcon className="w-6 h-6 text-white" />
          </div>
          <h3 className="text-lg font-bold text-gray-900 mb-2">
            Permission Granted
          </h3>
          <p className="text-sm text-gray-700">
            Full Disk Access is enabled. Finishing setup...
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * PermissionsStep definition
 */
const permissionsStep: OnboardingStep = {
  meta: {
    id: "permissions",
    progressLabel: "Permissions",
    platforms: ["macos"],
    navigation: {
      showBack: true,
      hideContinue: false,
    },
    // Disable Continue button - step auto-proceeds after FDA is granted
    canProceed: () => false,
    // Step is never "complete" via button - it auto-proceeds via PERMISSION_GRANTED action
    isStepComplete: () => false,
    // Only show if permissions not yet granted (or unknown during loading).
    // Using !== true means: show if false OR undefined (unknown state).
    // BACKLOG-1842: this is the resume-skip contract — after the FDA-grant
    // relaunch, startup checkPermissions() reports granted, permissionsGranted
    // becomes true, and this step is skipped so onboarding/sync resume cleanly.
    shouldShow: (context) => context.permissionsGranted !== true,
    // Queue predicates
    isApplicable: () => true, // Platform filtering via flow array (macOS only)
    isComplete: (context) => context.permissionsGranted === true,
  },
  Content,
};

export default permissionsStep;
