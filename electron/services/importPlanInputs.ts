/**
 * Import Plan Inputs — BACKLOG-2772
 *
 * The ONE place the resolver's inputs are gathered.
 *
 * `importPlan.ts` is pure: it decides, but it reads nothing. This module is its
 * only supplier — it loads the stored preferences and derives the audit spans,
 * and every entry point calls `resolveImportPlanForUser` rather than assembling
 * either one itself.
 *
 * ## Why a separate module, rather than doing this in each handler
 *
 * Because doing it in each handler is the defect. Before this, the preference
 * load lived in `messageImportHandlers.ts` (with its own `?? 50000` collapse —
 * BACKLOG-2733), the non-rejected-transaction query lived there too, and
 * `messagesSyncTrigger.ts` had a THIRD assembly whose entire filter object was
 * `{ auditPeriodStart }` — no lookback, no cap, no attachment preference. A
 * pure resolver alone would not have fixed that: three callers would simply
 * have built three different requests and the resolver would have faithfully
 * honoured all three.
 *
 * One decider needs one supplier.
 */

import logService from "./logService";
import supabaseService from "./supabaseService";
import { dbAll } from "./db/core/dbConnection";
import { unsafeSql } from "./db/core/sqlText";
import { computeTransactionDateRange } from "../utils/emailDateRange";
import {
  resolveImportPlan,
  type AuditSpan,
  type ImportMode,
  type ImportPlan,
  type ImportPlanRequest,
  type StoredImportFilters,
} from "./importPlan";

import { LIVE_TRANSACTION_SQL_PREDICATE_UNALIASED } from "./transactionEligibility";

const SERVICE_NAME = "ImportPlanInputs";

/** Transaction date columns, as stored. */
export interface TransactionDateRow {
  started_at: string | null;
  created_at: string | null;
  closed_at: string | null;
}

/**
 * Read the transactions whose audit periods bear on an import.
 *
 * BACKLOG-2308 settled this filter: `status != 'rejected'`. Pending, active and
 * closed deals all carry an audit-completeness obligation — "treat closed as
 * live" is the standing definition, reaffirmed by the founder when Cap' was
 * fixed. Rejected deals are dead and protect nothing.
 *
 * The prior spelling `!= 'archived'` was a dead no-op ('archived' is not a
 * valid status), so rejected deals wrongly pinned the import floor.
 *
 * BACKLOG-2562: the predicate itself now comes from `transactionEligibility` —
 * the ONE definition — rather than being spelled out here. autoLinkService was
 * still carrying the dead form long after this file was migrated; a shared
 * constant is what stops the next reader drifting the same way.
 *
 * Every reader on the import side now goes through this function — the plan,
 * the transaction trigger's required-start, and the effective-window label —
 * and it matches the export gate's predicate
 * (`auditCoverageService.checkExportCompleteness`), so the two sides cannot
 * disagree about which deals carry an audit obligation.
 */
export function readNonRejectedTransactions(userId: string): TransactionDateRow[] {
  return dbAll<TransactionDateRow>(
    unsafeSql(`SELECT started_at, created_at, closed_at
       FROM transactions
      WHERE user_id = ? AND ${LIVE_TRANSACTION_SQL_PREDICATE_UNALIASED}`),
    [userId]
  );
}

/**
 * Derive one audit span per non-rejected deal.
 *
 * The START is `computeTransactionDateRange`'s — the same producer the email
 * fetch and `computeEarliestAuditStart` read (started_at -> created_at -> a
 * two-year fallback). Transcribed, not re-derived: an import that disagreed
 * with the email fetch about when a deal's audit period begins would build an
 * audit out of two different windows.
 *
 * The END is deliberately NOT that function's. `computeTransactionDateRange`
 * returns "today" as the end for a deal with no `closed_at`, which is right for
 * bounding a fetch and wrong for a PROTECTED period: a protection that expires
 * at the instant it was computed would start excluding messages the moment the
 * query ran, and every message arriving on a live deal after that would be
 * counted against the cap. An unclosed deal's audit period is open-ended, and
 * that is what `null` says here.
 */
export function deriveAuditSpans(userId: string): AuditSpan[] {
  const spans: AuditSpan[] = [];
  for (const txn of readNonRejectedTransactions(userId)) {
    const { start, end } = computeTransactionDateRange(txn);
    spans.push({
      startISO: start.toISOString(),
      // Closed deal -> a real upper bound (with the buffer the shared helper
      // applies). Open deal -> open-ended, see above.
      endISO: txn.closed_at ? end.toISOString() : null,
    });
  }
  return spans;
}

/**
 * Load the stored `messageImport.filters` preference object.
 *
 * Returned RAW and unresolved. The temptation is to resolve `lookbackMonths`
 * and `maxMessages` here, and that is precisely what must not happen: a
 * pre-resolved value lets a caller resolve it differently first, which is the
 * two-readers-of-one-fact shape BACKLOG-2561, 2733 and 2760 all were.
 * `resolveImportPlan` is the only resolver.
 *
 * A failure to read preferences is non-fatal and returns `null`, which the
 * resolver treats as "no preference stored" — the documented defaults.
 */
export async function loadStoredImportFilters(
  userId: string
): Promise<StoredImportFilters | null> {
  try {
    const preferences = await supabaseService.getPreferences(userId);
    return preferences?.messageImport?.filters ?? null;
  } catch (error) {
    logService.warn(
      "Failed to load import filter preferences; falling back to the stored defaults",
      SERVICE_NAME,
      { error: error instanceof Error ? error.message : String(error) }
    );
    return null;
  }
}

/** What an entry point states about the run it wants. */
export interface ImportPlanContext {
  userId: string;
  mode: ImportMode;
  /**
   * An explicit lower bound this run must reach — the transaction trigger's
   * `proposedStartISO`, for a deal being created or having its start date moved
   * earlier. Absent for the Settings buttons and background sync, whose bound
   * comes entirely from the preference and the existing deals.
   */
  requestedStartISO?: string | null;
  /**
   * The Settings panel's CURRENT, not-yet-saved selection, layered over the
   * stored preference.
   *
   * Only the estimate channel supplies this, and it is a legitimate
   * per-entry-point difference of the kind that belongs in the REQUEST rather
   * than in a second assembler: the user changes the dropdown and expects the
   * estimate beneath it to move before they have saved anything. Every other
   * entry point reads the stored preference alone.
   *
   * BACKLOG-2760 is what this replaces. The estimate used to build its own
   * filters from whatever the renderer sent, so the number on the screen and
   * the number the button would import were computed by two different
   * assemblers and raced each other. Layering here means both go through the
   * same resolver and can differ only by this one stated input.
   */
  selectionOverride?: StoredImportFilters | null;
}

/**
 * Gather the inputs and resolve the plan. THE entry point for every import.
 *
 * `now` is injectable so a caller's tests can pin it; production never passes it.
 */
export async function resolveImportPlanForUser(
  context: ImportPlanContext,
  now: Date = new Date()
): Promise<ImportPlan> {
  const stored = await loadStoredImportFilters(context.userId);
  // Key-by-key, so an override that mentions only `lookbackMonths` does not
  // silently erase a stored cap. An explicitly-null value in the override is a
  // CHOICE ("All time" / "Unlimited") and must survive the merge, so this
  // cannot use `??` on the object's fields — the same operator that caused
  // BACKLOG-2561 and 2733.
  const override = context.selectionOverride;
  const storedFilters: StoredImportFilters | null =
    override === null || override === undefined
      ? stored
      : { ...(stored ?? {}), ...override };

  // A failure to read deals is non-fatal, and it degrades in the SAFE
  // direction: no spans means no protection and no widening, so the run
  // honours the user's own selection exactly. It must never widen on a guess.
  let auditSpans: AuditSpan[] = [];
  try {
    auditSpans = deriveAuditSpans(context.userId);
  } catch (error) {
    logService.warn(
      "Failed to derive audit spans for the import plan; using the stored selection alone",
      SERVICE_NAME,
      { error: error instanceof Error ? error.message : String(error) }
    );
  }

  const request: ImportPlanRequest = {
    mode: context.mode,
    storedFilters,
    auditSpans,
    requestedStartISO: context.requestedStartISO ?? null,
  };

  return resolveImportPlan(request, now);
}
