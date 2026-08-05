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
import { DatabaseError } from "../../types";
import { dbGet, dbAll, dbRun, ensureDb } from "./core/dbConnection";
import { validateFields } from "../../utils/sqlFieldWhitelist";

// Transaction contact association data
// Note: `role` now stores SPECIFIC_ROLES values (ContactRole) — normalized from specific_role on writes
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

  dbRun(sql, params);

  // Auto-update contact default_role
  if (role) {
    dbRun(
      `UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [role, contactId]
    );
  }
}

/**
 * Assign contact to transaction with detailed role data
 * Uses INSERT OR REPLACE to handle duplicate assignments gracefully
 */
export async function assignContactToTransaction(
  transactionId: string,
  data: TransactionContactData,
): Promise<string> {
  // Normalize: keep role in sync with specific_role (canonical source)
  if (data.specific_role) {
    data.role = data.specific_role;
  }

  // First check if this contact is already assigned to this transaction
  const existingCheck = `
    SELECT id FROM transaction_contacts
    WHERE transaction_id = ? AND contact_id = ?
  `;
  const existing = dbGet<{ id: string }>(existingCheck, [
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
    dbRun(updateSql, [
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
        `UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
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

  dbRun(sql, params);

  // Auto-update contact default_role
  if (data.specific_role) {
    dbRun(
      `UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
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

  return dbAll<Contact>(sql, [transactionId]);
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
      (SELECT COUNT(*) FROM contact_emails WHERE contact_id = c.id) as contact_email_count,
      (SELECT COUNT(*) FROM contact_phones WHERE contact_id = c.id) as contact_phone_count
    FROM transaction_contacts tc
    LEFT JOIN contacts c ON tc.contact_id = c.id
    WHERE tc.transaction_id = ? AND tc.removed_at IS NULL
    ORDER BY tc.is_primary DESC, tc.created_at ASC
  `;

  return dbAll<TransactionContactResult>(sql, [transactionId]);
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
      c.source as contact_source
    FROM transaction_contacts tc
    LEFT JOIN contacts c ON tc.contact_id = c.id
    WHERE tc.transaction_id = ? AND tc.specific_role = ? AND tc.removed_at IS NULL
    ORDER BY tc.is_primary DESC
  `;

  return dbAll<TransactionContactResult>(sql, [transactionId, role]);
}

/**
 * Update contact role information
 */
export async function updateContactRole(
  transactionId: string,
  contactId: string,
  updates: Partial<TransactionContactData>,
): Promise<void> {
  const allowedFields = [
    "role",
    "role_category",
    "specific_role",
    "is_primary",
    "notes",
  ];
  const fields: string[] = [];
  const values: unknown[] = [];

  Object.keys(updates).forEach((key) => {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = ?`);
      values.push((updates as Record<string, unknown>)[key]);
    }
  });

  if (fields.length === 0) {
    throw new DatabaseError("No valid fields to update");
  }

  // Validate fields against whitelist before SQL construction
  validateFields("transaction_contacts", fields);

  values.push(transactionId, contactId);

  // BACKLOG-2366: scoped to live rows. A removed party's role is a historical
  // fact — editing it would rewrite what the record says they were. Restoring
  // them (re-add) is the way back to an editable role.
  const sql = `
    UPDATE transaction_contacts
    SET ${fields.join(", ")}
    WHERE transaction_id = ? AND contact_id = ? AND removed_at IS NULL
  `;

  dbRun(sql, values);

  // Auto-update contact default_role
  if (updates.specific_role || updates.role) {
    dbRun(
      `UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [updates.specific_role || updates.role, contactId]
    );
  }
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
  dbRun(sql, [reason || DEFAULT_REMOVAL_REASON, transactionId, contactId]);
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
  const result = dbGet(sql, [transactionId, contactId]);
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
      c.source as contact_source
    FROM transaction_contacts tc
    LEFT JOIN contacts c ON tc.contact_id = c.id
    WHERE tc.transaction_id = ? AND tc.removed_at IS NOT NULL
    ORDER BY tc.removed_at DESC
  `;

  return dbAll<TransactionContactResult>(sql, [transactionId]);
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
  const { changes } = dbRun(sql, [transactionId, contactId]);
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
