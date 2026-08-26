/**
 * Submission Status Badge Component
 *
 * The submission chip on a transaction LIST row (`TransactionListCard`,
 * `TransactionMobileCard`). Part of BACKLOG-391: Submit for Review UI.
 *
 * ---------------------------------------------------------------------------
 * THE WORDS ARE NOT DEFINED HERE (BACKLOG-2869)
 * ---------------------------------------------------------------------------
 * They come from `SUBMISSION_STATUS_LABEL`, the one map both this chip and the
 * transaction header read. Before BACKLOG-2869 each surface carried its own
 * table, and the header's said "Submitted" for `submitted`, `under_review` AND
 * `approved` — so an approved deal never learned its outcome. Fixing only the
 * header would have left the same deal reading "Under Review" at the top of
 * the detail screen and "Submitted" on the row behind it: one state, two
 * words, a translation table the user has to build for himself.
 *
 * What this file still owns is TONE — background, text colour and glyph. A
 * dense list row and a header chip are not the same object and are allowed to
 * look different; they are not allowed to disagree about what a deal IS.
 *
 * `submitted`, `under_review` and `resubmitted` therefore share one tone as
 * well as one word. Three colours for one label would reintroduce the question
 * the shared label removes ("is the blue one different from the yellow one?").
 * The tone they share is the one `submitted` already had — blue with a clock —
 * because `submitted` is the status the vast majority of rows sit in, so the
 * common row is unchanged in colour and changes only in wording. Blue also
 * stays clearly apart from the orange of `needs_changes`, which is the one
 * in-flight state that asks the user to DO something.
 */
import React from "react";
import type { SubmissionStatus } from "@/types";
import { SUBMISSION_STATUS_LABEL } from "./submissionStatusLabels";

interface SubmissionStatusBadgeProps {
  status: SubmissionStatus;
  className?: string;
}

interface SubmissionStatusTone {
  bgColor: string;
  textColor: string;
  icon?: React.ReactNode;
}

/** Waiting on the broker, however many times it has been sent. */
const TONE_IN_FLIGHT: SubmissionStatusTone = {
  bgColor: "bg-blue-100",
  textColor: "text-blue-700",
  icon: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
};

/**
 * Tone per status. No labels — see the file header.
 *
 * `Record<SubmissionStatus, …>` for the same reason the label map is one: a
 * status added to the schema union stops this file compiling until someone
 * decides how it looks, rather than falling through to a default nobody chose.
 */
const STATUS_TONE: Record<SubmissionStatus, SubmissionStatusTone> = {
  not_submitted: {
    bgColor: "bg-gray-100",
    textColor: "text-gray-600",
    icon: null,
  },
  submitted: TONE_IN_FLIGHT,
  under_review: TONE_IN_FLIGHT,
  resubmitted: TONE_IN_FLIGHT,
  needs_changes: {
    bgColor: "bg-orange-100",
    textColor: "text-orange-700",
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
  },
  approved: {
    bgColor: "bg-green-100",
    textColor: "text-green-700",
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
  },
  rejected: {
    bgColor: "bg-red-100",
    textColor: "text-red-700",
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    ),
  },
};

export function SubmissionStatusBadge({
  status,
  className = "",
}: SubmissionStatusBadgeProps): React.ReactElement {
  // A row written by an older build or a future portal can hold a string
  // neither map has heard of; it falls back to the never-sent treatment rather
  // than rendering an empty chip.
  const tone = STATUS_TONE[status] || STATUS_TONE.not_submitted;
  const label = SUBMISSION_STATUS_LABEL[status] || SUBMISSION_STATUS_LABEL.not_submitted;

  return (
    <span
      data-testid="submission-status-chip"
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${tone.bgColor} ${tone.textColor} ${className}`}
    >
      {tone.icon}
      {label}
    </span>
  );
}

export default SubmissionStatusBadge;
