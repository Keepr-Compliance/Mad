/**
 * Mark a submission under_review when a reviewer first opens it.
 * Moved out of app/dashboard/submissions/[id]/page.tsx (BACKLOG-3477) so its
 * zero-row handling can be tested.
 *
 * Skipped during impersonation (read-only) and for a reviewer who may not
 * decide (it_admin: UPDATE on transaction_submissions is not widened to them,
 * so the write could only match zero rows).
 *
 * A write that matches zero rows is a FAILURE and is reported. This runs
 * fire-and-forget from a server render, so the report is an error log (the
 * portal's server logs), not UI.
 */

import { createClient } from '@/lib/supabase/server';
import { updatedNoRows } from './reviewMessages';

export type MarkUnderReviewOutcome = 'skipped' | 'updated' | 'no_rows' | 'error';

export async function markAsUnderReview(
  submission: { id: string; status: string },
  options: { isImpersonating: boolean; canDecide: boolean }
): Promise<MarkUnderReviewOutcome> {
  if (options.isImpersonating || !options.canDecide) return 'skipped';

  // Only transition from 'submitted' or 'resubmitted' to 'under_review'
  if (submission.status !== 'submitted' && submission.status !== 'resubmitted') {
    return 'skipped';
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .from('transaction_submissions')
    .update({ status: 'under_review' })
    .eq('id', submission.id)
    .select('id');

  if (error) {
    console.error('Failed to mark submission as under_review:', error.message, { submissionId: submission.id });
    return 'error';
  }
  if (updatedNoRows(data)) {
    console.error('Marking submission as under_review matched no rows', { submissionId: submission.id });
    return 'no_rows';
  }
  return 'updated';
}
