/**
 * Plain-language copy for the submission review writes — BACKLOG-3477.
 *
 * The reviewer RPCs raise SQLSTATE 42501 with one of three messages
 * (20260925073000_backlog_3477_submission_checklist_review.sql, header and
 * §7/§8): not_authorized, not_open_for_review, added_at_review. They raise
 * 22023 invalid_argument / invalid_payload for a malformed call. supabase-js
 * surfaces these as `error.code` and `error.message`. No raw code ever
 * reaches the screen.
 */

export type ReviewFailureReason =
  | 'not_authorized'
  | 'not_open_for_review'
  | 'added_at_review'
  | 'template_not_found'
  | 'invalid'
  | 'no_rows'
  | 'failed';

export const REVIEW_MESSAGES: Record<ReviewFailureReason, string> = {
  not_authorized: "You don't have permission to review this submission's checklists.",
  not_open_for_review: 'This submission is no longer open for review, so it can’t be changed.',
  added_at_review:
    'This checklist was added at review for the agent’s next version, so its items can’t be marked reviewed.',
  template_not_found: 'That checklist is no longer available. It may have been archived.',
  invalid: 'Something about that request was not valid. Refresh the page and try again.',
  no_rows: 'Nothing was saved. You may not have permission to make this change. Refresh the page and try again.',
  failed: 'Something went wrong. Please try again.',
};

export interface ReviewFailure {
  ok: false;
  reason: ReviewFailureReason;
  message: string;
}

export function reviewFailure(reason: ReviewFailureReason): ReviewFailure {
  return { ok: false, reason, message: REVIEW_MESSAGES[reason] };
}

/** Map a supabase-js RPC error to a reason. Unknown errors are 'failed'. */
export function reasonForReviewRpcError(error: { code?: string | null; message?: string | null }): ReviewFailureReason {
  const message = (error.message ?? '').trim();
  if (error.code === '42501') {
    if (message === 'not_open_for_review') return 'not_open_for_review';
    if (message === 'added_at_review') return 'added_at_review';
    return 'not_authorized';
  }
  if (error.code === '22023') return 'invalid';
  return 'failed';
}

/**
 * A write that matched no row is a FAILURE (pm_comments dcc91c87, ruling 3b).
 * RLS refuses an UPDATE by filtering it to zero rows, with no error, so an
 * `error`-only check reports success for a write that changed nothing.
 * Pass the `data` of an `.update(...).select(...)` call.
 */
export function updatedNoRows(data: unknown): boolean {
  return !Array.isArray(data) || data.length === 0;
}
