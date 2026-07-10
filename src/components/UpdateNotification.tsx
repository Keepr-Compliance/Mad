import { useState, useEffect } from "react";
import type { UpdateErrorType } from "../../electron/types/ipc";

interface UpdateInfo {
  version: string;
}

/**
 * BACKLOG-1905: which recovery affordances a given errorType offers.
 * Keyed on the fingerprint class emitted by the main-process error handler.
 * `guidance` is optional extra copy shown when there's a concrete user action
 * (e.g. free up disk space). See the acceptance matrix in BACKLOG-1905.
 */
interface RecoveryAffordances {
  /** Retryable in-app (re-check for updates). */
  canRetry: boolean;
  /** Offer the one-click platform-correct manual installer download. */
  canDownload: boolean;
  /** Offer the "Report issue" button (opens support with diagnostics). */
  canReport: boolean;
  /** Optional actionable guidance line. */
  guidance?: string;
}

const RECOVERY_MATRIX: Record<UpdateErrorType, RecoveryAffordances> = {
  // Auto full-download fallback already ran in main; if it still failed, the
  // user's cleanest path is a fresh manual installer.
  checksum_mismatch: { canRetry: false, canDownload: true, canReport: true },
  // Auto network retries already ran in main; allow one more manual retry too.
  network_timeout: { canRetry: true, canDownload: true, canReport: true },
  // Missing release/asset (likely a publishing issue) — manual + report.
  feed_not_found: { canRetry: false, canDownload: true, canReport: true },
  manifest_parse: { canRetry: false, canDownload: true, canReport: true },
  // An unsignable asset won't install — do NOT offer a download; just report.
  signature_codesign: { canRetry: false, canDownload: false, canReport: true },
  disk_space: {
    canRetry: true,
    canDownload: false,
    canReport: false,
    guidance: "Free up disk space, then try again.",
  },
  // On macOS read-only volumes this is routed to the translocation card instead;
  // this branch only shows for the generic permission case.
  permission: {
    canRetry: false,
    canDownload: false,
    canReport: false,
    guidance:
      "Keepr couldn't write the update. Move Keepr to your Applications folder and try again.",
  },
  unknown: { canRetry: false, canDownload: true, canReport: true },
};

export default function UpdateNotification() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  // BACKLOG-1905: fingerprint class + Sentry event id from the structured
  // error payload — drive the recovery affordances + report linkage.
  const [errorType, setErrorType] = useState<UpdateErrorType>("unknown");
  const [sentryEventId, setSentryEventId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [translocationDetected, setTranslocationDetected] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const cleanups: (() => void)[] = [];

    // Listen for update events
    if (window.api?.update?.onAvailable) {
      const cleanup = window.api.update.onAvailable((info) => {
        setUpdateAvailable(true);
        setUpdateError(null);
        setUpdateInfo(info as UpdateInfo);
      });
      if (cleanup) cleanups.push(cleanup);
    }

    if (window.api?.update?.onProgress) {
      const cleanup = window.api.update.onProgress((progress) => {
        setDownloadProgress(
          Math.round((progress as { percent: number }).percent),
        );
      });
      if (cleanup) cleanups.push(cleanup);
    }

    if (window.api?.update?.onDownloaded) {
      const cleanup = window.api.update.onDownloaded(() => {
        setUpdateDownloaded(true);
        setUpdateError(null);
      });
      if (cleanup) cleanups.push(cleanup);
    }

    // BACKLOG-1641/1903: Listen for auto-updater errors so the UI does not
    // stay stuck at 100% when checksum verification (or anything else) fails.
    // BACKLOG-1903: the payload is now a structured object
    // { message, errorType, sentryEventId } but a bare string may still arrive
    // from legacy emitters — defensively accept both so an object can never
    // crash React by being rendered directly.
    if (window.api?.update?.onError) {
      const cleanup = window.api.update.onError((payload) => {
        // BACKLOG-1903/1905: payload is now { message, errorType, sentryEventId }
        // but a bare string may still arrive from legacy emitters.
        if (typeof payload === "string") {
          setUpdateError(payload);
          setErrorType("unknown");
          setSentryEventId(null);
        } else {
          setUpdateError(payload?.message ?? "Update failed");
          setErrorType(payload?.errorType ?? "unknown");
          setSentryEventId(payload?.sentryEventId ?? null);
        }
        setRetrying(false);
      });
      if (cleanup) cleanups.push(cleanup);
    }

    // macOS App Translocation: show guidance when app is not in /Applications
    if (window.api?.update?.onTranslocationDetected) {
      const cleanup = window.api.update.onTranslocationDetected(() => {
        setTranslocationDetected(true);
      });
      if (cleanup) cleanups.push(cleanup);
    }

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, []);

  const handleInstall = () => {
    if (window.api?.update?.install) {
      window.api.update.install();
    }
  };

  const handleDismiss = () => {
    setUpdateDownloaded(false);
    setUpdateAvailable(false);
    setUpdateError(null);
    setErrorType("unknown");
    setSentryEventId(null);
  };

  const handleDismissTranslocation = () => {
    setTranslocationDetected(false);
  };

  const handleRetry = async () => {
    if (!window.api?.update?.checkForUpdates) return;
    setRetrying(true);
    setUpdateError(null);
    setDownloadProgress(0);
    try {
      await window.api.update.checkForUpdates();
    } catch {
      // Error will be caught by the onError listener
    }
  };

  // BACKLOG-1905: one-click, platform-correct manual installer. Opens the EXACT
  // target-version asset for the user's OS/arch from the canonical releases repo
  // (main process resolves version + platform + owner/repo). No more
  // keeprcompliance.com website dead-end.
  const handleDownloadInstaller = () => {
    window.api?.update?.openManualInstaller?.().catch(() => {
      // The card stays visible with Report/Dismiss so the user isn't stuck.
    });
  };

  // BACKLOG-1905: open the in-app support dialog pre-filled with a human-readable
  // failure summary. collectDiagnostics() (BACKLOG-1903) automatically attaches
  // the structured updater_failure + sentry_event_id block on submit, so the
  // resulting ticket arrives pre-diagnosed.
  const handleReport = () => {
    const version = updateInfo?.version ? ` v${updateInfo.version}` : "";
    const subject = `Auto-update failed (${errorType})`;
    const description =
      `Automatic update${version} failed to install.\n\n` +
      `Error type: ${errorType}\n` +
      (sentryEventId ? `Reference: ${sentryEventId}\n` : "") +
      `\nWhat happened just before this / anything else that would help:\n`;
    window.dispatchEvent(
      new CustomEvent("open-support-widget", {
        detail: { subject, description },
      }),
    );
  };

  // BACKLOG-610: Use z-[110] to ensure visibility above all modals and toasts (z-[100])

  // macOS App Translocation warning — shown when app cannot auto-update
  // Takes precedence over the generic error UI because it's actionable.
  if (translocationDetected) {
    return (
      <div className="fixed bottom-4 right-4 bg-amber-500 text-white p-4 rounded-lg shadow-lg max-w-sm z-[110]">
        <h3 className="font-bold text-lg mb-2">Updates Unavailable</h3>
        <p className="text-sm mb-3">
          Please move Keepr to your Applications folder to enable automatic
          updates. macOS prevents updates when the app is run from a download
          or temporary location.
        </p>
        <button
          onClick={handleDismissTranslocation}
          className="w-full px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 transition-colors"
        >
          Dismiss
        </button>
      </div>
    );
  }

  // BACKLOG-1641/1905: Error state — shown when download/verification fails.
  // Non-modal, always dismissible, keyed on errorType so the user gets the right
  // self-recovery affordances (download installer / retry / report). It renders
  // fixed bottom-right ALONGSIDE app content and never traps focus, so it can
  // never block login (BACKLOG-1905 hit an unauthenticated user).
  if (updateError) {
    const affordances = RECOVERY_MATRIX[errorType] ?? RECOVERY_MATRIX.unknown;
    // Auto-recovery (full re-download / network retries) already ran in the main
    // process before this card appeared, so the copy points the user to the
    // remaining self-service options rather than promising another auto-attempt.
    return (
      <div
        className="fixed bottom-4 right-4 bg-red-500 text-white p-4 rounded-lg shadow-lg max-w-sm z-[110]"
        role="alert"
      >
        <h3 className="font-bold text-lg mb-2">Update Failed</h3>
        <p className="text-sm mb-3">
          {affordances.guidance ??
            "The automatic update couldn't be installed. Your current version keeps working — you can download the latest installer or report the issue."}
        </p>
        <div className="flex flex-wrap gap-2">
          {affordances.canRetry && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="flex-1 min-w-[6rem] bg-white text-red-500 px-4 py-2 rounded font-medium hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              {retrying ? "Retrying..." : "Retry"}
            </button>
          )}
          {affordances.canDownload && (
            <button
              onClick={handleDownloadInstaller}
              className="flex-1 min-w-[8rem] bg-white text-red-500 px-4 py-2 rounded font-medium hover:bg-red-50 transition-colors"
            >
              Download installer
            </button>
          )}
          {affordances.canReport && (
            <button
              onClick={handleReport}
              className="flex-1 min-w-[6rem] bg-red-600 text-white px-4 py-2 rounded font-medium hover:bg-red-700 transition-colors"
            >
              Report issue
            </button>
          )}
          <button
            onClick={handleDismiss}
            className="px-3 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors text-sm"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (updateDownloaded) {
    return (
      <div className="fixed bottom-4 right-4 bg-green-500 text-white p-4 rounded-lg shadow-lg max-w-sm z-[110]">
        <h3 className="font-bold text-lg mb-2">Update Ready!</h3>
        <p className="text-sm mb-3">
          Version {updateInfo?.version} has been downloaded and is ready to
          install.
        </p>
        <div className="flex gap-2">
          <button
            onClick={handleInstall}
            className="flex-1 bg-white text-green-500 px-4 py-2 rounded font-medium hover:bg-green-50 transition-colors"
          >
            Restart & Install
          </button>
          <button
            onClick={handleDismiss}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
          >
            Later
          </button>
        </div>
      </div>
    );
  }

  if (updateAvailable) {
    return (
      <div className="fixed bottom-4 right-4 bg-blue-500 text-white p-4 rounded-lg shadow-lg max-w-sm z-[110]">
        <h3 className="font-bold text-lg mb-2">Downloading Update...</h3>
        <p className="text-sm mb-3">Version {updateInfo?.version}</p>
        <div className="w-full bg-white/30 rounded-full h-2 mb-2">
          <div
            className="bg-white h-2 rounded-full transition-all duration-300"
            style={{ width: `${downloadProgress}%` }}
          />
        </div>
        <p className="text-sm text-right">{downloadProgress}%</p>
      </div>
    );
  }

  return null;
}
