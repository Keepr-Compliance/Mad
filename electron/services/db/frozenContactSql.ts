/**
 * THE FREEZE PREDICATE, AS A STRING (BACKLOG-2664)
 *
 * ===========================================================================
 * WHY A SQL FRAGMENT AND NOT JUST THE TYPESCRIPT FUNCTION
 * ===========================================================================
 * `frozenContactDbService.isContactOnFrozenTransaction` answers "did this
 * contact's details go out in a filed audit?" for callers that can run
 * TypeScript. Two writers cannot:
 *
 *   - `contactQueryWorker.runBackfillQuery` holds its OWN `better-sqlite3`
 *     handle on a worker thread and cannot import a db service;
 *   - its main-thread twin `contactHandlers.backfillImportedContactsFromExternal`
 *     could, but the two must agree, and the only thing they genuinely share is
 *     the SQL text in `contactSourceLinkSql.ts`.
 *
 * So the predicate is expressed ONCE, here, as an `EXISTS (...)` expression, and
 * both the TypeScript function and `CONTACT_SOURCE_RECORDS_SQL` are built from
 * it. A second hand-written copy inside the query would be a rule that could
 * drift from the rule it enforces — and this one is load-bearing for an audit
 * guarantee, so drift would be silent and consequential.
 *
 * BACKLOG-2669 UPDATE — READ THIS BEFORE ASSUMING THE QUERY STILL GATES ON IT.
 * `CONTACT_SOURCE_RECORDS_SQL` no longer interpolates this fragment, because the
 * branches it gated are deleted: the backfill reads crosswalk-linked records
 * only, so it cannot copy onto a frozen contact for the same reason it cannot
 * copy onto any contact. The gate became UNNECESSARY, not wrong — the two
 * writers above still cannot run TypeScript, and if either ever needs the freeze
 * question again, this is the one place to ask it. The sole consumer today is
 * `frozenContactDbService.isContactOnFrozenTransaction`, and the parity block in
 * `__tests__/contactSourceLinkSql.frozenCopy-2664.test.ts` still pins the string
 * and the function to the same answers.
 *
 * ===========================================================================
 * WHAT IT ASKS
 * ===========================================================================
 * `transactions.first_exported_at IS NOT NULL` is the freeze boundary
 * (BACKLOG-2013). The contact -> transaction relationship is THREE-WAY and a
 * predicate that checks only the junction table under-reports:
 *   1. direct FK columns on `transactions` (buyer_agent_id, ...)
 *   2. the `transaction_contacts` junction
 *   3. the `other_contacts` JSON array
 *
 * BACKLOG-2366 — THE JUNCTION CHECK IS DELIBERATELY NOT FILTERED BY
 * `removed_at`, which is the opposite of every other read of
 * `transaction_contacts` after that ticket. The question is not "is this contact
 * a current party?" but "did this contact's details go out in a filed audit?",
 * and removing someone from a deal today cannot un-send yesterday's export.
 *
 * ===========================================================================
 * USAGE
 * ===========================================================================
 * Takes ONE named parameter, `@contactId`. Named rather than positional because
 * it appears six times and every call site interpolates the fragment into a
 * larger statement, where six positional `?` would be an ordering hazard on
 * every future edit.
 *
 *   `SELECT 1 AS hit WHERE ${FROZEN_CONTACT_EXISTS_SQL}`   -- the predicate
 *   `... AND NOT ${FROZEN_CONTACT_EXISTS_SQL}`             -- a gate
 *
 * Aliases (`t`, `tc`, `oc`) are local to the subquery and chosen not to collide
 * with the aliases of the queries that embed it.
 */

/**
 * `EXISTS (...)` — true when `@contactId` is a party to a transaction that has
 * been exported.
 *
 * A complete boolean expression, so it composes under `NOT` without needing
 * parentheses added at the call site.
 */
import { sql } from "./core/sqlText";

export const FROZEN_CONTACT_EXISTS_SQL = sql`EXISTS (
    SELECT 1 FROM transactions t
     WHERE t.first_exported_at IS NOT NULL
       AND (
         t.buyer_agent_id = @contactId
         OR t.seller_agent_id = @contactId
         OR t.escrow_officer_id = @contactId
         OR t.inspector_id = @contactId
         -- BACKLOG-2366: deliberately NOT filtered by removed_at.
         -- See the docblock above for why.
         OR EXISTS (
           SELECT 1 FROM transaction_contacts tc
            WHERE tc.transaction_id = t.id AND tc.contact_id = @contactId
         )
         OR (
           t.other_contacts IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM json_each(t.other_contacts) oc WHERE oc.value = @contactId
           )
         )
       )
  )`;
