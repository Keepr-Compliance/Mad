'use client';

/**
 * ReviewActions Component
 *
 * Floating action bar at the bottom of the screen for broker review actions.
 * Allows brokers to approve, reject, or request changes on submissions.
 * Part of BACKLOG-400.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { Button } from '@keepr/design-system';

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
}

type ReviewAction = 'approve' | 'reject' | 'changes' | null;

export function ReviewActions({ submission, disabled, isImpersonating }: ReviewActionsProps) {
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
        .select();

      if (updateError) {
        console.error('Supabase update error:', updateError);
        // Provide more specific error messages
        if (updateError.code === 'PGRST301' || updateError.message?.includes('permission')) {
          throw new Error('Permission denied. You may not have broker access for this organization.');
        }
        throw updateError;
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

  // Terminal states - review is complete (show minimal floating bar)
  if (disabled || submission.status === 'approved' || submission.status === 'rejected') {
    return (
      <div className="fixed bottom-0 left-[var(--sidebar-w,0px)] right-0 z-30">
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
    <div className="fixed bottom-0 left-[var(--sidebar-w,0px)] right-0 z-30">
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
                className="w-full border border-gray-300 rounded-md p-3 text-sm text-gray-900 focus:ring-1 focus:ring-primary-500 focus:border-primary-500 resize-none"
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
          <div className="flex items-center gap-3">
            {!action ? (
              <>
                {/* Collapsed state - show all action buttons */}
                <span className="text-sm font-medium text-gray-700 mr-2">Review Actions:</span>
                <Button variant="success" onClick={() => setAction('approve')}>
                  <Check className="w-4 h-4" />
                  Approve
                </Button>
                <Button variant="warning" onClick={() => setAction('changes')}>
                  <AlertTriangle className="w-4 h-4" />
                  Request Changes
                </Button>
                <Button variant="danger" onClick={() => setAction('reject')}>
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
