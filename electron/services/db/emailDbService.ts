/**
 * Email Database Service (BACKLOG-506)
 * Handles all email-related database operations.
 *
 * This is the content store for emails. The communications table
 * is a junction table that links emails to transactions.
 *
 * Pattern: emails table for content, communications table for links
 * Similar to: messages table for texts, communications for links
 */

import crypto from "crypto";
import * as Sentry from "@sentry/electron/main";
import { dbGet, dbAll, dbRun, getRawDatabase } from "./core/dbConnection";
import { DatabaseError } from "../../types";
import type { ParsedParticipant } from "../../types/models";
import { computeParticipantHash, parseEmailAddressList } from "../../utils/emailAddress";

// ============================================
// TYPE DEFINITIONS
// ============================================

/**
 * Email record stored in the emails table
 */
export interface Email {
  id: string;
  user_id: string;
  external_id?: string;
  source?: "gmail" | "outlook";
  account_id?: string;
  direction?: "inbound" | "outbound";
  subject?: string;
  body_plain?: string;
  body_html?: string;
  sender?: string;
  recipients?: string;
  cc?: string;
  bcc?: string;
  thread_id?: string;
  in_reply_to?: string;
  references_header?: string;
  sent_at?: string;
  received_at?: string;
  has_attachments?: boolean;
  attachment_count?: number;
  message_id_header?: string;
  content_hash?: string;
  labels?: string;
  created_at?: string;
}

/**
 * Data required to create a new email
 */
export interface NewEmail {
  user_id: string;
  external_id?: string;
  source?: "gmail" | "outlook";
  account_id?: string;
  direction?: "inbound" | "outbound";
  subject?: string;
  body_plain?: string;
  body_html?: string;
  sender?: string;
  recipients?: string;
  cc?: string;
  bcc?: string;
  thread_id?: string;
  in_reply_to?: string;
  references_header?: string;
  sent_at?: string;
  received_at?: string;
  has_attachments?: boolean;
  attachment_count?: number;
  message_id_header?: string;
  content_hash?: string;
  labels?: string;

  /**
   * Optional participants for the `email_participants` junction (BACKLOG-1722).
   *
   * Callers that pre-parse the message (Outlook/Gmail fetch services) should
   * pass this so the junction is populated atomically with the email INSERT.
   *
   * If absent, the email INSERT succeeds and a Sentry breadcrumb records the
   * miss (per SR Step-7 Q4 resolution: optional + breadcrumb, not required).
   * The legacy flat columns (sender/recipients/cc/bcc) remain authoritative
   * for free-text search regardless.
   */
  participants?: ParsedParticipant[];
}

// BACKLOG-1107: Explicit column lists for SELECT queries instead of SELECT *.
const EMAIL_COLUMNS = `id, user_id, external_id, source, account_id, direction,
  subject, body_plain, body_html, sender, recipients, cc, bcc,
  thread_id, in_reply_to, references_header, sent_at, received_at,
  has_attachments, attachment_count, message_id_header, content_hash, labels, created_at`;

const EMAIL_COLUMNS_LIGHT = `id, user_id, external_id, source, account_id, direction,
  subject, sender, recipients, cc, bcc, thread_id, in_reply_to, references_header,
  sent_at, received_at, has_attachments, attachment_count, message_id_header,
  content_hash, labels, created_at`;

// ============================================
// CRUD OPERATIONS
// ============================================

/**
 * Create a new email in the emails table.
 *
 * BACKLOG-506: Emails are stored separately from communications.
 * After creating an email, use communicationDbService to create the junction link.
 *
 * @param emailData - The email content to store
 * @returns The created email with generated ID
 */
export async function createEmail(emailData: NewEmail): Promise<Email> {
  const id = crypto.randomUUID();

  const sql = `
    INSERT INTO emails (
      id, user_id, external_id, source, account_id, direction,
      subject, body_plain, body_html,
      sender, recipients, cc, bcc,
      thread_id, in_reply_to, references_header,
      sent_at, received_at,
      has_attachments, attachment_count,
      message_id_header, content_hash, labels,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;

  const params = [
    id,
    emailData.user_id,
    emailData.external_id || null,
    emailData.source || null,
    emailData.account_id || null,
    emailData.direction || null,
    emailData.subject || null,
    emailData.body_plain || null,
    emailData.body_html || null,
    emailData.sender || null,
    emailData.recipients || null,
    emailData.cc || null,
    emailData.bcc || null,
    emailData.thread_id || null,
    emailData.in_reply_to || null,
    emailData.references_header || null,
    emailData.sent_at || null,
    emailData.received_at || null,
    emailData.has_attachments ? 1 : 0,
    emailData.attachment_count || 0,
    emailData.message_id_header || null,
    emailData.content_hash || null,
    emailData.labels || null,
  ];

  // BACKLOG-1722: insert email + participants atomically in a single
  // transaction. When callers omit `participants` (e.g. _saveCommunications),
  // self-derive them from the legacy sender/recipients/cc/bcc fields so every
  // email has junction rows regardless of which write path created it.
  const resolvedParticipants: Array<{
    role: "from" | "to" | "cc" | "bcc";
    position: number;
    email_address: string;
    display_name: string | null;
  }> =
    emailData.participants && emailData.participants.length > 0
      ? emailData.participants.map((p) => ({
          role: p.role,
          position: p.position,
          email_address: p.email_address,
          display_name: p.display_name ?? null,
        }))
      : (() => {
          // R2 (BACKLOG-1722): self-derive from legacy columns
          const derived: typeof resolvedParticipants = [];
          const fields: Array<{ col: string | null | undefined; role: "from" | "to" | "cc" | "bcc" }> = [
            { col: emailData.sender, role: "from" },
            { col: emailData.recipients, role: "to" },
            { col: emailData.cc, role: "cc" },
            { col: emailData.bcc, role: "bcc" },
          ];
          for (const f of fields) {
            if (!f.col) continue;
            try {
              const parsed = parseEmailAddressList(f.col);
              parsed.addresses.forEach((addr, idx) => {
                derived.push({ role: f.role, position: idx, email_address: addr.email_address, display_name: addr.display_name ?? null });
              });
            } catch {
              // Non-fatal: legacy row is still written
            }
          }
          return derived;
        })();

  const rawDb = getRawDatabase();
  const insertParticipantStmt = rawDb.prepare(
    `INSERT OR IGNORE INTO email_participants
       (email_id, role, position, participant_hash, email_address, display_name)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const runTx = rawDb.transaction(() => {
    dbRun(sql, params);
    for (const p of resolvedParticipants) {
      insertParticipantStmt.run(
        id,
        p.role,
        p.position,
        computeParticipantHash(id, p.role, p.position, p.email_address),
        p.email_address,
        p.display_name
      );
    }
  });
  runTx();

  if (resolvedParticipants.length === 0) {
    Sentry.addBreadcrumb({
      category: "email.create",
      message: "createEmail: no participants derived — junction not populated",
      level: "info",
      data: {
        emailId: id,
        userId: emailData.user_id,
        source: emailData.source ?? null,
      },
    });
  } else if (!emailData.participants || emailData.participants.length === 0) {
    Sentry.addBreadcrumb({
      category: "email.create",
      message: "createEmail: derived participants from legacy fields",
      level: "info",
      data: { emailId: id, count: resolvedParticipants.length },
    });
  }

  // BACKLOG-1107: Return data from memory instead of INSERT-then-SELECT.
  const email: Email = {
    id, user_id: emailData.user_id,
    external_id: emailData.external_id || undefined,
    source: emailData.source || undefined,
    account_id: emailData.account_id || undefined,
    direction: emailData.direction || undefined,
    subject: emailData.subject || undefined,
    body_plain: emailData.body_plain || undefined,
    body_html: emailData.body_html || undefined,
    sender: emailData.sender || undefined,
    recipients: emailData.recipients || undefined,
    cc: emailData.cc || undefined,
    bcc: emailData.bcc || undefined,
    thread_id: emailData.thread_id || undefined,
    in_reply_to: emailData.in_reply_to || undefined,
    references_header: emailData.references_header || undefined,
    sent_at: emailData.sent_at || undefined,
    received_at: emailData.received_at || undefined,
    has_attachments: emailData.has_attachments || false,
    attachment_count: emailData.attachment_count || 0,
    message_id_header: emailData.message_id_header || undefined,
    content_hash: emailData.content_hash || undefined,
    labels: emailData.labels || undefined,
    created_at: new Date().toISOString(),
  };

  return email;
}

/**
 * Get an email by ID
 */
export async function getEmailById(emailId: string): Promise<Email | null> {
  const sql = `SELECT ${EMAIL_COLUMNS} FROM emails WHERE id = ?`;
  const email = dbGet<Email>(sql, [emailId]);
  return email || null;
}

/**
 * Get an email by external ID (Gmail/Outlook message ID)
 * Used for deduplication during import
 */
export async function getEmailByExternalId(
  userId: string,
  externalId: string
): Promise<Email | null> {
  const sql = `SELECT ${EMAIL_COLUMNS_LIGHT} FROM emails WHERE user_id = ? AND external_id = ?`;
  const email = dbGet<Email>(sql, [userId, externalId]);
  return email || null;
}

/**
 * Get an email by message_id_header (RFC 5322 Message-ID)
 * Used for deduplication during import
 */
export async function getEmailByMessageIdHeader(
  userId: string,
  messageIdHeader: string
): Promise<Email | null> {
  const sql = `SELECT ${EMAIL_COLUMNS_LIGHT} FROM emails WHERE user_id = ? AND message_id_header = ?`;
  const email = dbGet<Email>(sql, [userId, messageIdHeader]);
  return email || null;
}

/**
 * Get all emails for a user
 */
export async function getEmailsByUser(userId: string): Promise<Email[]> {
  const sql = `
    SELECT ${EMAIL_COLUMNS} FROM emails
    WHERE user_id = ?
    ORDER BY sent_at DESC
  `;
  return dbAll<Email>(sql, [userId]);
}

/**
 * Get cached emails for a user with optional date range, search query, and limit.
 * Used by the Attach Emails modal to read from local cache before hitting the provider API.
 */
export async function getCachedEmails(
  userId: string,
  options?: { query?: string; after?: Date | null; before?: Date | null; maxResults?: number }
): Promise<Email[]> {
  const conditions = ["user_id = ?"];
  const params: (string | number)[] = [userId];

  if (options?.after) {
    conditions.push("sent_at >= ?");
    params.push(options.after.toISOString());
  }
  if (options?.before) {
    conditions.push("sent_at <= ?");
    params.push(options.before.toISOString());
  }
  if (options?.query) {
    // BACKLOG-1722 (intentional LIKE — DO NOT migrate to email_participants):
    // this is the user-facing free-text search box in the Attach Emails modal.
    // Users type partial names, subject fragments, or domain stems — NOT
    // exact email addresses — so the junction lookup would be a behavior
    // regression. Subject is the most useful field here and isn't in the
    // junction at all.
    conditions.push("(subject LIKE ? OR sender LIKE ? OR recipients LIKE ?)");
    const q = `%${options.query}%`;
    params.push(q, q, q);
  }

  const limit = options?.maxResults || 500;

  // BACKLOG-1579 Phase 2: Return native UUID from the emails table.
  // linkEmails now accepts UUIDs directly, so no provider-prefix needed.
  //
  // BACKLOG-1707: include body_plain + body_html so the Attach Emails
  // modal's preview pane renders content BEFORE the email is attached.
  // The list is bounded by `LIMIT` (default 500) so the extra payload is
  // bounded too; the user already sees this data once attached, so there
  // is no privacy delta.
  const sql = `
    SELECT
      e.id,
      e.user_id, e.external_id, e.source, e.account_id, e.direction,
      e.subject, e.sender, e.recipients, e.cc, e.bcc,
      e.body_plain, e.body_html,
      e.thread_id,
      e.in_reply_to, e.references_header,
      e.sent_at, e.received_at,
      e.has_attachments, e.attachment_count, e.message_id_header,
      e.content_hash, e.labels, e.created_at
    FROM emails e
    WHERE ${conditions.join(" AND ")}
    ORDER BY sent_at DESC
    LIMIT ?
  `;
  params.push(limit);
  return dbAll<Email>(sql, params);
}

/**
 * Get emails in a thread
 */
export async function getEmailsByThread(
  userId: string,
  threadId: string
): Promise<Email[]> {
  const sql = `
    SELECT ${EMAIL_COLUMNS} FROM emails
    WHERE user_id = ? AND thread_id = ?
    ORDER BY sent_at ASC
  `;
  return dbAll<Email>(sql, [userId, threadId]);
}

/**
 * Update an email
 */
export async function updateEmail(
  emailId: string,
  updates: Partial<Email>
): Promise<void> {
  const allowedFields = [
    "subject",
    "body_plain",
    "body_html",
    "sender",
    "recipients",
    "cc",
    "bcc",
    "thread_id",
    "has_attachments",
    "attachment_count",
    "labels",
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

  values.push(emailId);

  const sql = `UPDATE emails SET ${fields.join(", ")} WHERE id = ?`;
  dbRun(sql, values);
}

/**
 * Delete an email by ID
 * Note: This will also delete any communications referencing this email
 * via the ON DELETE CASCADE foreign key constraint.
 */
export async function deleteEmail(emailId: string): Promise<void> {
  const sql = "DELETE FROM emails WHERE id = ?";
  dbRun(sql, [emailId]);
}

/**
 * Delete an email by external ID
 */
export async function deleteEmailByExternalId(
  userId: string,
  externalId: string
): Promise<void> {
  const sql = "DELETE FROM emails WHERE user_id = ? AND external_id = ?";
  dbRun(sql, [userId, externalId]);
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Check if an email exists (by external_id or message_id_header)
 * Used for deduplication during import
 */
export async function emailExists(
  userId: string,
  externalId?: string,
  messageIdHeader?: string
): Promise<boolean> {
  if (externalId) {
    const email = await getEmailByExternalId(userId, externalId);
    if (email) return true;
  }

  if (messageIdHeader) {
    const email = await getEmailByMessageIdHeader(userId, messageIdHeader);
    if (email) return true;
  }

  return false;
}

/**
 * Count emails for a user
 */
export async function countEmailsByUser(userId: string): Promise<number> {
  const sql = "SELECT COUNT(*) as count FROM emails WHERE user_id = ?";
  const result = dbGet<{ count: number }>(sql, [userId]);
  return result?.count || 0;
}
