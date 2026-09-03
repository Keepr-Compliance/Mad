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
import { unsafeSql } from "./core/sqlText";
import { FROZEN_CONTACT_EXISTS_SQL } from "./frozenContactSql";

/**
 * Is this contact referenced by an EXPORTED (frozen) transaction?
 *
 * ===========================================================================
 * THE PREDICATE ITSELF LIVES IN `frozenContactSql.ts` — BACKLOG-2664
 * ===========================================================================
 * It used to be written out here, and that was fine while every caller could
 * run TypeScript. The backfill's content fallback
 * (`contactSourceLinkSql.CONTACT_SOURCE_RECORDS_SQL`) now has to ask the same
 * question from inside a query, on a worker thread that cannot import this
 * module. Two hand-written copies of a rule that guards an audit guarantee is a
 * drift waiting to happen, so the `EXISTS (...)` body is a shared constant and
 * this function is one of its two consumers.
 *
 * Read `frozenContactSql.ts` for what the predicate asks and why the junction
 * check ignores `removed_at`. `contactSourceLinkSql.frozenCopy-2664.test.ts`
 * holds the two consumers to the same answers.
 */
export function isContactOnFrozenTransaction(contactId: string): boolean {
  // Named parameter: `contactId` appears six times inside the fragment and
  // better-sqlite3 rejects `?N` numbered placeholders, while six positional `?`
  // would be an ordering hazard on every future edit.
  const row = dbGet<{ hit: number }>(
    unsafeSql(`SELECT 1 AS hit WHERE ${FROZEN_CONTACT_EXISTS_SQL}`),
    [{ contactId }],
  );
  return row !== undefined && row !== null;
}
