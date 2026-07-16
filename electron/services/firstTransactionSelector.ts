/**
 * First-Transaction Selector (BACKLOG-2006a)
 *
 * The free teaser reveals ONE email + ONE text thread on exactly ONE deal:
 * the user's "first" transaction. This module defines that deterministic
 * selection so the in-app reveal (2006b) and the sample-export gate (this item)
 * agree on the SAME transaction — a disagreement would either leak a free
 * export or wrongly deny the sample.
 *
 * DETERMINISTIC RULE (founder Q2, resolved): the "first" transaction is the
 * MOST RECENT deal by close/created date:
 *     ORDER BY COALESCE(closed_at, created_at) DESC,
 *              created_at DESC,
 *              id ASC        (stable final tie-break)
 * The single most-recent row is the first-transaction. Empty list ⇒ null.
 */

/** Minimal shape needed to rank transactions; a structural subset of Transaction. */
export interface RankableTransaction {
  id: string;
  closed_at?: string | null;
  created_at: string;
}

/**
 * Sort key: COALESCE(closed_at, created_at). Missing/empty closed_at falls back
 * to created_at. Returns a comparable timestamp string (ISO) — string compare is
 * valid for ISO-8601, and we normalize via Date for safety against mixed formats.
 */
function primaryTimeMs(t: RankableTransaction): number {
  const raw = t.closed_at && t.closed_at.trim() !== "" ? t.closed_at : t.created_at;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/**
 * Compare two transactions for "first" ranking. Returns negative when `a`
 * should sort BEFORE `b` (i.e. `a` is more "first"). Descending by primary
 * time, then descending by created_at, then ascending by id.
 */
export function compareForFirst(
  a: RankableTransaction,
  b: RankableTransaction,
): number {
  const pa = primaryTimeMs(a);
  const pb = primaryTimeMs(b);
  if (pa !== pb) return pb - pa; // more recent first

  const ca = Date.parse(a.created_at);
  const cb = Date.parse(b.created_at);
  const caN = Number.isNaN(ca) ? -Infinity : ca;
  const cbN = Number.isNaN(cb) ? -Infinity : cb;
  if (caN !== cbN) return cbN - caN; // more recent created_at first

  // Final stable tie-break: lexicographically smallest id.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The deterministic id of the user's first (most-recent) transaction, or null
 * if the list is empty.
 */
export function selectFirstTransactionId(
  transactions: RankableTransaction[],
): string | null {
  if (!transactions || transactions.length === 0) return null;
  let best = transactions[0];
  for (let i = 1; i < transactions.length; i++) {
    if (compareForFirst(transactions[i], best) < 0) {
      best = transactions[i];
    }
  }
  return best.id;
}

/**
 * True iff the given transaction id is the user's first (most-recent) transaction.
 */
export function isFirstTransaction(
  transactionId: string,
  transactions: RankableTransaction[],
): boolean {
  return selectFirstTransactionId(transactions) === transactionId;
}
