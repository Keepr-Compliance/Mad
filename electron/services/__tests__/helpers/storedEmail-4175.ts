/**
 * BACKLOG-4175 test helper: writes a cached `emails` row through the SAME
 * statement the sync writes with (`prepareEmailInsert`, emailSyncSql.ts), with
 * the parameters bound in emailSyncService.ts's order, so a fixture row has
 * the shape a synced row has.
 *
 * Sender shapes, transcribed:
 *   - Gmail: the raw RFC 5322 `From` header value (`getHeader("From")`,
 *     gmailFetchService.ts:678), e.g. `"Zillow" <addr>`.
 *   - Outlook: `${name} <${address}>` when Graph gives a display name, else the
 *     bare address (outlookFetchService.ts:1384-1388).
 *
 * Non-Zillow addresses use reserved domains only.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { prepareEmailInsert } from "../../db/emailSyncSql";
import { CURRENT_DERIVATION_VERSION } from "../../../utils/derivationVersion";

export interface StoredEmailInput {
  id: string;
  userId: string;
  sender: string;
  subject: string;
  bodyPlain: string;
  sentAt: string;
  recipients?: string;
  source?: "gmail" | "outlook";
  hasAttachments?: boolean;
  /** emails.account_id; default "acct-4175". null stores NULL. */
  accountId?: string | null;
  /** Gmail labels / Outlook categories, JSON-encoded as the sync does (empty → NULL). */
  labels?: string[];
  /** Retained bulk headers, JSON-encoded as the sync does (empty → NULL). Keys from bulkMailHeaders.ts. */
  bulkMailHeaders?: Record<string, string | string[]>;
  /** emails.thread_id; default `th-<id>`. */
  threadId?: string;
}

export function gmailFrom(name: string, address: string): string {
  return `"${name}" <${address}>`;
}

export function outlookFrom(name: string | null, address: string): string {
  return name ? `${name} <${address}>` : address;
}

export function insertStoredEmail(db: DatabaseType, e: StoredEmailInput): void {
  prepareEmailInsert(db, { mode: "live" }).run(
    e.id,
    e.userId,
    `ext-${e.id}`,
    e.source ?? "gmail",
    e.accountId === undefined ? "acct-4175" : e.accountId,
    "inbound",
    e.subject,
    e.bodyPlain,
    null,
    e.sender,
    e.recipients ?? "me@example.test",
    null,
    null,
    e.threadId ?? `th-${e.id}`,
    null,
    null,
    e.sentAt,
    e.sentAt,
    e.hasAttachments ? 1 : 0,
    0,
    `<${e.id}@mail.example.test>`,
    "c".repeat(64),
    // Same encoding as emailSyncService.ts:962-977.
    e.labels && e.labels.length > 0 ? JSON.stringify(e.labels) : null,
    e.bulkMailHeaders && Object.keys(e.bulkMailHeaders).length > 0 ? JSON.stringify(e.bulkMailHeaders) : null,
    "filter",
    null,
    CURRENT_DERIVATION_VERSION,
  );
}
