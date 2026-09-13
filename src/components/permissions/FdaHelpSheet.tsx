/**
 * FdaHelpSheet — the ONE Full Disk Access explainer, for every dead-end
 * outside onboarding (BACKLOG-3210 part 2).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Until BACKLOG-3208 nothing outside onboarding mentioned Full Disk Access at
 * all. 3208 added a notice to Settings → Messages, and its button opened the
 * raw macOS Privacy pane — a window with a list of apps, no explanation of what
 * Keepr wants or why, and no way back. BACKLOG-3219 makes the dashboard health
 * banner reachable for the same population, which would have produced a second
 * button into that same bare pane.
 *
 * So "Show me how" opens the instructions the app already has: the numbered
 * steps with the ported macOS graphics that are the last screen of onboarding,
 * rendered here WITHOUT the onboarding queue's own chrome (its Continue / Back
 * buttons live outside the card and belong to the queue).
 *
 * ---------------------------------------------------------------------------
 * ONE DEFINITION, NOT A COPY
 * ---------------------------------------------------------------------------
 * The steps come from `FdaInstructionSteps`, which `PermissionsStep` also
 * renders. That is the whole point of the extraction: two copies would teach
 * users different things the first time either was edited, and no test in this
 * repo would notice. The control is exactly that — mutate `FdaInstructionSteps`
 * once and BOTH consumers' suites go red.
 *
 * ---------------------------------------------------------------------------
 * EVERY AFFORDANCE OF THE ONBOARDING SCREEN IS HERE
 * ---------------------------------------------------------------------------
 * Open System Settings · the safety link · "add it manually" and its return leg
 * · Check permissions. What differs is what two of them MEAN outside the queue,
 * and both differences are deliberate:
 *
 *   - **Skip, on the safety sheet, is the EXIT.** In onboarding it advances the
 *     queue past the step. There is no queue here, so it closes the explainer —
 *     it remains the way out for a user who cannot make the permission work,
 *     which is the reason the link is kept at all. It does NOT write the
 *     onboarding `fdaSkipped` preference: that flag exists so onboarding stops
 *     asking, and a user who opened this from Settings has already finished
 *     onboarding. Writing it from here would record a decision she did not make.
 *
 *   - **Check permissions does not relaunch.** Onboarding relaunches on a
 *     successful check because macOS caches the Full Disk Access decision per
 *     process and the fresh grant cannot take effect otherwise. Settings is
 *     somewhere the user is in the middle of something else; an app that quit
 *     itself out from under them there would be a worse bug than the one this
 *     fixes — BACKLOG-3208 settled that, and its user-initiated restart notice
 *     is the right place for it. Here a successful check closes the explainer
 *     and tells the host surface to re-check itself.
 *
 * @module components/permissions/FdaHelpSheet
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ResponsiveModal } from "../common/ResponsiveModal";
import { FdaSafetySheet } from "../onboarding/steps/FdaSafetySheet";
import { FDA_SAFETY_LINK_COPY } from "../onboarding/steps/fdaTelemetry";
import { FdaInstructionSteps, FdaManualAddSteps } from "./FdaInstructionSteps";
import { systemService } from "../../services";
import logger from "../../utils/logger";

export interface FdaHelpSheetProps {
  /** Close the explainer. Fired by "Not now", by Skip, and by a backdrop click. */
  onClose: () => void;
  /**
   * Optional work after the macOS pane has been asked to open — e.g. Settings
   * re-checks its own status. The sheet stays open either way: the user needs
   * it to still be there when they come back from System Settings.
   */
  onOpenedSettings?: () => void | Promise<void>;
  /**
   * Optional work when this sheet observes the permission has been GRANTED.
   *
   * The sheet closes itself; this is how the surface that opened it clears too
   * — the Settings notice and the dashboard banner each re-check their own
   * state rather than being told what to render. Both of those already re-check
   * on their own (window focus, and a 2-minute health poll), so this is a
   * promptness fix, not the only path.
   */
  onPermissionGranted?: () => void | Promise<void>;
  /** data-testid for the modal overlay. Defaults to `fda-help-sheet`. */
  testId?: string;
}

/**
 * The restart sentence, for surfaces where nothing restarts on its own.
 *
 * Onboarding relaunches the app itself the moment it detects the grant
 * (`PermissionsStep.relaunchForGrant`). macOS decides an app's Full Disk Access
 * at process start and does not revisit it, so from Settings or the dashboard
 * the running process stays denied until the user restarts it — which is why
 * BACKLOG-3208 put a "restart Keepr to finish" notice in the Messages panel,
 * one inch below where this sheet opens. Carrying onboarding's promise here
 * would contradict the panel behind it.
 */
const RESTART_COPY_OUTSIDE_ONBOARDING = (
  <>
    macOS will ask you to confirm with Touch ID or your password &mdash; this
    exact prompt. Approve it, then restart Keepr so the new access takes effect.
    Nothing is lost.
  </>
);

/** The same correction, for the manual-add detour's closing step. */
const RETURN_COPY_OUTSIDE_ONBOARDING = (
  <>
    Keepr appears in the list already enabled. Come back and restart Keepr so
    the new access takes effect.
  </>
);

type HelpView = "steps" | "manual-add" | "safety";

export function FdaHelpSheet({
  onClose,
  onOpenedSettings,
  onPermissionGranted,
  testId = "fda-help-sheet",
}: FdaHelpSheetProps): React.ReactElement {
  const [view, setView] = useState<HelpView>("steps");
  const [isChecking, setIsChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  /** Guards the focus listener against a close firing twice. */
  const grantedRef = useRef(false);

  /**
   * Ask whether the permission is now held.
   *
   * `checkMessagesPermission` is THREE-state on purpose (BACKLOG-3208):
   * `true`, `false`, and `undefined` for "the check did not answer". Only
   * `true` is treated as granted. An unanswered check is NOT a denial and is
   * NOT a grant — the sheet stays exactly as it is, because guessing either way
   * would either strand a user who is done or tell one who is not that she is.
   */
  const readPermission = useCallback(async (): Promise<boolean | undefined> => {
    const result = await systemService.checkMessagesPermission();
    if (!result.success || result.data?.hasPermission === undefined) {
      logger.warn(
        "[FdaHelpSheet] Full Disk Access check did not answer:",
        result.error
      );
      return undefined;
    }
    return result.data.hasPermission;
  }, []);

  const settle = useCallback(async () => {
    if (grantedRef.current) return;
    grantedRef.current = true;
    if (onPermissionGranted) {
      await onPermissionGranted();
    }
    onClose();
  }, [onPermissionGranted, onClose]);

  const handleOpenSystemSettings = useCallback(async () => {
    const result = await systemService.openFullDiskAccessSettings();
    if (!result.success) {
      // Non-fatal: the sheet stays open and the user can try again or follow
      // the written instructions. Reporting a failure we cannot act on would
      // be worse than taking the explanation off the screen.
      logger.error(
        "[FdaHelpSheet] Failed to open the Full Disk Access pane:",
        result.error
      );
    }
    if (onOpenedSettings) {
      await onOpenedSettings();
    }
  }, [onOpenedSettings]);

  /**
   * "Check permissions" — the explicit ask.
   *
   * Granted closes the sheet and lets the host clear. Denied says so, in
   * onboarding's words. An unanswered check is reported as not-detected here
   * and NOT on the focus path below: the user asked, so silence would be worse
   * than an honest "we could not see it".
   */
  const handleCheckPermissions = useCallback(async () => {
    setIsChecking(true);
    setCheckFailed(false);
    try {
      if ((await readPermission()) === true) {
        await settle();
        return;
      }
      setCheckFailed(true);
    } catch (error) {
      logger.error("[FdaHelpSheet] checkPermissions failed:", error);
      setCheckFailed(true);
    } finally {
      setIsChecking(false);
    }
  }, [readPermission, settle]);

  /**
   * Granting the permission means leaving Keepr for System Settings, so the
   * moment the user comes back is exactly when the answer may have changed.
   * Same mechanism the Messages panel already uses for its own re-check.
   *
   * Silent on both non-grant outcomes: a user who wandered away and came back
   * has not asked anything, so a "not detected" message here would accuse her
   * of failing at something she did not attempt.
   */
  useEffect(() => {
    const handleFocus = () => {
      void (async () => {
        try {
          if ((await readPermission()) === true) {
            await settle();
          }
        } catch (error) {
          logger.warn("[FdaHelpSheet] focus re-check failed:", error);
        }
      })();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [readPermission, settle]);

  const backToSteps = useCallback(() => setView("steps"), []);

  // The safety sheet brings its own modal, so it REPLACES this one rather than
  // stacking on it.
  if (view === "safety") {
    return (
      <FdaSafetySheet
        testId="fda-help-safety"
        // "Let's go" returns to the instructions, the same "close this and
        // carry on" it means in onboarding.
        onLetsGo={backToSteps}
        primaryLabel="Back to the steps"
        // Skip keeps its name and its job: it is the way OUT for someone who
        // cannot make the permission work. Outside the onboarding queue there
        // is no step to advance past, so it closes the explainer — and it does
        // NOT write the onboarding `fdaSkipped` preference, which exists to
        // stop onboarding asking and would be recording a decision this user
        // never made.
        onSkip={onClose}
        onClose={backToSteps}
        footer={
          <>
            Skipping only pauses text-message capture.
            <br />
            Your email records keep building.
            <br />
            Turn it on any time in Settings &rarr; Messages.
          </>
        }
      />
    );
  }

  const isManualAdd = view === "manual-add";

  return (
    <ResponsiveModal
      testId={testId}
      onClose={onClose}
      overlayClassName="bg-black bg-opacity-50"
      // Matches FdaSafetySheet's sizing chain: at `sm:` and up the card hugs
      // its content instead of stretching to the viewport, stays scrollable
      // when tall, and keeps the full-screen sheet presentation on mobile.
      panelClassName="max-w-lg sm:h-auto sm:max-h-[90vh] p-6 justify-start overflow-y-auto"
    >
      <p className="text-[10.5px] font-bold uppercase tracking-wider text-gray-400 mb-1">
        Full Disk Access
      </p>
      <h2 className="text-lg font-extrabold text-gray-900 mb-1 leading-tight">
        {isManualAdd ? "Manually add Keepr." : "One toggle to go"}
      </h2>

      {isManualAdd ? (
        <>
          <p className="text-sm text-gray-500 mb-4">
            Keepr isn&rsquo;t in your Full Disk Access list yet. Here&rsquo;s
            how to add it.
          </p>
          <FdaManualAddSteps returnCopy={RETURN_COPY_OUTSIDE_ONBOARDING} />
          {/* The detour's return leg. Not onboarding navigation — without it
              the detour is a dead-end, which is the shape this whole item
              exists to remove. */}
          <button
            type="button"
            onClick={backToSteps}
            data-testid="fda-help-manual-add-back"
            className="w-full bg-indigo-50 text-primary border border-indigo-200 py-2.5 px-6 rounded-lg font-semibold hover:bg-indigo-100 transition-colors"
          >
            &larr; Back &mdash; I&rsquo;ve added it
          </button>
        </>
      ) : (
        <>
          <p className="text-base font-semibold text-gray-500">
            Keepr needs it to read your Messages
          </p>
          <button
            type="button"
            onClick={() => setView("safety")}
            data-testid="fda-help-safety-link"
            className="mt-3 mb-4 block text-left text-xs font-semibold text-primary underline underline-offset-2"
          >
            {FDA_SAFETY_LINK_COPY}
          </button>

          <FdaInstructionSteps
            onOpenSystemSettings={() => {
              void handleOpenSystemSettings();
            }}
            onAddManually={() => setView("manual-add")}
            restartCopy={RESTART_COPY_OUTSIDE_ONBOARDING}
          />

          {checkFailed && (
            <p
              className="text-center text-xs text-red-600 font-medium mb-3"
              data-testid="fda-help-check-failed"
            >
              Permission not detected. Please follow the steps above and try
              again.
            </p>
          )}

          <button
            type="button"
            onClick={() => {
              void handleCheckPermissions();
            }}
            disabled={isChecking}
            data-testid="fda-help-check"
            className="w-full border border-gray-200 bg-white text-gray-500 py-2.5 px-6 rounded-lg text-sm font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50 mb-2"
          >
            {isChecking ? "Checking..." : "✓ Check permissions"}
          </button>

          <button
            type="button"
            onClick={onClose}
            data-testid="fda-help-not-now"
            className="w-full bg-gray-100 text-gray-700 py-2.5 px-6 rounded-lg font-semibold hover:bg-gray-200 transition-colors"
          >
            Not now
          </button>
        </>
      )}
    </ResponsiveModal>
  );
}

export default FdaHelpSheet;
