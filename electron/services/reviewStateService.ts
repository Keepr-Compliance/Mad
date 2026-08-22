/**
 * Review State Service (BACKLOG-2791 / BACKLOG-2792)
 *
 * THE ONE SOURCE OF TRUTH for "what still needs review on this transaction".
 *
 * Founder ruling, 2026-08-22:
 *   "both text messages and emails that need review should have ONE source of
 *    trust; they can be displayed combined (email+text) in Needs Review or
 *    separately in the needs-review sections of the emails/texts tabs, but the
 *    data and state should be the same in the backend, and it all counts toward
 *    the needs-review required for completing the transaction."
 *
 * So: TWO stores, ONE read function.
 *
 *   store A  `pending_review_communications` — found by the sync, NOT linked.
 *   store B  `communications` rows with `match_reason='address_missing'` — the
 *            legacy BACKLOG-2319 population, already linked but flagged.
 *
 * `getReviewState()` unions them. EVERY surface — the combined S2 screen, the
 * emails tab's needs-review section, the texts tab's needs-review section, the
 * B1 badge, the P2/P3 counts and the Complete gate — reads THIS and nothing
 * else. No surface may query either store directly; `reviewStateService.singleReadPath`
 * test pins that, and the same-set-by-ID test pins that the three renderings
 * show one set.
 *
 * Storage stays split on purpose: unifying the STORES would mean unlinking
 * previously-linked rows and changing what a Quick Export already contains.
 * Unification happens at the read function, which costs nothing and reverses
 * cleanly.
 *
 * WHY STORE A IS A SEPARATE TABLE, AND NOT A NEW `match_reason` VALUE
 * ------------------------------------------------------------------
 * The founder's model is "found, but NOT linked until approved". Every row in
 * `communications` IS a link — 41 read sites across 10 files treat it that way,
 * with no choke point. Encoding "pending" there would have:
 *   1. broken `linkEmailToTransaction`, which decides `already_linked` purely
 *      from row existence — a pending row is indistinguishable from a real link
 *      to the linker itself;
 *   2. surfaced pending mail in transaction search (6 read sites);
 *   3. shipped unapproved mail inside a per-row Quick Export from the
 *      transactions list, which bypasses the details-screen Complete gate
 *      entirely (exportGate is paywall-only);
 *   4. inverted the column's documented meaning ("why this email IS attached").
 * A dedicated table makes all four impossible: nothing that exists reads it.
 *
 * DELTA-CHEAPNESS (BACKLOG-2620 convergence constraint)
 * -----------------------------------------------------
 * The sync runs on EVERY transaction open, so it must not re-examine records
 * that already lost. `autoLinkCommunicationsForContact` is structurally a full
 * re-scan of the deal's whole window per assigned contact, made incremental only
 * by `AND c.id IS NULL` — precisely the 2620 shape, and what this replaces on
 * the details surface.
 *
 * The two triggers scan on DIFFERENT axes, each bounded:
 *   T1 "open"           — only records INGESTED since
 *                         `transactions.last_pending_scan_at`, across all deal
 *                         identities. The watermark advances, so an unmatched
 *                         record is never examined twice. Converges.
 *   T2 "contact-change" — the FULL window, but ONLY for the CHANGED identities.
 *                         A watermark cannot cover this direction: a newly-added
 *                         contact's matching mail is OLDER than the watermark
 *                         and would be missed forever.
 *
 * The watermark compares `created_at` (ingestion time), NOT `sent_at`: a
 * backfill or device import writes an OLD `sent_at` with a NEW `created_at`, and
 * a `sent_at` watermark would silently skip every one of them.
 */

import crypto from "crypto";
import { dbGet, dbAll, dbRun } from "./db/core/dbConnection";
import {
  getIgnoredEmailIdsForTransaction,
  getIgnoredThreadIdsForTransaction,
  createThreadCommunicationReference,
  addIgnoredCommunication,
  confirmEmailLinksByEmailIds,
} from "./db/communicationDbService";
import { linkEmailToTransaction } from "./autoLinkService";
import { computeTransactionDateRange } from "../utils/emailDateRange";
import { reactionExclusion } from "./db/reactionExclusion";
import logService from "./logService";

const MODULE = "ReviewStateService";

/** Which store an item came from. Drives which existing machinery acts on it. */
export type ReviewOrigin = "pending" | "legacy";
export type ReviewKind = "email" | "text";

/**
 * What a surface needs to RENDER an item.
 *
 * It travels with the item rather than being fetched separately, because a
 * pending item is deliberately NOT in `communications` — the tabs' existing
 * loaders cannot see it, so a surface that tried to join display data itself
 * would silently render nothing for exactly the rows this feature exists to
 * show.
 */
export interface ReviewItemDisplay {
  /** Email subject, or the text thread's counterparty handle. */
  title: string;
  /** Sender address (emails) or thread participants (texts). */
  subtitle: string;
  /** First line of the body, for recognisability. */
  snippet: string;
  /** ISO timestamp of the communication itself (NOT when it was queued). */
  occurredAt: string | null;
  /** Messages in the thread (texts) or emails in the thread (emails). */
  itemCount: number;
}

export interface ReviewItem {
  /** `${origin}:${rowId}` — stable and unambiguous across every surface. */
  id: string;
  origin: ReviewOrigin;
  kind: ReviewKind;
  transaction_id: string;
  email_id: string | null;
  thread_id: string | null;
  found_at: string;
  display: ReviewItemDisplay;
}

export interface ReviewState {
  items: ReviewItem[];
  /** items.length — the ONE number for the badge, P2/P3 and the Complete gate. */
  count: number;
}

export interface PendingSyncResult {
  /** Items THIS run newly added — the P2 popup is silent when 0. */
  added: number;
  /** Outstanding total after the run (badge). */
  outstanding: number;
}

export type PendingSyncReason = "open" | "contact-change";

interface TxnRow {
  id: string;
  user_id: string;
  started_at: string | null;
  created_at: string | null;
  closed_at: string | null;
  last_pending_scan_at: string | null;
}

const encodeId = (origin: ReviewOrigin, rowId: string): string => `${origin}:${rowId}`;

function decodeId(id: string): { origin: ReviewOrigin; rowId: string } | null {
  const idx = id.indexOf(":");
  if (idx <= 0) return null;
  const origin = id.slice(0, idx);
  const rowId = id.slice(idx + 1);
  if (origin !== "pending" && origin !== "legacy") return null;
  if (!rowId) return null;
  return { origin, rowId };
}

/* ------------------------------------------------------------------ *
 * THE canonical read
 * ------------------------------------------------------------------ */

/**
 * Every needs-review item on the transaction, from BOTH stores, as one set.
 *
 * This is the ONLY function any surface may call to learn review state. Adding a
 * second read path is what `reviewStateService.singleReadPath` fails on.
 */
export function getReviewState(transactionId: string): ReviewState {
  const pending = dbAll<{
    id: string;
    transaction_id: string;
    email_id: string | null;
    thread_id: string | null;
    found_at: string;
  }>(
    `SELECT id, transaction_id, email_id, thread_id, found_at
       FROM pending_review_communications
      WHERE transaction_id = ?`,
    [transactionId],
  ).map<ReviewItem>((r) => ({
    id: encodeId("pending", r.id),
    origin: "pending",
    kind: r.email_id ? "email" : "text",
    transaction_id: r.transaction_id,
    email_id: r.email_id,
    thread_id: r.thread_id,
    found_at: r.found_at,
    display: r.email_id ? emailDisplay(r.email_id) : threadDisplay(r.thread_id),
  }));

  // Legacy BACKLOG-2319 population: linked but flagged address_missing. The
  // founder ruled these count toward the same total and belong to the same set,
  // so they are unioned HERE and nowhere else — one include point.
  const legacy = dbAll<{
    id: string;
    transaction_id: string;
    email_id: string | null;
    thread_id: string | null;
    linked_at: string;
  }>(
    `SELECT id, transaction_id, email_id, thread_id, linked_at
       FROM communications
      WHERE transaction_id = ?
        AND email_id IS NOT NULL
        AND match_reason = 'address_missing'`,
    [transactionId],
  ).map<ReviewItem>((r) => ({
    id: encodeId("legacy", r.id),
    origin: "legacy",
    kind: "email",
    transaction_id: r.transaction_id,
    email_id: r.email_id,
    thread_id: r.thread_id,
    found_at: r.linked_at,
    display: emailDisplay(r.email_id),
  }));

  const items = [...pending, ...legacy].sort((a, b) =>
    (b.display.occurredAt ?? b.found_at).localeCompare(a.display.occurredAt ?? a.found_at),
  );
  return { items, count: items.length };
}

const EMPTY_DISPLAY: ReviewItemDisplay = {
  title: "(no subject)",
  subtitle: "",
  snippet: "",
  occurredAt: null,
  itemCount: 1,
};

function firstLine(text: string | null): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

function emailDisplay(emailId: string | null): ReviewItemDisplay {
  if (!emailId) return EMPTY_DISPLAY;
  const row = dbGet<{
    subject: string | null;
    sender: string | null;
    body_plain: string | null;
    sent_at: string | null;
  }>("SELECT subject, sender, body_plain, sent_at FROM emails WHERE id = ?", [emailId]);
  if (!row) return EMPTY_DISPLAY;
  return {
    title: row.subject?.trim() || "(no subject)",
    subtitle: row.sender ?? "",
    snippet: firstLine(row.body_plain),
    occurredAt: row.sent_at,
    itemCount: 1,
  };
}

function threadDisplay(threadId: string | null): ReviewItemDisplay {
  if (!threadId) return EMPTY_DISPLAY;
  const row = dbGet<{
    n: number;
    participants: string | null;
    body_text: string | null;
    sent_at: string | null;
  }>(
    `SELECT COUNT(*) AS n,
            MAX(m.participants_flat) AS participants,
            MAX(m.body_text) AS body_text,
            MAX(m.sent_at) AS sent_at
       FROM messages m
      WHERE m.thread_id = ?`,
    [threadId],
  );
  if (!row) return EMPTY_DISPLAY;
  return {
    title: row.participants?.split(",")[0]?.trim() || "Text conversation",
    subtitle: row.participants ?? "",
    snippet: firstLine(row.body_text),
    occurredAt: row.sent_at,
    itemCount: row.n ?? 1,
  };
}

/**
 * Convenience for the badge / gate. Deliberately derived from getReviewState so
 * a count can never disagree with the list it summarises.
 */
export function countReviewItems(transactionId: string): number {
  return getReviewState(transactionId).count;
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

function getTransactionRow(transactionId: string): TxnRow | undefined {
  return dbGet<TxnRow>(
    `SELECT id, user_id, started_at, created_at, closed_at, last_pending_scan_at
       FROM transactions WHERE id = ?`,
    [transactionId],
  );
}

function getIdentities(
  transactionId: string,
  contactIds?: string[],
): { emails: string[]; phones: string[] } {
  const scoped = !!contactIds && contactIds.length > 0;
  const idFilter = scoped
    ? `IN (${contactIds!.map(() => "?").join(", ")})`
    : `IN (SELECT contact_id FROM transaction_contacts WHERE transaction_id = ?)`;
  const params: string[] = scoped ? contactIds! : [transactionId];

  const emails = dbAll<{ email: string }>(
    `SELECT DISTINCT LOWER(TRIM(email)) AS email FROM contact_emails
      WHERE contact_id ${idFilter} AND email IS NOT NULL AND TRIM(email) != ''`,
    params,
  ).map((r) => r.email);

  const phones = dbAll<{ phone: string }>(
    `SELECT DISTINCT phone_number AS phone FROM contact_phones
      WHERE contact_id ${idFilter} AND phone_number IS NOT NULL AND TRIM(phone_number) != ''`,
    params,
  ).map((r) => r.phone);

  return { emails, phones };
}

/**
 * Candidate emails: match a deal identity, inside the deal's window, NOT already
 * linked, NOT already pending, NOT previously rejected. `since` (the watermark)
 * bounds the scan to newly-INGESTED rows on the T1 path.
 */
function findCandidateEmailIds(
  txn: TxnRow,
  addresses: string[],
  range: { start: Date; end: Date },
  since: string | null,
): string[] {
  if (addresses.length === 0) return [];
  const placeholders = addresses.map(() => "?").join(", ");
  const sql = `
    SELECT DISTINCT e.id
      FROM email_participants ep
      JOIN emails e ON e.id = ep.email_id
      LEFT JOIN communications c
        ON c.email_id = e.id AND c.transaction_id = ?
      LEFT JOIN pending_review_communications p
        ON p.email_id = e.id AND p.transaction_id = ?
     WHERE ep.email_address IN (${placeholders})
       AND e.user_id = ?
       AND c.id IS NULL
       AND p.id IS NULL
       AND e.sent_at >= ?
       AND e.sent_at <= ?
       ${since ? "AND e.created_at > ?" : ""}
  `;
  const params: (string | number)[] = [
    txn.id,
    txn.id,
    ...addresses,
    txn.user_id,
    range.start.toISOString(),
    range.end.toISOString(),
  ];
  if (since) params.push(since);
  return dbAll<{ id: string }>(sql, params).map((r) => r.id);
}

/** Candidate text threads — same exclusions, keyed on thread_id. */
function findCandidateThreadIds(
  txn: TxnRow,
  phones: string[],
  range: { start: Date; end: Date },
  since: string | null,
): string[] {
  if (phones.length === 0) return [];
  const phoneConditions = phones.map(() => "m.participants_flat LIKE ?").join(" OR ");
  const sql = `
    SELECT DISTINCT m.thread_id AS thread_id
      FROM messages m
     WHERE m.user_id = ?
       AND m.channel IN ('sms', 'imessage')
       AND m.duplicate_of IS NULL
       AND m.thread_id IS NOT NULL
       AND ${reactionExclusion("m")}
       AND (${phoneConditions})
       AND m.sent_at >= ?
       AND m.sent_at <= ?
       ${since ? "AND m.created_at > ?" : ""}
       AND m.thread_id NOT IN (
         SELECT thread_id FROM communications
          WHERE transaction_id = ? AND thread_id IS NOT NULL
       )
       AND m.thread_id NOT IN (
         SELECT thread_id FROM pending_review_communications
          WHERE transaction_id = ? AND thread_id IS NOT NULL
       )
  `;
  const params: (string | number)[] = [txn.user_id];
  for (const phone of phones) {
    const digits = phone.replace(/\D/g, "");
    params.push(`%${digits.length > 10 ? digits.slice(-10) : digits}%`);
  }
  params.push(range.start.toISOString(), range.end.toISOString());
  if (since) params.push(since);
  params.push(txn.id, txn.id);
  return dbAll<{ thread_id: string }>(sql, params).map((r) => r.thread_id);
}

/**
 * THE sync. Adds newly-found communications to the queue as PENDING — it never
 * links. Returns how many were added (P2 shows only when > 0) and the
 * outstanding total (B1 badge).
 */
export async function syncReviewQueueForTransaction(opts: {
  transactionId: string;
  reason: PendingSyncReason;
  contactIds?: string[];
}): Promise<PendingSyncResult> {
  const { transactionId, reason, contactIds } = opts;
  const txn = getTransactionRow(transactionId);
  if (!txn) return { added: 0, outstanding: 0 };

  const range = computeTransactionDateRange({
    started_at: txn.started_at,
    created_at: txn.created_at,
    closed_at: txn.closed_at,
  });

  const since = reason === "open" ? txn.last_pending_scan_at : null;
  const { emails, phones } = getIdentities(transactionId, contactIds);

  const rejectedEmailIds = new Set(getIgnoredEmailIdsForTransaction(transactionId));
  const rejectedThreadIds = new Set(getIgnoredThreadIdsForTransaction(transactionId));

  const emailIds = findCandidateEmailIds(txn, emails, range, since).filter(
    (id) => !rejectedEmailIds.has(id),
  );
  const threadIds = findCandidateThreadIds(txn, phones, range, since).filter(
    (id) => !rejectedThreadIds.has(id),
  );

  let added = 0;
  for (const emailId of emailIds) {
    // INSERT OR IGNORE + the UNIQUE index is the DB backstop for the dedup
    // predicate: even a racing sync cannot double-queue an item. `changes`
    // therefore counts only rows that were genuinely NEW, which is what makes
    // `added` (and so the P2 popup) honest.
    const res = dbRun(
      `INSERT OR IGNORE INTO pending_review_communications
         (id, user_id, transaction_id, email_id, thread_id, found_at)
       VALUES (?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)`,
      [crypto.randomUUID(), txn.user_id, transactionId, emailId],
    );
    if ((res.changes ?? 0) > 0) added++;
  }
  for (const threadId of threadIds) {
    const res = dbRun(
      `INSERT OR IGNORE INTO pending_review_communications
         (id, user_id, transaction_id, email_id, thread_id, found_at)
       VALUES (?, ?, ?, NULL, ?, CURRENT_TIMESTAMP)`,
      [crypto.randomUUID(), txn.user_id, transactionId, threadId],
    );
    if ((res.changes ?? 0) > 0) added++;
  }

  // Advance the watermark ONLY on the open path. The contact-change path scanned
  // BEHIND the watermark for a subset of identities, so advancing it there would
  // declare records scanned that never were.
  if (reason === "open") {
    dbRun("UPDATE transactions SET last_pending_scan_at = CURRENT_TIMESTAMP WHERE id = ?", [
      transactionId,
    ]);
  }

  await logService.debug(`Review sync (${reason}) added ${added} item(s)`, MODULE, {
    transactionId,
    reason,
    added,
    scopedContacts: contactIds?.length ?? null,
    since,
  });

  return { added, outstanding: countReviewItems(transactionId) };
}

/* ------------------------------------------------------------------ *
 * Approve / Reject — uniform regardless of which surface acted
 * ------------------------------------------------------------------ */

function loadItem(id: string): ReviewItem | undefined {
  const decoded = decodeId(id);
  if (!decoded) return undefined;

  if (decoded.origin === "pending") {
    const r = dbGet<{
      id: string;
      transaction_id: string;
      email_id: string | null;
      thread_id: string | null;
      found_at: string;
    }>(
      `SELECT id, transaction_id, email_id, thread_id, found_at
         FROM pending_review_communications WHERE id = ?`,
      [decoded.rowId],
    );
    if (!r) return undefined;
    return {
      id,
      origin: "pending",
      kind: r.email_id ? "email" : "text",
      transaction_id: r.transaction_id,
      email_id: r.email_id,
      thread_id: r.thread_id,
      found_at: r.found_at,
      display: r.email_id ? emailDisplay(r.email_id) : threadDisplay(r.thread_id),
    };
  }

  const r = dbGet<{
    id: string;
    transaction_id: string;
    email_id: string | null;
    thread_id: string | null;
    linked_at: string;
  }>(
    `SELECT id, transaction_id, email_id, thread_id, linked_at
       FROM communications WHERE id = ? AND match_reason = 'address_missing'`,
    [decoded.rowId],
  );
  if (!r) return undefined;
  return {
    id,
    origin: "legacy",
    kind: "email",
    transaction_id: r.transaction_id,
    email_id: r.email_id,
    thread_id: r.thread_id,
    found_at: r.linked_at,
    display: emailDisplay(r.email_id),
  };
}

/**
 * Approve. For a PENDING item this is what LINKS it, per the normal rules. For a
 * LEGACY item the row is already linked, so approval is the existing 2319
 * confirm (match_reason → user_confirmed). Both leave the item out of
 * getReviewState afterwards, which is what "uniform state transitions" means.
 */
export async function approveReviewItems(itemIds: string[]): Promise<{ approved: number }> {
  let approved = 0;
  for (const itemId of itemIds) {
    const item = loadItem(itemId);
    if (!item) continue;

    if (item.origin === "legacy") {
      if (!item.email_id) continue;
      confirmEmailLinksByEmailIds([item.email_id], item.transaction_id);
      approved++;
      continue;
    }

    if (item.email_id) {
      await linkEmailToTransaction(
        item.email_id,
        item.transaction_id,
        "manual",
        0.95,
        "user_confirmed",
      );
    } else if (item.thread_id) {
      const txn = getTransactionRow(item.transaction_id);
      if (!txn) continue;
      await createThreadCommunicationReference(
        item.thread_id,
        item.transaction_id,
        txn.user_id,
        "manual",
        0.95,
      );
    }
    dbRun("DELETE FROM pending_review_communications WHERE id = ?", [
      decodeId(itemId)!.rowId,
    ]);
    approved++;
  }
  return { approved };
}

/**
 * Reject — durable in BOTH directions. Writes the same `ignored_communications`
 * suppression row the existing unlink path writes, which every discovery path
 * (this service AND autoLinkService) already filters on, so a rejected item
 * cannot be resurrected by a later sync. A LEGACY item additionally has its
 * existing link row deleted, exactly as unlinking it from the tab would.
 */
export async function rejectReviewItems(itemIds: string[]): Promise<{ rejected: number }> {
  let rejected = 0;
  for (const itemId of itemIds) {
    const item = loadItem(itemId);
    if (!item) continue;

    const txn = getTransactionRow(item.transaction_id);
    if (!txn) continue;

    await addIgnoredCommunication({
      user_id: txn.user_id,
      transaction_id: item.transaction_id,
      email_id: item.email_id ?? undefined,
      thread_id: item.thread_id ?? undefined,
      original_communication_id: item.origin === "legacy" ? decodeId(itemId)!.rowId : undefined,
      reason: "rejected_in_review",
      match_reason: item.origin === "legacy" ? "address_missing" : null,
    });

    if (item.origin === "legacy") {
      dbRun("DELETE FROM communications WHERE id = ?", [decodeId(itemId)!.rowId]);
    } else {
      dbRun("DELETE FROM pending_review_communications WHERE id = ?", [
        decodeId(itemId)!.rowId,
      ]);
    }
    rejected++;
  }
  return { rejected };
}
