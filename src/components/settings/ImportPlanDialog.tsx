/**
 * ImportPlanDialog — the ONE pre-import dialog (BACKLOG-2749)
 *
 * ## What it replaces
 *
 * Before this there were three surfaces disclosing one decision, each computing
 * its own numbers from whatever was nearest to hand:
 *
 *   - an inline amber "cap prompt" with its own two buttons,
 *   - an inline red space-refusal block with a third button,
 *   - and a header derived from the stored preference.
 *
 * They contradicted each other on the founder's own machine, 2026-08-22: the
 * header said "Importing up to 50,000 messages" while the line under it said the
 * selection covered 62,823. Both were "right" — the header read the stored cap,
 * the line read the admitted count — and that is exactly the failure. Under Cap'
 * (BACKLOG-2772) messages inside a deal's audit period are fetched complete and
 * never counted against the cap, so the admitted set is
 * `protected ∪ (the newest `cap` unprotected messages)` and is legitimately
 * LARGER than the cap. A surface that has not been told the cap cannot describe
 * that, and one that has not been told the admitted count cannot either.
 *
 * ## The rule this component is built to keep
 *
 * **It computes nothing it could be told.** Every number it renders arrives as a
 * prop, sourced from the resolver's own plan (`ImportPlan.effectiveCap`,
 * `ImportPlan.overrides`) and from the estimate that resolves the SAME plan
 * (`windowCount`, `filteredCount`, the attachment bytes, the disk verdict).
 * The single piece of arithmetic it does — `windowCount - admittedCount`, the
 * messages the limit leaves out — is stated once, here, so that the completion
 * surface and this dialog cannot disagree about it.
 *
 * That constraint is what makes the component testable against the resolver:
 * numbers in, callbacks out, no IPC, no store, no derivation of the cap from
 * the counts.
 *
 * ## The founder's recorded decisions, and where each one lives below
 *
 * 1. `23cb2428` — the same modal component and visual weight as the force
 *    re-import confirm, but NEUTRAL: this is a choice, not a danger.
 * 2. `1e8baa69` — no "Importing up to N messages" header. Lead with the window
 *    statement, then the coverage line.
 * 3. `1e8baa69` — the coverage line states what the store will COVER when the
 *    run finishes, not what gets downloaded. He read 62,823 as re-download
 *    volume; a delta import skips what is already present.
 * 4. `3a4fc2b2` — the keep-the-limit choice states the protected-history total.
 *    The import-everything choice carries the WINDOW count (BACKLOG-2772).
 * 5. `c2300351` — safe action prominent, expensive/destructive action recessive
 *    but honestly labelled.
 * 6. `2259031c` — a refusal computes the way out: the largest preset window
 *    that fits, named with its own estimate.
 *
 * @module settings/ImportPlanDialog
 */

import React from "react";
import { ResponsiveModal } from "../common/ResponsiveModal";
// Type-only across the renderer/main boundary — the only safe direction. The
// override list is the resolver's own type, so a new override kind becomes a
// compile-time fact here rather than a silently-unrendered case.
import type { ImportPlanOverride } from "@electron/types/ipc/window-api-messages";

/**
 * Why the dialog is open.
 *
 * `space` outranks `cap` at the call site, and deliberately: an import that
 * cannot fit on the disk must not be offered a choice between two sizes of
 * import that both fail.
 */
export type ImportPlanDialogReason = "cap" | "space";

/**
 * A shorter preset window that the main process says WILL fit.
 *
 * `attachmentBytes` is that window's estimate, computed by main for that
 * window's own resolved plan — never scaled or interpolated from another
 * window's figure.
 */
export interface FittingWindowCandidate {
  lookbackMonths: number;
  attachmentBytes: number;
}

/** How the search for a fitting window is going. */
export type FittingWindowStatus = "searching" | "found" | "none";

export interface ImportPlanDialogProps {
  reason: ImportPlanDialogReason;
  /**
   * Whether the pending run is a force re-import. Changes the VERBS only —
   * under D2' both modes cover the same window, so every number is identical.
   */
  isReimport: boolean;

  // ---- Counts, all from the plan/estimate. None derived here. ----
  /** Messages the SELECTION covers, before the cap. `MessageImportCountResult.windowCount`. */
  windowCount: number;
  /**
   * What the store will COVER when the run finishes — Cap' applied.
   * `MessageImportCountResult.filteredCount`.
   */
  admittedCount: number;
  /**
   * The cap the resolved plan will enforce; `null` = Unlimited.
   * `ImportPlan.effectiveCap`, carried on the estimate wire.
   *
   * NEVER inferred from the counts. `min(windowCount, admittedCount)` is not
   * the cap, and under Cap' `admittedCount` exceeds it whenever a deal's audit
   * period is in range.
   */
  effectiveCap: number | null;
  /** The plan's own overrides, verbatim. Empty = the run does what the user asked. */
  overrides: ImportPlanOverride[];

  // ---- Space refusal facts (reason === "space") ----
  /** Attachment bytes the admitted set would copy. */
  attachmentBytes: number | null;
  /** Free space available to the app; null when unreadable. */
  availableDiskBytes: number | null;
  /** The largest preset window that fits, once known. */
  fittingWindow: FittingWindowCandidate | null;
  fittingWindowStatus: FittingWindowStatus;

  /**
   * BACKLOG-2749: an action was attempted and could not be carried out, so no
   * import was started.
   *
   * Both window-changing buttons persist a preference before importing, and a
   * failed write must stop the run rather than let it proceed on the old
   * setting. When that happens the dialog STAYS OPEN and says so — a button
   * that silently does nothing reads as a broken app, and one that silently
   * does something else is the defect this whole item is about.
   */
  actionError: string | null;

  // ---- Callbacks ----
  /** Keep the limit: run with the cap the plan already resolved. */
  onKeepLimit: () => void;
  /** Import everything in the window: clears the cap for this run. */
  onImportEverything: () => void;
  /**
   * Narrow the selection to a window that fits, then import.
   *
   * Both this and `onTextOnly` PERSIST a preference before importing, so the
   * caller may decline to start the run — see `actionError`. The dialog fires
   * them and renders whatever comes back; it does not assume the click won.
   */
  onChooseWindow: (lookbackMonths: number) => void;
  /** Import message text without attachment files. */
  onTextOnly: () => void;
  onCancel: () => void;
}

/**
 * Plain size formatting — real numbers, no adjectives.
 *
 * Transcribed from `MacOSMessagesImportSettings`'s `formatGb` rather than
 * re-derived, so the dialog and the panel behind it round identically. Three
 * suites assert the panel's exact strings ("61.3 GB", "2.6 GB"), and a dialog
 * that rounded differently would put two spellings of one number on screen.
 */
export function formatGb(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb < 0.1) return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  return `${gb.toFixed(1)} GB`;
}

/**
 * The pre-import dialog.
 *
 * Rendered only when the caller has a resolved plan to describe. It never asks
 * for one, and it never guesses at a missing number: a caller without the plan
 * facts must not open it.
 */
export function ImportPlanDialog({
  reason,
  isReimport,
  windowCount,
  admittedCount,
  effectiveCap,
  overrides,
  attachmentBytes,
  availableDiskBytes,
  fittingWindow,
  fittingWindowStatus,
  actionError,
  onKeepLimit,
  onImportEverything,
  onChooseWindow,
  onTextOnly,
  onCancel,
}: ImportPlanDialogProps): React.ReactElement {
  const verb = isReimport ? "Re-import" : "Import";

  /**
   * Does protected audit history ride along with the cap?
   *
   * This is a fact READ from two independent sources — the resolver's cap and
   * the estimate's admitted count — not a number computed from one of them.
   * Under Cap' they are equal exactly when nothing is protected, and the
   * admitted count exceeds the cap by the size of the protected set otherwise.
   */
  const hasProtectedHistory =
    effectiveCap !== null && admittedCount > effectiveCap;

  /**
   * Messages the limit leaves out.
   *
   * Window MINUS the coverage the run will end up with. NOT window minus what
   * this run downloads: a delta import skips messages already stored, and
   * counting those as "excluded" is the arithmetic that told the founder
   * 659,619 messages were excluded when the real figure was 645,576
   * (`a14b3a82`, 2026-08-22).
   */
  const excludedByLimit = windowCount - admittedCount;

  const windowExtendedByDeals = overrides.some(
    (o) => o.kind === "window-extended-by-deals"
  );

  return (
    <ResponsiveModal
      onClose={onCancel}
      zIndex="z-[70]"
      panelClassName="max-w-md p-6"
      testId="import-plan-dialog"
    >
      {/* Founder decision 1 (`23cb2428`): the force re-import confirm's shape
          and weight, in NEUTRAL colours. That dialog gates a destructive act
          and earns its red; this one asks the user to pick a size. Painting a
          choice as a danger is how a warning stops being read. */}
      <div className="flex items-center gap-3 mb-3">
        <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
          <svg
            className="w-6 h-6 text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
        </div>
        <h3 className="text-lg font-bold text-gray-900">
          {reason === "space"
            ? "Not enough space for this import"
            : "More messages than your limit"}
        </h3>
      </div>

      {reason === "cap" ? (
        <div data-testid="import-plan-cap-body">
          {/* Founder decision 2 (`1e8baa69`): NO "Importing up to N messages"
              header. It contradicted the line beneath it whenever protected
              audit history pushed the admitted count past the cap. The window
              statement leads instead — it is the fact that makes the rest
              necessary, and it cannot contradict anything because it names the
              window and the limit as two different things. */}
          <p className="text-sm text-gray-800 mb-2">
            This time period contains{" "}
            <strong>{windowCount.toLocaleString()}</strong> messages, which
            exceeds the{" "}
            {effectiveCap === null
              ? "current"
              : effectiveCap.toLocaleString()}{" "}
            limit.
          </p>

          {/* Founder decision 3 (`1e8baa69`): COVERAGE, not download volume. He
              read 62,823 as "Keepr will re-download 62,823 messages"; it is
              what the store will HOLD for this period once the run finishes,
              and a delta import fetches only the part it does not already
              have. Saying so is the whole of this sentence's job. */}
          <p
            data-testid="import-plan-coverage"
            className="text-sm text-gray-600 mb-4"
          >
            If you keep your limit, your messages for this period will cover{" "}
            <strong>{admittedCount.toLocaleString()}</strong> of{" "}
            {windowCount.toLocaleString()} — the{" "}
            {effectiveCap !== null && `${effectiveCap.toLocaleString()} `}
            newest
            {hasProtectedHistory && (
              <>
                , plus your deals&rsquo; protected history, which is always kept
                complete
              </>
            )}
            . That is the coverage you end up with, not a download size —
            messages Keepr already has are not fetched again.{" "}
            <span className="text-gray-500">
              {excludedByLimit.toLocaleString()} older messages in this period
              stay outside your limit.
            </span>
          </p>

          {windowExtendedByDeals && (
            <p
              data-testid="import-plan-window-extended"
              className="text-xs text-gray-500 mb-4"
            >
              This period already reaches further back than your
              &ldquo;Import messages from&rdquo; setting, because one of your
              deals&rsquo; audit periods needs it.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {actionError !== null && (
              <p
                data-testid="import-plan-action-error"
                className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-1"
              >
                {actionError}
              </p>
            )}
            {/* Founder decision 5 (`c2300351`), safe action PROMINENT.
                Founder decision 4 (`3a4fc2b2`), the label:

                With no protected history the admitted set IS the cap, and
                "Import most recent 50,000 only" is exactly true — kept
                verbatim, because it is the sentence BACKLOG-2772 pinned and
                nothing about it became false.

                With protected history it understates in the user's favour:
                clicking it delivered 62,823, not 50,000. He asked for the
                total to be said. */}
            <button
              onClick={onKeepLimit}
              data-testid="import-plan-keep-limit"
              className="w-full px-3 py-2.5 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded transition-all"
            >
              {effectiveCap === null
                ? `${verb} the newest ${admittedCount.toLocaleString()}`
                : hasProtectedHistory
                  ? `Keep the ${effectiveCap.toLocaleString()} newest — plus your deals' protected history (${admittedCount.toLocaleString()} total)`
                  : `${verb} most recent ${effectiveCap.toLocaleString()} only`}
            </button>

            {/* The expensive choice: RECESSIVE, and honestly labelled
                (founder decision 5, with the builder note — red conventionally
                flags the destructive control, so the de-emphasis is carried by
                weight and colour while the label carries the cost).

                The number is the WINDOW, because this button clears the cap for
                the run and the run then fetches the whole window. BACKLOG-2772
                fixed it reading the admitted count, where it offered to import
                50,000 and imported 707,842. Pinned by
                `MacOSMessagesImportSettings.capDialog-2772.test.tsx`. */}
            <button
              onClick={onImportEverything}
              data-testid="import-plan-import-all"
              className="w-full px-3 py-2.5 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm font-medium rounded transition-all"
            >
              {verb} all {windowCount.toLocaleString()} messages
            </button>
            <p className="text-xs text-gray-500 -mt-1 mb-1">
              Removes your limit for this import. It will take much longer and
              use considerably more disk space.
            </p>

            <button
              onClick={onCancel}
              data-testid="import-plan-cancel"
              className="w-full px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm font-medium transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div data-testid="import-space-block">
          {/* The refusal sentence, verbatim from the surface it replaces, so
              the fact the user reads is unchanged by the move. "up to": the
              figure is an upper bound by construction — identical files are
              copied once, and that is not subtracted here. */}
          <p className="text-sm text-gray-800 font-medium mb-2">
            This import needs up to{" "}
            {attachmentBytes !== null ? formatGb(attachmentBytes) : "more space"}{" "}
            for attachments
            {availableDiskBytes !== null && (
              <> but only {formatGb(availableDiskBytes)} is available</>
            )}
            . It will not start.
          </p>

          {/* Founder decision 6 (`2259031c`): the refusal computes the way out.
              A bare "choose a shorter period" tells the user to go and find one
              by trial and error, on a panel where each trial costs a full
              estimate. The button names a window that FITS and what it costs.

              The hiding rule is one rule, not two: when nothing shorter fits —
              including because deal audit periods force the window open — no
              button appears. That case is not a failure to compute; it is the
              computation's answer. */}
          {fittingWindowStatus === "searching" && (
            <p
              data-testid="import-plan-window-searching"
              className="text-sm text-gray-500 mb-3 flex items-center gap-2"
            >
              <span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              Looking for a shorter period that fits&hellip;
            </p>
          )}

          <div className="flex flex-col gap-2 mt-3">
            {actionError !== null && (
              <p
                data-testid="import-plan-action-error"
                className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-1"
              >
                {actionError}
              </p>
            )}
            {fittingWindowStatus === "found" && fittingWindow !== null && (
              <button
                onClick={() => onChooseWindow(fittingWindow.lookbackMonths)}
                data-testid="import-plan-fitting-window"
                className="w-full px-3 py-2.5 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded transition-all"
              >
                {verb} last {fittingWindow.lookbackMonths} months —{" "}
                {formatGb(fittingWindow.attachmentBytes)}
              </button>
            )}

            {/* The escape hatch that makes the refusal actionable at all.
                Message text is a small fraction of the attachment copy, so this
                always fits when the full import does not.

                DEVIATION from the founder's sketch, which reads
                "[ Text only — ~1 GB ]": no text-only size estimate exists on
                any wire today, and inventing one is precisely the self-computed
                number this item forbids. The button carries no size rather than
                a fabricated one. */}
            <button
              onClick={onTextOnly}
              data-testid="import-without-attachments"
              className="w-full px-3 py-2.5 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm font-medium rounded transition-all"
            >
              Import message text only (no attachment files)
            </button>

            <button
              onClick={onCancel}
              data-testid="import-plan-cancel"
              className="w-full px-3 py-2 text-gray-700 hover:bg-gray-100 rounded text-sm font-medium transition-all"
            >
              Cancel
            </button>
          </div>

          {/* There is deliberately NO "import anyway". macOS makes room by
              deleting the user's local Time Machine snapshots, which is the
              failure this guard exists for (BACKLOG-2743). */}
        </div>
      )}
    </ResponsiveModal>
  );
}

export default ImportPlanDialog;
