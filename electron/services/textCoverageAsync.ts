/**
 * BACKLOG-3884: `transactions:get-text-coverage` without the main-thread scan.
 *
 * `getTransactionTextCoverage` (auditCoverageService) reads the per-source floors
 * synchronously (MESSAGES_FLOOR_BY_SOURCE_SQL, json_extract over every text row of the
 * user): ~3.5 s of main-process block per call on the PC, and the Texts tab asked
 * several times per open. This is the same answer built on
 * `getTransactionSourceCoverageAsync` (BACKLOG-3837: dedicated worker, per-user cache
 * invalidated by message writes, one read in flight per user, never on main). Until
 * the floors are known the answer is `pending` with no gaps — never "covered".
 *
 * The rest (the deal's window row, the linked-chat refinement) is a few indexed reads.
 */
import { dbGet } from "./db/core/dbConnection";
import { TRANSACTION_WINDOW_SQL } from "./db/auditCoverageSql";
import { getTransactionSourceCoverageAsync, sourceCoverageGaps } from "./auditCoverageService";
import { computeTransactionDateRange } from "../utils/emailDateRange";
import { isLiveTransactionStatus } from "./transactionEligibility";
import type { TextCoverageResult, TextSource } from "../types/auditCoverage";

/** Same contract as `getTransactionTextCoverage`, plus `pending`. Never throws. */
export async function getTransactionTextCoverageAsync(
  transactionId: string,
  userId: string,
  chosen: TextSource | null,
): Promise<TextCoverageResult> {
  try {
    const txn = dbGet<{ started_at: string | null; created_at: string | null; closed_at: string | null; status: string | null }>(
      TRANSACTION_WINDOW_SQL,
      [transactionId, userId],
    );
    if (!txn || !isLiveTransactionStatus(txn.status)) return { success: true, auditStartISO: null, gaps: [] };
    const auditStartISO = computeTransactionDateRange(txn).start.toISOString();
    const coverage = await getTransactionSourceCoverageAsync(userId, transactionId);
    if (!coverage) return { success: true, auditStartISO, gaps: [], pending: true };
    return { success: true, auditStartISO, gaps: sourceCoverageGaps(coverage, auditStartISO, chosen) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, auditStartISO: null, gaps: [], error: message };
  }
}
