/**
 * BACKLOG-2865 — the transactions-list card's email count, scoped to the same
 * set the Emails tab describes.
 *
 * WHY THIS FILE EXISTS. BACKLOG-2861 scoped the Emails tab header to
 * `linkedThreads` (every attached conversation MINUS the needs-review ones).
 * The card's number is produced somewhere else entirely — a
 * `COUNT(DISTINCT c.email_id)` subquery in `transactionDbService` — and still
 * counted everything. On the founder's transaction, where all six conversations
 * are legitimately in review, that left the list reading 9 over a tab reading
 * "0 conversations (0 emails)". Fixing the tab and leaving the card moved a
 * number-that-disagrees-with-what-you-see one screen EARLIER rather than
 * removing it. Founder decision 2026-08-25: the card scopes the same way, and
 * he accepted the consequence that such a deal reads as having no email at all
 * from the list view.
 *
 * WHAT THIS COUNTS: EMAILS, not conversations. That unit is not a fresh choice
 * — BACKLOG-2838 already ruled on this exact field. It found "Email threads:"
 * rendered over `COUNT(DISTINCT c.email_id)` and moved the WORD to fit the
 * VALUE ("Emails:"), explicitly rejecting a re-unit to threads because it would
 * change a number the founder had just confirmed correct. So the card number is
 * the tab header's PARENTHETICAL figure — the `(N emails)` half — not its
 * conversation count.
 *
 * WHY THE RULES ARE DUPLICATED HERE. The classification they mirror lives in
 * `src/components/transactionDetailsModule/components/EmailThreadCard.tsx`
 * (`normalizeSubject`, `getEmailThreadKey`, `threadMatchReason`). `electron/`
 * cannot import from `src/` — `rootDir` forbids it — and the renderer cannot
 * value-import from `electron/`, so a genuinely shared module would be a
 * main/renderer boundary migration this item does not need. The duplication is
 * therefore deliberate AND pinned: `transactionDbService.cardScope-2865.test.ts`
 * runs BOTH implementations over one set of real rows and asserts the numbers
 * agree, including on the subject-fallback shapes where a naive mirror drifts.
 * A test may cross the boundary that production code may not.
 *
 * WHAT IS NOT MIRRORED, ON PURPOSE: the review QUEUE's definition — the
 * per-email legacy population inside `reviewStateService`. The tab's split is
 * per-THREAD and the queue's is per-EMAIL, and BACKLOG-2861 left them as two
 * definitions after reasoning it out. This file mirrors the TAB, because the tab
 * is the surface the card has to agree with.
 *
 * That distinction is also why this file classifies in TYPESCRIPT and never
 * SELECTs on the value. BACKLOG-2791's founder ruling gives review state exactly
 * one read path, and `reviewStateService.singleReadPath-2791.test.ts` enforces it
 * by grepping for a SQL-shaped predicate on the column. Classifying rows the way
 * the tab components already do is what that guard permits; issuing a query that
 * decides what counts as needs-review is what it forbids. The predicate is
 * deliberately not spelled out anywhere in this file — a guard that greps source
 * cannot tell a sentence from a statement (BACKLOG-2731).
 */

/** One attached email, as the count needs to see it. */
export interface ScopedEmailRow {
  transaction_id: string;
  /** `communications.email_id`. Non-null by construction — the query filters. */
  email_id: string;
  /** `emails.thread_id`. NULL on rows whose provider gave no conversation id. */
  thread_id: string | null;
  /** `emails.subject`. The grouping fallback when `thread_id` is NULL. */
  subject: string | null;
  /**
   * `communications.match_reason`. NULL is a legacy pre-BACKLOG-2319 link and
   * counts as 'address_found' — see `MISSING` below.
   */
  match_reason: string | null;
}

/**
 * The one value that holds an email OUT of the linked set.
 *
 * A thread is needs-review only when EVERY email in it carries this. Anything
 * else — 'address_found', 'manual', 'user_confirmed', or a NULL legacy link —
 * makes the whole conversation linked.
 */
const MISSING = "address_missing";

/**
 * Mirror of `normalizeSubject` (EmailThreadCard.tsx).
 *
 * Strips REPEATED reply/forward prefixes, then lowercases. The repetition is
 * the part that matters: "Re: Fwd: Re: Closing" and "closing" are one
 * conversation, and a single-pass strip would split them. This is also the
 * reason the grouping is not written in SQL — a recursive CTE cannot be trusted
 * to reproduce the JS `while` loop below exactly, and a near-mirror that drifts
 * is worse than an honest duplicate with a parity test.
 */
export function normalizeSubjectForThreadKey(
  subject: string | null | undefined,
): string {
  if (!subject) return "";

  let normalized = subject.trim();
  const prefixPattern = /^(re:|fwd:|fw:)\s*/i;

  while (prefixPattern.test(normalized)) {
    normalized = normalized.replace(prefixPattern, "").trim();
  }

  return normalized.toLowerCase();
}

/**
 * Mirror of `getEmailThreadKey` (EmailThreadCard.tsx).
 *
 * Precedence is PER EMAIL, not per conversation: an email carrying a thread_id
 * and an email without one never join, even when their subjects match. That
 * asymmetry is real behaviour and the corpus pins it.
 */
export function emailThreadKey(row: ScopedEmailRow): string {
  if (row.thread_id) {
    return `thread-${row.thread_id}`;
  }

  const normalizedSubject = normalizeSubjectForThreadKey(row.subject);
  if (normalizedSubject) {
    return `subject-${normalizedSubject}`;
  }

  // The renderer keys this on the Communication's `id`, which for an email row
  // is `COALESCE(m.id, e.id, c.id)` → the email id. Same value.
  return `email-${row.email_id}`;
}

/**
 * Mirror of `threadMatchReason` (EmailThreadCard.tsx), over rows rather than
 * `EmailThread` objects.
 *
 * NOTE the `??` — a NULL `match_reason` becomes 'address_found', so a legacy
 * link keeps its conversation linked. Writing this as `row.match_reason === MISSING`
 * would be the same for present values and wrong for every pre-BACKLOG-2319 row.
 */
function threadIsNeedsReview(rows: ScopedEmailRow[]): boolean {
  if (rows.length === 0) return false;
  return rows.every((r) => (r.match_reason ?? "address_found") === MISSING);
}

/**
 * Emails in LINKED conversations, per transaction.
 *
 * `rows` must arrive in the loader's order (`emails.sent_at DESC`) because the
 * de-duplication below keeps the FIRST row seen for an email id, exactly as
 * `getCommunicationsWithMessages` does with its `seenIds` pass. Two
 * `communications` rows pointing at one email collapse to one there, and a
 * count that did not collapse them would over-report where the tab does not.
 *
 * Transactions with no attached email are absent from the map; callers default
 * to 0.
 */
export function countLinkedEmailsByTransaction(
  rows: ScopedEmailRow[],
): Map<string, number> {
  // transaction -> thread key -> that thread's emails
  const byTransaction = new Map<string, Map<string, ScopedEmailRow[]>>();
  const seen = new Set<string>();

  for (const row of rows) {
    // The separator is written as an ESCAPE, never as a raw byte: a literal
    // NUL in a source file makes the whole file read as binary, and every
    // repo-wide grep then skips it silently (BACKLOG-2731).
    const dedupeKey = `${row.transaction_id}\u0000${row.email_id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let threads = byTransaction.get(row.transaction_id);
    if (!threads) {
      threads = new Map<string, ScopedEmailRow[]>();
      byTransaction.set(row.transaction_id, threads);
    }

    const key = emailThreadKey(row);
    const thread = threads.get(key);
    if (thread) {
      thread.push(row);
    } else {
      threads.set(key, [row]);
    }
  }

  const counts = new Map<string, number>();
  for (const [transactionId, threads] of byTransaction) {
    let linkedEmails = 0;
    for (const thread of threads.values()) {
      if (threadIsNeedsReview(thread)) continue;
      linkedEmails += thread.length;
    }
    counts.set(transactionId, linkedEmails);
  }

  return counts;
}
