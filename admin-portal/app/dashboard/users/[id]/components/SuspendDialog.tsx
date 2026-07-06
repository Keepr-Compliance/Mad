'use client';

import { useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@keepr/design-system';
import { suspendUser, unsuspendUser } from '@/lib/admin-queries';

interface SuspendDialogProps {
  userId: string;
  userName: string;
  isSuspended: boolean;
}

/**
 * SuspendDialog - Confirmation dialog for suspend / unsuspend actions.
 *
 * Renders a button that opens an HTML <dialog> for confirmation.
 * On confirm, calls the appropriate RPC and refreshes the page data.
 */
export function SuspendDialog({ userId, userName, isSuspended }: SuspendDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const openDialog = useCallback(() => {
    setError(null);
    setReason('');
    dialogRef.current?.showModal();
  }, []);

  const closeDialog = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  const handleConfirm = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = isSuspended
        ? await unsuspendUser(userId)
        : await suspendUser(userId, reason || undefined);

      if (result.error) {
        setError(result.error.message);
        return;
      }

      closeDialog();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  }, [isSuspended, userId, reason, closeDialog, router]);

  const action = isSuspended ? 'Unsuspend' : 'Suspend';

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className={
          isSuspended
            ? 'inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-success-600 hover:bg-success-700 transition-colors'
            : 'inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-danger-600 hover:bg-danger-700 transition-colors'
        }
      >
        {action} User
      </button>

      <dialog
        ref={dialogRef}
        className="rounded-lg shadow-xl border border-gray-200 p-0 backdrop:bg-black/50 max-w-md w-full"
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900">
            {action} User
          </h3>

          <p className="mt-2 text-sm text-gray-600">
            {isSuspended ? (
              <>
                Are you sure you want to unsuspend{' '}
                <span className="font-medium text-gray-900">{userName}</span>?
                Their account will be reactivated.
              </>
            ) : (
              <>
                Are you sure you want to suspend{' '}
                <span className="font-medium text-gray-900">{userName}</span>?
                They will lose access to the application immediately.
              </>
            )}
          </p>

          {/* Reason field for suspend only */}
          {!isSuspended && (
            <div className="mt-4">
              <label
                htmlFor="suspend-reason"
                className="block text-sm font-medium text-gray-700"
              >
                Reason (optional)
              </label>
              <textarea
                id="suspend-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                placeholder="e.g. Terms of service violation"
                disabled={loading}
              />
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-md bg-danger-50 p-3">
              <p className="text-sm text-danger-700">{error}</p>
            </div>
          )}

          <div className="mt-6 flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={closeDialog}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={isSuspended ? 'success' : 'danger'}
              onClick={handleConfirm}
              disabled={loading}
            >
              {loading ? (
                <span className="inline-flex items-center gap-1.5">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Processing...
                </span>
              ) : (
                `Confirm ${action}`
              )}
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
