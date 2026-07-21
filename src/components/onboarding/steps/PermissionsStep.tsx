/**
 * PermissionsStep - macOS Full Disk Access permissions screen
 *
 * Single-screen checklist layout that guides macOS users through granting
 * Full Disk Access permission. Shows permission status with auto-detection
 * and provides a button to open System Settings directly.
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
 *   2. WARN them that granting FDA will restart Keepr (set expectation).
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

/**
 * Shield icon with lock - represents security/permissions
 */
function ShieldLockIcon({ className }: { className?: string }) {
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
        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
      />
    </svg>
  );
}

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
 * Checklist item for a single permission requirement
 */
interface ChecklistItemProps {
  label: string;
  description: string;
  isGranted: boolean;
}

function ChecklistItem({ label, description, isGranted }: ChecklistItemProps) {
  return (
    <div className="flex items-center gap-3">
      {isGranted ? (
        <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center flex-shrink-0">
          <CheckIcon className="w-4 h-4 text-white" />
        </div>
      ) : (
        <div className="w-2 h-2 rounded-full bg-gray-400 flex-shrink-0 ml-2" />
      )}
      <div>
        <p className={`text-sm font-medium ${isGranted ? "text-green-800" : "text-gray-900"}`}>
          {label}
        </p>
        <p className={`text-xs ${isGranted ? "text-green-600" : "text-gray-500"}`}>
          {description}
        </p>
      </div>
    </div>
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
  // System Settings, clicked "Restart Keepr") before the relaunch, so the
  // "Restart Keepr" button must be available immediately on return rather
  // than requiring them to click "Open System Settings" again first.
  const [hasTriggeredFDA, setHasTriggeredFDA] = useState(
    () => context.isResumedFromFdaRelaunch
  );
  // BACKLOG-1842: true while the clean relaunch is in flight (button disabled,
  // "Restarting..." shown). In packaged builds the process exits before this
  // matters; it guards the E2E/dev fallthrough and double-clicks.
  const [isRelaunching, setIsRelaunching] = useState(false);

  // BACKLOG-1842: whether FDA was ALREADY granted when this step first mounted
  // (returning user, dev/E2E, or a stale-cache read). If so, the current
  // process already has working FDA — we must NOT relaunch (that would loop);
  // we just advance. We only relaunch when the grant appears AFTER the user
  // engaged the FDA flow this session (opened System Settings to flip it).
  const grantedAtMountRef = useRef(false);
  const mountCheckDoneRef = useRef(false);

  /**
   * BACKLOG-1842 (resume-at-step fix round): true once the user has clicked
   * "Restart Keepr" and RETURNED to this step with FDA still not detected —
   * either because the relaunch was suppressed (E2E/dev) or because the grant
   * genuinely didn't take (wrong copy of Keepr, toggle not actually flipped,
   * etc.). Shows the explicit "we still can't detect it" message instead of
   * silently looping the same instructions.
   */
  const [stillNotDetectedAfterRestart, setStillNotDetectedAfterRestart] = useState(false);

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
   */
  const relaunchForGrant = useCallback(async () => {
    if (isRelaunching) return;
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
      setIsRelaunching(false);
    }
  }, [isRelaunching, context.userId, hasFullDiskAccess]);

  /**
   * BACKLOG-1842: Handle the moment FDA is detected as granted.
   * - If it was already granted at mount → the current process has working FDA,
   *   so just advance onboarding (no restart, no loop).
   * - If the grant appeared after the user engaged the flow this session →
   *   the running process still can't read chat.db (cached deny), so relaunch.
   */
  const handleFdaGranted = useCallback(() => {
    setHasFullDiskAccess(true);
    setStillNotDetectedAfterRestart(false);
    if (grantedAtMountRef.current) {
      onAction({ type: "PERMISSION_GRANTED" });
    }
    // Otherwise: leave the "Restart Keepr" affordance for the user. We do NOT
    // auto-relaunch on a poll hit — the in-process check is unreliable and a
    // user-initiated restart is deterministic. See mount effect + button.
  }, [onAction]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // BACKLOG-1842: this is now a cosmetic hint only — on a hit it reveals the
  // restart affordance via handleFdaGranted; it never starts a sync and never
  // auto-relaunches. macOS caches the FDA deny per-process, so this poll may
  // legitimately never flip in-process; the "Restart Keepr" button is the
  // deterministic path.
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

  const handleManualCheck = async () => {
    logger.debug('[PermissionsStep] Check Permissions button clicked');
    setIsChecking(true);
    setCheckFailed(false);
    try {
      const granted = await checkPermissions();
      if (!granted) {
        setCheckFailed(true);
      }
    } catch (error) {
      logger.error('[PermissionsStep] checkPermissions error:', error);
      setCheckFailed(true);
    }
    setIsChecking(false);
  };

  // BACKLOG-1842: user-initiated clean relaunch. This is the deterministic way
  // to make the newly granted FDA take effect (the running process can't read
  // chat.db until it relaunches). Sync runs in the fresh process, not here.
  const handleRestart = async () => {
    await relaunchForGrant();
  };

  // Single-screen checklist layout
  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center mb-5">
        <div className="inline-flex items-center justify-center w-14 h-14 bg-primary/10 rounded-full mb-4">
          <ShieldLockIcon className="w-7 h-7 text-primary" />
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">
          Permissions Required
        </h1>
        <p className="text-sm text-gray-600">
          Keepr needs the following macOS permission to work properly.
          Grant it in System Settings, then come back here.
        </p>
      </div>

      {/* Privacy note */}
      <div className="mb-5 bg-blue-50 border border-blue-200 rounded-lg p-3">
        <div className="flex items-start">
          <svg
            className="w-5 h-5 text-blue-600 mr-2 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="text-sm text-blue-800">
            <strong>Your privacy matters.</strong> All data stays on your
            device. We never upload or share your messages.
          </p>
        </div>
      </div>

      {/* Permission Checklist */}
      <div className="space-y-3 mb-5">
        <ChecklistItem
          label="Full Disk Access"
          description={
            hasFullDiskAccess
              ? "Granted -- Keepr can read your Messages database"
              : "Required to read your iMessage database for auditing"
          }
          isGranted={hasFullDiskAccess}
        />
      </div>

      {/* Action Area */}
      {!hasFullDiskAccess ? (
        <div className="space-y-3">
          {/* BACKLOG-1842: Restart expectation warning — set the expectation
              BEFORE the user flips the toggle so the relaunch isn't a surprise. */}
          <div
            className="bg-amber-50 border border-amber-200 rounded-lg p-3"
            data-testid="onboarding-permissions-restart-warning"
          >
            <div className="flex items-start">
              <svg
                className="w-5 h-5 text-amber-600 mr-2 flex-shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.74-3l-6.93-12a2 2 0 00-3.48 0l-6.93 12a2 2 0 001.74 3z"
                />
              </svg>
              <p className="text-sm text-amber-800">
                <strong>Keepr will restart to finish setup.</strong> Turning on
                Full Disk Access requires a quick restart before Keepr can read
                your Messages. That&rsquo;s expected &mdash; your setup resumes
                automatically right after.
              </p>
            </div>
          </div>

          {/* Info box */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <div className="flex items-start">
              <svg
                className="w-5 h-5 text-blue-600 mr-2 flex-shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <div className="text-sm text-blue-800">
                <p className="font-semibold mb-1">How to grant permission:</p>
                <ol className="list-decimal list-inside space-y-1 text-xs">
                  <li>Click &ldquo;Open System Settings&rdquo; below</li>
                  <li>
                    Find <strong>Keepr</strong> in the <strong>Full Disk Access</strong> list and switch its toggle <strong>on</strong>.
                    {" "}
                    <span className="italic">
                      Don&rsquo;t see Keepr listed? Click the <strong>+</strong> button (or drag the Keepr app in) to add it manually
                      &mdash; make sure you add THIS copy of Keepr, the one you&rsquo;re running now.
                    </span>
                  </li>
                  <li>Come back here and click <strong>Restart Keepr</strong> to finish setup (if macOS shows &ldquo;Quit &amp; Reopen,&rdquo; either choice is fine &mdash; Keepr resumes where you left off)</li>
                </ol>
                <p className="text-xs text-blue-700 mt-1 ml-4 italic">If System Settings opens to the main page, click <strong>Privacy &amp; Security</strong> in the left sidebar, then scroll down and click <strong>Full Disk Access</strong>.</p>
              </div>
            </div>
          </div>

          {/* BACKLOG-1842 (resume-at-step fix round): explicit "still can't
              detect it" feedback — shown after the user returns from "I've
              enabled it" / a relaunch and FDA is STILL not granted, instead of
              silently looping the same instructions with no acknowledgment. */}
          {stillNotDetectedAfterRestart && (
            <div
              className="bg-red-50 border border-red-200 rounded-lg p-3"
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

          {/* Primary action button */}
          <button
            onClick={handleOpenSystemSettings}
            data-testid="onboarding-permissions-open-settings"
            className="w-full bg-primary text-white py-2.5 px-6 rounded-lg font-semibold hover:bg-blue-600 transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Open System Settings
          </button>

          {/* BACKLOG-1842: Restart Keepr — the deterministic path to make the
              newly enabled FDA take effect. Shown once the user has engaged the
              FDA flow (opened System Settings). */}
          {hasTriggeredFDA && (
            <button
              onClick={handleRestart}
              disabled={isRelaunching}
              data-testid="onboarding-permissions-restart"
              className="w-full bg-primary text-white py-2.5 px-6 rounded-lg font-semibold hover:bg-blue-600 transition-colors disabled:opacity-50"
            >
              {isRelaunching ? "Restarting..." : "I've enabled it -- Restart Keepr"}
            </button>
          )}

          {/* Manual check button */}
          <button
            onClick={handleManualCheck}
            disabled={isChecking}
            data-testid="onboarding-permissions-check"
            className="w-full bg-gray-100 text-gray-700 py-2 px-4 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {isChecking ? "Checking..." : "Check Permissions"}
          </button>

          {checkFailed && (
            <p className="text-center text-xs text-red-600 font-medium">
              Permission not detected. Please follow the steps above and try again.
            </p>
          )}

          {hasTriggeredFDA && !checkFailed && (
            <p className="text-center text-xs text-gray-500">
              We are checking for permission changes automatically.
            </p>
          )}
        </div>
      ) : (
        /* Permission granted state */
        <div className="bg-green-50 border-2 border-green-300 rounded-lg p-4 text-center">
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
