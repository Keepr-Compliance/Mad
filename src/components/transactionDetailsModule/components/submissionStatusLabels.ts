/**
 * WHAT A SUBMISSION STATUS IS CALLED — ONE MAP, EVERY SURFACE.
 *
 * ===========================================================================
 * THIS IS THE SOURCE OF TRUTH FOR THE WORDS. Both the transaction header chip
 * (`TransactionHeader.tsx`) and the list-row chip (`SubmissionStatusBadge.tsx`)
 * read it. Neither carries a label of its own.
 * ===========================================================================
 *
 * BACKLOG-2869. The founder's direction is that one state gets one word
 * wherever it appears — the mental model must not need a translation table.
 * The first half of this item fixed the header, where a single boolean drew
 * one chip reading "Submitted" for three different states (so an APPROVED deal
 * never learned its outcome, and `rejected` / `needs_changes` drew nothing at
 * all). Fixing only the header would have traded one wrong label for a worse
 * problem: the SAME deal reading "Under Review" in the header and "Submitted"
 * in the list row behind it, which is a question the user has to resolve
 * rather than an answer.
 *
 * So the words live here and the surfaces own only their styling.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE STATUSES SHARE ONE WORD, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `submitted`, `under_review` and `resubmitted` all read "Under Review". From
 * the user's side those are one experience — sent, waiting — and the states
 * worth distinguishing are the ones carrying an ANSWER. The distinction the
 * old code made was not between different experiences, it was between rows
 * the boolean happened to name.
 *
 * That deliberate collision is also why the tests here assert an ABSENCE
 * beside every presence: "a badge is on screen" is true both before and after
 * this item. What separates the two worlds is that the rival words are gone.
 *
 * ---------------------------------------------------------------------------
 * THE LABEL MOVES. THE ROW DOES NOT.
 * ---------------------------------------------------------------------------
 * `submitted` READS "Under Review"; nothing here transitions it to
 * `under_review`. That transition belongs to the broker portal, where it means
 * a human opened the file and where `submissionSyncService` raises a
 * notification on it. `underReviewOwnership-2869.test.ts` fails if any desktop
 * source starts originating that value.
 *
 * ---------------------------------------------------------------------------
 * VISIBILITY IS NOT A LABEL, AND BELONGS TO THE SURFACE
 * ---------------------------------------------------------------------------
 * `not_submitted` has a word here for completeness, but every current consumer
 * suppresses the badge for it: the header maps it to no tone, and both list
 * cards guard with `submission_status !== "not_submitted"` before rendering.
 * A deal nobody has sent has no status to report, and the Complete button
 * beside it already says what it is waiting for. Keeping the word in the map
 * means `Record<SubmissionStatus, string>` stays exhaustive — add a status to
 * the schema and every consumer stops compiling until someone decides what it
 * is CALLED, which is exactly the gap that produced this item.
 */
import type { SubmissionStatus } from "@/types";

export const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = {
  not_submitted: "Not Submitted",
  submitted: "Under Review",
  under_review: "Under Review",
  resubmitted: "Under Review",
  needs_changes: "Changes Requested",
  approved: "Approved",
  rejected: "Rejected",
};
