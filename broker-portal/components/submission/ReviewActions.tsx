'use client';

/**
 * ReviewActions Component
 *
 * Floating action bar at the bottom of the screen for broker review actions.
 * Allows brokers to approve, reject, or request changes on submissions.
 * Part of BACKLOG-400.
 */

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { Button } from '@keepr/design-system';
import { REVIEW_MESSAGES, updatedNoRows } from '@/lib/submissions/reviewMessages';
import { DECISION_OPEN_STATUSES, isOpenForDecision } from '@/lib/submissions/checklistModel';

/**
 * BACKLOG-3798: the fixed bar publishes its height as --review-bar-h on <html>
 * so the support button can sit above it on a phone. A callback ref, because
 * the status branches below mount different root nodes.
 */
function useReviewBarHeight() {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback((node: HTMLDivElement | null) => {
    const root = document.documentElement;
    observer.current?.disconnect();
    observer.current = null;
    if (!node) {
      root.style.removeProperty('--review-bar-h');
      return;
    }
    const write = () => root.style.setProperty('--review-bar-h', `${Math.round(node.getBoundingClientRect().height)}px`);
    write();
    if (typeof ResizeObserver === 'function') {
      observer.current = new ResizeObserver(write);
      observer.current.observe(node);
    }
  }, []);
}

interface ReviewActionsProps {
  submission: {
    id: string;
    status: string;
    organization_id: string;
  };
  disabled?: boolean;
  /** BACKLOG-899: Defense-in-depth write block during impersonation.
   *  The parent page already hides this component when impersonating,
   *  but this prop provides a code-level guard inside the write handler. */
  isImpersonating?: boolean;
  /**
   * BACKLOG-3477: false for a reviewer who may tick but not decide (it_admin;
   * lib/submissions/reviewAccess.ts). The whole bar is hidden for them.
   */
  canDecide?: boolean;
  /**
   * BACKLOG-3477: show the hint beside Request Changes. On when the
   * Checklists area is shown for this submission.
   */
  showChecklistHint?: boolean;
}

/** Copy owned by the coordinator (pm_comments dcc91c87, ruling 2). */
export const REQUEST_CHANGES_HINT = 'Add any missing checklist before requesting changes';

/** BACKLOG-3592: shown in place of the decision buttons on a needs_changes version. */
export const WAITING_FOR_RESUBMIT = 'Changes requested — waiting for the agent to resubmit.';

type ReviewAction = 'approve' | 'reject' | 'changes' | null;

export function ReviewActions({
  submission,
  disabled,
  isImpersonating,
  canDecide = true,
  showChecklistHint = false,
}: ReviewActionsProps) {
  const barRef = useReviewBarHeight();
  const [action, setAction] = useState<ReviewAction>(null);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleSubmitReview = async () => {
    if (!action) return;

    // BACKLOG-899: Defense-in-depth — block writes during impersonation.
    // The UI hides this component during impersonation, but if somehow
    // rendered (e.g., stale cache, prop bypass), refuse the write.
    if (isImpersonating) {
      setError('Write operations are not allowed during impersonation sessions.');
      return;
    }

    // Secondary check: detect impersonation cookie on the client side.
    // This catches edge cases where the prop isn't passed correctly.
    if (typeof document !== 'undefined' && document.cookie.includes('impersonation_session=')) {
      setError('Write operations are not allowed during impersonation sessions.');
      return;
    }

    // For reject, show confirmation first
    if (action === 'reject' && !showConfirm) {
      setShowConfirm(true);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      // Check for auth errors
      if (authError) {
        console.error('Auth error getting user:', authError);
        throw new Error('Authentication failed. Please refresh the page and try again.');
      }

      if (!user) {
        console.error('No user found in session');
        throw new Error('You must be logged in to review submissions.');
      }

      if (process.env.NODE_ENV === 'development') {
        console.log('Review action on submission:', submission.id);
      }

      const statusMap: Record<Exclude<ReviewAction, null>, string> = {
        approve: 'approved',
        reject: 'rejected',
        changes: 'needs_changes',
      };

      const newStatus = statusMap[action];
      const now = new Date().toISOString();

      const { error: updateError, data: updateData } = await supabase
        .from('transaction_submissions')
        .update({
          status: newStatus,
          reviewed_by: user.id,
          reviewed_at: now,
          review_notes: notes || null,
        })
        .eq('id', submission.id)
        // BACKLOG-3592: the database refuses a decision on a version that is
        // no longer open (already sent back, approved or rejected) — a stale
        // tab or a repeat click matches zero rows instead of overwriting the
        // earlier review. Zero rows is reported below as a failure.
        .in('status', [...DECISION_OPEN_STATUSES])
        .select('id');

      if (updateError) {
        console.error('Supabase update error:', updateError);
        // Provide more specific error messages
        if (updateError.code === 'PGRST301' || updateError.message?.includes('permission')) {
          throw new Error('Permission denied. You may not have broker access for this organization.');
        }
        throw updateError;
      }

      // BACKLOG-3477: RLS refuses an UPDATE by matching zero rows, with no
      // error. That is a failure, never a success.
      if (updatedNoRows(updateData)) {
        console.error('Review update matched no rows', { submissionId: submission.id });
        throw new Error(REVIEW_MESSAGES.no_rows);
      }

      // Log success for debugging (dev only)
      if (process.env.NODE_ENV === 'development') {
        console.log('Review action successful:', updateData);
      }

      // Add a comment for the record if notes provided
      if (notes) {
        await supabase.from('submission_comments').insert({
          submission_id: submission.id,
          user_id: user.id,
          content: notes,
        });
      }

      // Refresh page to show updated status
      router.refresh();

      // Reset form
      setAction(null);
      setNotes('');
      setShowConfirm(false);
    } catch (err) {
      console.error('Review error:', err);
      // Show more specific error message if available
      const errorMessage = err instanceof Error ? err.message : 'Failed to submit review. Please try again.';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setAction(null);
    setNotes('');
    setError(null);
    setShowConfirm(false);
  };

  // BACKLOG-3477: a tick-only reviewer (it_admin) gets no review decisions.
  if (!canDecide) return null;

  // Terminal states - review is complete (show minimal floating bar)
  if (disabled || submission.status === 'approved' || submission.status === 'rejected') {
    return (
      <div ref={barRef} className="fixed bottom-0 left-[var(--sidebar-w,0px)] right-0 z-30">
        <div className="bg-white border-t border-gray-200 shadow-lg">
          <div className="max-w-6xl mx-auto px-4 py-3">
            <div className="flex items-center justify-center gap-2">
              <div
                className={`w-3 h-3 rounded-full ${
                  submission.status === 'approved' ? 'bg-green-500' : 'bg-red-500'
                }`}
              />
              <span className="text-sm text-gray-600">
                Review Complete -{' '}
                <span
                  className={`font-medium ${
                    submission.status === 'approved' ? 'text-green-600' : 'text-red-600'
                  }`}
                >
                  {submission.status === 'approved' ? 'Approved' : 'Rejected'}
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // BACKLOG-3592: sent back to the agent — no decision is open until they
  // resubmit, so no buttons and no hint.
  if (submission.status === 'needs_changes') {
    return (
      <div ref={barRef} className="fixed bottom-0 left-[var(--sidebar-w,0px)] right-0 z-30">
        <div className="bg-white border-t border-gray-200 shadow-lg">
          <div className="max-w-6xl mx-auto px-4 py-3">
            <div className="flex items-center justify-center gap-2">
              <div className="w-3 h-3 rounded-full bg-amber-500" />
              <span className="text-sm text-gray-600" data-testid="waiting-for-resubmit">
                {WAITING_FOR_RESUBMIT}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Any other status that is not open for a decision (e.g. uploading): the
  // decision write would be refused, so offer nothing.
  if (!isOpenForDecision(submission.status)) return null;

  // Rejection confirmation overlay
  if (showConfirm) {
    return (
      <>
        {/* Backdrop */}
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50" onClick={handleCancel} />

        {/* Confirmation panel */}
        <div className="fixed bottom-0 left-0 right-0 z-50">
          <div className="bg-white border-t border-gray-200 shadow-xl rounded-t-lg">
            <div className="max-w-2xl mx-auto px-6 py-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-red-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">Confirm Rejection</h3>
                  <p className="text-sm text-gray-500">This action cannot be undone.</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-3 mb-4">
                <p className="text-xs text-gray-500 mb-1">Rejection reason:</p>
                <p className="text-sm text-gray-700">{notes}</p>
              </div>

              {/* BACKLOG-3592: a refused rejection must be visible here too. */}
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-md px-3 py-2 mb-4">
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={handleCancel}
                  disabled={loading}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={handleSubmitReview}
                  disabled={loading}
                  className="flex-1"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Rejecting...
                    </>
                  ) : (
                    'Yes, Reject Submission'
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <div ref={barRef} className="fixed bottom-0 left-[var(--sidebar-w,0px)] right-0 z-30">
      <div className={`bg-white border-t border-gray-200 shadow-lg transition-all duration-300 ${action ? 'shadow-xl' : ''}`}>
        {/* Error message */}
        {error && (
          <div className="bg-red-50 border-b border-red-200 px-4 py-2">
            <p className="text-sm text-red-700 text-center">{error}</p>
          </div>
        )}

        <div className="max-w-6xl mx-auto px-4 py-4">
          {/* Expanded form when action selected */}
          {action && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-gray-700">
                  {action === 'approve'
                    ? 'Approval Notes (optional)'
                    : action === 'changes'
                      ? 'What changes are needed?'
                      : 'Rejection Reason'}
                </label>
                <button
                  onClick={handleCancel}
                  className="text-gray-400 hover:text-gray-600 p-1"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full border border-gray-300 rounded-md p-3 text-base md:text-sm text-gray-900 focus:ring-1 focus:ring-primary-500 focus:border-primary-500 resize-none"
                rows={3}
                placeholder={
                  action === 'approve'
                    ? 'Add any notes for the record...'
                    : action === 'changes'
                      ? 'Describe what needs to be fixed...'
                      : 'Explain why this submission is being rejected...'
                }
                autoFocus
              />
              {action !== 'approve' && notes.length > 0 && notes.length < 10 && (
                <p className="mt-1 text-xs text-warning-600">
                  Please provide at least 10 characters of feedback.
                </p>
              )}
            </div>
          )}

          {/* Action buttons row */}
          {/* BACKLOG-3798: below md the collapsed row is a 2-column grid (label,
              Approve full width, Request Changes | Reject, hint last). md: restores
              the desktop flex row exactly. */}
          <div
            className={
              !action ? 'grid grid-cols-2 gap-2 md:flex md:items-center md:gap-3' : 'flex items-center gap-3'
            }
          >
            {!action ? (
              <>
                {/* Collapsed state - show all action buttons */}
                <span className="col-span-2 text-xs uppercase tracking-wide font-medium text-gray-700 md:col-span-1 md:text-sm md:normal-case md:tracking-normal mr-2">
                  Review Actions:
                </span>
                <Button
                  variant="success"
                  onClick={() => setAction('approve')}
                  className="col-span-2 min-h-[44px] md:col-span-1 md:min-h-0"
                >
                  <Check className="w-4 h-4" />
                  Approve
                </Button>
                <Button
                  variant="warning"
                  onClick={() => setAction('changes')}
                  className="min-h-[44px] md:min-h-0"
                >
                  <AlertTriangle className="w-4 h-4" />
                  Request Changes
                </Button>
                {showChecklistHint && (
                  <span
                    className="col-span-2 order-last text-xs text-gray-500 md:col-span-1 md:order-none"
                    data-testid="request-changes-hint"
                  >
                    {REQUEST_CHANGES_HINT}
                  </span>
                )}
                <Button variant="danger" onClick={() => setAction('reject')} className="min-h-[44px] md:min-h-0">
                  <X className="w-4 h-4" />
                  Reject
                </Button>
              </>
            ) : (
              <>
                {/* Expanded state - show submit and cancel */}
                <Button
                  variant={
                    action === 'approve'
                      ? 'success'
                      : action === 'changes'
                        ? 'warning'
                        : 'danger'
                  }
                  onClick={handleSubmitReview}
                  disabled={loading || (action !== 'approve' && notes.trim().length < 10)}
                  className="flex-1"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      {action === 'approve' && (
                        <>
                          <Check className="w-4 h-4" />
                          Approve Submission
                        </>
                      )}
                      {action === 'changes' && (
                        <>
                          <AlertTriangle className="w-4 h-4" />
                          Request Changes
                        </>
                      )}
                      {action === 'reject' && (
                        <>
                          <X className="w-4 h-4" />
                          Reject Submission
                        </>
                      )}
                    </>
                  )}
                </Button>
                <Button variant="secondary" onClick={handleCancel} disabled={loading}>
                  Cancel
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ReviewActions;
