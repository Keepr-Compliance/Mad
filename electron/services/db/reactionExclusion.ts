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

import {
  REACTION_TYPE_BAND_MIN,
  REACTION_TYPE_BAND_MAX,
} from "../../utils/reactionUtils";

/**
 * Build the reaction-exclusion predicate for the local `messages` table.
 *
 * @param alias - Table alias used in the query (e.g. "m"). Omit / "" when the
 *   `messages` table is referenced without an alias.
 * @returns A parenthesized boolean SQL expression that is TRUE for non-reaction
 *   rows (NULL associated_message_type or a value outside the tapback band).
 */
export function reactionExclusion(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return (
    `(${p}associated_message_type IS NULL` +
    ` OR ${p}associated_message_type NOT BETWEEN ${REACTION_TYPE_BAND_MIN} AND ${REACTION_TYPE_BAND_MAX})`
  );
}

/** Unqualified variant for queries that reference `messages` without an alias. */
export const LOCAL_REACTION_EXCLUSION = reactionExclusion();
