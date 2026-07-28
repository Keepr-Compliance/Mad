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
}

export function useAuditCoverageCheck(userId: string): UseAuditCoverageCheckResult {
  const [importing, setImporting] = useState<boolean>(false);
  const [progress, setProgress] = useState<CoverageImportProgress | null>(null);

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
      const unsub = window.api.messages?.onImportProgress
        ? window.api.messages.onImportProgress((p) => setProgress(p))
        : () => {};
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
      } finally {
        unsub();
        setImporting(false);
        setProgress(null);
      }
    },
    [userId],
  );

  return { checkCoverage, checkExportCompleteness, runMessagesImport, importing, progress };
}
