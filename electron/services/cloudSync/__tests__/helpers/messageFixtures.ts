/**
 * BACKLOG-4263 P5: emails, texts and links written with the producers' own statements (transcribed, not invented):
 * - emails: prepareEmailInsert (electron/services/db/emailSyncSql.ts:98-124), the sync insert;
 * - macOS texts: prepareInsertMessage (messageImportForceSql.ts:196-206), delta mode = the live table;
 * - iPhone texts: the column list of syncDbService.ts:169-174 (thread_id may be NULL: iPhoneSyncStorageService.ts:860);
 * - email links: INSERT_EMAIL_COMMUNICATION_SQL (autoLinkSql.ts:249-252);
 * - text links: INSERT_COMMUNICATION_SQL (messageMatchingSql.ts:140-145);
 * - thread links: the statement of createThreadCommunicationReference (communicationDbService.ts:1136-1139).
 * Ids are all-zero-style; addresses use example.test.
 */
import { prepareEmailInsert } from "../../../db/emailSyncSql";
import { prepareInsertMessage, prepareRetagReaction } from "../../../db/messageImportForceSql";
import { INSERT_EMAIL_COMMUNICATION_SQL } from "../../../db/autoLinkSql";
import { INSERT_COMMUNICATION_SQL } from "../../../db/messageMatchingSql";
import { DELETE_COMMUNICATION_SQL } from "../../../db/reviewStateSql";
import { HIDE_TEXT_FROM_EXPORT_SQL, UNHIDE_TEXT_FROM_EXPORT_SQL } from "../../../db/hiddenTextSql";
import { USER_A } from "./fixtures";
import type { TestDb } from "./sqlite";

export const fz = (kind: number, n: number) => `00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(n).padStart(12, "0")}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const raw = (db: TestDb) => db as any;

export interface EmailOpts {
  subject?: string | null;
  bodyPlain?: string | null;
  bodyHtml?: string | null;
  sender?: string | null;
  recipients?: string | null;
  cc?: string | null;
  threadId?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
  user?: string;
}

export function addEmail(db: TestDb, id: string, o: EmailOpts = {}): void {
  prepareEmailInsert(raw(db), { mode: "live" }).run(
    id, o.user ?? USER_A, `ext-${id}`, "gmail", "acct-1", "inbound",
    o.subject === undefined ? "Inspection report" : o.subject,
    o.bodyPlain === undefined ? "The report is attached." : o.bodyPlain,
    o.bodyHtml === undefined ? null : o.bodyHtml,
    o.sender === undefined ? "agent@example.test" : o.sender,
    o.recipients === undefined ? "buyer@example.test, seller@example.test" : o.recipients,
    o.cc === undefined ? null : o.cc,
    null,
    o.threadId === undefined ? `gth-${id}` : o.threadId, null, null,
    o.sentAt === undefined ? "2026-10-01T09:00:00.000Z" : o.sentAt,
    o.receivedAt === undefined ? "2026-10-01T09:00:05.000Z" : o.receivedAt,
    0, 0, null, null, null, null, "filter", null, 1,
  );
}

export interface TextOpts {
  channel?: "imessage" | "sms";
  externalId?: string | null;
  body?: string;
  threadId?: string | null;
  sentAt?: string;
  assocType?: number | null;
  assocGuid?: string | null;
  user?: string;
  participants?: string;
}

/** A macOS-imported text (the importer's own statement). */
export function addText(db: TestDb, id: string, o: TextOpts = {}): void {
  prepareInsertMessage(raw(db), { mode: "delta" }).run(
    id, o.user ?? USER_A, o.channel ?? "imessage", o.externalId === undefined ? `guid-${id}` : o.externalId, "inbound",
    o.body === undefined ? "See you at the closing" : o.body,
    o.participants ?? JSON.stringify({ from: "+15555550101", to: ["me"] }), "15555550101",
    o.threadId === undefined ? "macos-chat-1" : o.threadId,
    o.sentAt ?? "2026-10-02T10:00:00.000Z", 0, "text", JSON.stringify({ source: "macos_messages" }),
    o.assocType ?? null, o.assocGuid ?? null,
  );
}

/** An iPhone-synced text (syncDbService.ts:169-174 column list). */
export function addPhoneText(db: TestDb, id: string, o: { externalId?: string; threadId?: string | null; body?: string | null } = {}): void {
  db.prepare(
    `INSERT OR IGNORE INTO messages (
      id, user_id, channel, external_id, direction,
      body_text, participants, participants_flat, thread_id, sent_at,
      has_attachments, message_type, metadata, sync_session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  ).run(
    id, USER_A, "imessage", o.externalId ?? `guid-${id}`, "inbound",
    o.body === undefined ? "Running late" : o.body, JSON.stringify({ from: "+15555550102", to: ["me"] }), "15555550102",
    o.threadId === undefined ? null : o.threadId, "2026-10-03T11:00:00.000Z", 0, "text", JSON.stringify({ source: "iphone_sync" }), null,
  );
}

export function linkEmail(db: TestDb, linkId: string, deal: string, emailId: string, o: { matchReason?: string | null; source?: string; confidence?: number } = {}): void {
  db.prepare(INSERT_EMAIL_COMMUNICATION_SQL).run(linkId, USER_A, deal, emailId, `gth-${emailId}`, o.source ?? "auto", o.confidence ?? 0.9, o.matchReason ?? null);
}

export function linkText(db: TestDb, linkId: string, deal: string, messageId: string): void {
  db.prepare(INSERT_COMMUNICATION_SQL).run(linkId, USER_A, deal, messageId, "manual", 1);
}

export function linkThread(db: TestDb, linkId: string, deal: string, threadId: string, user = USER_A): void {
  db.prepare(
    `INSERT INTO communications (
      id, user_id, thread_id, transaction_id,
      link_source, link_confidence, linked_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  ).run(linkId, user, threadId, deal, "manual", 1);
}

export function unlink(db: TestDb, linkId: string): void {
  db.prepare(DELETE_COMMUNICATION_SQL).run(linkId);
}

export function hideText(db: TestDb, deal: string, messageId: string): number {
  return (db.prepare(HIDE_TEXT_FROM_EXPORT_SQL).run(USER_A, messageId, deal) as { changes: number }).changes;
}

export function unhideText(db: TestDb, deal: string, messageId: string): void {
  db.prepare(UNHIDE_TEXT_FROM_EXPORT_SQL).run(deal, messageId, messageId);
}

/** The importer's in-place retag of a legacy reaction (messageImportForceSql.ts:219-230), delta mode. */
export function retag(db: TestDb, externalId: string, type: number, guid: string): number {
  return (prepareRetagReaction(raw(db), { mode: "delta" }).run(type, guid, USER_A, externalId) as { changes: number }).changes;
}
