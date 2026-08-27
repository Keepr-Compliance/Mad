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
    // Special state: waiting for passcode
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
   * may claim a first sync.
   *
   * | state       | meaning                                   | banner |
   * |-------------|-------------------------------------------|--------|
   * | `"none"`    | host established there is no prior backup | shown  |
   * | `"exists"`  | a prior backup is on disk (whole or part) | hidden |
   * | `"unknown"` | could not be established, or field absent | hidden |
   *
   * Absent field reads as `"unknown"`: a payload from a main process that
   * predates this field must not be read as "first sync".
   *
   * NOTE: `"none"` is not produced by anything yet. `checkBackupStatus` returns
   * `null` both for ENOENT and for a check that threw, so the orchestrator maps
   * `null` to `"unknown"` on purpose (see BACKLOG-2917). Until 2917 lands this
   * banner therefore stays hidden in every reachable state — deliberately.
   * Claiming a two-hour first sync on a guess is the bug this replaces, and the
   * founder's rule for the unknown case is to render nothing.
   */
  const priorBackup = progress.priorBackup ?? "unknown";
  const isEstablishedFirstSync = priorBackup === "none";

  // Show first sync time warning once transfer has started — and only when the
  // host actually established that this IS a first sync.
  const showFirstSyncHint =
    !isComplete && !isError && isBackingUp && hasStartedTransfer && isEstablishedFirstSync;

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
            <p className="text-xs text-amber-600">
              Enter your passcode on your iPhone if prompted. It may take up to 10 minutes for the iPhone to report back that the passcode was entered as it indexes and prepares the export. This is normal — please don't disconnect or cancel.
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
