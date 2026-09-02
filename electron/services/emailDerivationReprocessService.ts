/**
 * BACKLOG-2857 — repair emails produced by a superseded derivation.
 *
 * WHAT THIS FIXES, CONCRETELY
 * ---------------------------
 * Before BACKLOG-2855, every HTML email from Outlook stored Microsoft Graph's
 * `bodyPreview` — documented as "the first 255 characters of the message body" —
 * into `emails.body_plain`. That column is not a display convenience: it is the
 * one search (`transactionSearchDbService`, `e.body_plain LIKE ?`) and auto-link
 * (`autoLinkService`) read, and neither reads `body_html` at all. So for every
 * such message, anything past character 255 was not findable and any address past
 * character 255 could not auto-link. The full HTML was already on disk the whole
 * time; it was discarded at the mapper.
 *
 * 2855 fixed the mapper, which fixes mail arriving from now on. This pass fixes
 * the mail already stored, WITHOUT a re-download: it re-derives `body_plain` from
 * the `body_html` that was always there.
 *
 * WHY IT IS NOT A MIGRATION
 * -------------------------
 * `MigrationEntry.migrate` is typed `(d: DatabaseType) => void` — synchronous. A
 * pass over an entire mailbox that never yields would freeze the UI for its whole
 * duration, and a migration cannot `await`. v67 therefore adds the column and the
 * index only; the work happens here, at runtime, in yielding batches.
 *
 * THE TERMINATION INVARIANT — read before changing anything
 * ---------------------------------------------------------
 * The batch cursor IS the data: each pass selects rows `WHERE derived_version <
 * CURRENT` and every row it touches is stamped to CURRENT, which removes it from
 * that predicate. There is no offset and no saved position, which is exactly what
 * makes it resumable — kill the process at any point and the remaining set is
 * still precisely "the rows not yet done".
 *
 * The corollary is a trap: EVERY selected row must be stamped, including rows this
 * version cannot improve (no `body_html` to re-derive from, or a re-derivation that
 * produces nothing better). Stamping is the claim "version 1 has been applied to
 * this row", which is true even when version 1 had nothing to change. Skipping the
 * stamp on those rows would re-select them on the next iteration forever — an
 * infinite loop, not a slow pass.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * - It never blanks a body. If re-derivation yields empty text (no HTML, or HTML
 *   that is all markup), the existing `body_plain` is LEFT ALONE and the row is
 *   stamped. A repair that destroys the little text a row had would be worse than
 *   the truncation.
 * - It never touches the network. Class-1 versions are re-derivable from local
 *   data by definition; if a future version declares itself `"refetch"`, this pass
 *   REFUSES to run rather than stamping rows it cannot actually repair. Stamping a
 *   row that still needs a re-fetch would mark it repaired forever.
 * - It never widens beyond `body_plain` and `derived_version`. `updated_at` is
 *   deliberately not written: nothing in the codebase writes it today, and moving
 *   it here would make a silent repair look like a user edit.
 *
 * A DECISION, NOT AN ACCIDENT: HEALTHY GMAIL ROWS ARE REWRITTEN TOO
 * -----------------------------------------------------------------
 * Every pre-existing row sits at version 0 — including Gmail rows whose
 * `body_plain` is a GENUINE `text/plain` MIME part rather than a truncated
 * preview. This pass re-derives those from `body_html` as well, so a correct
 * column gets replaced by HTML-derived text that will differ in whitespace and
 * line breaks.
 *
 * That is accepted, for a reason that cannot be engineered around: nothing on
 * disk records WHICH rule produced a given row's `body_plain`. A genuine
 * text/plain part and a 255-char `bodyPreview` are both just text in the same
 * column. The post-2855 sync prefers the real part (`bodyPlain ||
 * htmlToPlainText(body)`), but that preference is applied at FETCH time against
 * data this pass no longer has. Mirroring it here is not possible — only
 * approximable by heuristics like "is it exactly 255 characters", which would
 * silently skip genuinely damaged rows that happen to be a different length.
 *
 * The cost is bounded and the benefit is not: both texts describe the same
 * message, `body_html` remains authoritative for rendering, and search/auto-link
 * (the only two readers) match on content that is present either way. The
 * alternative — leaving rows unrepaired because they MIGHT be healthy — is the
 * failure this whole item exists to remove. Locked by a test.
 *
 * Consequence worth knowing when reading the log line: `rewritten` counts these
 * rows too, so it is "rows whose text changed", NOT "truncated Outlook rows
 * recovered". The two are not the same number.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import {
  EMAILS_TABLE_EXISTS_SQL,
  EMAILS_TABLE_INFO_SQL,
  STAMP_DERIVATION_VERSION_SQL,
  UPDATE_BODY_AND_VERSION_SQL,
  prepareStaleEmailSelect,
} from "./db/emailDerivationSql";
import { getRawDatabase } from "./db/core/dbConnection";
import { htmlToPlainText } from "../utils/htmlToPlainText";
import {
  CURRENT_DERIVATION_VERSION,
  isLocallyRepairable,
  repairClassesFrom,
} from "../utils/derivationVersion";
import { yieldToEventLoop } from "./macOSMessagesImportService/importHelpers";

/**
 * Rows per batch. Small enough that the yield between batches keeps the UI
 * responsive on a large mailbox, large enough that the per-statement overhead
 * does not dominate. Each batch is one transaction.
 */
export const REPROCESS_BATCH_SIZE = 200;

export interface ReprocessOptions {
  /** Defaults to the live connection. Injected by tests. */
  db?: DatabaseType;
  /** Limit to one user. Omitted = every row in the database. */
  userId?: string;
  /** Rows per batch/transaction. */
  batchSize?: number;
  /**
   * Consulted BETWEEN batches. Returning true stops the pass cleanly, leaving
   * every already-processed row correctly stamped.
   */
  shouldCancel?: () => boolean;
  onProgress?: (progress: { scanned: number; rewritten: number }) => void;
}

export interface ReprocessResult {
  /** Rows selected and stamped to CURRENT. */
  scanned: number;
  /** Subset of `scanned` whose `body_plain` actually changed. */
  rewritten: number;
  /** Rows stamped without a body change (nothing to re-derive from). */
  unchanged: number;
  batches: number;
  cancelled: boolean;
  /**
   * True when the pass declined to run because reaching CURRENT needs a
   * provider re-fetch. Nothing is stamped in that case.
   */
  skippedNeedsRefetch: boolean;
}

interface StaleRow {
  id: string;
  body_plain: string | null;
  body_html: string | null;
  derived_version: number;
}

/**
 * Re-derive one row's plain text.
 *
 * Returns the replacement text, or null to mean "leave `body_plain` as it is"
 * (the row is still stamped — see the termination invariant above).
 *
 * EXTEND HERE when adding a class-1 version: switch on `fromVersion` so each
 * version applies only the transforms a row has not already had.
 */
export function reDeriveRow(row: {
  body_plain: string | null;
  body_html: string | null;
}): string | null {
  const derived = htmlToPlainText(row.body_html);

  // Nothing recoverable — no HTML, or HTML carrying no text. Keep what is there.
  if (!derived) return null;

  // Identical to what is stored: stamp, but do not spend a write.
  if (derived === (row.body_plain ?? "")) return null;

  return derived;
}

/**
 * Repair every row below CURRENT_DERIVATION_VERSION, in resumable batches.
 *
 * Safe to call on every import: when nothing is stale the first SELECT returns no
 * rows and the pass costs one indexed query.
 */
export async function reprocessEmailDerivations(
  options: ReprocessOptions = {},
): Promise<ReprocessResult> {
  const db = options.db ?? getRawDatabase();
  const batchSize = options.batchSize ?? REPROCESS_BATCH_SIZE;

  const result: ReprocessResult = {
    scanned: 0,
    rewritten: 0,
    unchanged: 0,
    batches: 0,
    cancelled: false,
    skippedNeedsRefetch: false,
  };

  // A row at 0 is the oldest thing we can be asked to repair, so it bounds the
  // work. If reaching CURRENT from there needs the provider, this pass must not
  // run at all: stamping a row it cannot repair would mark it fixed forever.
  if (!isLocallyRepairable(0)) {
    console.warn(
      `[derivation-reprocess] refusing to run — reaching v${CURRENT_DERIVATION_VERSION} requires ${repairClassesFrom(
        0,
      ).join("+")}; a local pass cannot repair those rows (BACKLOG-2857)`,
    );
    result.skippedNeedsRefetch = true;
    return result;
  }

  // The `emails` table is absent in some minimal fixtures; the column is absent
  // if v67 has not run. Either way there is nothing to do — and neither is an
  // error worth failing an import over.
  if (!hasDerivedVersionColumn(db)) return result;

  // Prepared once; the optional user clause and its bound parameter both come
  // from the single `options.userId` capture inside db/, so they cannot drift.
  const selectStmt = prepareStaleEmailSelect(db, options.userId);

  // Two statements, so a row whose text is unchanged costs a stamp and nothing
  // more. Neither writes `updated_at`.
  const updateBothStmt = db.prepare(UPDATE_BODY_AND_VERSION_SQL);
  const stampOnlyStmt = db.prepare(STAMP_DERIVATION_VERSION_SQL);

  // One transaction per batch. This is the unit of resumability: an interrupted
  // batch rolls back whole, so no row is left half-repaired — stamped but with
  // its old body, which would be the one state that loses data permanently.
  const applyBatch = db.transaction((rows: StaleRow[]) => {
    let rewritten = 0;
    for (const row of rows) {
      const next = reDeriveRow(row);
      if (next === null) {
        stampOnlyStmt.run(CURRENT_DERIVATION_VERSION, row.id);
      } else {
        updateBothStmt.run(next, CURRENT_DERIVATION_VERSION, row.id);
        rewritten++;
      }
    }
    return rewritten;
  });

  for (;;) {
    if (options.shouldCancel?.()) {
      result.cancelled = true;
      break;
    }

    const rows = selectStmt.all(CURRENT_DERIVATION_VERSION, batchSize) as StaleRow[];
    if (rows.length === 0) break;

    const rewritten = applyBatch(rows) as number;

    result.batches++;
    result.scanned += rows.length;
    result.rewritten += rewritten;
    result.unchanged += rows.length - rewritten;

    // Yield AFTER the transaction commits, never inside it — holding a write
    // transaction open across a yield would block every other writer.
    await yieldToEventLoop();
    options.onProgress?.({ scanned: result.scanned, rewritten: result.rewritten });
  }

  if (result.scanned > 0) {
    console.log(
      `[derivation-reprocess] repaired ${result.rewritten} of ${result.scanned} rows to v${CURRENT_DERIVATION_VERSION} in ${result.batches} batches (BACKLOG-2857)`,
    );
  }

  return result;
}

/** True when `emails` exists AND carries `derived_version` (i.e. v67 has run). */
function hasDerivedVersionColumn(db: DatabaseType): boolean {
  const hasTable = db
    .prepare(EMAILS_TABLE_EXISTS_SQL)
    .get();
  if (!hasTable) return false;

  const cols = (
    db.prepare(EMAILS_TABLE_INFO_SQL).all() as Array<{ name: string }>
  ).map((c) => c.name);
  return cols.includes("derived_version");
}
