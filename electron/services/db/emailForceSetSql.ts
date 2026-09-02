/**
 * The email force-set predicate — BACKLOG-2989 commit A2.
 *
 * Moved out of `electron/services/emailForceStaging.ts`. This is the ORIGIN of
 * the SQL, not a relocation of a signature: `EmailForceSetPredicate` used to
 * carry `sql` and `survivingSql` as fields, so a predicate built in one service
 * travelled as TEXT into a read view, a DELETE and a UNION source. That type is
 * gone. `EmailForceSet` carries DATA — who, which providers, from when — and
 * every statement is built here.
 *
 * ## The rule, and why the builders below are allowed
 *
 * A `db/` export may not EXECUTE SQL text it received as a parameter.
 *
 * `emailForceReadView` takes a `columns` string and returns text; it executes
 * nothing, and its caller keeps its own verb, so every execution stays an
 * enumerated call site. `deleteLiveForceSet` DOES execute — and takes no SQL,
 * only an `EmailForceSet`. Neither has the forbidden combination.
 *
 * ## What the predicate means, kept from the original
 *
 * Allow-list rather than deny-list, for the same reason as BACKLOG-2796: listing
 * the sources to SPARE re-plants the bug the moment somebody adds a third one.
 * An unrecognised row survives by default, which is the only defensible default
 * for a predicate whose failure mode is deleting the user's mail.
 *
 * `sent_at >= ?` bounds the set by the user's cache window: rows older than the
 * window are outside what the run re-downloads, so they are scoped OUT rather
 * than trimmed off the back of the corpus.
 *
 * Parameters are POSITIONAL because every caller splices this into a query that
 * already binds positionally. `params` travels with the SQL so the two cannot
 * drift apart.
 */

import type { Database as DatabaseType } from "better-sqlite3";

export type EmailForceProvider = "gmail" | "outlook";

const ALLOWED_PROVIDERS: readonly EmailForceProvider[] = ["gmail", "outlook"];

/**
 * A force set, as DATA. No SQL crosses this type.
 *
 * The predicate is derived from it on demand — which is what stops a caller
 * holding a SQL string whose bound parameters live somewhere else.
 */
export interface EmailForceSet {
  readonly userId: string;
  readonly providers: readonly EmailForceProvider[];
  readonly cacheSinceIso: string;
}

/**
 * Refuses a set that cannot be turned into a safe predicate.
 *
 * Throws rather than filtering: a provider this code does not recognise means
 * the caller's model and this module's have diverged, and the failure mode of
 * guessing is deleting mail the run cannot rebuild.
 */
export function assertRebuildableProviders(
  providers: readonly EmailForceProvider[],
): void {
  for (const provider of providers) {
    if (!ALLOWED_PROVIDERS.includes(provider)) {
      throw new Error(
        `Refusing to build an email force set for unknown source "${provider}"`,
      );
    }
  }
  if (providers.length === 0) {
    throw new Error("Refusing to build an email force set with no rebuildable provider");
  }
}

interface ForceSetPredicate {
  readonly sql: string;
  readonly survivingSql: string;
  readonly params: readonly string[];
}

/**
 * INTERNAL. The predicate, built fresh from the set each time it is needed.
 *
 * Not exported: a caller holding this object is exactly the SQL-carrier shape
 * this commit removes.
 */
function predicateFor(set: EmailForceSet): ForceSetPredicate {
  assertRebuildableProviders(set.providers);

  const sourceList = set.providers.map((p) => `'${p}'`).join(", ");
  const sql =
    `user_id = ? AND external_id IS NOT NULL ` +
    `AND source IN (${sourceList}) ` +
    `AND sent_at >= ?`;

  return {
    sql,
    // NULL-safe by hand. `source` is nullable past its CHECK constraint and
    // `sent_at` is nullable outright, so the force predicate CAN evaluate to
    // NULL. For such a row a plain `NOT (…)` is NULL — the row would survive
    // the DELETE (correct: a DELETE removes a row only when its WHERE is TRUE)
    // and then drop out of the rebuild's survivor read (wrong), which is
    // exactly how a surviving row stops being deduplicated against and gets
    // staged a second time. COALESCE spells out what "survived" means: the
    // force set was not TRUE.
    survivingSql: `COALESCE(${sql}, 0) = 0`,
    params: [set.userId, set.cacheSinceIso],
  };
}

/**
 * The read source for a run with a rebuild in flight: live rows the force set
 * LEAVES ALONE, unioned with what this run has staged so far.
 *
 * A pure text builder — it executes nothing, so its callers keep their verbs
 * and the gate keeps seeing them.
 *
 * `stagingTable` is quoted here; it is a runtime-generated name and is checked
 * by `checkedStagingTable` at construction (see `db/stagingDdlSql`).
 */
export function emailForceReadView(
  set: EmailForceSet,
  stagingTable: string,
  columns: string,
): { sql: string; params: readonly string[] } {
  const predicate = predicateFor(set);
  return {
    sql:
      `(SELECT ${columns} FROM emails WHERE ${predicate.survivingSql}` +
      ` UNION ALL SELECT ${columns} FROM "${stagingTable}")`,
    params: predicate.params,
  };
}

/**
 * Delete the force set from live `emails`.
 *
 * The one statement in this module that executes, and it takes no SQL — only
 * the set. Moved here because it consumed `forceSet.sql` directly, so it could
 * not stay behind once the predicate stopped travelling as text.
 *
 * The FK cascades this fires are the POINT, not an obstacle: deleting the force
 * set with an ordinary DELETE is what makes link loss happen exactly as it does
 * for a messages force re-import, which is the parity the founder asked for.
 */
export function deleteLiveForceSet(db: DatabaseType, set: EmailForceSet): number {
  const predicate = predicateFor(set);
  return db.prepare(`DELETE FROM emails WHERE ${predicate.sql}`).run(...predicate.params)
    .changes;
}
