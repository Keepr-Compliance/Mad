/**
 * Is a contact referenced by an EXPORTED (frozen) audit?
 *
 * ===========================================================================
 * WHY THIS PREDICATE HAS ITS OWN LEAF MODULE
 * ===========================================================================
 * It started life inside `contactSourceLinker`, whose only use for it was
 * refusing to CREATE a link. BACKLOG-2427 gave it a second caller —
 * `contactSourceValues`, which must refuse to REMOVE an address from a contact
 * an exported document already depends on.
 *
 * Leaving it in the linker would have made `contactSourceValues` import
 * `contactSourceLinker` while `contactSourceLinker` imports
 * `contactSourceValues` (it applies a source's values the moment it creates a
 * link). TypeScript's CommonJS emit happens to survive that cycle by late-
 * binding through the namespace object, but a require cycle that works by
 * accident is exactly the kind of thing that stops working when someone later
 * moves a call to module scope.
 *
 * So it lives here: a leaf with no service dependencies, imported by both.
 * `contactSourceLinker` re-exports it, so every existing import and test keeps
 * working unchanged.
 */

import { dbGet } from "./core/dbConnection";

/**
 * Is this contact referenced by an EXPORTED (frozen) transaction?
 *
 * `transactions.first_exported_at IS NOT NULL` is the freeze boundary
 * (BACKLOG-2013). The contact→transaction relationship is THREE-WAY and a
 * predicate that checks only the junction table under-reports:
 *   1. direct FK columns on `transactions` (buyer_agent_id, ...)
 *   2. the `transaction_contacts` junction
 *   3. the `other_contacts` JSON array
 */
/**
 * BACKLOG-2366 — THE JUNCTION CHECK BELOW IS DELIBERATELY NOT FILTERED BY
 * `removed_at`, which is the opposite of every other read of
 * `transaction_contacts` after that ticket.
 *
 * The question this predicate asks is not "is this contact a current party?" but
 * "did this contact's details go out in a filed audit?" — and removing someone
 * from a deal today cannot un-send yesterday's export.
 *
 * Adding the filter here would let a user remove a party from an already-exported
 * transaction and thereby unlock deletion of the email addresses and phone
 * numbers that defined that audit's search set (see contactSourceValues.ts:310),
 * silently changing what the filed artifact can be reconciled against.
 *
 * The tombstone makes this position STRONGER than it was: that junction row used
 * to be deleted outright on removal, so this check could go quiet on its own.
 */
export function isContactOnFrozenTransaction(contactId: string): boolean {
  // Named parameter: `contactId` appears six times and better-sqlite3 rejects
  // `?N` numbered placeholders, while six positional `?` would be an ordering
  // hazard on every future edit.
  const row = dbGet<{ hit: number }>(
    `SELECT 1 AS hit FROM transactions t
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
              SELECT 1 FROM json_each(t.other_contacts) j WHERE j.value = @contactId
            )
          )
        )
      LIMIT 1`,
    [{ contactId }],
  );
  return row !== undefined && row !== null;
}
