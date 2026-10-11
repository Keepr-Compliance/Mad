import React, { useEffect, useRef } from "react";
import { useIPhoneSyncContext } from "../../contexts/IPhoneSyncContext";
import { ConnectionStatus } from "./ConnectionStatus";
import { SyncProgress } from "./SyncProgress";
import { SyncLockBanner } from "../sync/SyncLockBanner";
import logger from "../../utils/logger";
import { isWindowsArm64 } from "../../utils/platform";
import { SyncStepChangeLog } from "../../utils/syncStepLog";

interface IPhoneSyncFlowProps {
  /**
   * Callback when the user dismisses the flow — Continue on success, Close on
   * error, and the modal's own minimize button.
   *
   * BACKLOG-3416: there is deliberately no "sync started" callback beside it.
   * TASK-2116 added one that auto-minimised the modal the moment the phase
   * reached `backing_up`, and it fired on a signal that says nothing about
   * whether the user has finished with the phone: `backing_up` is reached while
   * the iPhone may still be locked, still showing "Trust This Computer", or
   * still asking for a passcode. The modal hid those instructions while the user
   * was reading them. The app blocks other actions during a sync anyway, so
   * auto-minimising bought nothing. The manual minimize button is the only way
   * out now, and it stays the user's decision.
   */
  onClose?: () => void;
}

/**
 * IPhoneSyncFlow Container Component
 *
 * Orchestrates the complete iPhone sync flow:
 * 1. Device connection status
 * 2. Sync initiation
 * 3. Progress tracking
 * 4. Apple-encrypted backups: the turn-it-off steps (BACKLOG-3881; Keepr takes no password)
 * 5. Success/Error states
 *
 * This component ties together the useIPhoneSync hook with
 * the individual UI components for a complete user experience.
 */
export const IPhoneSyncFlow: React.FC<IPhoneSyncFlowProps> = ({ onClose }) => {
  const {
    isConnected,
    device,
    syncStatus,
    progress,
    error,
    appleEncryptedBackup,
    lastSyncTime,
    isWaitingForPasscode,
    syncLocked,
    lockReason,
    // BACKLOG-1919: Apple-driver recovery state + action
    driverMissing,
    installDriverStatus,
    installDriverError,
    recoverInstallDriver,
    startSync,
    cancelSync,
    dismissSync,
    checkSyncStatus,
  } = useIPhoneSyncContext();

  // Determine if we're actively syncing
  const isSyncing = syncStatus === "syncing";
  const isComplete = syncStatus === "complete";
  const isError = syncStatus === "error";

  // BACKLOG-2333: Single source of truth for which primary view renders. A
  // switch-style resolution with a `connection` DEFAULT makes the render
  // provably total — no (syncStatus, progress, syncLocked) combination can fall
  // through to a blank container (the blank-white-on-reopen regression). Exactly
  // one primary view is chosen. Order = precedence, matching the prior top-to-bottom JSX (progress
  // before success), which also removes a latent complete+syncLocked+progress
  // double-render. Cancel now resets to "idle", so it resolves to `connection`.
  // BACKLOG-3881: an Apple-encrypted backup is its own view (the turn-it-off steps),
  // never the generic "Sync Failed" and never a password box.
  const view: "lockBanner" | "progress" | "success" | "appleEncrypted" | "error" | "connection" =
    (syncLocked && !isSyncing && !progress) ? "lockBanner" :
    ((isSyncing || (syncLocked && progress)) && !isError) ? "progress" :
    (isComplete && progress) ? "success" :
    (isError && appleEncryptedBackup) ? "appleEncrypted" :
    isError ? "error" :
    "connection";

  useEffect(() => {
    logger.info("[IPhoneSyncFlow] Mounted");
    return () => logger.info("[IPhoneSyncFlow] Unmounted");
  }, []);

  // BACKLOG-2898: TWO lines, deliberately separate.
  //
  // The per-frame notice stays, but at DEBUG. The main process pins the file
  // transport at "info" (electron/config/logFileConfig.ts), so debug never
  // reaches main.log while still being available in the dev console. Before
  // this change it was `info`, and the founder's 21-minute log held 2,824
  // byte-identical copies of it — 80.7% of the file — which rotated the
  // evidence of the sync away at the 1 MB default.
  //
  // The step line is the signal: it is emitted only when the user-visible step
  // CHANGES, and it carries the phase and the message the user is reading.
  // The `view` logged is the SAME one that drives the JSX below, so the log
  // can never drift from what actually renders.
  const stepLog = useRef(new SyncStepChangeLog());
  useEffect(() => {
    logger.debug(`[IPhoneSyncFlow] Rendering: ${view}`, { syncStatus, syncLocked, hasProgress: !!progress, isConnected, appleEncryptedBackup });

    const stepLine = stepLog.current.next({
      view,
      phase: progress?.phase ?? null,
      message: progress?.message ?? null,
      detail: { syncStatus, syncLocked, isConnected, appleEncryptedBackup },
    });
    if (stepLine) {
      logger.info(`[IPhoneSyncFlow] ${stepLine}`);
    }
  }, [view, syncStatus, syncLocked, progress, isConnected, appleEncryptedBackup]);

  // BACKLOG-3416: TASK-2116's auto-close effect lived here and was removed with
  // the `onSyncStarted` prop it fired. See the prop doc above for why. Nothing
  // dismisses this flow on its own any more — only the user does.

  return (
    <div className="iphone-sync-flow">
      {/* TASK-910: Sync Lock Banner - Shown when a non-iPhone sync is blocking.
          If the lock IS the iPhone sync (we have progress), show progress instead. */}
      {view === "lockBanner" && (
        <SyncLockBanner
          operationName={lockReason || "Another sync operation"}
          onRetry={checkSyncStatus}
        />
      )}

      {/* Connection Status - the clean start screen. BACKLOG-2333: this is the
          `view` DEFAULT, so it also renders for any otherwise-unmatched state
          (e.g. a stale idle+progress carried over on reopen) instead of a blank
          screen, and after a cancel (which now resets to "idle"). */}
      {view === "connection" && (
        <ConnectionStatus
          isConnected={isConnected}
          device={device}
          onSyncClick={startSync}
          lastSyncTime={lastSyncTime}
          driverMissing={driverMissing}
          onInstallDriver={recoverInstallDriver}
          isInstallingDriver={installDriverStatus === "installing"}
          driverInstallError={installDriverError}
          isWindowsArm64={isWindowsArm64()}
        />
      )}

      {/* Sync Progress - Shown during active sync OR when reopening modal during sync
          (syncLocked may be true but we have progress from the shared context) */}
      {view === "progress" && (
        <SyncProgress
          progress={progress || { phase: "backing_up", percent: 0, message: "Starting sync..." }}
          // BACKLOG-2333: Cancel resets to the clean idle start screen (no
          // separate "Sync Cancelled" screen). The modal stays open on the
          // ConnectionStatus view, as if freshly opened.
          onCancel={() => { logger.info("[IPhoneSyncFlow] Cancel clicked"); void cancelSync("progress-cancel"); }}
          isWaitingForPasscode={isWaitingForPasscode}
        />
      )}

      {/* Success State */}
      {view === "success" && (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mb-4">
            <svg
              className="w-8 h-8 text-green-500"
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
          </div>
          <h3 className="text-xl font-semibold text-gray-800">Sync Complete!</h3>
          {progress?.message && (
            <p className="text-gray-500 mt-2">{progress.message}</p>
          )}

          {/* TASK-1796: iCloud attachment limitation info */}
          <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg text-left max-w-sm">
            <div className="flex items-start gap-2">
              <svg
                className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5"
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
              <div>
                <p className="text-sm font-medium text-blue-800">About iPhone Attachments</p>
                <p className="text-xs text-blue-700 mt-1">
                  Photos and videos stored in iCloud are not included in local backups.
                  To include more attachments, disable iCloud Photos on your iPhone,
                  wait for media to download, then sync again.
                </p>
              </div>
            </div>
          </div>

          <button
            onClick={() => { logger.info("[IPhoneSyncFlow] Continue (success) clicked"); dismissSync(); onClose?.(); }}
            className="mt-6 px-6 py-3 bg-gradient-to-r from-purple-500 to-indigo-600 text-white font-medium rounded-lg hover:from-purple-600 hover:to-indigo-700 transition-all shadow-md hover:shadow-lg"
          >
            Continue
          </button>
        </div>
      )}

      {/* BACKLOG-3881: Apple-encrypted backups are not supported. The steps to turn
          "Encrypt local backup" off, then Sync again. No password is asked for. */}
      {view === "appleEncrypted" && (
        <div className="flex flex-col items-center justify-center p-8 text-center" data-testid="apple-encrypted-backup">
          <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mb-4">
            <svg
              className="w-8 h-8 text-amber-600"
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
          </div>
          <h3 className="text-xl font-semibold text-gray-800">Your iPhone backups are password-protected by Apple</h3>
          <p className="text-gray-600 mt-2 max-w-sm">Keepr can&apos;t read password-protected backups.</p>
          <div className="mt-4 max-w-sm text-left">
            <p className="text-sm font-medium text-gray-800">To continue:</p>
            <ol className="list-decimal list-inside text-sm text-gray-700 mt-1 space-y-1">
              <li>Open Finder (Mac) or Apple Devices (Windows) and select your iPhone.</li>
              <li>Untick <span className="font-medium">Encrypt local backup</span> and enter that password when asked.</li>
              <li>Come back and press Sync again.</li>
            </ol>
          </div>
          <p className="text-xs text-gray-500 mt-4 max-w-sm">
            Your data stays protected: Keepr encrypts its own copy of your messages.
          </p>
          <div className="flex gap-3 mt-6">
            <button
              onClick={() => { logger.info("[IPhoneSyncFlow] Apple-encrypted Close clicked"); void cancelSync("error-close"); onClose?.(); }}
              className="px-6 py-3 bg-gray-100 text-gray-700 font-medium rounded-lg hover:bg-gray-200 transition-colors"
            >
              Close
            </button>
            <button
              onClick={() => {
                logger.info("[IPhoneSyncFlow] Apple-encrypted Sync again clicked");
                if (isConnected) {
                  startSync();
                } else {
                  void cancelSync("try-again-no-device");
                }
              }}
              className="px-6 py-3 bg-gradient-to-r from-purple-500 to-indigo-600 text-white font-medium rounded-lg hover:from-purple-600 hover:to-indigo-700 transition-all"
            >
              Sync Again
            </button>
          </div>
        </div>
      )}

      {/* Error State */}
      {view === "error" && (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mb-4">
            <svg
              className="w-8 h-8 text-red-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </div>
          <h3 className="text-xl font-semibold text-gray-800">Sync Failed</h3>
          {error && (
            <p className="text-red-500 mt-2 max-w-sm">{error}</p>
          )}
          <div className="flex gap-3 mt-6">
            <button
              onClick={() => { logger.info("[IPhoneSyncFlow] Error Close clicked"); void cancelSync("error-close"); onClose?.(); }}
              className="px-6 py-3 bg-gray-100 text-gray-700 font-medium rounded-lg hover:bg-gray-200 transition-colors"
            >
              Close
            </button>
            {/* BACKLOG-3463: Try Again is ALWAYS rendered. It used to be wrapped
                in `{isConnected && …}`, and on a cable pull the error frame
                renders first with isConnected still true, then the detector's
                device-disconnected lands ~1.8 s later and the button
                disappeared out from under the user (dev log 2026-09-19
                20:40:18.500 → 20:40:20.263).

                With no phone present, retrying the sync is not the useful
                action and would be a dead end anyway: startSync() returns
                early on `!device` and only swaps the red text
                (useIPhoneSync.ts:829-881) — it never leaves syncStatus
                "error", so the user would stay on this same screen. Instead
                the click resets to the clean idle state via the existing
                cancelSync (useIPhoneSync.ts:1035-1063), which is exactly what
                Close beside it already does minus dismissing the modal. `view`
                then resolves to its `connection` DEFAULT and the user lands on
                the "Connect Your iPhone" step — no new step, no new state. */}
            <button
              onClick={() => {
                logger.info("[IPhoneSyncFlow] Try Again clicked");
                if (isConnected) {
                  startSync();
                } else {
                  logger.info("[IPhoneSyncFlow] Try Again with no device — returning to the connect step");
                  void cancelSync("try-again-no-device");
                }
              }}
              className="px-6 py-3 bg-gradient-to-r from-purple-500 to-indigo-600 text-white font-medium rounded-lg hover:from-purple-600 hover:to-indigo-700 transition-all"
            >
              Try Again
            </button>
          </div>
        </div>
      )}

    </div>
  );
};
