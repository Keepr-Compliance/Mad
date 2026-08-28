import React, { useEffect } from "react";
import type { SyncProgressProps } from "../../types/iphone";
import logger from "../../utils/logger";

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * SyncProgress Component
 * Displays backup/sync progress with visual feedback
 *
 * Note: idevicebackup2 only provides per-file progress, not total backup size.
 * We emphasize bytes transferred (accurate) over percentages (estimated).
 */
export const SyncProgress: React.FC<SyncProgressProps> = ({
  progress,
  onCancel,
  isWaitingForPasscode = false,
}) => {
  useEffect(() => {
    logger.info("[SyncProgress] Mounted", { phase: progress.phase, percent: progress.percent });
    return () => logger.info("[SyncProgress] Unmounted");
  }, []);

  useEffect(() => {
    logger.debug(`[SyncProgress] Phase: ${progress.phase}, ${progress.percent}%`, { isWaitingForPasscode });
  }, [progress.phase, progress.percent, isWaitingForPasscode]);
  /**
   * Option C: 2-Level Progress Display
   * Level 1: Combined title + context (bold, larger)
   * Level 2: Dynamic detail from progress.message (smaller, gray)
   */
  const getPhaseTitle = (): string => {
    /**
     * BACKLOG-2911 (FIX 3): this state means "the iPhone has not started sending
     * yet", which is ALL that is known. See the amber panel below for the evidence.
     * The title was already honest — it says nothing about a passcode — and is kept.
     */
    if (isWaitingForPasscode) {
      return "Waiting for iPhone";
    }

    switch (progress.phase) {
      case "preparing":
        return "Preparing export...";
      case "backing_up":
        return "Exporting - Keep connected";
      case "extracting":
        return "Reading messages - Safe to disconnect";
      case "storing":
        return "Saving to database - Safe to disconnect";
      case "complete":
        return "Sync complete!";
      case "error":
        return "Sync failed";
      default:
        return "Processing...";
    }
  };

  const isComplete = progress.phase === "complete";
  const isError = progress.phase === "error";
  const isBackingUp = progress.phase === "backing_up";
  const isPreparing = progress.phase === "preparing";
  const isExtracting = progress.phase === "extracting";
  const isStoring = progress.phase === "storing";
  const hasStartedTransfer = (progress.bytesProcessed ?? 0) > 0 || (progress.processedFiles ?? 0) > 0;

  // Show passcode waiting warning (special state with detailed instructions)
  const showPasscodeWarning = isWaitingForPasscode;

  /**
   * BACKLOG-2907: the prior-backup signal has THREE states, and only one of them
   * may claim a full transfer is coming.
   *
   * | state       | meaning                                          | banner |
   * |-------------|--------------------------------------------------|--------|
   * | `"none"`    | no usable prior backup — a full transfer is next  | shown  |
   * | `"exists"`  | a USABLE prior backup is on disk; incremental     | hidden |
   * | `"unknown"` | could not be established, or field absent         | hidden |
   *
   * Absent field reads as `"unknown"`: a payload from a main process that
   * predates this field must not be read as "first sync".
   *
   * BACKLOG-2917 is what makes `"none"` producible at all. Before it,
   * `checkBackupStatus` returned `null` for both ENOENT and a thrown check, so
   * the orchestrator could only say `"unknown"` and this banner was unreachable.
   *
   * BACKLOG-2938 then changed WHICH on-disk states produce `"none"`. The host now
   * reports USABILITY, not existence: a directory that exists but cannot be
   * restored from maps to `"none"`, because the user is about to wait for a full
   * transfer either way. That is the founder's ruling of 2026-08-27 — "if the sync
   * isn't useable show the this may take two hours msg." — after his own install
   * showed him "Previous backup can't be used. Starting a fresh backup..." while
   * this banner stayed hidden.
   *
   * The unknown case is unchanged and still renders nothing: claiming a two-hour
   * first sync on a guess is the bug this all replaces.
   */
  const priorBackup = progress.priorBackup ?? "unknown";
  const isEstablishedFullTransfer = priorBackup === "none";

  // Show first sync time warning once transfer has started — and only when the
  // host actually established that no usable prior backup exists.
  const showFirstSyncHint =
    !isComplete && !isError && isBackingUp && hasStartedTransfer && isEstablishedFullTransfer;

  return (
    <div className="p-6">
      {/*
        Progress Icon

        BACKLOG-2907: the default (in-progress) state has NO icon. The purple
        spinner that used to fill it was removed at the founder's request. The
        wrapper is kept — it centres the complete / error / passcode icons — but
        renders only when one of those exists, so the default state does not
        leave an empty `mb-4` box pushing the title down.
      */}
      {(isComplete || isError || isWaitingForPasscode) && (
        <div className="flex justify-center mb-4">
          {isComplete ? (
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
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
          ) : isError ? (
            <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">
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
          ) : (
            // Special icon for passcode waiting - phone with keypad
            <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center animate-pulse">
              <svg
                className="w-8 h-8 text-amber-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {/* Phone outline */}
                <rect x="7" y="2" width="10" height="20" rx="2" strokeWidth={2} />
                {/* Keypad dots */}
                <circle cx="10" cy="10" r="1" fill="currentColor" />
                <circle cx="12" cy="10" r="1" fill="currentColor" />
                <circle cx="14" cy="10" r="1" fill="currentColor" />
                <circle cx="10" cy="13" r="1" fill="currentColor" />
                <circle cx="12" cy="13" r="1" fill="currentColor" />
                <circle cx="14" cy="13" r="1" fill="currentColor" />
                <circle cx="12" cy="16" r="1" fill="currentColor" />
              </svg>
            </div>
          )}
        </div>
      )}

      {/* Level 1: Phase Title (combined title + context) */}
      <h3 className="text-lg font-semibold text-gray-800 text-center mb-1">
        {getPhaseTitle()}
      </h3>

      {/* Level 2: Dynamic detail message from backend */}
      {progress.message && !isComplete && (
        <p className="text-sm text-gray-500 text-center mb-3">
          {progress.message}
        </p>
      )}

      {/* Progress Bar - shown during backup phase (always indeterminate since idevicebackup2 estimates are unreliable) */}
      {!isComplete && !isError && isBackingUp && (
        <div className="mb-4">
          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full w-1/3 bg-gradient-to-r from-purple-500 to-indigo-600 rounded-full"
              style={{
                animation: 'indeterminate 1.5s ease-in-out infinite'
              }}
            />
          </div>
          <style>{`
            @keyframes indeterminate {
              0% { transform: translateX(-100%); }
              100% { transform: translateX(400%); }
            }
          `}</style>
        </div>
      )}

      {/* Primary Metric: Bytes Transferred (large and prominent) */}
      {hasStartedTransfer && !isComplete && (
        <div className="text-center mb-4">
          <p className="text-2xl font-bold text-gray-800">
            {formatBytes(progress.bytesProcessed)}
          </p>
          <p className="text-sm text-gray-500">
            transferred
            {progress.processedFiles !== undefined && progress.processedFiles > 0 && (
              <span> • {progress.processedFiles} files</span>
            )}
          </p>
        </div>
      )}

      {/* Determinate Progress Bar - for extracting and storing phases where we have progress */}
      {!isComplete && !isError && (isExtracting || isStoring) && (
        <div className="mb-4">
          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-purple-500 to-indigo-600 rounded-full transition-all duration-300"
              style={{ width: `${Math.min(progress.percent, 100)}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 text-center mt-1">
            {progress.percent}% complete
          </p>
        </div>
      )}

      {/* Passcode Waiting Warning - detailed instructions when waiting for passcode */}
      {showPasscodeWarning && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg mt-4">
          <svg
            className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
            />
          </svg>
          <div className="text-sm text-amber-700">
            {/*
              BACKLOG-2911 (FIX 3): SAY WHAT IS KNOWN, THEN THE POSSIBILITY.

              Nothing on this path reports that the device wants a passcode. The
              signal behind `isWaitingForPasscode` is only that no file has started
              transferring 5 seconds after the backup was requested — which is
              produced identically by the device indexing, by a person who has not
              picked up their phone, and by a hung process.

              On the founder's 12:09 run on 2026-08-28 he had ALREADY ENTERED his
              passcode and this panel went on telling him to enter it for fifteen
              more minutes, because the transfer did not begin for 903.9 seconds.
              The same class of defect as BACKLOG-2913, and the same rule as the
              three-state ruling in BACKLOG-2886: uncertainty reports itself as
              uncertainty, it does not substitute a confident cause.

              "Up to 20 minutes" is not a round number chosen for comfort — it is
              above the longest wait ever measured on his machine (903.9 s = 15.1
              minutes, with 507 s and 684.6 s on the two runs before it). The first
              draft of this copy said 15 minutes and
              `SyncProgress.waitCause-2911.test.tsx` reddened on it: 900 s is BELOW
              903.9 s, so the reassurance would have run out before his own longest
              successful sync did.
            */}
            <p className="text-xs text-amber-600">
              Your iPhone is preparing the export. This can take up to 20 minutes before the transfer starts, and it&apos;s normal — please don&apos;t disconnect or cancel. If your iPhone is showing a passcode prompt, enter it to continue.
            </p>
          </div>
        </div>
      )}

      {/* First Sync Time Warning - shown once transfer has started */}
      {showFirstSyncHint && (
        <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg mt-4">
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
          <p className="text-sm text-blue-700">
            <span className="font-medium">First sync</span> may take up to two hours depending on your phone's data. Future syncs will be much faster.
          </p>
        </div>
      )}

      {/* Don't Disconnect Warning - shown during backup (but NOT when waiting for passcode, that has its own message) */}
      {!isComplete && !isError && (isBackingUp || isPreparing) && !isWaitingForPasscode && (
        <div className="flex items-start gap-2 p-3 bg-gray-50 border border-gray-200 rounded-lg mt-3">
          <svg
            className="w-5 h-5 text-gray-500 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          <p className="text-sm text-gray-600">
            Please keep your iPhone connected until export completes.
          </p>
        </div>
      )}

      {/* Cancel Button */}
      {onCancel && !isComplete && !isError && (
        <div className="mt-6 flex justify-center">
          <button
            onClick={() => { logger.info("[SyncProgress] Cancel button clicked"); onCancel(); }}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 text-sm font-medium transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};

export default SyncProgress;
