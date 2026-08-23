/**
 * ONE REVIEW CARD = ONE THREAD (BACKLOG-2791, the Communication Lifecycle
 * Contract's "unit rule": the thread is the unit of display AND of decision).
 *
 * This lives in `utils/` rather than beside the section that draws the cards
 * because the COUNT and the CARDS must come from the same grouping, and the
 * count is derived in `useReviewQueue` — a hook importing from a component file
 * would be the wrong direction, and duplicating the rule is how a badge starts
 * disagreeing with the list it summarises.
 *
 * The key is the provider's conversation id, projected onto the item as
 * `display.threadId`, falling back to the item's own id when the provider never
 * threaded the record — a lone email is a thread of one.
 *
 * SUBJECT IS DELIBERATELY NOT A FALLBACK KEY, unlike the tabs' own
 * `getEmailThreadKey`. Founder correction (2026-08-23): two separately-removed
 * emails must be two cards with two Restores, and subject-merging was the
 * suspected cause when they were not. Merging on subject here would put one
 * Confirm in charge of linking two unrelated emails — the same surprise, on the
 * more dangerous side of the decision. The contract defines a thread as "what
 * the mail/message provider says it is (thread_id)", so that is the only key.
 *
 * Order is first-appearance, so the caller's sort (newest first) survives
 * grouping.
 */
import type { ReviewItemDto } from "../../../../electron/types/ipc/window-api-transactions";

export interface ReviewThreadGroup {
  /** `display.threadId`, or the item id for an unthreaded one-email thread. */
  key: string;
  /** Every pending item in this thread. Buttons act on ALL of them. */
  items: ReviewItemDto[];
}

export function groupReviewItemsByThread(items: ReviewItemDto[]): ReviewThreadGroup[] {
  const groups: ReviewThreadGroup[] = [];
  const byKey = new Map<string, ReviewThreadGroup>();
  for (const item of items) {
    // `display` is optional-chained on purpose, and it is not defensive
    // programming for its own sake. Grouping used to happen only while drawing
    // cards; it now also runs on EVERY render of useReviewQueue, because the
    // badge's count is derived there. That widens the blast radius of one
    // malformed item from a single card to the entire transaction screen — a
    // crash instead of a degraded row. An item with no display payload falls
    // back to its own id, i.e. a thread of one, which is what an unthreaded
    // record does anyway.
    const key = item.display?.threadId ?? item.id;
    const existing = byKey.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const group: ReviewThreadGroup = { key, items: [item] };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}
