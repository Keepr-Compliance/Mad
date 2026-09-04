/**
 * Communication Database Service
 * Handles all communication-related database operations (emails, etc.)
 */

import crypto from "crypto";
import type {
  Communication,
  NewCommunication,
  CommunicationFilters,
  IgnoredCommunication,
  NewIgnoredCommunication,
} from "../../types";
import { DatabaseError } from "../../types";
// BACKLOG-3067: row ids are distinct types. Lookups take `string` and MINT a brand;
// mutations DEMAND one. See electron/types/ids.ts for why that split is the design.
import type {
  CommunicationId,
  CommunicationRow,
  TransactionId,
} from "../../types/ids";
import { dbGet, dbAll, dbRun } from "./core/dbConnection";
import { sql, unsafeSql } from "./core/sqlText";
import {
  validateFields,
  type ColumnOf,
  type FieldExpression,
} from "../../utils/sqlFieldWhitelist";
import { isTextMessage } from "../../utils/channelHelpers";
import { dbTimestampNow } from "../../utils/dbTimestamp";
import logService from "../logService";
import { placeholderList } from "./core/sqlFragments";
import { assignmentList } from "./core/columnSql";

/**
 * Create a new communication (junction table entry linking content to transaction)
 *
 * BACKLOG-506 Phase 5 (TASK-1307): Communications is now a PURE junction table.
 * - NO content columns (subject, body, sender, etc.)
 * - Content lives in: messages table (texts) or emails table (emails)
 * - Must set one of: message_id, email_id, or thread_id
 *
 * For email linking, the caller should:
 * 1. Create email in emails table via emailDbService.createEmail()
 * 2. Call this function with email_id set
 *
 * For text message linking, the caller should:
 * 1. Messages already exist in messages table (imported from device)
 * 2. Call this function with message_id or thread_id set
 */
export async function createCommunication(
  communicationData: NewCommunication,
): Promise<CommunicationRow> {
  const id = crypto.randomUUID();

  // BACKLOG-506: Pure junction table.
  // BACKLOG-2319: + match_reason (why the email is attached).
  const statement = sql`
    INSERT INTO communications (
      id, user_id, transaction_id, message_id, email_id, thread_id,
      link_source, link_confidence, match_reason, linked_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;

  const params = [
    id,
    communicationData.user_id,
    communicationData.transaction_id || null,
    communicationData.message_id || null,
    communicationData.email_id || null,
    communicationData.thread_id || null,
    // BACKLOG-2565: 'auto', not null. The three other INSERT sites into this
    // column already default to 'auto' (`createCommunicationReference` below,
    // `messageMatchingService.createCommunicationReference`,
    // `autoLinkService.linkEmailToTransaction`); this one wrote NULL, giving one
    // column two defaults. 'auto' is the honest value — the only live caller
    // that omits `link_source` is the extraction path
    // (`transactionService.ts:683`), which creates the link without a user
    // asking — and unlike NULL it is inside the column's declared domain
    // (`'auto' | 'manual' | 'scan'`), which a NULL satisfies the CHECK for only
    // because SQLite treats a NULL CHECK result as passing.
    //
    // FORWARD-ONLY, deliberately: no reader filters on `link_source` today
    // (`getCommunications` exposes `user_id`/`transaction_id` filters only), so
    // the pre-existing mix of NULL and 'auto' rows harms nothing yet. Back-
    // filling them is a real schema-chain entry and belongs to its own item,
    // not smuggled into a tidy-up.
    communicationData.link_source || "auto",
    communicationData.link_confidence || null,
    communicationData.match_reason || null,
    communicationData.linked_at || null,
  ];

  dbRun(statement, params);

  // BACKLOG-1107: Return data from memory instead of INSERT-then-SELECT.
  const communication = {
    id,
    user_id: communicationData.user_id,
    transaction_id: communicationData.transaction_id || null,
    message_id: communicationData.message_id || null,
    email_id: communicationData.email_id || null,
    thread_id: communicationData.thread_id || null,
    // BACKLOG-2565: must stay identical to the bound param above. This object is
    // returned INSTEAD of re-SELECTing the row (BACKLOG-1107), so a default
    // applied on only one of the two lines hands the caller an object that
    // disagrees with the row it describes — the shape BACKLOG-2632 pinned for
    // `ignored_at`.
    link_source: communicationData.link_source || "auto",
    link_confidence: communicationData.link_confidence || null,
    match_reason: communicationData.match_reason || null,
    linked_at: communicationData.linked_at || null,
    has_attachments: false,
    is_false_positive: false,
    created_at: new Date().toISOString(),
    // BACKLOG-3067: `CommunicationRow`, not `Communication`. This is where a
    // CommunicationId is BORN — `id` above is this function's own `randomUUID()`,
    // so no value has better provenance. The cast is not new: the object is
    // assembled in memory instead of being re-SELECTed (BACKLOG-1107), so it was
    // already being asserted into shape. Retargeting it costs nothing.
  } as unknown as CommunicationRow;

  // BACKLOG-396: Update thread count if this is a text message linked to a transaction
  // Check if linked message is a text type
  if (communicationData.transaction_id && communicationData.message_id) {
    const message = dbGet<{ channel: string | null }>(
      sql`SELECT channel FROM messages WHERE id = ?`,
      [communicationData.message_id]
    );
    if (message?.channel && isTextMessage({ channel: message.channel })) {
      updateTransactionThreadCount(communicationData.transaction_id);
    }
  }
  // Thread-based linking is always for text messages
  if (communicationData.transaction_id && communicationData.thread_id) {
    updateTransactionThreadCount(communicationData.transaction_id);
  }

  return communication;
}

/**
 * Get communication by ID
 */
export async function getCommunicationById(
  communicationId: string,
): Promise<CommunicationRow | null> {
  // BACKLOG-1107: Explicit column list instead of SELECT *
  // BACKLOG-2319: include match_reason so unlink can carry it onto the ignored row.
  const statement = sql`SELECT id, user_id, transaction_id, message_id, email_id, thread_id,
    link_source, link_confidence, match_reason, linked_at, created_at
    FROM communications WHERE id = ?`;
  // BACKLOG-3067: the parameter stays `string` DELIBERATELY. Handing a lookup the
  // wrong kind of id returns null — it cannot corrupt anything — so protecting it
  // would buy nothing and would push the brand out across every caller, turning a
  // ratchet into a sweep. Instead this is a MINT: `dbGet<T>` already ends in
  // `stmt.get(...) as T`, an assertion that verifies nothing about the row, so
  // naming the row type `CommunicationRow` adds no unsoundness that was not
  // already there — and it makes a successful read the thing that earns the brand.
  const communication = dbGet<CommunicationRow>(statement, [communicationId]);
  return communication || null;
}

/**
 * Get communications with filters
 *
 * BACKLOG-506 Phase 5 (TASK-1307): Communications is now a pure junction table.
 * Filters like communication_type, sent_at, has_attachments are no longer supported
 * since those columns don't exist. Use getCommunicationsWithMessages() instead for
 * queries that need content/metadata filtering.
 */
export async function getCommunications(
  filters?: CommunicationFilters,
): Promise<Communication[]> {
  // BACKLOG-1107: Explicit column list
  let statement = sql`SELECT id, user_id, transaction_id, message_id, email_id, thread_id, link_source, link_confidence, linked_at, created_at FROM communications WHERE 1=1`;
  const params: unknown[] = [];

  if (filters?.user_id) {
    statement = sql`${statement} AND user_id = ?`;
    params.push(filters.user_id);
  }

  if (filters?.transaction_id) {
    statement = sql`${statement} AND transaction_id = ?`;
    params.push(filters.transaction_id);
  }

  // BACKLOG-506: communication_type, sent_at, has_attachments filters are no longer
  // supported since those columns don't exist in the pure junction table.
  // These filters are intentionally ignored - use getCommunicationsWithMessages()
  // if you need to filter by content/metadata.

  statement = sql`${statement} ORDER BY created_at DESC`;

  return dbAll<Communication>(statement, params);
}

/**
 * Get communications for a transaction (junction records only)
 *
 * BACKLOG-506 Phase 5 (TASK-1307): Returns raw junction records.
 * For communications with content, use getCommunicationsWithMessages() instead.
 */
export async function getCommunicationsByTransaction(
  transactionId: string,
): Promise<Communication[]> {
  // BACKLOG-1107: Explicit column list
  const statement = sql`
    SELECT id, user_id, transaction_id, message_id, email_id, thread_id,
           link_source, link_confidence, linked_at, created_at
    FROM communications
    WHERE transaction_id = ?
    ORDER BY created_at DESC
  `;
  return dbAll<Communication>(statement, [transactionId]);
}

/**
 * Update communication
 *
 * BACKLOG-506 Phase 5 (TASK-1307): Only junction table fields are allowed.
 * Content fields (subject, body, sender, etc.) no longer exist in this table.
 */
export async function updateCommunication(
  communicationId: string,
  updates: Partial<Communication>,
): Promise<void> {
  // BACKLOG-506: Pure junction table - only these fields exist
  const allowedFields: readonly ColumnOf<"communications">[] = [
    "transaction_id",
    "message_id",
    "email_id",
    "thread_id",
    "link_source",
    "link_confidence",
    "match_reason",
    "linked_at",
  ];

  const columns: ColumnOf<"communications">[] = [];
  const values: unknown[] = [];

  Object.keys(updates).forEach((key) => {
    const column = allowedFields.find((allowed) => allowed === key);
    if (column) {
      const value = (updates as Record<string, unknown>)[key];
      columns.push(column);
      values.push(value);
    }
  });

  if (columns.length === 0) {
    throw new DatabaseError("No valid fields to update");
  }

  // Validate column names against the whitelist before SQL construction.
  //
  // BACKLOG-3085 retires the BACKLOG-2739 Phase 1 seam cast that used to sit
  // here. `columns` is now the column UNION rather than `string[]`, because the
  // SET clause is built by `assignmentList` from the enumerated column
  // fragments — so there is nothing left to cast. The runtime check stays: it
  // is for names that arrive from outside the type system, which the types
  // cannot see. See `sqlFieldWhitelist.ts`'s own header.
  validateFields("communications", columns);

  values.push(communicationId);

  const statement = sql`UPDATE communications SET ${assignmentList(columns)} WHERE id = ?`;
  dbRun(statement, values);
}

/**
 * BACKLOG-2319: Confirm a set of "Needs review" email links.
 *
 * Promotes every communications row for these emails on this transaction to
 * match_reason='user_confirmed', which moves them out of the Needs-review
 * section and into Linked. Thread-aware: the caller passes every email id in
 * the confirmed conversation. Idempotent — re-confirming is a harmless no-op.
 *
 * @returns the number of link rows updated
 */
export function confirmEmailLinksByEmailIds(
  emailIds: string[],
  transactionId: string,
): number {
  const ids = emailIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return 0;

  const placeholders = placeholderList(ids.length);
  const statement = sql`
    UPDATE communications
       SET match_reason = 'user_confirmed'
     WHERE transaction_id = ?
       AND email_id IN (${placeholders})
  `;
  return dbRun(statement, [transactionId, ...ids]).changes ?? 0;
}

/**
 * Delete communication
 */
export async function deleteCommunication(communicationId: string): Promise<void> {
  // BACKLOG-506 (TASK-1307): Get the transaction ID and message_id before deleting.
  // We need to check if the linked message is a text type to update thread count.
  const comm = dbGet<{ transaction_id: string | null; message_id: string | null; thread_id: string | null }>(
    sql`SELECT transaction_id, message_id, thread_id FROM communications WHERE id = ?`,
    [communicationId]
  );

  const statement = sql`DELETE FROM communications WHERE id = ?`;
  dbRun(statement, [communicationId]);

  // BACKLOG-396: Update thread count if this was a text message linked to a transaction
  if (comm?.transaction_id) {
    // Thread-based link is always for text messages
    if (comm.thread_id) {
      updateTransactionThreadCount(comm.transaction_id);
    }
    // Message-based link - check if the message is a text type
    else if (comm.message_id) {
      const message = dbGet<{ channel: string | null }>(
        sql`SELECT channel FROM messages WHERE id = ?`,
        [comm.message_id]
      );
      if (message?.channel && isTextMessage({ channel: message.channel })) {
        updateTransactionThreadCount(comm.transaction_id);
      }
    }
  }
}

/**
 * Delete communication by message_id
 * Used when unlinking messages from a transaction - removes the communications table reference
 */
export async function deleteCommunicationByMessageId(messageId: string): Promise<void> {
  // BACKLOG-506 (TASK-1307): Get the transaction ID before deleting.
  // Check if the message is a text type to update thread count.
  const comm = dbGet<{ transaction_id: string | null }>(
    sql`SELECT transaction_id FROM communications WHERE message_id = ?`,
    [messageId]
  );

  const statement = sql`DELETE FROM communications WHERE message_id = ?`;
  dbRun(statement, [messageId]);

  // BACKLOG-396: Update thread count if this was a text message linked to a transaction
  if (comm?.transaction_id) {
    const message = dbGet<{ channel: string | null }>(
      sql`SELECT channel FROM messages WHERE id = ?`,
      [messageId]
    );
    if (message?.channel && isTextMessage({ channel: message.channel })) {
      updateTransactionThreadCount(comm.transaction_id);
    }
  }
}

/**
 * Link communication to transaction
 *
 * BACKLOG-3067: both parameters are BRANDED, and this is the signature the whole
 * item exists for. Until now they were two `string`s, so this function accepted an
 * email id (BACKLOG-2829 — the live defect: the predicate matches zero rows and
 * the caller logs success) and would equally have accepted the two arguments in
 * the wrong ORDER. Neither is expressible now.
 *
 * To call this, read the row first. `getCommunicationById` and `createCommunication`
 * hand back a `CommunicationRow` whose `id` is already branded, so the ordinary
 * path needs no cast and no ceremony — that is control 3, and it is the reason the
 * brand does not simply get cast away by the next person in a hurry.
 *
 * NOT FIXED HERE: the predicate itself. BACKLOG-2829 has a specified fix (correct
 * the predicate AND update both transactions' stored thread counts, pinned
 * together) which must ship as specified. This item stops the NEXT one.
 */
export async function linkCommunicationToTransaction(
  communicationId: CommunicationId,
  transactionId: TransactionId,
): Promise<void> {
  const statement = sql`UPDATE communications SET transaction_id = ? WHERE id = ?`;
  dbRun(statement, [transactionId, communicationId]);
}

// ============================================
// IGNORED COMMUNICATION OPERATIONS
// ============================================

/**
 * Add a communication to the ignored list for a transaction
 * This prevents the email from being re-added during future scans
 */
export async function addIgnoredCommunication(
  data: NewIgnoredCommunication,
): Promise<IgnoredCommunication> {
  const id = crypto.randomUUID();

  // BACKLOG-2632: persist ignored_at EXPLICITLY instead of leaning on the column
  // default. Previously the row got `DEFAULT CURRENT_TIMESTAMP` (naive UTC,
  // "2026-08-10 01:00:00") while the object returned below carried
  // `new Date().toISOString()` — a different string for the same instant. The
  // in-memory value rendered the correct day and then FLIPPED to the next day on
  // the first refetch, which reads as data corruption rather than a skewed date.
  // One value, written and returned, so persisted and in-memory are byte-identical.
  const ignoredAt = dbTimestampNow();

  // BACKLOG-1560: Include email_id and thread_id columns for direct suppression
  // BACKLOG-2319: + match_reason, preserved so restore reclassifies correctly.
  const statement = sql`
    INSERT INTO ignored_communications (
      id, user_id, transaction_id, email_subject, email_sender,
      email_sent_at, email_thread_id, email_id, thread_id,
      original_communication_id, reason, match_reason, ignored_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    id,
    data.user_id,
    data.transaction_id,
    data.email_subject || null,
    data.email_sender || null,
    data.email_sent_at || null,
    data.thread_id || null,
    data.email_id || null,
    data.thread_id || null,
    data.original_communication_id || null,
    data.reason || null,
    data.match_reason || null,
    ignoredAt,
  ];

  dbRun(statement, params);

  logService.debug("[BACKLOG-1560] addIgnoredCommunication SUCCESS", "CommunicationDbService", {
    id, transaction_id: data.transaction_id, thread_id: data.thread_id ?? 'NULL'
  });

  // BACKLOG-1107: Return data from memory instead of INSERT-then-SELECT.
  const ignoredComm: IgnoredCommunication = {
    id,
    user_id: data.user_id,
    transaction_id: data.transaction_id,
    email_subject: data.email_subject || null,
    email_sender: data.email_sender || null,
    email_sent_at: data.email_sent_at || null,
    email_id: data.email_id || null,
    thread_id: data.thread_id || null,
    original_communication_id: data.original_communication_id || null,
    reason: data.reason || null,
    match_reason: data.match_reason || null,
    // BACKLOG-2632: the SAME string that was just persisted, not a fresh
    // toISOString(). Renderers normalise it via parseDbTimestamp().
    ignored_at: ignoredAt,
  } as IgnoredCommunication;

  return ignoredComm;
}

/**
 * Get all ignored communications for a transaction
 */
export async function getIgnoredCommunicationsByTransaction(
  transactionId: string,
): Promise<IgnoredCommunication[]> {
  const statement = sql`
    SELECT * FROM ignored_communications
    WHERE transaction_id = ?
    ORDER BY ignored_at DESC
  `;
  return dbAll<IgnoredCommunication>(statement, [transactionId]);
}

/**
 * Get all ignored communications for a user
 */
export async function getIgnoredCommunicationsByUser(
  userId: string,
): Promise<IgnoredCommunication[]> {
  const statement = sql`
    SELECT * FROM ignored_communications
    WHERE user_id = ?
    ORDER BY ignored_at DESC
  `;
  return dbAll<IgnoredCommunication>(statement, [userId]);
}

/**
 * BACKLOG-2571 — TRANSITION BRIDGE, NOT THE INTENDED DESIGN.
 *
 * Both matchers below identify a dismissed email by
 * (scope, sender, subject, timestamp) with EXACT string equality on the
 * timestamp. That timestamp is copied from an email row's `sent_at`
 * (`transactionService.unlinkCommunication`), and BACKLOG-2571 changed what
 * `sent_at` means: it used to be the RECEIVE time and is now the
 * sender-asserted SEND time.
 *
 * So one `ignored_communications` table now holds keys written under two
 * different semantics, and an equality match against a single value misses
 * whichever half it was not handed. A miss here is not cosmetic: an email the
 * founder explicitly dismissed COMES BACK on the next scan.
 *
 * `IN (?, ?)` lets a caller offer both candidate timestamps — an email's
 * `sent_at` and its `received_at` — so a key written under either semantics
 * still matches. A caller holding only one value passes it alone; the second
 * placeholder then repeats it, which matches exactly what the single-value
 * form used to do.
 *
 * The index `(user_id, email_sender, email_subject, email_sent_at)` still
 * serves an `IN` on its trailing column, so this costs nothing at runtime.
 *
 * DO NOT BUILD ON THIS SHAPE. "Match either timestamp" is a bridge across a
 * meaning change, not a design — a timestamp was always a weak key, and two
 * weak keys are not stronger than one. The intended fix is to re-key
 * `ignored_communications` on `message_id_header` / `email_id`, which identify
 * a message rather than describing it. Filed as the follow-up to BACKLOG-2571.
 */

/**
 * Check if a communication is ignored for a transaction
 * Uses email sender, subject, and sent_at to identify the email
 */
export async function isEmailIgnoredForTransaction(
  transactionId: string,
  emailSender: string,
  emailSubject: string,
  emailSentAt: string,
  /** BACKLOG-2571: second candidate timestamp — see the bridge note above. */
  emailAltSentAt?: string | null,
): Promise<boolean> {
  const statement = sql`
    SELECT id FROM ignored_communications
    WHERE transaction_id = ?
      AND email_sender = ?
      AND email_subject = ?
      AND email_sent_at IN (?, ?)
    LIMIT 1
  `;
  const result = dbGet(statement, [
    transactionId,
    emailSender,
    emailSubject,
    emailSentAt,
    emailAltSentAt ?? emailSentAt,
  ]);
  return !!result;
}

/**
 * Check if a communication is ignored for any transaction of a user
 * Used during email scanning to filter out previously ignored emails
 */
export async function isEmailIgnoredByUser(
  userId: string,
  emailSender: string,
  emailSubject: string,
  emailSentAt: string,
  /** BACKLOG-2571: second candidate timestamp — see the bridge note above. */
  emailAltSentAt?: string | null,
): Promise<boolean> {
  const statement = sql`
    SELECT id FROM ignored_communications
    WHERE user_id = ?
      AND email_sender = ?
      AND email_subject = ?
      AND email_sent_at IN (?, ?)
    LIMIT 1
  `;
  const result = dbGet(statement, [
    userId,
    emailSender,
    emailSubject,
    emailSentAt,
    emailAltSentAt ?? emailSentAt,
  ]);
  return !!result;
}

/**
 * Remove an ignored communication (re-allow it to be linked)
 */
export async function removeIgnoredCommunication(ignoredCommId: string): Promise<void> {
  const statement = sql`DELETE FROM ignored_communications WHERE id = ?`;
  dbRun(statement, [ignoredCommId]);
}

/**
 * BACKLOG-1560: Get set of email IDs that are ignored for a specific transaction.
 * Used by auto-link to skip previously unlinked emails.
 */
export function getIgnoredEmailIdsForTransaction(
  transactionId: string,
): Set<string> {
  const statement = sql`
    SELECT email_id FROM ignored_communications
    WHERE transaction_id = ? AND email_id IS NOT NULL
  `;
  const rows = dbAll<{ email_id: string }>(statement, [transactionId]);
  return new Set(rows.map((r) => r.email_id));
}

/**
 * BACKLOG-1560: Get set of thread IDs that are ignored for a specific transaction.
 * Used by auto-link to skip previously unlinked message threads.
 */
export function getIgnoredThreadIdsForTransaction(
  transactionId: string,
): Set<string> {
  const statement = sql`
    SELECT thread_id FROM ignored_communications
    WHERE transaction_id = ? AND thread_id IS NOT NULL
  `;
  const rows = dbAll<{ thread_id: string }>(statement, [transactionId]);
  const result = new Set(rows.map((r) => r.thread_id));

  logService.debug("[BACKLOG-1560] getIgnoredThreadIds", "CommunicationDbService", {
    transactionId, count: result.size, ids: Array.from(result)
  });

  return result;
}

/**
 * BACKLOG-1560: Get set of original_communication_ids (message IDs) that are ignored
 * for a specific transaction. Used for per-message suppression when messages have
 * no valid thread_id (null or empty string).
 */
export function getIgnoredCommunicationIdsForTransaction(
  transactionId: string,
): Set<string> {
  const statement = sql`
    SELECT original_communication_id FROM ignored_communications
    WHERE transaction_id = ? AND original_communication_id IS NOT NULL
  `;
  const rows = dbAll<{ original_communication_id: string }>(statement, [transactionId]);
  return new Set(rows.map((r) => r.original_communication_id));
}

// ============================================
// EXTRACTED DATA OPERATIONS
// ============================================

/**
 * Save extracted transaction data (audit trail)
 */
export async function saveExtractedData(
  transactionId: string,
  fieldName: string,
  fieldValue: string,
  sourceCommId?: string,
  confidence?: number,
): Promise<string> {
  const id = crypto.randomUUID();

  const statement = sql`
    INSERT INTO extracted_transaction_data (
      id, transaction_id, field_name, field_value,
      source_communication_id, extraction_method, confidence_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  dbRun(statement, [
    id,
    transactionId,
    fieldName,
    fieldValue,
    sourceCommId || null,
    "pattern_matching",
    confidence || null,
  ]);

  return id;
}

// ============================================
// TASK-975: JUNCTION TABLE OPERATIONS
// ============================================

/**
 * Data required to create a communication reference (junction table pattern)
 */
export interface CreateCommunicationReferenceData {
  user_id: string;
  message_id: string;
  transaction_id: string;
  link_source?: 'auto' | 'manual' | 'scan';
  link_confidence?: number;
}

/**
 * Create a communication reference linking a message to a transaction.
 *
 * TASK-975: This is the new junction table pattern.
 * - message_id references the messages table (where content lives)
 * - transaction_id references the transactions table
 * - No content duplication - content stays in messages table
 *
 * @param data - The reference data
 * @returns The created communication reference
 */
export async function createCommunicationReference(
  data: CreateCommunicationReferenceData,
): Promise<CommunicationRow> {
  const id = crypto.randomUUID();

  const statement = sql`
    INSERT INTO communications (
      id, user_id, message_id, transaction_id,
      link_source, link_confidence, linked_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;

  const params = [
    id,
    data.user_id,
    data.message_id,
    data.transaction_id,
    data.link_source || 'auto',
    data.link_confidence || null,
  ];

  dbRun(statement, params);

  // BACKLOG-1107: Return data from memory instead of INSERT-then-SELECT.
  const communication = {
    id,
    user_id: data.user_id,
    transaction_id: data.transaction_id,
    message_id: data.message_id,
    email_id: null,
    thread_id: null,
    link_source: data.link_source || 'auto',
    link_confidence: data.link_confidence || null,
    linked_at: new Date().toISOString(),
    has_attachments: false,
    is_false_positive: false,
    created_at: new Date().toISOString(),
    // BACKLOG-3067: the second `randomUUID()` birth point for a CommunicationId,
    // branded for the same reason as `createCommunication` above.
  } as unknown as CommunicationRow;

  // BACKLOG-396: Check if the linked message is a text and update thread count
  const message = dbGet<{ channel: string | null }>(
    sql`SELECT channel FROM messages WHERE id = ?`,
    [data.message_id]
  );
  if (message?.channel && isTextMessage({ channel: message.channel })) {
    updateTransactionThreadCount(data.transaction_id);
  }

  return communication;
}

/**
 * Get communications for a transaction, joining to messages table for content.
 *
 * TASK-975: This retrieves communications with full message content from the
 * messages table when message_id is set. Falls back to legacy content columns
 * for records without message_id.
 *
 * TASK-992: Added direction field from messages table for proper bubble display.
 *
 * TASK-1116: Updated to support thread-based linking. For records with thread_id
 * but no message_id, returns all messages in the thread.
 *
 * @param transactionId - The transaction ID
 * @returns Communications with content from messages table when available
 */
export async function getCommunicationsWithMessages(
  transactionId: string,
  channelFilter?: "email" | "text",
  limit?: number,
): Promise<Communication[]> {
  // BACKLOG-506: Three-way join - messages for texts, emails for emails
  // Query handles:
  //   1. Records with message_id (per-message text linking)
  //   2. Records with thread_id (per-thread text linking)
  //   3. Records with email_id (email linking - NEW)
  //
  // NOTE: The return type Communication is aliased to Message for backward compatibility.
  // The SELECT populates Message fields from JOINs to messages/emails tables.
  // BACKLOG-3102 — NOT CONVERTED, and the escape is the record of why.
  // `LIMIT ${Number(limit)}` below splices a NUMBER into SQL text. That is
  // BACKLOG-3062's shape exactly, and the `sql` tag refuses it — correctly.
  // Rewriting it (`LIMIT ?`, with the value bound) is a real fix and a real
  // behaviour change, so it does NOT belong inside a byte-identical
  // conversion. Filed, owned, and left visible rather than escaped past.
  const statement = unsafeSql(`
    SELECT
      -- Use content table ID when available, fall back to communication ID
      COALESCE(m.id, e.id, c.id) as id,
      c.id as communication_id,
      c.user_id,
      c.transaction_id,
      -- HOTFIX: For thread-linked messages, c.message_id is NULL but m.id has the actual message ID
      -- This is needed for attachment lookup which uses message_id
      COALESCE(c.message_id, m.id) as message_id,
      c.email_id,
      c.link_source,
      c.link_confidence,
      -- BACKLOG-2319: why the email is attached (drives the "Needs review" split)
      c.match_reason,
      c.linked_at,
      c.created_at,
      -- Type: prefer message channel, then 'email' if email_id set
      CASE
        WHEN m.id IS NOT NULL THEN m.channel
        WHEN e.id IS NOT NULL THEN 'email'
        ELSE 'unknown'
      END as channel,
      CASE
        WHEN m.id IS NOT NULL THEN m.channel
        WHEN e.id IS NOT NULL THEN 'email'
        ELSE 'unknown'
      END as communication_type,
      -- Content from messages or emails table (NO legacy column fallback)
      COALESCE(m.body_text, e.body_plain) as body_text,
      COALESCE(m.body_text, e.body_plain) as body_plain,
      COALESCE(m.body_html, e.body_html) as body,
      COALESCE(m.subject, e.subject) as subject,
      COALESCE(json_extract(m.participants, '$.from'), e.sender) as sender,
      COALESCE(
        (SELECT group_concat(value) FROM json_each(json_extract(m.participants, '$.to'))),
        e.recipients
      ) as recipients,
      COALESCE(m.sent_at, e.sent_at) as sent_at,
      COALESCE(m.received_at, e.received_at) as received_at,
      COALESCE(m.has_attachments, e.has_attachments) as has_attachments,
      -- Thread ID for grouping messages into conversations
      COALESCE(m.thread_id, e.thread_id) as thread_id,
      -- Participants JSON for group chat detection and sender identification
      m.participants as participants,
      -- BACKLOG-2814: the group's user-visible name, joined in from
      -- message_thread_names. NULL for 1:1 chats and unnamed groups.
      tn.display_name as thread_display_name,
      -- Direction from messages table for bubble display
      COALESCE(m.direction, e.direction) as direction,
      -- External ID for attachment lookup fallback
      COALESCE(m.external_id, e.external_id) as external_id,
      -- BACKLOG-2280: reaction columns so the renderer can partition tapbacks to
      -- their parent bubble. Emails have neither; both are NULL for normal texts.
      m.associated_message_type as associated_message_type,
      m.associated_message_guid as associated_message_guid,
      -- Email-specific fields from emails table only
      e.source as source,
      e.cc as cc,
      e.bcc as bcc,
      e.attachment_count as attachment_count
      -- BACKLOG-506 (TASK-1307): Legacy metadata columns removed from communications table.
      -- Analysis fields (keywords, relevance, etc.) are now stored on messages/emails if needed.
    FROM communications c
    LEFT JOIN messages m ON (
      -- Per-message linking
      (c.message_id IS NOT NULL AND c.message_id = m.id)
      OR
      -- Thread-based linking
      (c.message_id IS NULL AND c.email_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
    )
    LEFT JOIN emails e ON (
      -- BACKLOG-506: Email linking - join only when email_id is set and matches
      c.email_id IS NOT NULL AND c.email_id = e.id
    )
    -- BACKLOG-2814: user_id is part of the join key, not just thread_id. The
    -- table's PK is (user_id, thread_id) and thread ids are only unique per
    -- machine, so joining on thread_id alone would show one user's group name
    -- on another user's thread in a shared database.
    LEFT JOIN message_thread_names tn ON (
      tn.thread_id = m.thread_id AND tn.user_id = m.user_id
    )
    WHERE c.transaction_id = ?
    ${channelFilter === "email" ? "AND c.email_id IS NOT NULL" : ""}
    ${channelFilter === "text" ? "AND c.email_id IS NULL" : ""}
    ORDER BY COALESCE(m.sent_at, e.sent_at) DESC
    ${limit ? `LIMIT ${Number(limit)}` : ""}
  `);

  const results = dbAll<Communication>(statement, [transactionId]);

  // Deduplicate by message ID first
  const seenIds = new Set<string>();
  const dedupedById = results.filter(r => {
    if (seenIds.has(r.id)) return false;
    seenIds.add(r.id);
    return true;
  });

  // Content-based deduplication for text messages
  // Catches cases where same content exists with different IDs
  const seenContent = new Set<string>();
  const deduped = dedupedById.filter(r => {
    const channel = (r as { channel?: string }).channel;
    const commType = (r as { communication_type?: string }).communication_type;
    const isTextMessage = channel === 'sms' || channel === 'imessage' ||
                          commType === 'sms' || commType === 'imessage';

    if (!isTextMessage) return true;

    const bodyText = (r as { body_text?: string }).body_text || '';

    // BACKLOG-2280 (I2): content-dedup keys on `bodyText|sentAt`, but MANY distinct
    // rows now share an empty body — reactions (empty by design) AND caption-less
    // media (empty since BACKLOG-2262). Two empty-body rows at the same second are
    // DIFFERENT messages, so keying them on content would wrongly collapse them
    // (e.g. two reactions in the same second, or a reaction that coincides with a
    // caption-less photo). Empty-body rows are already de-duplicated by id above;
    // exempt them from content-dedup entirely.
    if (bodyText.trim().length === 0) return true;

    const sentAt = (r as { sent_at?: string }).sent_at || '';
    const contentKey = `${bodyText}|${sentAt}`;

    if (seenContent.has(contentKey)) return false;
    seenContent.add(contentKey);
    return true;
  });

  return deduped;
}

/**
 * Check if a message is already linked to a transaction
 *
 * @param messageId - The message ID
 * @param transactionId - The transaction ID
 * @returns True if the link exists
 */
export async function isMessageLinkedToTransaction(
  messageId: string,
  transactionId: string,
): Promise<boolean> {
  const statement = sql`
    SELECT id FROM communications
    WHERE message_id = ? AND transaction_id = ?
    LIMIT 1
  `;
  const result = dbGet(statement, [messageId, transactionId]);
  return !!result;
}

/**
 * Get all transactions a message is linked to
 *
 * @param messageId - The message ID
 * @returns Array of transaction IDs
 */
export async function getTransactionsForMessage(
  messageId: string,
): Promise<string[]> {
  const statement = sql`
    SELECT transaction_id FROM communications
    WHERE message_id = ?
  `;
  const results = dbAll<{ transaction_id: string }>(statement, [messageId]);
  return results.map(r => r.transaction_id);
}

// ============================================
// TASK-1115: THREAD-LEVEL LINKING OPERATIONS
// ============================================

/**
 * Create a thread-level communication link (one record per thread per transaction).
 *
 * TASK-1115: This replaces message-by-message linking for thread-based communications.
 * Instead of creating one communication record per message, we create one per thread.
 * The messages table retains individual messages; this is just the linking junction.
 *
 * @param threadId - The thread identifier (from messages.thread_id)
 * @param transactionId - The transaction to link to
 * @param userId - The user ID
 * @param linkSource - How the link was created ('auto', 'manual', 'scan')
 * @param linkConfidence - Confidence score (0.0 - 1.0)
 * @returns The created communication ID
 */
export async function createThreadCommunicationReference(
  threadId: string,
  transactionId: string,
  userId: string,
  linkSource: 'auto' | 'manual' | 'scan' = 'auto',
  linkConfidence: number = 0.9,
): Promise<string> {
  const id = crypto.randomUUID();

  // BACKLOG-506 (TASK-1307): Pure junction table - no communication_type column.
  // The type is determined by JOINing to messages table (for thread_id-based links).
  const statement = sql`
    INSERT INTO communications (
      id, user_id, thread_id, transaction_id,
      link_source, link_confidence, linked_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;

  const params = [
    id,
    userId,
    threadId,
    transactionId,
    linkSource,
    linkConfidence,
  ];

  dbRun(statement, params);

  // BACKLOG-396: Thread-based linking is always for text messages, update count
  updateTransactionThreadCount(transactionId);

  return id;
}

/**
 * Delete communication records by thread_id for a specific transaction.
 *
 * TASK-1115: Used when unlinking a thread from a transaction.
 * Removes the junction record so the thread is no longer associated.
 *
 * @param threadId - The thread identifier
 * @param transactionId - The transaction to unlink from
 */
export async function deleteCommunicationByThread(
  threadId: string,
  transactionId: string,
): Promise<void> {
  const statement = sql`
    DELETE FROM communications
    WHERE thread_id = ? AND transaction_id = ?
  `;
  dbRun(statement, [threadId, transactionId]);

  // BACKLOG-396: Thread-based unlinking is always for text messages, update count
  updateTransactionThreadCount(transactionId);
}

/**
 * Check if a thread is already linked to a transaction.
 *
 * TASK-1115: Used to avoid duplicate links when auto-linking.
 *
 * @param threadId - The thread identifier
 * @param transactionId - The transaction ID
 * @returns True if the thread is already linked to this transaction
 */
export async function isThreadLinkedToTransaction(
  threadId: string,
  transactionId: string,
): Promise<boolean> {
  const statement = sql`
    SELECT id FROM communications
    WHERE thread_id = ? AND transaction_id = ?
    LIMIT 1
  `;
  const result = dbGet(statement, [threadId, transactionId]);
  return !!result;
}

// ============================================
// BACKLOG-396: THREAD COUNT MANAGEMENT
// ============================================

/**
 * Normalize a participant identifier for consistent grouping.
 * Matches frontend logic in MessageThreadCard.tsx.
 */
function normalizeParticipant(participant: string): string {
  if (!participant) return '';

  // If it looks like a phone number, normalize to digits only
  const digits = participant.replace(/\D/g, '');
  if (digits.length >= 10) {
    // Use last 10 digits to normalize +1 prefix variations
    return digits.slice(-10);
  }

  // Otherwise return lowercase trimmed version
  return participant.toLowerCase().trim();
}

/**
 * Generate a key for grouping messages into threads.
 * Matches frontend logic in MessageThreadCard.tsx getThreadKey().
 */
function getThreadKey(msg: { thread_id?: string | null; participants?: string | null; id: string }): string {
  // FIRST: Use thread_id if available - this is the actual iMessage chat ID
  if (msg.thread_id) {
    return msg.thread_id;
  }

  // FALLBACK: Compute from participants if no thread_id
  try {
    if (msg.participants) {
      const parsed = typeof msg.participants === 'string'
        ? JSON.parse(msg.participants)
        : msg.participants;

      // Collect all participants
      const allParticipants = new Set<string>();

      if (parsed.from) {
        allParticipants.add(normalizeParticipant(parsed.from));
      }
      if (parsed.to) {
        const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
        toList.forEach((p: string) => allParticipants.add(normalizeParticipant(p)));
      }

      // Remove "me" - we only care about external participants for grouping
      allParticipants.delete('me');

      // Sort and join to create a consistent key
      if (allParticipants.size > 0) {
        return `participants-${Array.from(allParticipants).sort().join('|')}`;
      }
    }
  } catch {
    // Fall through to default
  }

  // Last resort: use message id (each message is its own "thread")
  return `msg-${msg.id}`;
}

/**
 * Count unique threads for text communications linked to a transaction.
 * Uses the same logic as frontend's groupMessagesByThread().
 *
 * BACKLOG-396: This is the source of truth for text thread counts.
 * BACKLOG-506 (TASK-1307): Updated for pure junction table (no communication_type column).
 */
export function countTextThreadsForTransaction(transactionId: string): number {
  // Get all text communications linked to this transaction
  // BACKLOG-506: Since communications is now a pure junction table, we ONLY check
  // m.channel from the messages table. Thread-based links (c.thread_id) are always
  // for text messages by design.
  const statement = sql`
    SELECT
      COALESCE(m.id, c.id) as id,
      m.thread_id as thread_id,
      m.participants as participants
    FROM communications c
    LEFT JOIN messages m ON (
      (c.message_id IS NOT NULL AND c.message_id = m.id)
      OR
      (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
    )
    WHERE c.transaction_id = ?
      AND (m.channel IN ('text', 'sms', 'imessage') OR (m.id IS NULL AND c.thread_id IS NOT NULL))
  `;

  const messages = dbAll<{ id: string; thread_id: string | null; participants: string | null }>(
    statement,
    [transactionId]
  );

  // Group messages by thread using the same logic as frontend
  const threads = new Set<string>();
  for (const msg of messages) {
    const threadKey = getThreadKey(msg);
    threads.add(threadKey);
  }

  return threads.size;
}

/**
 * Update the text_thread_count on a transaction.
 * Call this after linking/unlinking messages to keep the count in sync.
 *
 * BACKLOG-396: Ensures TransactionCard displays the correct thread count.
 */
export function updateTransactionThreadCount(transactionId: string): void {
  const threadCount = countTextThreadsForTransaction(transactionId);

  const statement = sql`UPDATE transactions SET text_thread_count = ? WHERE id = ?`;
  dbRun(statement, [threadCount, transactionId]);
}

/**
 * Backfill text_thread_count for all transactions.
 * Run this once to populate existing data.
 *
 * BACKLOG-396: Migration helper for existing transactions.
 */
export function backfillAllTransactionThreadCounts(): { updated: number; errors: number } {
  // BACKLOG-1095: Single GROUP BY query replaces N+1 per-transaction queries.
  const threadCountsSql = sql`
    SELECT c.transaction_id, COUNT(DISTINCT COALESCE(m.thread_id, m.id)) as thread_count
    FROM communications c
    LEFT JOIN messages m ON (
      (c.message_id IS NOT NULL AND c.message_id = m.id)
      OR
      (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
    )
    WHERE c.transaction_id IS NOT NULL
      AND (m.channel IN ('text', 'sms', 'imessage') OR (m.id IS NULL AND c.thread_id IS NOT NULL))
    GROUP BY c.transaction_id
  `;

  const threadCounts = dbAll<{ transaction_id: string; thread_count: number }>(threadCountsSql);

  const countMap = new Map<string, number>();
  for (const row of threadCounts) {
    countMap.set(row.transaction_id, row.thread_count);
  }

  const transactions = dbAll<{ id: string }>(sql`SELECT id FROM transactions`);

  let updated = 0;
  let errors = 0;

  for (const tx of transactions) {
    try {
      const count = countMap.get(tx.id) || 0;
      dbRun(sql`UPDATE transactions SET text_thread_count = ? WHERE id = ?`, [count, tx.id]);
      updated++;
    } catch {
      errors++;
    }
  }

  return { updated, errors };
}
