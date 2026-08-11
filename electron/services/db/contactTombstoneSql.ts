/**
 * Contact tombstone predicates — BACKLOG-2365.
 *
 * Removing a contact writes `contacts.removed_at` (migration v56) instead of
 * `DELETE FROM contacts`, so that the FK cascade never fires and the contact's
 * emails, phones and — the reason this matters — its `transaction_contacts`
 * ROLES on audited deals survive the removal.
 *
 * The cost of that choice is that removed rows are still physically present, so
 * every query that shows a user a LIST of contacts has to say it isn't
 * interested in them. This module exists so that sentence is written ONCE.
 *
 * ## Why a shared constant and not `AND c.removed_at IS NULL` typed inline
 *
 * The main Clients & Contacts list query exists TWICE, byte-identical, in two
 * files: `contactDbService.getImportedContactsByUserId` and
 * `contactQueryWorker.runImportedQuery`. The worker copy is the one that
 * actually runs whenever the worker pool is up — which is to say, in
 * production. Filtering one copy and not the other produces a build where every
 * test passes and the founder still sees deleted contacts on screen. Both files
 * import from here for exactly that reason.
 *
 * ## What deliberately does NOT use these
 *
 * Not every read of `contacts` should hide a removed row, and the distinction is
 * not cosmetic:
 *
 *  - **Lookups by id** (`getContactById`, `getContactUserId`) must keep
 *    returning removed contacts. They are how a contact is audited, updated and
 *    — once BACKLOG-2367 lands — restored. Filtering them makes a removed
 *    contact permanently unreachable, which is just a slower hard delete.
 *  - **Name resolution for historical communications** (phone/email → display
 *    name in an email header, a text thread, an export) keeps resolving removed
 *    contacts. A removal takes someone off the contact list; it does not redact
 *    who was on a message that has already been captured. Blanking those names
 *    back to raw phone numbers would destroy audit fidelity to achieve nothing.
 *  - **Dedup / matching lookups** (`findContactByNormalizedPhone`,
 *    `contactSourceLinker`) are untouched here by instruction — the
 *    one-matching-rule work is BACKLOG-2369/2370, and the tombstone-side defect
 *    in matching is BACKLOG-2636.
 *
 *    `findContactByName` was named in this list until BACKLOG-2617 DELETED it.
 *    Its missing tombstone filter was not a cosmetic omission: it sat on the
 *    CREATE path, so a REMOVED contact could capture a new create — press Save
 *    and get back the person you deleted. Nothing on the create path resolves
 *    identity any more, so that path is now indifferent to tombstones by
 *    construction rather than by filter.
 */

/**
 * Tombstone filter for a query that aliases `contacts` (conventionally `c`).
 * Emitted with a leading space so it appends cleanly onto an existing WHERE.
 *
 * @example
 *   WHERE c.user_id = ? AND c.is_imported = 1${activeContactsClause("c")}
 */
export function activeContactsClause(alias: string): string {
  return ` AND ${alias}.removed_at IS NULL`;
}

/**
 * Tombstone filter for a query with no table alias (bare `FROM contacts`).
 */
export const ACTIVE_CONTACTS_CLAUSE_UNALIASED = " AND removed_at IS NULL";

/**
 * Aliased form for the overwhelmingly common `c` alias, pre-rendered so call
 * sites read as plain SQL inside a template literal.
 */
export const ACTIVE_CONTACTS_CLAUSE_C = activeContactsClause("c");
