/**
 * What a force re-cache destroys, in the user's words (BACKLOG-2856).
 *
 * WHY THIS IS A DECLARED LIST AND NOT PROSE IN THE DIALOG
 * ------------------------------------------------------
 * The first version of the confirmation named exactly one loss — transaction
 * links — and the swap in fact destroys three. The founder read the warning,
 * accepted it, ran the re-cache, and then reported the Needs Review section as
 * broken, because nothing had told him the queue would be cleared. A warning
 * that leaves the user believing the app is broken has failed at its only job.
 *
 * Keeping the categories in one exported list lets a test assert that every
 * table the swap measurably empties is named on screen. `emailSyncService`'s
 * blast-radius suite proves the deletions by row-id set and then reads this file
 * to check the wording covers them, so the copy and the behaviour cannot drift
 * apart again without something going red.
 *
 * `key` is the join to that test, not something the UI renders. It is a
 * semantic name deliberately, NOT a table name: BACKLOG-2791 requires that no
 * renderer file names the pending review store, and this module is a renderer
 * file. The key -> table mapping lives on the electron side, in the suite that
 * actually observes the deletions.
 */
export type ForceRecacheLossKey = "links" | "review-queue" | "decisions";

export interface ForceRecacheLoss {
  /** Joins this sentence to the deletion proven in the blast-radius suite. */
  key: ForceRecacheLossKey;
  /** The sentence shown in the confirmation dialog. */
  text: string;
}

export const FORCE_RECACHE_LOSSES: readonly ForceRecacheLoss[] = [
  {
    key: "links",
    text: "Your emails will be unlinked from their transactions — you'll need to re-attach them.",
  },
  {
    key: "review-queue",
    // Measured, not assumed: after a force re-cache `queueEmailForReview`
    // returns true again for the same message, so discovery does put these back.
    // Saying so matters — "your queue is emptied" alone would read as permanent
    // loss and is not what happens.
    text:
      "Your Needs Review queue will be emptied. Emails come back to it as your transactions are re-scanned, but as new items.",
  },
  {
    key: "decisions",
    text:
      "Approve and remove decisions you already made on these emails will be lost, so previously removed emails can reappear for review.",
  },
] as const;

/** The one-line summary above the enumerated list. */
export const FORCE_RECACHE_WARNING_LEAD =
  "This re-downloads every email in your cache window from scratch. Three things are lost:";

/** The trailing note — true of the run, not a category of loss. */
export const FORCE_RECACHE_WARNING_TAIL =
  "Attachments are re-downloaded when you next open or export them. This can take a while.";
