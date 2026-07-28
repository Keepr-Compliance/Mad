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
  progress: CoverageImportProgress | null;
  /**
   * BACKLOG-2305: TRUE once the import spans MULTIPLE passes (a per-pass 0→100
   * reset was observed). The determinate percentage is meaningless across passes,
   * so the popup switches to an indeterminate "Updating…" bar instead of visibly
   * looping 100%→0%.
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
/** A percent drop larger than this between consecutive events = a new pass. */
const PASS_RESET_DELTA = 10;

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
      let prevPercent = -1;

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
            // A per-pass reset (percent drops sharply) means the coverage op spans
            // multiple import passes — switch to indeterminate so the bar never
            // visibly loops 100%→0% (BACKLOG-2305).
            if (prevPercent >= 0 && p.percent + PASS_RESET_DELTA < prevPercent) {
              setIndeterminate(true);
            }
            prevPercent = p.percent;
            setProgress(p);
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
