/**
 * Reaction exclusion SQL helper (BACKLOG-2280).
 *
 * ONE shared local-side clause so every list / count / search / contact /
 * autolink reader excludes stored tapback (reaction) rows consistently. Reactions
 * are stored as ordinary `messages` rows (see BACKLOG-2280) with a non-null
 * `associated_message_type` in the [2000,3005] band; without this filter they
 * would leak into conversation lists, counts, LLM analysis, and search as empty
 * junk bubbles.
 *
 * This is the LOCAL analogue of macOSMessagesImportService's
 * `reactionExclusionSqlClause()` (which uses the `message.` source-table prefix).
 * Here the alias is the LOCAL `messages` table (aliased `m` in many queries, or
 * unqualified), so the alias is a parameter and there is NO `message.` prefix.
 *
 * Returns a bare boolean predicate (no leading AND) — callers append it with
 * `AND ${reactionExclusion(alias)}`.
 */

import { sql, type SafeSql } from "./core/sqlText";

/**
 * The `messages` aliases this predicate is written for. A CLOSED set, not a `string`.
 *
 * BACKLOG-3085: an alias is an IDENTIFIER — SQLite cannot bind one — so the `sql`
 * tag refuses to splice it, correctly. Enumerating the aliases keeps this a checked
 * producer: a query wanting a third alias has to add it here AND to `ALIAS_PREFIX`,
 * and the compiler makes that mandatory rather than remembered.
 */
export type MessagesAlias = "" | "m" | "m2";

const ALIAS_PREFIX: Record<MessagesAlias, SafeSql> = {
  "": sql``,
  m: sql`m.`,
  m2: sql`m2.`,
};

/**
 * The tapback band, as SQL text.
 *
 * These are the same two numbers as `REACTION_TYPE_BAND_MIN` / `_MAX` in
 * `utils/reactionUtils`, which remain the source of truth for the JavaScript-side
 * test. They are restated here rather than interpolated because the tag refuses a
 * number, and the two statements of them are held equal by
 * `__tests__/reactionExclusion.brand.test.ts` — a CHECKED duplication rather than a
 * remembered one. Change one and that test goes red.
 */
const BAND_MIN_SQL = sql`2000`;
const BAND_MAX_SQL = sql`3005`;

/**
 * Build the reaction-exclusion predicate for the local `messages` table.
 *
 * @param alias - Table alias used in the query (e.g. "m"). Omit / "" when the
 *   `messages` table is referenced without an alias.
 * @returns A parenthesized boolean SQL expression that is TRUE for non-reaction
 *   rows (NULL associated_message_type or a value outside the tapback band).
 */
export function reactionExclusion(alias: MessagesAlias = ""): SafeSql {
  const p = ALIAS_PREFIX[alias];
  return sql`(${p}associated_message_type IS NULL OR ${p}associated_message_type NOT BETWEEN ${BAND_MIN_SQL} AND ${BAND_MAX_SQL})`;
}

/** Unqualified variant for queries that reference `messages` without an alias. */
export const LOCAL_REACTION_EXCLUSION = reactionExclusion();
