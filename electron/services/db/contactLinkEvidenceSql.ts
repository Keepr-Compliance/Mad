/**
 * SQL for contact link evidence — BACKLOG-3044 PR 2.
 *
 * Moved out of `electron/services/contactLinkEvidence.ts` (4 sites), **together with
 * the `onTransaction` fragment they splice**. The fragment had to come too: leaving it
 * behind would have moved a statement into the layer that still interpolates SQL text
 * authored in a service, which is the half-done state the PR split exists to avoid.
 *
 * ## `onTransactionFor` — a NAMED PARAMETER rename, not a value splice
 *
 * The base wrote the predicate once with `@c` and then produced two copies with
 * `onTransaction.replace(/@c/g, "@a")` and `…"@b"`. `@a` and `@b` are SQLite NAMED BIND
 * PARAMETERS: the contact ids never enter the text, they travel in the params object
 * (`[{ a: contactA, b: contactB }]`). So this is placeholder naming, not a value
 * reaching SQLite as text, and it converts cleanly — unlike the four statements
 * BACKLOG-3103 owns, where a status VALUE really is quoted into the text.
 *
 * It is expressed as an alias-taking producer on the `reactionExclusion(alias)`
 * precedent rather than as two hand-written copies, so the predicate still has exactly
 * one statement of itself. The runtime `.replace()` is gone with it: the parameter is
 * now spliced as a `SafeSql` fragment at the one position it belongs, instead of being
 * rewritten out of finished text by a regular expression.
 *
 * **The base declared this fragment TWICE, in two functions.** The two were checked
 * byte-identical by execution before being collapsed into this one producer — had they
 * differed, collapsing them would have silently changed one of the two statements, and
 * the skeleton-level identity control could not have seen it.
 *
 * ## Why the predicate is deliberately NOT filtered by `removed_at`
 *
 * Carried verbatim from the base, because it is the kind of comment that gets
 * "corrected" by someone tidying: two contacts appearing on the same transaction is
 * evidence they are DIFFERENT PEOPLE — you do not put one human on a deal twice — so
 * this is an ANTI-merge signal and it stays true after one of them is taken off the
 * deal. Filtering by `removed_at` here would DISCARD evidence and make a wrong merge
 * more likely (BACKLOG-2366).
 *
 * Text is byte-identical to what it replaced, and the fragment's own text is pinned by
 * `__tests__/contactFragments.movedText.test.ts` — the skeleton control renders an
 * interpolation as a marker, so a moving fragment needs a control of its own.
 */

import { sql } from "./core/sqlText";
import type { SafeSql } from "./core/sqlText";

/** Which side of the pair a predicate copy binds. */
type TransactionPairSide = "a" | "b";

/**
 * The named bind parameter per side. Declared as `SafeSql` constants rather than
 * interpolated from the `side` string, because the tag refuses a bare `string` — which
 * is exactly the protection that makes this conversion safe rather than incidental.
 */
const SIDE_PARAM: Record<TransactionPairSide, SafeSql> = {
  a: sql`@a`,
  b: sql`@b`,
};

/**
 * "This transaction involves the contact bound to `@a` / `@b`", as a parenthesised
 * boolean expression over the `transactions` table aliased `t`.
 *
 * Six ways a contact can be on a deal, and all six count: the four role columns, a
 * `transaction_contacts` row, and a `json_each` membership test over the
 * `other_contacts` JSON array. The consuming statement MUST alias `transactions` as
 * `t`.
 */
function onTransactionFor(side: TransactionPairSide): SafeSql {
  const c = SIDE_PARAM[side];
  return sql`(
      t.buyer_agent_id = ${c}
      OR t.seller_agent_id = ${c}
      OR t.escrow_officer_id = ${c}
      OR t.inspector_id = ${c}
      OR EXISTS (
        SELECT 1 FROM transaction_contacts tc
         WHERE tc.transaction_id = t.id AND tc.contact_id = ${c}
      )
      OR (
        t.other_contacts IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM json_each(t.other_contacts) j WHERE j.value = ${c}
        )
      )
    )`;
}

/** A contact's display name. One bound parameter: contact id. */
export const CONTACT_DISPLAY_NAME_SQL = sql`SELECT display_name FROM contacts WHERE id = ?`;

/**
 * One external record's name. Three bound parameters: user id, source, external record
 * id.
 */
export const EXTERNAL_RECORD_NAME_SQL = sql`SELECT name FROM external_contacts
      WHERE user_id = ? AND source = ? AND external_record_id = ? LIMIT 1`;

/**
 * Do these two contacts appear on any transaction together? Named parameters `@a` and
 * `@b`.
 *
 * `LIMIT 1` because the question is existence, not count.
 */
export const CONTACTS_SHARE_TRANSACTION_SQL = sql`SELECT 1 AS hit FROM transactions t
      WHERE ${onTransactionFor("a")}
        AND ${onTransactionFor("b")}
      LIMIT 1`;

/**
 * The addresses of transactions the two contacts share, for the "both appear on" line.
 * Named parameters `@a` and `@b`.
 *
 * `LIMIT 3` is a rendering decision that lives in the statement: the sentence names at
 * most three deals. `ORDER BY t.property_address` makes which three deterministic.
 */
export const SHARED_TRANSACTION_ADDRESSES_SQL = sql`SELECT t.property_address FROM transactions t
      WHERE ${onTransactionFor("a")}
        AND ${onTransactionFor("b")}
      ORDER BY t.property_address
      LIMIT 3`;
