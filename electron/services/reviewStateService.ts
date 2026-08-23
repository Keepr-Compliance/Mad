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
import { BrowserWindow } from "electron";
import { dbGet, dbAll, dbRun } from "./db/core/dbConnection";
import {
  createThreadCommunicationReference,
  addIgnoredCommunication,
  confirmEmailLinksByEmailIds,
} from "./db/communicationDbService";
import { linkEmailToTransaction } from "./autoLinkService";
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
  /**
   * THE GROUPING KEY — the provider's conversation id (BACKLOG-2791, the
   * contract's "unit rule": one card per thread, every button acts on the whole
   * thread).
   *
   * For an EMAIL this is `emails.thread_id`. It has to be projected here
   * because the item's OWN `thread_id` is NULL for every email row — the queue
   * keys emails by `email_id` and threads by `thread_id`, one or the other — so
   * the renderer has nothing to group on without it.
   *
   * It rides on `display` rather than on `ReviewItem.thread_id` deliberately:
   * `rejectReviewItems` writes `item.thread_id` into the
   * `ignored_communications` suppression row, and RemovedMessagesSection reads
   * removed TEXT threads out of exactly that column. An email item carrying a
   * thread_id would file rejected EMAILS under removed TEXTS.
   *
   * NULL when the provider never threaded the record — the renderer then keys
   * on the item id, which is a thread of one.
   */
  threadId: string | null;

  // ---- raw fields, so the renderer can rebuild a real thread ----
  //
  // BACKLOG-2791 (founder revert, 2026-08-22): the review surfaces render the
  // app's ORIGINAL EmailThreadCard / MessageThreadCard, which need a hydrated
  // thread — not the compact card the first cut used. A PENDING item is
  // deliberately absent from `communications`, so the tabs' own loaders cannot
  // hydrate it and the renderer would show nothing for exactly the rows this
  // feature exists to show. These are projected straight from the `emails` /
  // `messages` rows the item points at, so the card resolves participants (and
  // therefore CONTACT NAMES via nameMap) exactly as it does for a linked one.
  /** Comma-separated To addresses (emails). */
  recipients: string | null;
  /** Comma-separated Cc addresses (emails). */
  cc: string | null;
  /** Sender address (emails) — the raw value, unlike `subtitle`. */
  sender: string | null;
  /** Whether the underlying record carries attachments. */
  hasAttachments: boolean;
  /** Every distinct handle on a TEXT thread, for participant display. */
  threadParticipants: string[];
  /**
   * The TEXT thread's actual messages, so MessageThreadCard can render a real
   * conversation (participants, group detection, avatar, the View modal) rather
   * than a stand-in. Empty for email items.
   */
  threadMessages: Array<{
    id: string;
    thread_id: string | null;
    body_text: string | null;
    sent_at: string | null;
    direction: string | null;
    participants_flat: string | null;
    channel: string | null;
  }>;
}

export interface ReviewItem {
  /** `${origin}:${rowId}` — stable and unambiguous across every surface. */
  id: string;
  /**
   * The underlying row's primary key, already decoded. Carried so the
   * approve/reject paths never re-decode `id` (which forced a non-null
   * assertion at four sites, and with it the chance of asserting on a row that
   * had been deleted between the read and the write).
   */
  rowId: string;
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
  /** Items THIS run newly added to the review queue — the popup's "R". */
  added: number;
  /**
   * Communications THIS run LINKED outright, without needing approval — the
   * popup's "L". Confident emails plus every matching text thread.
   */
  linked: number;
  /** Outstanding total after the run (badge). */
  outstanding: number;
}

/**
 * Which axis a sync scans, and — just as important — whether it OWNS the
 * watermark.
 *
 *  "open"           the user opened the deal. Scans since the watermark, then
 *                   ADVANCES it. The one caller allowed to advance, so that
 *                   `added` can mean "new since you last looked".
 *  "background"     the on-open provider fetch queueing what it just pulled in.
 *                   Scans since the watermark but does NOT advance it, so the
 *                   "open" sync that follows still counts these items as new
 *                   and P2 does not under-report by exactly the freshly-fetched
 *                   mail — which is the case P2 exists for.
 *  "contact-change" a contact was added/edited/confirmed on the deal. Ignores
 *                   the watermark entirely (the matching mail is OLDER than it)
 *                   and does not advance it.
 */
export type PendingSyncReason =
  | "open"
  | "background"
  | "contact-change"
  /** The audit dates were edited so the window covers MORE (BACKLOG-2791). */
  | "date-extended";

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
    rowId: r.id,
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
    rowId: r.id,
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
  threadId: null,
  recipients: null,
  cc: null,
  sender: null,
  hasAttachments: false,
  threadParticipants: [],
  threadMessages: [],
};

function firstLine(text: string | null): string {
  if (!text) return "";
  // 200 to match EmailThreadCard's own `body_text.substring(0, 200)`, so the
  // preview row on a review card is fed exactly what a linked card gets before
  // the card applies its own 120-character display truncation.
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function emailDisplay(emailId: string | null): ReviewItemDisplay {
  if (!emailId) return EMPTY_DISPLAY;
  const row = dbGet<{
    subject: string | null;
    sender: string | null;
    recipients: string | null;
    cc: string | null;
    body_plain: string | null;
    sent_at: string | null;
    has_attachments: number | null;
    thread_id: string | null;
  }>(
    `SELECT subject, sender, recipients, cc, body_plain, sent_at, has_attachments, thread_id
       FROM emails WHERE id = ?`,
    [emailId],
  );
  if (!row) return EMPTY_DISPLAY;
  return {
    title: row.subject?.trim() || "(no subject)",
    subtitle: row.sender ?? "",
    snippet: firstLine(row.body_plain),
    occurredAt: row.sent_at,
    itemCount: 1,
    // The EMAIL's own thread — the grouping key. See ReviewItemDisplay.threadId.
    threadId: row.thread_id,
    recipients: row.recipients,
    cc: row.cc,
    sender: row.sender,
    hasAttachments: !!row.has_attachments,
    threadParticipants: [],
    threadMessages: [],
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
  // The real messages, so the card renders a real conversation.
  const threadMessages = dbAll<{
    id: string;
    thread_id: string | null;
    body_text: string | null;
    sent_at: string | null;
    direction: string | null;
    participants_flat: string | null;
    channel: string | null;
  }>(
    `SELECT id, thread_id, body_text, sent_at, direction, participants_flat, channel
       FROM messages
      WHERE thread_id = ? AND duplicate_of IS NULL
      ORDER BY sent_at ASC`,
    [threadId],
  );
  const handles = (row.participants ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return {
    title: handles[0] || "Text conversation",
    subtitle: row.participants ?? "",
    snippet: firstLine(row.body_text),
    occurredAt: row.sent_at,
    itemCount: row.n ?? 1,
    // A TEXT item is already one row per thread; carrying the key anyway keeps
    // the renderer's grouping uniform across both media.
    threadId,
    recipients: null,
    cc: null,
    sender: handles[0] ?? null,
    hasAttachments: false,
    threadParticipants: handles,
    threadMessages,
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




export interface ReviewQueueChangedEvent {
  transactionId: string;
  /** What THIS run newly queued — the popup's "R". Silent at 0. */
  added: number;
  /** What THIS run linked outright — the popup's "L". */
  linked: number;
  /** Outstanding total — drives the badge. */
  outstanding: number;
  reason: PendingSyncReason;
}

/**
 * Broadcast to every window, matching messagesBackgroundImportSignal's pattern.
 *
 * Never throws: a signal that cannot be delivered must not take down the sweep
 * it describes. The queue is already persisted at this point, so the worst case
 * is the old behaviour — the user sees it on the next open.
 */
function broadcastReviewQueueChanged(payload: ReviewQueueChangedEvent): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents) {
        win.webContents.send("review:queue-changed", payload);
      }
    }
  } catch {
    /* delivery is best-effort; the queue is already durable */
  }
}

/**
 * Announce that review state changed, without claiming anything was found.
 *
 * EVERY review mutation calls this — approve, reject, restore — not just the
 * discovery sweep. The founder's one-source rule has to hold at the VIEW layer
 * too, and it did not: the sweep broadcast, the mutations did not, so a reject
 * followed by a restore rewrote the database and left all three surfaces
 * rendering whatever they had at mount. Reopening the transaction "fixed" it,
 * which is the signature of state that is only ever read once.
 *
 * added/linked are 0 because a mutation discovers nothing; it only moves an item
 * that was already counted. That keeps the popup silent (it fires on added > 0)
 * while the badge, the tab sections and the review screen all refresh.
 */
export function notifyReviewStateChanged(transactionId: string): void {
  broadcastReviewQueueChanged({
    transactionId,
    added: 0,
    linked: 0,
    outstanding: countReviewItems(transactionId),
    reason: "background",
  });
}

/**
 * Queue ONE email for review, without linking it.
 *
 * The single write-point for the ambiguous half of develop's classification
 * (BACKLOG-2791 founder ruling): the confident half still links exactly as it
 * always has, and only the address-missing half lands here.
 *
 * Returns false when the row already existed — the caller counts that as
 * "already handled", never as newly queued, so the popup's R stays a true delta.
 */
export async function queueEmailForReview(
  transactionId: string,
  emailId: string,
  userId: string,
): Promise<boolean> {
  // A previously REJECTED email must not be re-queued; the suppression row is
  // the same one every discovery path already filters on.
  const rejected = dbGet<{ id: string }>(
    "SELECT id FROM ignored_communications WHERE transaction_id = ? AND email_id = ?",
    [transactionId, emailId],
  );
  if (rejected) return false;

  const res = dbRun(
    `INSERT OR IGNORE INTO pending_review_communications
       (id, user_id, transaction_id, email_id, thread_id, found_at)
     VALUES (?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)`,
    [crypto.randomUUID(), userId, transactionId, emailId],
  );
  return (res.changes ?? 0) > 0;
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
  if (!txn) return { added: 0, linked: 0, outstanding: 0 };


  // Only "open" advances the watermark; every reason may read it.
  const previousWatermark = txn.last_pending_scan_at;

  // ONE discovery mechanism, not two.
  //
  // BACKLOG-2791 (founder ruling, 2026-08-22): this sweep applies DEVELOP'S
  // classification rather than queueing everything —
  //   texts  -> always link (TASK-2087 removed address filtering from messages,
  //             so a matching thread has never needed review),
  //   emails -> the shipped split: confident links, address-missing queues.
  // It is delegated to autoLinkCommunicationsForContact so the predicate, the
  // multi-deal disambiguation and the rejection suppression stay in the ONE
  // place that implements them. An earlier revision ALSO ran its own candidate
  // loop here; because that list was computed before the autoLink pass, it
  // re-queued the very emails autoLink had just linked.
  //
  // The watermark still decides WHETHER to sweep and what "new" means; it no
  // longer decides what happens to what is found.
  const { autoLinkCommunicationsForContact } = await import("./autoLinkService");
  const assignedContacts =
    contactIds && contactIds.length > 0
      ? contactIds
      : dbAll<{ contact_id: string }>(
          "SELECT contact_id FROM transaction_contacts WHERE transaction_id = ?",
          [transactionId],
        ).map((r) => r.contact_id);

  let linked = 0;
  let added = 0;
  for (const contactId of assignedContacts) {
    try {
      const r = await autoLinkCommunicationsForContact({
        contactId,
        transactionId,
        queueAmbiguousInsteadOfLinking: true,
      });
      linked += r.emailsLinked + r.messagesLinked;
      added += r.queuedForReview ?? 0;
    } catch (error) {
      await logService.warn(
        `[BACKLOG-2791] discovery failed for contact ${contactId}: ${error instanceof Error ? error.message : "Unknown"}`,
        MODULE,
      );
    }
  }

  // `added` is what the user has not been told about yet.
  //
  // For "open" that is every pending row queued SINCE THE LAST OPEN, not merely
  // the rows this call inserted — because the provider fetch on the same open
  // has usually queued them microseconds earlier under "background". Counting
  // only our own inserts would report 0 for exactly the freshly-arrived mail P2
  // exists to announce.
  if (reason === "open") {
    const row = previousWatermark
      ? dbGet<{ n: number }>(
          "SELECT COUNT(*) AS n FROM pending_review_communications WHERE transaction_id = ? AND found_at > ?",
          [transactionId, previousWatermark],
        )
      : dbGet<{ n: number }>(
          "SELECT COUNT(*) AS n FROM pending_review_communications WHERE transaction_id = ?",
          [transactionId],
        );
    added = row?.n ?? added;

    // Only the open path advances. A background or contact-change run scanned a
    // narrower slice than the watermark claims to cover, so advancing there
    // would declare records scanned that never were.
    dbRun("UPDATE transactions SET last_pending_scan_at = CURRENT_TIMESTAMP WHERE id = ?", [
      transactionId,
    ]);
  }

  // Tell the renderer. EVERY trigger reports through this one call — the on-open
  // sweep, the provider-fetch sweep, a contact saved on the deal, a contact
  // edited in Clients & Contacts, and deal creation.
  //
  // Without it the main-process triggers were invisible: correcting a party's
  // email queued three communications in the database and the screen showed
  // nothing — no popup, and a badge still displaying the old total — until the
  // deal was next opened. The founder's refinement 2 is explicit that the popup
  // count shows "every time a transaction is opened OR a change was saved to
  // contacts", so a silent T2 is not a missing nicety, it is half the feature.
  broadcastReviewQueueChanged({
    transactionId,
    added,
    linked,
    outstanding: countReviewItems(transactionId),
    reason,
  });

  await logService.debug(`Review sync (${reason}) added ${added} item(s)`, MODULE, {
    transactionId,
    reason,
    added,
    linked,
    scopedContacts: contactIds?.length ?? null,
    previousWatermark,
  });

  return { added, linked, outstanding: countReviewItems(transactionId) };
}

/**
 * Restore a REJECTED item back into the review queue.
 *
 * Returns true when the ignored row was a review rejection and has been put back
 * on the queue (its suppression row removed), false when it is an ordinary
 * removal the caller should restore its own way.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ignored_communications` rows are also what the Removed sections render, and
 * the RESTORE affordance there recreates a LINK. For emails that is already
 * safe: the row carries match_reason='address_missing', and the email restore
 * path preserves it, so a restored email lands back in needs-review.
 *
 * The text restore path had no such carry — `createThreadCommunicationReference`
 * writes no match_reason at all — so a rejected TEXT restored from the Removed
 * section became an ordinary link: in the audit, in exports, never approved.
 * Same defect class as the email side door, and only the email half had been
 * closed. Routing a review rejection back to PENDING is the text-side equivalent
 * of "returns to needs-review", and it makes both halves behave identically.
 */
export async function restoreRejectedToQueue(ignoredCommId: string): Promise<number> {
  const row = dbGet<{
    id: string;
    user_id: string;
    transaction_id: string;
    email_id: string | null;
    thread_id: string | null;
    match_reason: string | null;
    reason: string | null;
  }>(
    `SELECT id, user_id, transaction_id, email_id, thread_id, match_reason, reason
       FROM ignored_communications WHERE id = ?`,
    [ignoredCommId],
  );
  if (!row) return 0;

  // `reason` is the discriminator: only this service writes 'rejected_in_review'.
  // match_reason alone would also match a legacy 2319 removal, whose restore
  // must keep its existing link-recreating behaviour.
  if (row.reason !== "rejected_in_review") return 0;

  // THREAD-AWARE, matching restoreRemovedEmailThread.
  //
  // BACKLOG-2791: this used to restore exactly ONE row. Show removed groups by
  // thread_id (BACKLOG-1766) and hands the restore a single representative,
  // because the ordinary restore path expands to siblings itself. This
  // short-circuit did not, so a "(2 emails)" card restored one email and left
  // the other to reappear on its own — the founder's case was two recurring
  // calendar invites, which the provider threads into one conversation.
  //
  // Siblings are found through the EMAIL's thread, not the ignored row's
  // thread_id, which is NULL for a queued email (the queue keys emails by id).
  const siblings = row.email_id
    ? dbAll<{ id: string; email_id: string | null; thread_id: string | null }>(
        `SELECT ic.id, ic.email_id, ic.thread_id
           FROM ignored_communications ic
           JOIN emails e ON e.id = ic.email_id
          WHERE ic.transaction_id = ?
            AND ic.reason = 'rejected_in_review'
            AND e.thread_id IS NOT NULL
            AND e.thread_id = (SELECT thread_id FROM emails WHERE id = ?)`,
        [row.transaction_id, row.email_id],
      )
    : [];

  const toRestore = siblings.length > 0
    ? siblings
    : [{ id: row.id, email_id: row.email_id, thread_id: row.thread_id }];

  for (const item of toRestore) {
    dbRun(
      `INSERT OR IGNORE INTO pending_review_communications
         (id, user_id, transaction_id, email_id, thread_id, found_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [crypto.randomUUID(), row.user_id, row.transaction_id, item.email_id, item.thread_id],
    );
    dbRun("DELETE FROM ignored_communications WHERE id = ?", [item.id]);
  }

  await logService.debug("Restored a rejected item to the review queue", MODULE, {
    ignoredCommId,
    transactionId: row.transaction_id,
    kind: row.email_id ? "email" : "text",
  });
  notifyReviewStateChanged(row.transaction_id);
  return toRestore.length;
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
      rowId: decoded.rowId,
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
    rowId: decoded.rowId,
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
  let touched: string | null = null;
  for (const itemId of itemIds) {
    const item = loadItem(itemId);
    if (!item) continue;
    touched = item.transaction_id;

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
    dbRun("DELETE FROM pending_review_communications WHERE id = ?", [item.rowId]);
    approved++;
  }
  if (approved > 0 && touched) notifyReviewStateChanged(touched);
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
  let touched: string | null = null;
  for (const itemId of itemIds) {
    const item = loadItem(itemId);
    if (!item) continue;
    touched = item.transaction_id;

    const txn = getTransactionRow(item.transaction_id);
    if (!txn) continue;

    await addIgnoredCommunication({
      user_id: txn.user_id,
      transaction_id: item.transaction_id,
      email_id: item.email_id ?? undefined,
      thread_id: item.thread_id ?? undefined,
      original_communication_id: item.origin === "legacy" ? item.rowId : undefined,
      reason: "rejected_in_review",
      // ALWAYS address_missing, including for a never-linked pending item.
      //
      // The suppression row is also what the Removed section renders and what
      // RESTORE reads back, and restore recreates the link with the stored
      // classification — where NULL means "legacy, treat as address_found", i.e.
      // LINKED. A pending rejection stored as NULL would therefore have given a
      // one-click path from "rejected, never linked" to "silently linked with no
      // approval", straight through the existing Removed UI and around the whole
      // point of this feature. Storing address_missing sends a restored item
      // back into the review queue instead, which getReviewState counts.
      match_reason: "address_missing",
    });

    if (item.origin === "legacy") {
      dbRun("DELETE FROM communications WHERE id = ?", [item.rowId]);
    } else {
      dbRun("DELETE FROM pending_review_communications WHERE id = ?", [item.rowId]);
    }
    rejected++;
  }
  if (rejected > 0 && touched) notifyReviewStateChanged(touched);
  return { rejected };
}
