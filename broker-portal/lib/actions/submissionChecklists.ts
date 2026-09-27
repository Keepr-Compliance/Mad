'use server';

/**
 * Submission checklist review writes — BACKLOG-3477.
 *
 * Every action runs, in order:
 *   1. requireSubmissionReviewer()  impersonation refusal, signed-in user, the
 *                                   submission read under RLS, and
 *                                   can_review_submission(org) (fail-closed).
 *                                   lib/submissions/reviewAccess.ts is the one
 *                                   place this is decided.
 *   2. one RPC. The RPC is SECURITY DEFINER and re-checks the caller, the
 *      role, the transaction_checklists feature and the submission status;
 *      its Status History entry is written in the same statement.
 *
 * Results carry plain copy only; raw SQLSTATEs never reach the page.
 */

import { revalidatePath } from 'next/cache';
import { requireSubmissionReviewer } from '@/lib/submissions/reviewAccess';
import {
  reasonForReviewRpcError,
  reviewFailure,
  type ReviewFailure,
} from '@/lib/submissions/reviewMessages';

export type SetReviewerCheckResult =
  | {
      ok: true;
      changed: boolean;
      reviewerChecked: boolean;
      reviewerCheckedBy: string | null;
      reviewerCheckedAt: string | null;
    }
  | ReviewFailure;

export type AddChecklistResult =
  | { ok: true; status: 'added' | 'exists'; checklistId: string }
  | ReviewFailure;

function reviewPath(submissionId: string): string {
  return `/dashboard/submissions/${submissionId}`;
}

export async function setReviewerCheck(
  submissionId: string,
  itemId: string,
  checked: boolean
): Promise<SetReviewerCheckResult> {
  if (typeof itemId !== 'string' || itemId === '' || typeof checked !== 'boolean') {
    return reviewFailure('invalid');
  }
  const reviewer = await requireSubmissionReviewer(submissionId);
  if (!reviewer) return reviewFailure('not_authorized');

  const { data, error } = await reviewer.supabase.rpc('set_submission_checklist_reviewer_check', {
    p_item_id: itemId,
    p_checked: checked,
  });
  if (error) {
    const reason = reasonForReviewRpcError(error);
    if (reason === 'failed') console.warn('[submissions] reviewer tick failed', error.code, error.message);
    return reviewFailure(reason);
  }

  // §7 returns {changed, reviewer_checked, reviewer_checked_by?, reviewer_checked_at?}.
  const row = (data ?? null) as {
    changed?: unknown;
    reviewer_checked?: unknown;
    reviewer_checked_by?: unknown;
    reviewer_checked_at?: unknown;
  } | null;
  if (!row || typeof row.changed !== 'boolean' || typeof row.reviewer_checked !== 'boolean') {
    return reviewFailure('failed');
  }

  revalidatePath(reviewPath(submissionId));
  return {
    ok: true,
    changed: row.changed,
    reviewerChecked: row.reviewer_checked,
    reviewerCheckedBy: typeof row.reviewer_checked_by === 'string' ? row.reviewer_checked_by : null,
    reviewerCheckedAt: typeof row.reviewer_checked_at === 'string' ? row.reviewer_checked_at : null,
  };
}

export async function addChecklistAtReview(
  submissionId: string,
  templateId: string
): Promise<AddChecklistResult> {
  if (typeof templateId !== 'string' || templateId === '') return reviewFailure('invalid');
  const reviewer = await requireSubmissionReviewer(submissionId);
  if (!reviewer) return reviewFailure('not_authorized');

  const { data, error } = await reviewer.supabase.rpc('add_submission_checklist_at_review', {
    p_submission_id: submissionId,
    p_template_id: templateId,
  });
  if (error) {
    const reason = reasonForReviewRpcError(error);
    if (reason === 'failed') console.warn('[submissions] add checklist failed', error.code, error.message);
    return reviewFailure(reason);
  }

  // §8 returns {status: 'added'|'exists'|'template_not_found', checklist_id?, items?}.
  const row = (data ?? null) as { status?: unknown; checklist_id?: unknown } | null;
  if (row?.status === 'template_not_found') return reviewFailure('template_not_found');
  if ((row?.status === 'added' || row?.status === 'exists') && typeof row.checklist_id === 'string') {
    revalidatePath(reviewPath(submissionId));
    return { ok: true, status: row.status, checklistId: row.checklist_id };
  }
  return reviewFailure('failed');
}
