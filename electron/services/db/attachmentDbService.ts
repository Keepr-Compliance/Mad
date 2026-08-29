/**
 * Attachment Database Service
 * Handles all attachment-related database operations
 */

import { randomUUID } from "crypto";
import { ensureDb } from "./core/dbConnection";
// BACKLOG-2781: the closing-day end bound is the export resolver's canonical
// one, so the Attachments tab and the submission package agree on where the
// closing day ends. LATENT today — the tab's only caller
// (TransactionDetails.tsx) passes no audit window, and deliberately so: the tab
// shows all linked content, matching the Emails/Texts tabs. Fixed anyway so the
// next caller that supplies a window does not inherit the wrong day.
import { auditWindowEnd } from "../exportPlan";

// ============================================
// ATTACHMENT CRUD OPERATIONS
// ============================================

/**
 * Get all attachment storage paths (for content hash deduplication).
 */
export function getAttachmentStoragePaths(): { storage_path: string }[] {
  const db = ensureDb();
  return db
    .prepare(`SELECT storage_path FROM attachments WHERE storage_path IS NOT NULL`)
    .all() as { storage_path: string }[];
}

/**
 * Check if an attachment already exists for a given email and filename.
 */
export function hasAttachmentForEmail(emailId: string, filename: string): boolean {
  const db = ensureDb();
  const row = db
    .prepare(`SELECT id FROM attachments WHERE email_id = ? AND filename = ?`)
    .get(emailId, filename);
  return !!row;
}

/**
 * Create an attachment record in the database.
 */
export function createAttachmentRecord(params: {
  id: string;
  emailId: string;
  externalEmailId: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  storagePath: string;
}): void {
  const db = ensureDb();
  db.prepare(
    `
    INSERT INTO attachments (
      id, email_id, external_message_id, filename, mime_type, file_size_bytes, storage_path, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `
  ).run(
    params.id,
    params.emailId,
    params.externalEmailId,
    params.filename,
    params.mimeType,
    params.fileSizeBytes,
    params.storagePath
  );
}

/**
 * BACKLOG-1870: Persist email attachment METADATA at sync time (filename / mime /
 * size) WITHOUT downloading the file bytes, so filenames are searchable after a
 * normal sync. Leaves `storage_path` and `text_content` NULL — a later on-demand
 * download (preview/export) fills those on the SAME row via
 * {@link setEmailAttachmentStorage}.
 *
 * Idempotent by (email_id, filename): re-syncing the same email does NOT create a
 * duplicate row. When a row already exists, mime_type / file_size_bytes are
 * backfilled only where currently NULL (COALESCE), never overwriting values a
 * download already wrote.
 *
 * @returns the attachment row id (existing or newly created).
 */
export function upsertEmailAttachmentMetadata(params: {
  emailId: string;
  externalEmailId: string | null;
  filename: string;
  mimeType?: string | null;
  fileSizeBytes?: number | null;
}): string {
  const db = ensureDb();

  const existing = db
    .prepare(
      `SELECT id FROM attachments WHERE email_id = ? AND filename = ? LIMIT 1`
    )
    .get(params.emailId, params.filename) as { id: string } | undefined;

  if (existing) {
    // Backfill metadata only where it is currently NULL — never clobber a value a
    // download (or a previous sync) already wrote.
    db.prepare(
      `UPDATE attachments
         SET mime_type = COALESCE(mime_type, ?),
             file_size_bytes = COALESCE(file_size_bytes, ?)
       WHERE id = ?`
    ).run(params.mimeType ?? null, params.fileSizeBytes ?? null, existing.id);
    return existing.id;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO attachments (
      id, email_id, external_message_id, filename, mime_type, file_size_bytes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    id,
    params.emailId,
    params.externalEmailId,
    params.filename,
    params.mimeType ?? null,
    params.fileSizeBytes ?? null
  );
  return id;
}

/**
 * BACKLOG-1870: Look up an email attachment row by (email_id, filename), returning
 * its id and storage_path so the download path can distinguish a metadata-only
 * row (storage_path NULL → download bytes and backfill in place) from a row whose
 * bytes are already stored (skip).
 */
export function getEmailAttachmentByFilename(
  emailId: string,
  filename: string
): { id: string; storage_path: string | null } | undefined {
  const db = ensureDb();
  return db
    .prepare(
      `SELECT id, storage_path FROM attachments WHERE email_id = ? AND filename = ? LIMIT 1`
    )
    .get(emailId, filename) as
    | { id: string; storage_path: string | null }
    | undefined;
}

/**
 * BACKLOG-1870: Fill in storage_path (and the actual byte size) on an EXISTING
 * attachment row after an on-demand download. Matches by id so a sync-created
 * metadata row is reconciled in place rather than duplicated.
 */
export function setEmailAttachmentStorage(
  id: string,
  storagePath: string,
  fileSizeBytes: number
): void {
  const db = ensureDb();
  db.prepare(
    `UPDATE attachments SET storage_path = ?, file_size_bytes = ? WHERE id = ?`
  ).run(storagePath, fileSizeBytes, id);
}

/**
 * BACKLOG-2257: Persist locally-extracted text (PDF text layer / plain-text files)
 * onto an EXISTING attachment row. Matches by id so the extraction pipeline updates
 * the same downloaded row in place.
 *
 * Empty-text semantics (see attachmentTextExtractionService): `text` is stored
 * VERBATIM, so an empty string ("") means "extraction was attempted but yielded no
 * text" (scanned/image-only PDF, empty text layer, or an over-cap file that was not
 * parsed). This is DISTINCT from `text_content IS NULL` = "never attempted", which
 * is what the backfill/eligibility guards key on — so writing "" removes a no-text
 * row from the pending set and keeps re-runs idempotent.
 */
export function setAttachmentTextContent(id: string, text: string): void {
  const db = ensureDb();
  db.prepare(`UPDATE attachments SET text_content = ? WHERE id = ?`).run(text, id);
}

/**
 * BACKLOG-2257: Look up a single attachment's extraction-relevant fields by id, so
 * the id-based extraction entrypoint can re-check the current text_content guard
 * (avoids re-extracting a row another pass already handled).
 */
export function getAttachmentTextExtractionRow(
  id: string
): { storage_path: string | null; mime_type: string | null; text_content: string | null } | undefined {
  const db = ensureDb();
  return db
    .prepare(
      `SELECT storage_path, mime_type, text_content FROM attachments WHERE id = ? LIMIT 1`
    )
    .get(id) as
    | { storage_path: string | null; mime_type: string | null; text_content: string | null }
    | undefined;
}

/**
 * Get attachments for an email by email_id.
 */
export function getAttachmentsByEmailId(
  emailId: string
): {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}[] {
  const db = ensureDb();
  return db
    .prepare(
      `
      SELECT id, filename, mime_type, file_size_bytes, storage_path
      FROM attachments
      WHERE email_id = ?
    `
    )
    .all(emailId) as {
    id: string;
    filename: string;
    mime_type: string | null;
    file_size_bytes: number | null;
    storage_path: string | null;
  }[];
}

// ============================================
// FOLDER EXPORT ATTACHMENT QUERIES (TASK-2100)
// ============================================

/**
 * Get attachments for a text message by message_id, with fallback to external_message_id.
 */
export function getAttachmentsForMessageWithFallback(
  messageId: string,
  externalId?: string
): {
  id: string;
  filename: string;
  mime_type: string | null;
  storage_path: string | null;
  file_size_bytes: number | null;
}[] {
  const db = ensureDb();

  // Direct message_id lookup
  let rows = db
    .prepare(
      `SELECT id, filename, mime_type, storage_path, file_size_bytes
       FROM attachments WHERE message_id = ?`
    )
    .all(messageId) as {
    id: string;
    filename: string;
    mime_type: string | null;
    storage_path: string | null;
    file_size_bytes: number | null;
  }[];

  // Fallback to external_message_id
  if (rows.length === 0) {
    let lookupExternalId = externalId;
    if (!lookupExternalId) {
      const messageRow = db
        .prepare(`SELECT external_id FROM messages WHERE id = ?`)
        .get(messageId) as { external_id: string | null } | undefined;
      lookupExternalId = messageRow?.external_id || undefined;
    }

    if (lookupExternalId) {
      rows = db
        .prepare(
          `SELECT id, filename, mime_type, storage_path, file_size_bytes
           FROM attachments WHERE external_message_id = ?`
        )
        .all(lookupExternalId) as typeof rows;

      // Update stale message_id for future queries
      if (rows.length > 0) {
        db.prepare(
          `UPDATE attachments SET message_id = ? WHERE external_message_id = ?`
        ).run(messageId, lookupExternalId);
      }
    }
  }

  return rows;
}

/**
 * Get attachments for an email by email_id (folder export variant).
 */
export function getAttachmentsForEmailExport(
  emailId: string
): {
  id: string;
  filename: string;
  mime_type: string | null;
  storage_path: string | null;
  file_size_bytes: number | null;
}[] {
  const db = ensureDb();
  return db
    .prepare(
      `SELECT id, filename, mime_type, storage_path, file_size_bytes
       FROM attachments WHERE email_id = ?`
    )
    .all(emailId) as {
    id: string;
    filename: string;
    mime_type: string | null;
    storage_path: string | null;
    file_size_bytes: number | null;
  }[];
}

/**
 * Bulk query attachments by message_ids, external_message_ids, and email_ids.
 * Used by folderExportService for building attachment manifests.
 */
export function getAttachmentsForExportBulk(
  messageIds: string[],
  externalIds: string[],
  emailIds: string[]
): {
  id: string;
  message_id: string | null;
  email_id: string | null;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}[] {
  const db = ensureDb();
  type AttachmentRow = {
    id: string;
    message_id: string | null;
    email_id: string | null;
    filename: string;
    mime_type: string | null;
    file_size_bytes: number | null;
    storage_path: string | null;
  };
  let attachmentRows: AttachmentRow[] = [];

  if (messageIds.length > 0) {
    const placeholders = messageIds.map(() => "?").join(", ");
    const textRows = db
      .prepare(
        `SELECT id, message_id, NULL as email_id, filename, mime_type, file_size_bytes, storage_path
         FROM attachments WHERE message_id IN (${placeholders})`
      )
      .all(...messageIds) as AttachmentRow[];
    attachmentRows = [...attachmentRows, ...textRows];

    if (externalIds.length > 0) {
      const externalPlaceholders = externalIds.map(() => "?").join(", ");
      const fallbackRows = db
        .prepare(
          `SELECT id, message_id, NULL as email_id, filename, mime_type, file_size_bytes, storage_path
           FROM attachments
           WHERE external_message_id IN (${externalPlaceholders})
             AND id NOT IN (SELECT id FROM attachments WHERE message_id IN (${placeholders}))`
        )
        .all(...externalIds, ...messageIds) as AttachmentRow[];
      attachmentRows = [...attachmentRows, ...fallbackRows];
    }
  }

  if (emailIds.length > 0) {
    const emailPlaceholders = emailIds.map(() => "?").join(", ");
    const emailRows = db
      .prepare(
        `SELECT id, NULL as message_id, email_id, filename, mime_type, file_size_bytes, storage_path
         FROM attachments WHERE email_id IN (${emailPlaceholders})`
      )
      .all(...emailIds) as AttachmentRow[];
    attachmentRows = [...attachmentRows, ...emailRows];
  }

  return attachmentRows;
}

// ============================================
// UNIFIED TRANSACTION ATTACHMENTS (BACKLOG-322 Phase A)
// ============================================

/**
 * A single row in the unified transaction Attachments tab. Covers BOTH email and
 * text/iMessage attachments, INCLUDING metadata-only rows whose bytes have not
 * been downloaded yet (`storage_path` NULL — common post-BACKLOG-1870).
 */
export interface TransactionAttachmentRow {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  /** NULL when the bytes have not been downloaded yet (metadata-only row). */
  storage_path: string | null;
  created_at: string | null;
  /** Which comm channel the attachment came from. */
  source: "email" | "text";
  /** email.sent_at or message.sent_at — the date shown in the context line / used for date sort. */
  source_date: string | null;
  /** 'inbound' | 'outbound' when known — lets the UI say "You"/sender. */
  direction: string | null;
  /** Email subject (email rows only; NULL for texts). */
  context_subject: string | null;
  /** Email sender address, or a text message's flattened participants. */
  context_sender: string | null;
  /** Owning email id (email rows) — needed to force an on-demand download. */
  email_id: string | null;
  /** Owning message id (text rows). */
  message_id: string | null;
}

/**
 * BACKLOG-322 Phase A: return EVERY attachment linked to a transaction — email
 * AND text/iMessage — as one unified list for the Attachments tab.
 *
 * Unlike {@link getTransactionAttachments} (submission/export path) this does NOT
 * filter on `storage_path IS NOT NULL`: metadata-only rows (not yet downloaded)
 * are included so the tab can show them with a "not downloaded" affordance and
 * offer an on-demand download.
 *
 * Linkage mirrors the per-tab display queries:
 *  - Email: `communications.email_id = emails.id`.
 *  - Text : `attachments.message_id = messages.id` joined through communications
 *    (message_id OR thread_id), PLUS an `external_message_id` fallback for rows
 *    whose `message_id` was never backfilled (see
 *    {@link getAttachmentsForMessageWithFallback}).
 *
 * The optional audit window filters on the owning email/message `sent_at`. Callers
 * that want the same "everything linked" view the Emails/Texts tabs show should
 * omit it (those tabs do not date-filter their display).
 */
export function getTransactionAllAttachments(
  transactionId: string,
  auditStartDate?: Date | null,
  auditEndDate?: Date | null
): TransactionAttachmentRow[] {
  const db = ensureDb();

  // Shared date-window builder (on the owning email/message sent_at column).
  const buildDateFilter = (
    column: string
  ): { clause: string; params: string[] } => {
    let clause = "";
    const params: string[] = [];
    if (auditStartDate) {
      clause += ` AND ${column} >= ?`;
      params.push(auditStartDate.toISOString());
    }
    const end = auditWindowEnd(auditEndDate);
    if (end) {
      clause += ` AND ${column} <= ?`;
      params.push(end.toISOString());
    }
    return { clause, params };
  };

  type RawRow = Omit<TransactionAttachmentRow, "source">;

  // ---- Email attachments -------------------------------------------------
  const emailFilter = buildDateFilter("e.sent_at");
  const emailRows = db
    .prepare(
      `SELECT DISTINCT
         a.id, a.filename, a.mime_type, a.file_size_bytes, a.storage_path,
         a.created_at, a.email_id, a.message_id,
         e.sent_at   AS source_date,
         e.direction AS direction,
         e.subject   AS context_subject,
         e.sender    AS context_sender
       FROM attachments a
       INNER JOIN emails e ON a.email_id = e.id
       INNER JOIN communications c ON c.email_id = e.id
       WHERE c.transaction_id = ?
         AND a.email_id IS NOT NULL
         ${emailFilter.clause}`
    )
    .all(transactionId, ...emailFilter.params) as RawRow[];

  // ---- Text attachments (direct message_id link) -------------------------
  const textFilter = buildDateFilter("m.sent_at");
  const textRows = db
    .prepare(
      `SELECT DISTINCT
         a.id, a.filename, a.mime_type, a.file_size_bytes, a.storage_path,
         a.created_at, a.email_id, a.message_id,
         m.sent_at           AS source_date,
         m.direction         AS direction,
         NULL                AS context_subject,
         m.participants_flat AS context_sender
       FROM attachments a
       INNER JOIN messages m ON a.message_id = m.id
       INNER JOIN communications c ON (
         (c.message_id IS NOT NULL AND c.message_id = m.id)
         OR
         (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
       )
       WHERE c.transaction_id = ?
         ${textFilter.clause}`
    )
    .all(transactionId, ...textFilter.params) as RawRow[];

  // ---- Text attachments (external_message_id fallback) -------------------
  // Some attachments never had their message_id backfilled (only the macOS GUID
  // in external_message_id). Mirror getAttachmentsForMessageWithFallback so those
  // still surface on the transaction they belong to.
  const fallbackFilter = buildDateFilter("m.sent_at");
  const textFallbackRows = db
    .prepare(
      `SELECT DISTINCT
         a.id, a.filename, a.mime_type, a.file_size_bytes, a.storage_path,
         a.created_at, a.email_id, a.message_id,
         m.sent_at           AS source_date,
         m.direction         AS direction,
         NULL                AS context_subject,
         m.participants_flat AS context_sender
       FROM attachments a
       INNER JOIN messages m ON a.external_message_id = m.external_id
       INNER JOIN communications c ON (
         (c.message_id IS NOT NULL AND c.message_id = m.id)
         OR
         (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
       )
       WHERE c.transaction_id = ?
         AND a.message_id IS NULL
         ${fallbackFilter.clause}`
    )
    .all(transactionId, ...fallbackFilter.params) as RawRow[];

  // Merge, tag source, dedupe by attachment id (email ids and text ids are
  // disjoint in practice; the Map guards against any accidental double-match).
  const byId = new Map<string, TransactionAttachmentRow>();
  for (const r of emailRows) {
    if (!byId.has(r.id)) byId.set(r.id, { ...r, source: "email" });
  }
  for (const r of [...textRows, ...textFallbackRows]) {
    if (!byId.has(r.id)) byId.set(r.id, { ...r, source: "text" });
  }

  // Default order: newest first by the owning comm's date (UI re-sorts anyway).
  return Array.from(byId.values()).sort((a, b) => {
    const at = a.source_date ? new Date(a.source_date).getTime() : 0;
    const bt = b.source_date ? new Date(b.source_date).getTime() : 0;
    return bt - at;
  });
}

// ============================================
// CONTACT RESOLUTION QUERIES (TASK-2100)
// ============================================
//
// BACKLOG-2757 / BACKLOG-2758 — READ BEFORE CHANGING ANY QUERY BELOW.
//
// These three statements decide WHOSE NAME goes on an exported audit PDF, and
// in the text-thread case, whose name is written into a FILE NAME on disk.
//
// Two properties they did NOT have, and now must:
//
//   1. USER SCOPE. `contacts` carries `user_id`; none of these read it. In a
//      multi-user database a handle could resolve to another user's contact and
//      that person's name would be printed into this user's audit package.
//      This is a hard filter — there is no legitimate cross-user resolution.
//
//   2. TRANSACTION LINKAGE, as a PREFERENCE not a filter. A handle can match a
//      contact who has nothing to do with the deal being exported. Filtering
//      them out entirely would delete names from the export for every message
//      participant who is not a formal `transaction_contacts` party — which is
//      most of them. So the queries REPORT linkage (`is_transaction_linked`)
//      and the caller drops unlinked matches only when a linked one exists.
//
// They also now return `contact_id`, because the caller has to be able to tell
// "two rows, one contact" (two phone formats — not ambiguous) from "two rows,
// two contacts" (a shared line — ambiguous, and the whole point of 2757).

/** Scope for an export-time identity lookup. */
export interface ContactResolutionScope {
  /** Hard filter. Contacts belonging to other users never resolve. */
  userId?: string | null;
  /**
   * Preference, not a filter. Matches linked to this transaction are marked so
   * the caller can prefer them; unlinked matches are still returned.
   */
  transactionId?: string | null;
}

/** One contact matching a handle, with everything needed to rank it. */
export interface ContactHandleMatch {
  contact_id: string;
  display_name: string | null;
  is_transaction_linked: number;
}

export interface ContactPhoneMatch extends ContactHandleMatch {
  phone_e164: string | null;
  phone_display: string | null;
}

export interface ContactEmailMatch extends ContactHandleMatch {
  email: string;
}

/**
 * The linkage flag and its bound parameter.
 *
 * When no transaction is supplied every row reports `0` — "no transaction was
 * named", which the caller reads as "no preference to apply", NOT as "this
 * contact is not a party".
 */
function transactionLinkedSelect(transactionId?: string | null): {
  expr: string;
  params: string[];
} {
  if (!transactionId) {
    return { expr: "0 AS is_transaction_linked", params: [] };
  }
  // `tc.removed_at IS NULL` is BACKLOG-2366's off-this-deal enforcement, and it
  // is load-bearing here: without it a contact who was REMOVED from this
  // transaction would still count as linked and would out-rank a contact who is
  // actually a party — reintroducing the wrong-name-wins defect through the
  // preference tier instead of through row order. (Caught by the BACKLOG-2612
  // sweep's leg 6a, which asserts every statement touching
  // `FROM transaction_contacts tc` carries this filter.)
  return {
    expr: `EXISTS (
        SELECT 1 FROM transaction_contacts tc
        WHERE tc.contact_id = c.id
          AND tc.transaction_id = ?
          AND tc.removed_at IS NULL
      ) AS is_transaction_linked`,
    params: [transactionId],
  };
}

/** The user hard filter and its bound parameter. */
function userScopeClause(userId?: string | null): { clause: string; params: string[] } {
  if (!userId) return { clause: "", params: [] };
  return { clause: "AND c.user_id = ?", params: [userId] };
}

/**
 * Look up contact matches by phone numbers.
 * Matches against last 10 digits of both phone_e164 and phone_display.
 *
 * Returns EVERY match, ordered deterministically. The caller decides what a
 * handle with more than one contact is called — this query does not pick.
 */
export function getContactNamesByPhoneDigits(
  normalizedPhones: string[],
  scope: ContactResolutionScope = {}
): ContactPhoneMatch[] {
  if (normalizedPhones.length === 0) return [];
  const db = ensureDb();
  const placeholders = normalizedPhones.map(() => "?").join(", ");
  const linked = transactionLinkedSelect(scope.transactionId);
  const user = userScopeClause(scope.userId);
  const sql = `
    SELECT
      c.id AS contact_id,
      cp.phone_e164,
      cp.phone_display,
      c.display_name,
      ${linked.expr}
    FROM contact_phones cp
    JOIN contacts c ON cp.contact_id = c.id
    WHERE (substr(replace(replace(replace(cp.phone_e164, '+', ''), '-', ''), ' ', ''), -10) IN (${placeholders})
       OR substr(replace(replace(replace(cp.phone_display, '+', ''), '-', ''), ' ', ''), -10) IN (${placeholders}))
      ${user.clause}
    ORDER BY c.display_name COLLATE NOCASE, c.id
  `;
  return db
    .prepare(sql)
    .all(
      ...linked.params,
      ...normalizedPhones,
      ...normalizedPhones,
      ...user.params
    ) as ContactPhoneMatch[];
}

/**
 * Look up contact matches by email addresses (case-insensitive).
 * Returns EVERY match, ordered deterministically.
 */
export function getContactNamesByEmails(
  lowerEmails: string[],
  scope: ContactResolutionScope = {}
): ContactEmailMatch[] {
  if (lowerEmails.length === 0) return [];
  const db = ensureDb();
  const placeholders = lowerEmails.map(() => "?").join(", ");
  const linked = transactionLinkedSelect(scope.transactionId);
  const user = userScopeClause(scope.userId);
  const sql = `
    SELECT
      c.id AS contact_id,
      LOWER(ce.email) as email,
      c.display_name,
      ${linked.expr}
    FROM contact_emails ce
    JOIN contacts c ON ce.contact_id = c.id
    WHERE LOWER(ce.email) IN (${placeholders})
      ${user.clause}
    ORDER BY c.display_name COLLATE NOCASE, c.id
  `;
  return db
    .prepare(sql)
    .all(...linked.params, ...lowerEmails, ...user.params) as ContactEmailMatch[];
}

/**
 * Look up a contact display name by Apple ID prefix (email prefix match).
 *
 * BACKLOG-2758 finding 2: this was `LIKE ? || '@%' LIMIT 1` with NO `ORDER BY`
 * — the row returned was whatever SQLite yielded first, stable in practice and
 * guaranteed by nothing, free to change with an index or a vacuum.
 *
 * A single winner is the right shape here (unlike a shared phone line, an Apple
 * ID prefix collision is a near-miss between different addresses rather than one
 * identifier two people genuinely share), so the fix is to DECLARE the winner
 * rather than to surface an ambiguity: the alphabetically first email, tie-broken
 * on contact id. Both are stable under vacuum and index changes.
 */
export function getContactNameByAppleIdPrefix(
  appleIdLower: string,
  scope: ContactResolutionScope = {}
): { email: string; display_name: string | null; contact_id: string } | undefined {
  const db = ensureDb();
  const user = userScopeClause(scope.userId);
  const sql = `
    SELECT
      c.id AS contact_id,
      LOWER(ce.email) as email,
      c.display_name
    FROM contact_emails ce
    JOIN contacts c ON ce.contact_id = c.id
    WHERE LOWER(ce.email) LIKE ? || '@%'
      ${user.clause}
    ORDER BY LOWER(ce.email), c.id
    LIMIT 1
  `;
  return db.prepare(sql).get(appleIdLower, ...user.params) as
    | { email: string; display_name: string | null; contact_id: string }
    | undefined;
}
