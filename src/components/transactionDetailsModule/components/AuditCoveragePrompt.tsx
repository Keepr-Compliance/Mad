/**
 * AuditCoveragePrompt (BACKLOG-2292, Layer 1)
 *
 * Shown at audit CREATE and audit-date ADJUSTMENT time. TWO-LAYER messaging
 * (founder, 2026-07-28):
 *
 *   Layer 1 (ALWAYS): the audit dates are the single control that drives what's
 *     included — "All of your communications will be updated to reflect this date
 *     range." Reassurance, not a warning; shows even for a pure crop (no fetch).
 *
 *   Layer 2 (ADDITIVE, only when the new range extends earlier than the imported
 *     messages floor OR the email cache floor): "…and older messages will be
 *     imported to cover this range — import now?" with the inline import CTA +
 *     progress. Never a bare "import older messages?" popup with no context.
 *
 * Presentational only — the parent owns the IPC (via useAuditCoverageCheck) and
 * passes import state + callbacks.
 */
import React from "react";
import { ResponsiveModal } from "../../common/ResponsiveModal";
import type { CoverageImportProgress } from "../../../hooks/useAuditCoverageCheck";

export interface AuditCoveragePromptProps {
  /** New range extends earlier than the imported messages OR email floor. */
  hasGap: boolean;
  /** macOS + Full Disk Access — whether the "Update now" import can actually run. */
  importerAvailable: boolean;
  importing: boolean;
  progress: CoverageImportProgress | null;
  /**
   * BACKLOG-2305: the coverage op spans multiple import passes, so the per-pass
   * percentage is meaningless — render an indeterminate "Updating…" bar instead
   * of a determinate one that would visibly loop 100%→0%.
   */
  indeterminate?: boolean;
  /**
   * BACKLOG-2305: optional inline notice (e.g. the failsafe fired — the import is
   * still finishing in the background; the user may wait, retry, or skip). When
   * set, the actions are RE-ENABLED so the user is never trapped.
   */
  notice?: string | null;
  /** Primary action when a gap exists + importer available: import then proceed. */
  onUpdateNow: () => void;
  /** Proceed WITHOUT importing ("Skip for now" / "Continue"). */
  onSkip: () => void;
  /** Dismiss and return to editing (no proceed). */
  onCancel: () => void;
}

export function AuditCoveragePrompt({
  hasGap,
  importerAvailable,
  importing,
  progress,
  indeterminate = false,
  notice = null,
  onUpdateNow,
  onSkip,
  onCancel,
}: AuditCoveragePromptProps): React.ReactElement {
  const canImport = hasGap && importerAvailable;
  const percent = progress ? Math.max(0, Math.min(100, Math.round(progress.percent))) : 0;
  // BACKLOG-2305: fall back to indeterminate whenever we lack a trustworthy
  // determinate percentage (multi-pass, or importing with no progress yet).
  const showIndeterminate = importing && (indeterminate || progress === null);

  return (
    <ResponsiveModal
      onClose={importing ? undefined : onCancel}
      zIndex="z-[80]"
      panelClassName="max-w-md"
    >
      <div className="p-6" data-testid="audit-coverage-prompt">
        <div className="flex items-start gap-3 mb-4">
          <div
            className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
              hasGap ? "bg-amber-100" : "bg-indigo-100"
            }`}
          >
            <svg
              className={`w-5 h-5 ${hasGap ? "text-amber-600" : "text-indigo-600"}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-bold text-gray-900">
              {hasGap ? "Update communications for this date range" : "Communications will update"}
            </h3>
          </div>
        </div>

        {/* Layer 1 — ALWAYS. */}
        <p className="text-sm text-gray-700 mb-3">
          All of your communications will be updated to reflect this date range.
        </p>

        {/* Layer 2 — ADDITIVE, only when a real data gap exists. */}
        {hasGap && importerAvailable && (
          <p className="text-sm text-gray-700 mb-3" data-testid="audit-coverage-import-line">
            Because this range starts earlier than your imported message history,
            older messages will be imported to cover it.
          </p>
        )}
        {hasGap && !importerAvailable && (
          <p className="text-sm text-amber-700 mb-3" data-testid="audit-coverage-degrade-line">
            This range starts earlier than your imported message history. Older
            messages can only be imported on a Mac with Full Disk Access — the
            range will still update, but earlier texts won&apos;t be included on
            this device.
          </p>
        )}

        {/* Inline progress while importing. */}
        {importing && (
          <div className="mb-4" data-testid="audit-coverage-progress">
            <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
              <span>Updating messages for this audit period…</span>
              {/* BACKLOG-2305: only show a percentage for a single determinate
                  pass — never across a multi-pass op (it would loop 100%→0%). */}
              {!showIndeterminate && <span>{percent}%</span>}
            </div>
            {showIndeterminate ? (
              <div
                className="w-full h-2 bg-gray-200 rounded-full overflow-hidden"
                data-testid="audit-coverage-progress-indeterminate"
              >
                <div className="h-full w-1/3 bg-indigo-500 rounded-full animate-pulse" />
              </div>
            ) : (
              <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* BACKLOG-2305: failsafe notice — the import is still finishing in the
            background; the actions are re-enabled so the user can wait, retry, or
            skip rather than being trapped behind permanently-disabled buttons. */}
        {notice && (
          <p
            className="text-sm text-amber-700 mb-3"
            data-testid="audit-coverage-notice"
          >
            {notice}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 mt-5">
          {canImport ? (
            <>
              <button
                onClick={onSkip}
                disabled={importing}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="audit-coverage-skip"
              >
                Skip for now
              </button>
              <button
                onClick={onUpdateNow}
                disabled={importing}
                className="px-5 py-2 rounded-lg font-semibold text-white bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 shadow-md transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                data-testid="audit-coverage-update-now"
              >
                {importing ? "Updating…" : "Update now"}
              </button>
            </>
          ) : (
            <button
              onClick={onSkip}
              disabled={importing}
              className="px-5 py-2 rounded-lg font-semibold text-white bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 shadow-md transition-all disabled:opacity-60 disabled:cursor-not-allowed"
              data-testid="audit-coverage-continue"
            >
              {hasGap ? "Continue anyway" : "Got it"}
            </button>
          )}
        </div>
      </div>
    </ResponsiveModal>
  );
}

export default AuditCoveragePrompt;
