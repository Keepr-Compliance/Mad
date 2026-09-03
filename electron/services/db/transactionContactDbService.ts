/**
 * Transaction-Contact Database Service
 * Handles junction table operations between transactions and contacts
 *
 * ===========================================================================
 * REMOVAL IS A TOMBSTONE, NOT A DELETE (BACKLOG-2366)
 * ===========================================================================
 * `transaction_contacts` is where a party's ROLE lives — buyer's agent, lender,
 * title company. Until BACKLOG-2366 every removal was a hard DELETE, so taking
 * someone off a deal destroyed the only record that they had ever held that role
 * on it. On a transaction under audit that is evidence vanishing without trace.
 *
 * Removal now sets `removed_at`/`removed_reason` (migration v56) and the row
 * survives. Every read of a transaction's CURRENT parties filters
 * `removed_at IS NULL`.
 *
 * WHY AN IN-ROW TOMBSTONE RATHER THAN A SUPPRESSION TABLE. The comparable
 * feature — un-linking an email — uses a side table (`ignored_communications`).
 * That shape exists because the thing being suppressed (an email) has no row of
 * its own in the link table once unlinked. Here the junction row IS the record
 * worth keeping: it carries role, role_category, specific_role and the original
 * created_at. Migration v56 chose the in-row shape for exactly this reason; this
 * service implements it.
 *
 * RE-ADDING REVIVES, IT DOES NOT INSERT. `schema.sql` declares
 * UNIQUE(transaction_id, contact_id), so at most one row can exist per
 * (transaction, contact) pair. A second INSERT over a tombstone would not create
 * a duplicate — it would throw. Every write path therefore resolves an existing
 * row first and clears the tombstone on it.
 *
 * REMOVAL AS A NEGATIVE SIGNAL. No feature attaches a contact to a transaction
 * automatically. The three INSERT paths in this file are reachable only from
 * explicit user actions, and auto-detect deliberately stops short — it writes a
 * `suggested_contacts` JSON blob on `transactions`, and those become junction
 * rows only behind an Accept click.
 *
 * !! THIS PARAGRAPH USED TO END "So no feature can resurrect a removed role."
 * That sentence was TRUE BY ACCIDENT, and it is removed here (BACKLOG-2367)
 * because read as a guarantee it misleads the next engineer at precisely the
 * moment the guarantee stops holding. Nothing resurrects a removed role today
 * because the suggestions pipeline is DISCONNECTED — not because anything
 * guards against it.
 *
 * What actually stands between auto-detect and this table:
 *
 *  - A SHAPE MISMATCH between producer and consumer. The producer serialises a
 *    `ContactRoleExtraction`, an OBJECT — `{ assignments: [...] }`
 *    (`extraction/types.ts:73`, stringified at
 *    `transactionService/transactionService.ts:997`). The consumer does
 *    `if (Array.isArray(parsed))` and otherwise returns `[]` (the
 *    `suggestedContacts` useMemo in `useTransactionDetails.ts`). An object is
 *    not an array, so EVERY suggestion a real scan produces is discarded before
 *    render, and no Accept button can appear from one.
 *  - Two further mismatches sit behind that one, so repairing only the first
 *    still renders nothing: the consumer filters on `sc.role && sc.contact_id`
 *    (snake_case) while an assignment carries `contactId` (camelCase,
 *    `llm/tools/types.ts:85`), and that field is optional and never populated.
 *    Its own comment says "caller may match later"; no caller does. The stage
 *    that resolves an extracted `{name, email, phone}` to a contact id does not
 *    exist.
 *
 * WHAT HAPPENS THE DAY SOMEONE FIXES THAT PARSE. The Accept path goes live, and
 * it revives tombstones:
 *
 *  - Nothing filters the suggestion list against `transaction_contacts`, so a
 *    suggestion can name someone the user deliberately removed from that deal.
 *  - Accept calls `assignContactToTransaction`, whose existence probe is
 *    deliberately UNFILTERED by `removed_at IS NULL` (see the comment on that
 *    function) — so accepting CLEARS the tombstone. Accept All loops over every
 *    suggestion with no per-contact check
 *    (`useSuggestedContacts.ts:203-212`).
 *
 * The unfiltered probe is CORRECT for its own purpose: a user re-adding someone
 * by hand must revive the original row rather than collide with the UNIQUE
 * constraint, preserving role, is_primary, notes and created_at. It is only
 * wrong when the caller is a machine suggestion rather than a person — so the
 * filter belongs at the suggestion layer, not here. Whoever reconnects the
 * pipeline owns adding it, in the SAME change: the hazard is created by the
 * repair, not by the current state. All three are tracked together, and filed
 * together for that reason, as BACKLOG-2499.
 *
 * The one automatic writer is infrastructure, not a feature:
 * `databaseService._migrateToEncryptedDatabase` copies every table verbatim when
 * the database is re-encrypted. That copy is column-preserving, so it carries
 * `removed_at`/`removed_reason` across unchanged and cannot revive anything —
 * but "nothing writes this table automatically" would be too strong a claim.
 *
 * The live risk is the opposite direction: auto-link READS this table to decide
 * whose mail and messages get pulled into a deal. Those reads
 * (`autoLinkService`, `messageMatchingService`) filter the tombstone too, so a
 * removed party stops attracting new communications to the transaction.
 *
 * NOT FILTERED, DELIBERATELY: `frozenContactDbService.isContactOnFrozenTransaction`
 * — see the note there. A removal must not un-protect an already-exported audit.
 */

import crypto from "crypto";
import type { Contact } from "../../types";
import { dbGet, dbAll, dbRun, ensureDb, dbTransaction } from "./core/dbConnection";
import { unsafeSql } from "./core/sqlText";

// Transaction contact association data
// Note: `role` now stores SPECIFIC_ROLES values (ContactRole) — normalized from specific_role on writes

/**
 * The one stored value for "the other side's agent" (BACKLOG-2859).
 *
 * Spelled out in electron/ rather than imported from
 * `src/constants/contactRoles.ts` because `electron/` cannot import from `src/`
 * (rootDir). A parity test pins the two against each other.
 */
export const CANONICAL_AGENT_ROLE = "agent";

/** Retired agent values that collapse to CANONICAL_AGENT_ROLE. */
export const LEGACY_AGENT_ROLES = [
  "buyer_agent",
  "seller_agent",
  "listing_agent",
] as const;

/** Case-insensitive because roles reach the database layer both ways. */
export function isLegacyAgentRole(role: string): boolean {
  return (LEGACY_AGENT_ROLES as readonly string[]).includes(role.toLowerCase());
}


export interface TransactionContactData {
  contact_id: string;
  role?: string;
  role_category?: string;
  specific_role?: string;
  is_primary?: number | boolean;
  notes?: string;
}

// Transaction contact result with contact info
export interface TransactionContactResult extends TransactionContactData {
  id: string;
  transaction_id: string;
  created_at: string;
  updated_at: string;
  // BACKLOG-2366 tombstone columns (migration v56). Every query in this file
  // selects `tc.*`, so both are always on the wire; they are optional here
  // because a live row carries NULL in each. `getRemovedTransactionContacts` is
  // the reader that depends on them being typed.
  removed_at?: string | null;
  removed_reason?: string | null;
  /**
   * BACKLOG-2568 — the CONTACT's tombstone (`contacts.removed_at`), NOT the
   * junction's. Read the two fields above and this one together, because they
   * sit two lines apart and answer different questions:
   *
   *  - `removed_at` (above)   → this party was taken off THIS DEAL.
   *  - `contact_removed_at`   → this person was deleted from the ADDRESS BOOK.
   *
   * They are independent by design (`contactDbService.removeContact` writes only
   * `contacts.removed_at` and never touches this table), so all four
   * combinations are reachable — which is exactly why BACKLOG-2568 needs two
   * distinct labels and why one pill covering both would be wrong half the time.
   *
   * POPULATION CONTRACT: aliased by ALL THREE `c.`-joining SELECTs in this file
   * (`getTransactionContactsWithRoles`, `getTransactionContactsByRole`,
   * `getRemovedTransactionContacts`). The third was added with no reader today
   * on purpose: leaving one projection short would hand a future caller
   * `undefined` with `tsc` green and a pill that silently never renders.
   *
   * Format is SQLite `datetime('now')` — `YYYY-MM-DD HH:MM:SS`, not ISO-8601.
   * NULL for a live contact, and also NULL for an orphaned junction row whose
   * contact record is absent (the `LEFT JOIN` yields no row); pre-v56 hard
   * deletes could leave such rows. Pre-existing, not worsened here.
   */
  contact_removed_at?: string | null;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  contact_company?: string;
  contact_title?: string;
  contact_source?: string;
  contact_email_count?: number | string;
  contact_phone_count?: number | string;
}

/**
 * Contact assignment operation for batch updates
 */
export interface ContactAssignmentOperation {
  action: "add" | "remove";
  contactId: string;
  role?: string;
  roleCategory?: string;
  specificRole?: string;
  isPrimary?: boolean;
  notes?: string;
}

/**
 * Assign contact to transaction with role (simple version)
 */
export async function linkContactToTransaction(
  transactionId: string,
  contactId: string,
  role?: string,
): Promise<void> {
  /**
   * BACKLOG-2543 — the INSERT into `transaction_contacts` and the UPDATE of the
   * contact's default role are ONE write. A throw between them left the person
   * attached to the deal while their stored role said something else.
   *
   * The callback is SYNCHRONOUS even though this function is `async` — that is
   * what makes wrapping safe here. An async callback would let the transaction
   * commit over a rejected promise; see `createTransactionSync`.
   */
  dbTransaction(() => {
    const id = crypto.randomUUID();

    // BACKLOG-2366: this was a bare INSERT. With tombstones a removed pair still
    // occupies its UNIQUE(transaction_id, contact_id) slot, so a bare INSERT would
    // throw on every re-add. Upsert instead, clearing the tombstone — re-adding
    // someone revives the original row and its history rather than starting a new
    // one.
    const sql = `
      INSERT INTO transaction_contacts (
        id, transaction_id, contact_id, role, role_category, specific_role, is_primary, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transaction_id, contact_id) DO UPDATE SET
        role = excluded.role,
        specific_role = excluded.specific_role,
        removed_at = NULL,
        removed_reason = NULL,
        updated_at = CURRENT_TIMESTAMP
    `;

    const params = [
      id,
      transactionId,
      contactId,
      role || null,
      null,
      role || null,
      0,
      null,
    ];

    dbRun(unsafeSql(sql), params);

    // Auto-update contact default_role
    if (role) {
      dbRun(
        unsafeSql(`UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
        [role, contactId]
      );
    }

  });
}

/**
 * Assign contact to transaction with detailed role data
 * Uses INSERT OR REPLACE to handle duplicate assignments gracefully
 */
export async function assignContactToTransaction(
  transactionId: string,
  data: TransactionContactData,
): Promise<string> {
  return assignContactToTransactionSync(transactionId, data);
}

/**
 * The synchronous core of `assignContactToTransaction` (BACKLOG-2538).
 *
 * WHY IT HAD TO BE SPLIT OUT. Creating a deal with its parties is now ONE
 * transaction, and `dbTransaction` takes a SYNCHRONOUS callback. This body was
 * already synchronous — every statement is `dbGet`/`dbRun` — but the `async`
 * keyword turns a throw into a REJECTED PROMISE rather than a synchronous
 * throw. Called from inside `dbTransaction`, the callback would appear to
 * return normally and the transaction would COMMIT over the failure, with the
 * error surfacing later as an unhandled rejection. **The deal would keep the
 * parties that had already been written and lose the rest, silently** — the
 * exact outcome the transaction exists to prevent.
 *
 * The async wrapper stays because other callers await it.
 */
export function assignContactToTransactionSync(
  transactionId: string,
  data: TransactionContactData,
): string {
  // Normalize: keep role in sync with specific_role (canonical source)
  if (data.specific_role) {
    data.role = data.specific_role;
  }

  // THE CHOKE POINT FOR THE COLLAPSED ROLE VOCABULARY (BACKLOG-2859).
  //
  // Migration v68 rewrites every stored `buyer_agent` / `seller_agent` /
  // `listing_agent` to `agent`. A migration is a ONE-TIME event; this is the
  // ongoing guarantee, and without it the collapse silently un-does itself.
  //
  // The live producer of legacy values is the LLM extraction path: its tool enum
  // and prompt propose roles for a transaction, and those proposals reach this
  // function when a user accepts a suggested contact. So a database migrated at
  // upgrade would start re-accumulating three-way agent values on the next AI
  // detection. Restored backups from an older install are the second source.
  //
  // Normalizing HERE rather than at each caller is deliberate: every write to
  // transaction_contacts funnels through this function, so there is exactly one
  // place the invariant can be broken and exactly one place it is enforced.
  if (data.role && isLegacyAgentRole(data.role)) {
    data.role = CANONICAL_AGENT_ROLE;
  }
  if (data.specific_role && isLegacyAgentRole(data.specific_role)) {
    data.specific_role = CANONICAL_AGENT_ROLE;
  }

  // First check if this contact is already assigned to this transaction
  const existingCheck = `
    SELECT id FROM transaction_contacts
    WHERE transaction_id = ? AND contact_id = ?
  `;
  const existing = dbGet<{ id: string }>(unsafeSql(existingCheck), [
    transactionId,
    data.contact_id,
  ]);

  if (existing) {
    // Update the existing assignment instead of inserting.
    // BACKLOG-2366: the existence probe above is deliberately NOT filtered by
    // `removed_at IS NULL` — it must see tombstones, because a tombstoned row
    // still holds the UNIQUE(transaction_id, contact_id) slot. Clearing
    // removed_at/removed_reason here IS the revive path: re-adding someone
    // restores their original row (and its created_at) instead of inserting a
    // second one.
    const updateSql = `
      UPDATE transaction_contacts
      SET role = ?, role_category = ?, specific_role = ?, is_primary = ?, notes = ?,
          removed_at = NULL, removed_reason = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    dbRun(unsafeSql(updateSql), [
      data.role || null,
      data.role_category || null,
      data.specific_role || null,
      data.is_primary ? 1 : 0,
      data.notes || null,
      existing.id,
    ]);

    // Auto-update contact default_role
    if (data.specific_role) {
      dbRun(
        unsafeSql(`UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
        [data.specific_role, data.contact_id]
      );
    }

    return existing.id;
  }

  // Insert new assignment
  const id = crypto.randomUUID();
  const sql = `
    INSERT INTO transaction_contacts (
      id, transaction_id, contact_id, role, role_category, specific_role, is_primary, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    id,
    transactionId,
    data.contact_id,
    data.role || null,
    data.role_category || null,
    data.specific_role || null,
    data.is_primary ? 1 : 0,
    data.notes || null,
  ];

  dbRun(unsafeSql(sql), params);

  // Auto-update contact default_role
  if (data.specific_role) {
    dbRun(
      unsafeSql(`UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
      [data.specific_role, data.contact_id]
    );
  }

  return id;
}

/**
 * Get all contacts assigned to a transaction
 */
export async function getTransactionContacts(
  transactionId: string,
): Promise<Contact[]> {
  const sql = `
    SELECT
      c.*
    FROM transaction_contacts tc
    LEFT JOIN contacts c ON tc.contact_id = c.id
    WHERE tc.transaction_id = ? AND tc.removed_at IS NULL
    ORDER BY tc.is_primary DESC, tc.created_at ASC
  `;

  return dbAll<Contact>(unsafeSql(sql), [transactionId]);
}

/**
 * Get all contacts assigned to a transaction with role details
 */
export async function getTransactionContactsWithRoles(
  transactionId: string,
): Promise<TransactionContactResult[]> {
  const sql = `
    SELECT
      tc.*,
      c.display_name as contact_name,
      COALESCE(
        (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT email FROM contact_emails WHERE contact_id = c.id LIMIT 1)
      ) as contact_email,
      COALESCE(
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id LIMIT 1)
      ) as contact_phone,
      c.company as contact_company,
      c.title as contact_title,
      c.source as contact_source,
      -- BACKLOG-2568: the CONTACT's tombstone, distinct from tc.removed_at
      -- (which arrives via tc.* above and means "off this deal"). A contact
      -- deleted from Clients & Contacts leaves this junction row LIVE, so
      -- without this column the Key Contacts card cannot tell the founder why
      -- a removed person is still listed.
      c.removed_at as contact_removed_at,
      (SELECT COUNT(*) FROM contact_emails WHERE contact_id = c.id) as contact_email_count,
      (SELECT COUNT(*) FROM contact_phones WHERE contact_id = c.id) as contact_phone_count
    FROM transaction_contacts tc
    LEFT JOIN contacts c ON tc.contact_id = c.id
    WHERE tc.transaction_id = ? AND tc.removed_at IS NULL
    ORDER BY tc.is_primary DESC, tc.created_at ASC
  `;

  return dbAll<TransactionContactResult>(unsafeSql(sql), [transactionId]);
}

/**
 * Get all contacts for a specific role in a transaction
 */
export async function getTransactionContactsByRole(
  transactionId: string,
  role: string,
): Promise<TransactionContactResult[]> {
  const sql = `
    SELECT
      tc.*,
      c.display_name as contact_name,
      COALESCE(
        (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT email FROM contact_emails WHERE contact_id = c.id LIMIT 1)
      ) as contact_email,
      COALESCE(
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id LIMIT 1)
      ) as contact_phone,
      c.company as contact_company,
      c.title as contact_title,
      c.source as contact_source,
      -- BACKLOG-2568: aliased here too even though this projection has NO
      -- reader of it today and is not IPC-exposed. All three SELECTs return the
      -- same TransactionContactResult, and the field is optional — so a future
      -- caller reading contact_removed_at off a by-role result would get
      -- undefined with tsc green and a pill that silently never renders.
      -- One line closes the class.
      c.removed_at as contact_removed_at
    FROM transaction_contacts tc
    LEFT JOIN contacts c ON tc.contact_id = c.id
    WHERE tc.transaction_id = ? AND tc.specific_role = ? AND tc.removed_at IS NULL
    ORDER BY tc.is_primary DESC
  `;

  return dbAll<TransactionContactResult>(unsafeSql(sql), [transactionId, role]);
}

/** Default when a caller removes a party without stating why. */
export const DEFAULT_REMOVAL_REASON = "Removed from transaction by user";

/**
 * Remove contact from transaction.
 *
 * BACKLOG-2366 — call site 1 of 3. Was a hard DELETE; now tombstones the row so
 * the role survives. `AND removed_at IS NULL` makes this idempotent: removing an
 * already-removed party must not overwrite the original removal timestamp, which
 * is the audit-relevant value.
 */
export async function unlinkContactFromTransaction(
  transactionId: string,
  contactId: string,
  reason?: string,
): Promise<void> {
  const sql = `
    UPDATE transaction_contacts
    SET removed_at = CURRENT_TIMESTAMP, removed_reason = ?
    WHERE transaction_id = ? AND contact_id = ? AND removed_at IS NULL
  `;
  dbRun(unsafeSql(sql), [reason || DEFAULT_REMOVAL_REASON, transactionId, contactId]);
}

/**
 * Check if contact is assigned to transaction
 *
 * BACKLOG-2366: "assigned" means currently assigned. A tombstoned row is not an
 * assignment.
 */
export async function isContactAssignedToTransaction(
  transactionId: string,
  contactId: string,
): Promise<boolean> {
  const sql =
    "SELECT id FROM transaction_contacts WHERE transaction_id = ? AND contact_id = ? AND removed_at IS NULL LIMIT 1";
  const result = dbGet(unsafeSql(sql), [transactionId, contactId]);
  return !!result;
}

/**
 * Contacts previously removed from a transaction, most recent first.
 *
 * BACKLOG-2366 ships the data path only. The restore SURFACE is BACKLOG-2367,
 * which is expected to consume this through the generic
 * `RemovedItemsSection` / `useRemovedSection` idiom already used by
 * `RemovedEmailsSection` and `RemovedMessagesSection`.
 */
export async function getRemovedTransactionContacts(
  transactionId: string,
): Promise<TransactionContactResult[]> {
  const sql = `
    SELECT
      tc.*,
      c.display_name as contact_name,
      COALESCE(
        (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT email FROM contact_emails WHERE contact_id = c.id LIMIT 1)
      ) as contact_email,
      COALESCE(
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id LIMIT 1)
      ) as contact_phone,
      c.company as contact_company,
      c.title as contact_title,
      c.source as contact_source,
      -- BACKLOG-2568: every row here is already deal-tombstoned (the WHERE
      -- below). This column carries the OTHER tombstone, so the removed-section
      -- card can show BOTH labels when a party was taken off this deal AND
      -- deleted from the address book — the co-occurrence case.
      c.removed_at as contact_removed_at
    FROM transaction_contacts tc
    LEFT JOIN contacts c ON tc.contact_id = c.id
    WHERE tc.transaction_id = ? AND tc.removed_at IS NOT NULL
    ORDER BY tc.removed_at DESC
  `;

  return dbAll<TransactionContactResult>(unsafeSql(sql), [transactionId]);
}

/**
 * Put a removed party back on the transaction — BACKLOG-2367.
 *
 * The inverse of `unlinkContactFromTransaction`: clear the tombstone on the
 * EXISTING junction row rather than inserting a new one. That distinction is
 * the whole reason removal became a tombstone — the row carries `role`,
 * `role_category`, `specific_role`, `is_primary`, `notes` and its original
 * `created_at`, and an INSERT would lose every one of them and re-date the
 * party's association with the deal.
 *
 * ## Why `updated_at` moves here but `removed_at` did not move on removal
 *
 * Deliberately asymmetric, and deliberately matching an existing path rather
 * than being internally tidy. `linkContactToTransaction` and
 * `batchUpdateContactAssignments` ALREADY revive a tombstoned pair by clearing
 * `removed_at`/`removed_reason` and setting `updated_at = CURRENT_TIMESTAMP`
 * (the upsert at the top of this file, and the update inside the batch). Those
 * are what a user hits by re-adding a party through the picker. Restoring
 * through the removed-contacts section must land on a byte-identical row,
 * otherwise the same person ends up in two different states depending on which
 * button brought her back.
 *
 * ## `AND removed_at IS NOT NULL`
 *
 * Makes restoring a live assignment a no-op instead of a needless write, and
 * gives the caller an honest answer via `changes` — a stale click on a list
 * another window already restored from reports "nothing to restore" rather than
 * a success that changed nothing.
 *
 * ## What this does NOT do
 *
 * It does not clear `contacts.removed_at`. The two tombstones are independent
 * by design: "off this deal" and "removed from the database" are different
 * statements, made in different places, undone in different places. A contact
 * who is removed globally can still have a role restored here, and will still
 * not appear in Clients & Contacts until she is restored there too.
 */
export async function restoreContactToTransaction(
  transactionId: string,
  contactId: string,
): Promise<boolean> {
  const sql = `
    UPDATE transaction_contacts
    SET removed_at = NULL, removed_reason = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE transaction_id = ? AND contact_id = ? AND removed_at IS NOT NULL
  `;
  const { changes } = dbRun(unsafeSql(sql), [transactionId, contactId]);
  return changes > 0;
}

/**
 * Batch update contact assignments for a transaction
 * Executes all add/remove operations in a single SQLite transaction for atomicity
 */
export async function batchUpdateContactAssignments(
  transactionId: string,
  operations: ContactAssignmentOperation[],
): Promise<void> {
  if (operations.length === 0) {
    return;
  }

  const db = ensureDb();

  const batchOperation = db.transaction(() => {
    for (const op of operations) {
      if (op.action === "remove") {
        // BACKLOG-2366 — call sites 2 and 3 of 3. Both were hard DELETEs; both
        // now tombstone. `AND removed_at IS NULL` keeps the first removal's
        // timestamp authoritative when a remove is replayed.
        //
        // NOTE on the role-scoped branch: its original comment claimed the
        // predicate exists so "a contact can have multiple roles in the same
        // transaction". schema.sql declares UNIQUE(transaction_id, contact_id),
        // so that has never been possible — at most one row exists per pair and
        // the role predicate only decides WHETHER that single row is removed.
        // Behaviour is preserved exactly as-is; correcting the premise is out of
        // scope here.
        if (op.role || op.specificRole) {
          const roleToMatch = op.role || op.specificRole;
          const removeSql = `
            UPDATE transaction_contacts
            SET removed_at = CURRENT_TIMESTAMP, removed_reason = ?
            WHERE transaction_id = ? AND contact_id = ?
              AND (role = ? OR specific_role = ?) AND removed_at IS NULL
          `;
          db.prepare(removeSql).run(
            DEFAULT_REMOVAL_REASON,
            transactionId,
            op.contactId,
            roleToMatch,
            roleToMatch,
          );
        } else {
          // Fallback: remove all assignments for this contact (legacy behavior)
          const removeSql = `
            UPDATE transaction_contacts
            SET removed_at = CURRENT_TIMESTAMP, removed_reason = ?
            WHERE transaction_id = ? AND contact_id = ? AND removed_at IS NULL
          `;
          db.prepare(removeSql).run(
            DEFAULT_REMOVAL_REASON,
            transactionId,
            op.contactId,
          );
        }
      } else if (op.action === "add") {
        // Check if already exists. Deliberately unfiltered by removed_at — it
        // must see a tombstone so the UPDATE below revives it (BACKLOG-2366).
        const existingCheck =
          "SELECT id FROM transaction_contacts WHERE transaction_id = ? AND contact_id = ?";
        const existing = db
          .prepare(existingCheck)
          .get(transactionId, op.contactId) as { id: string } | undefined;

        if (existing) {
          // Update existing assignment — and clear any tombstone, so a remove
          // followed by an add in the SAME batch revives the original row
          // instead of leaving it removed (BACKLOG-2366).
          const updateSql = `
            UPDATE transaction_contacts
            SET role = ?, role_category = ?, specific_role = ?, is_primary = ?, notes = ?,
                removed_at = NULL, removed_reason = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `;
          db.prepare(updateSql).run(
            op.role || null,
            op.roleCategory || null,
            op.specificRole || null,
            op.isPrimary ? 1 : 0,
            op.notes || null,
            existing.id,
          );

          // Auto-update contact default_role
          if (op.specificRole || op.role) {
            db.prepare(`UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(op.specificRole || op.role, op.contactId);
          }
        } else {
          // Insert new assignment
          const id = crypto.randomUUID();
          const insertSql = `
            INSERT INTO transaction_contacts (
              id, transaction_id, contact_id, role, role_category, specific_role, is_primary, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `;
          db.prepare(insertSql).run(
            id,
            transactionId,
            op.contactId,
            op.role || null,
            op.roleCategory || null,
            op.specificRole || null,
            op.isPrimary ? 1 : 0,
            op.notes || null,
          );

          // Auto-update contact default_role
          if (op.specificRole || op.role) {
            db.prepare(`UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(op.specificRole || op.role, op.contactId);
          }
        }
      }
    }
  });

  // Execute the transaction - will rollback on any error
  batchOperation();
}
