/**
 * useAuditCoverageCheck (BACKLOG-2292)
 *
 * Renderer-side helper for the audit-window completeness guarantee. Centralizes
 * the three IPC touch-points behind the Layer-1 date-selection popup
 * (AuditCoveragePrompt) and the Layer-3 export gate (ExportModal):
 *
 *   - checkCoverage(proposedStartISO)      → does the chosen start predate the
 *                                            imported/cached history?
 *   - checkExportCompleteness(txnId)       → is this transaction's messages
 *                                            coverage complete for its window?
 *   - runMessagesImport(startISO, txnId?)  → the "Update now" action: import
 *                                            older messages + expand, streaming
 *                                            inline progress; resolves with the
 *                                            floor AFTER (observe-by-requery).
 *
 * All floor comparisons happen against ISO strings the main side returns
 * (SR-correction f) — this hook never coerces Date vs string.
 */
import { useCallback, useState } from "react";
import type {
  AuditCoverageResult,
  ExportCompletenessResult,
} from "../../electron/types/auditCoverage";
// BACKLOG-2832: the phase union, so a phase added without a band fails to compile.
import type { ImportPhase } from "../../electron/types/ipc/importPhase";

/** Progress shape as delivered by window.api.messages.onImportProgress. */
export interface CoverageImportProgress {
  phase: string;
  current: number;
  total: number;
  percent: number;
}

export interface RunMessagesImportOutcome {
  ran: boolean;
  /** Whether a real device import ran (vs expansion-only) — the export gate
   * proceeds on this even if the floor stays above the audit start. */
  importRan: boolean;
  /** MIN(sent_at) floor AFTER the attempt — callers re-derive completeness. */
  floorISO: string | null;
  /**
   * BACKLOG-2305: the failsafe watchdog fired before the coverage IPC resolved
   * (the backend may still be finishing in the background). Callers use this to
   * KEEP the prompt open + re-enabled (retry/skip) instead of silently
   * proceeding as if the import completed.
   */
  timedOut?: boolean;
  error?: string;
}

export interface UseAuditCoverageCheckResult {
  checkCoverage: (proposedStartISO: string) => Promise<AuditCoverageResult | null>;
  checkExportCompleteness: (transactionId: string) => Promise<ExportCompletenessResult | null>;
  runMessagesImport: (
    proposedStartISO: string | null,
    transactionId?: string,
  ) => Promise<RunMessagesImportOutcome>;
  importing: boolean;
  /**
   * BACKLOG-2344: `progress.percent` is the MONOTONIC OVERALL percent (0→~92)
   * across every import phase — NOT the raw per-phase percent the backend emits.
   * The other fields (phase/current/total) are carried through unchanged for
   * debugging; only `percent` is remapped for display.
   */
  progress: CoverageImportProgress | null;
  /**
   * BACKLOG-2344: TRUE only as a FALLBACK — when the backend reports a phase we
   * don't have an overall-progress band for, we can't honestly place it on the
   * bar, so the popup shows an indeterminate "Updating…" bar instead of guessing.
   * Recognized phases now render a monotonic determinate bar (no 100→0 looping),
   * superseding the earlier BACKLOG-2305 "reset ⇒ indeterminate" heuristic.
   */
  indeterminate: boolean;
}

/**
 * BACKLOG-2305 failsafe watchdog constants. The coverage operation can run for
 * minutes on a large device (the founder observed an 82,841-message deep import),
 * so the guarantee is NOT a short absolute timeout — it is:
 *   - IDLE: if NO import-progress event AND no IPC resolution arrive for this long,
 *     the operation is treated as stalled and the popup is re-enabled. Every
 *     progress event re-arms this timer, so a genuinely-progressing import never
 *     trips it.
 *   - HARD CAP: an absolute ceiling (matches the importer's own MAX_IMPORT_DURATION)
 *     so even a totally silent strand can never disable the buttons forever.
 * Either firing re-enables the UI — the buttons can NEVER stay permanently
 * disabled (the BACKLOG-2305 hang).
 */
export const IMPORT_IDLE_FAILSAFE_MS = 180_000; // 3 min of no progress + no resolution
export const IMPORT_HARD_CAP_MS = 10 * 60_000; // 10 min absolute ceiling

/**
 * BACKLOG-2344: honest, monotonic audit-range progress.
 *
 * The macOS Messages import (macOSMessagesImportService.importMessages) reports
 * progress PER PHASE, and every phase sweeps its OWN 0→100 — querying, then
 * importing (store), then attachments. Rendered raw on a single bar the user sees
 * it fill to 100, snap back to 0, and crawl again ("0→100→0→~40 and stuck",
 * support #90). The stall is a DISPLAY artifact: the long store phase on a large
 * device import is slow-but-progressing, made to look frozen by the reset + the
 * absence of any phase label.
 *
 * Fix: map each phase into an ascending slice of ONE overall bar and clamp the
 * result monotonic, so the bar only ever moves forward. Bands are ordered and
 * top out at a 92% ceiling; the final ~8% is reserved for the SILENT attached-
 * thread expansion tail that runs after importMessages returns (it emits no
 * progress). That keeps the bar from ever showing 100% before the operation
 * truly resolves — honest completion, never faked.
 */
const PHASE_BANDS: Record<ImportPhase, { start: number; end: number }> = {
  deleting: { start: 0, end: 5 },
  querying: { start: 5, end: 30 },
  importing: { start: 30, end: 75 },
  // BACKLOG-3132: attachments used to run 75->92, taking the bar to the ceiling.
  // It now stops at 88 so `finalizing` has somewhere to sit. The two numbers mean
  // different things: 88 is "every attachment is processed", 92 is "the import
  // has saved and returned". Before this item they were the same number, which is
  // why the end of a run looked finished while ~2 s of swap was still to come.
  attachments: { start: 75, end: 88 },
  // Unlike the others this phase does NOT sweep its band: the producer emits one
  // event for it, so the bar steps 88 -> 88 and holds until the import returns.
  // The band exists to separate the two meanings above, not to animate.
  finalizing: { start: 88, end: 92 },
};
/** Overall ceiling while importing — the last 8% is the silent expansion tail. */
const IMPORT_PROGRESS_CEILING = 92;
/**
 * BACKLOG-2832: the lookup view. `PHASE_BANDS` is exhaustive over `ImportPhase`
 * so a new phase without a band is a compile error, but the value arriving over
 * IPC is still typed `string` (CoverageImportProgress.phase) on purpose — the
 * `else` branch below is the deliberate BACKLOG-2344 indeterminate fallback for
 * a phase we have no honest band for. This alias keeps that lookup working with
 * a string key and no cast; it is a reference copy, not a second table.
 */
const BAND_LOOKUP: Readonly<Record<string, { start: number; end: number } | undefined>> =
  PHASE_BANDS;

export function useAuditCoverageCheck(userId: string): UseAuditCoverageCheckResult {
  const [importing, setImporting] = useState<boolean>(false);
  const [progress, setProgress] = useState<CoverageImportProgress | null>(null);
  const [indeterminate, setIndeterminate] = useState<boolean>(false);

  const checkCoverage = useCallback(
    async (proposedStartISO: string): Promise<AuditCoverageResult | null> => {
      if (!userId || !proposedStartISO) return null;
      try {
        return await window.api.transactions.getAuditCoverage(userId, proposedStartISO);
      } catch {
        // Detection failure must never block the create/edit flow (the export
        // gate remains the backstop). Treat as "no gap".
        return null;
      }
    },
    [userId],
  );

  const checkExportCompleteness = useCallback(
    async (transactionId: string): Promise<ExportCompletenessResult | null> => {
      if (!userId || !transactionId) return null;
      try {
        return await window.api.transactions.checkExportCompleteness(transactionId, userId);
      } catch {
        return null;
      }
    },
    [userId],
  );

  const runMessagesImport = useCallback(
    async (
      proposedStartISO: string | null,
      transactionId?: string,
    ): Promise<RunMessagesImportOutcome> => {
      setImporting(true);
      setProgress(null);
      setIndeterminate(false);

      // BACKLOG-2305 failsafe: the buttons are disabled purely by `importing`,
      // which clears in the finally below. If the coverage IPC resolution is ever
      // lost (the observed hang: backend completed, renderer never notified), the
      // finally would never run and the user would be trapped. Race the IPC
      // against an idle/hard-cap watchdog so `importing` is GUARANTEED to clear.
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let tripFailsafe: ((o: RunMessagesImportOutcome) => void) | undefined;
      // BACKLOG-2344: monotonic overall percent accumulated across all phases.
      let overall = 0;

      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!settled) {
            tripFailsafe?.({
              ran: false,
              importRan: false,
              floorISO: null,
              timedOut: true,
              error: "Still updating messages in the background",
            });
          }
        }, IMPORT_IDLE_FAILSAFE_MS);
      };

      const failsafe = new Promise<RunMessagesImportOutcome>((resolve) => {
        tripFailsafe = resolve;
        armIdle();
        hardTimer = setTimeout(() => {
          if (!settled) {
            resolve({
              ran: false,
              importRan: false,
              floorISO: null,
              timedOut: true,
              error: "Still updating messages in the background",
            });
          }
        }, IMPORT_HARD_CAP_MS);
      });

      const unsub = window.api.messages?.onImportProgress
        ? window.api.messages.onImportProgress((p) => {
            // BACKLOG-2344: map this phase's own 0→100 into its slice of the
            // overall bar, then clamp so the bar only ever advances.
            //
            // BACKLOG-3132 removed ONE of the two reasons this clamp existed. The
            // importer used to emit a late "importing 100%" AFTER attachments —
            // the swap signal, wearing the wrong phase — which mapped back down
            // into the importing band and dragged the bar backwards. That event
            // now has its own forward phase (`finalizing`), so it no longer
            // reverses.
            //
            // The clamp STAYS, because its other reason is untouched: every phase
            // still sweeps its own 0→100, so without `Math.max` the bar would
            // reset to the next band's floor at each phase change. Pinned — remove
            // the `Math.max` and this hook's suite goes red.
            const band = BAND_LOOKUP[p.phase];
            if (band) {
              const frac = Math.max(0, Math.min(100, p.percent)) / 100;
              const mapped = band.start + frac * (band.end - band.start);
              overall = Math.min(IMPORT_PROGRESS_CEILING, Math.max(overall, mapped));
            } else {
              // Unknown phase — we can't place it on the overall bar honestly, so
              // fall back to the indeterminate "Updating…" bar instead of guessing.
              setIndeterminate(true);
            }
            // Carry phase/current/total through for debugging; override only the
            // displayed percent with the monotonic overall value.
            setProgress({ ...p, percent: overall });
            armIdle(); // live activity → push the idle watchdog out
          })
        : () => {};

      const ipcCall: Promise<RunMessagesImportOutcome> = (async () => {
        try {
          const result = await window.api.transactions.ensureMessagesCoverage(
            userId,
            proposedStartISO,
            transactionId,
          );
          return {
            ran: result.ran,
            importRan: result.importRan,
            floorISO: result.messagesFloorISO,
            error: result.error,
          };
        } catch (err) {
          return {
            ran: false,
            importRan: false,
            floorISO: null,
            error: err instanceof Error ? err.message : "Import failed",
          };
        }
      })();

      try {
        return await Promise.race([ipcCall, failsafe]);
      } finally {
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (hardTimer) clearTimeout(hardTimer);
        unsub();
        setImporting(false);
        setProgress(null);
        setIndeterminate(false);
      }
    },
    [userId],
  );

  return {
    checkCoverage,
    checkExportCompleteness,
    runMessagesImport,
    importing,
    progress,
    indeterminate,
  };
}
