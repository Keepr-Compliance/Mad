/**
 * THE GROUND TRUTH FOR BACKLOG-2869, HAND-TRANSCRIBED ONCE.
 *
 * Not a test file (no `.test.` in the name, so no jest glob selects it) — a
 * fixture two suites import, so the founder's table is typed out in exactly
 * one place and cannot be half-updated.
 *
 * WHY IT IS HAND-TYPED. Every other list of statuses in these tests is derived
 * (from the schema's CHECK constraint, from the shared label map, from what a
 * component renders). This one may not be: a table derived from the map would
 * assert the map against itself and pass no matter what the map said. This is
 * the only copy of the requirement in the repo that a mutation cannot move,
 * which is why mutating the shipped map turns BOTH consumers red against it.
 *
 * Transcribed from the item body, which quotes the founder directly: a
 * submitted deal awaiting review should read "under review"; approved and
 * rejected should say so; and there is a separate state for the broker
 * rejecting with changes and asking for a resubmit.
 */
import type { SubmissionStatus } from "@/types";

export interface FounderLabelRow {
  status: SubmissionStatus;
  /** The word the user must see for this status, on any surface that shows one. */
  label: string;
  /**
   * Does the TRANSACTION HEADER draw a chip for it? Visibility is a surface
   * decision and differs legitimately: a never-sent deal has no status to
   * report next to a Complete button, while a list column with a hole in it
   * reads as a missing value. The list cards reach the same answer their own
   * way, guarding on `submission_status !== "not_submitted"` before rendering.
   */
  headerShowsBadge: boolean;
}

export const FOUNDER_LABEL_TABLE: FounderLabelRow[] = [
  { status: "not_submitted", label: "Not Submitted", headerShowsBadge: false },
  { status: "submitted", label: "Under Review", headerShowsBadge: true },
  { status: "under_review", label: "Under Review", headerShowsBadge: true },
  { status: "resubmitted", label: "Under Review", headerShowsBadge: true },
  { status: "needs_changes", label: "Changes Requested", headerShowsBadge: true },
  { status: "approved", label: "Approved", headerShowsBadge: true },
  { status: "rejected", label: "Rejected", headerShowsBadge: true },
];

/** The statuses the header draws a chip for, with the word each must carry. */
export const HEADER_BADGE_ROWS = FOUNDER_LABEL_TABLE.filter((row) => row.headerShowsBadge);

/** Every distinct word any surface can show, for rival-label absence checks. */
export const ALL_LABELS = Array.from(new Set(FOUNDER_LABEL_TABLE.map((row) => row.label)));
