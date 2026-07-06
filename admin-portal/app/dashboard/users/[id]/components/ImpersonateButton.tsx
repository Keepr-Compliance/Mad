'use client';

import { useRef, useState, useCallback } from 'react';
import { Eye } from 'lucide-react';
import { Button } from '@keepr/design-system';
import { startImpersonation } from '@/lib/admin-queries';

interface ImpersonateButtonProps {
  userId: string;
  userName: string;
  isOwnProfile: boolean;
}

/**
 * ImpersonateButton - "View as User" action with confirmation dialog.
 *
 * Opens a confirmation dialog explaining impersonation behavior,
 * then calls the admin_start_impersonation RPC and opens the
 * broker portal in a new tab with the impersonation token.
 */
export function ImpersonateButton({ userId, userName, isOwnProfile }: ImpersonateButtonProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDialog = useCallback(() => {
    setError(null);
    dialogRef.current?.showModal();
  }, []);

  const closeDialog = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  const handleConfirm = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await startImpersonation(userId);

      if (result.error) {
        setError(result.error.message);
        return;
      }

      if (!result.data?.success) {
        setError(result.data?.error || 'Failed to start impersonation');
        return;
      }

      // Open broker portal in new tab with token
      const brokerUrl = process.env.NEXT_PUBLIC_BROKER_PORTAL_URL || 'https://app.keeprcompliance.com';
      window.open(`${brokerUrl}/auth/impersonate?token=${result.data.token}`, '_blank');

      closeDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  }, [userId, closeDialog]);

  return (
    <>
      <div className="relative group">
        <button
          type="button"
          onClick={openDialog}
          disabled={isOwnProfile}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
            isOwnProfile
              ? 'text-gray-400 bg-gray-100 cursor-not-allowed'
              : 'text-purple-700 bg-purple-50 hover:bg-purple-100'
          }`}
        >
          <Eye className="h-4 w-4" />
          View as User
        </button>
        {isOwnProfile && (
          <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs text-white bg-gray-800 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            Cannot impersonate your own account
          </span>
        )}
      </div>

      <dialog
        ref={dialogRef}
        className="rounded-lg shadow-xl border border-gray-200 p-0 backdrop:bg-black/50 max-w-md w-full"
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900">
            View as {userName}?
          </h3>

          <div className="mt-3 space-y-2">
            <p className="text-sm text-gray-600">
              You will see the broker portal exactly as this user sees it.
            </p>
            <ul className="text-sm text-gray-600 list-disc list-inside space-y-1">
              <li>Session is <span className="font-medium">read-only</span> and lasts 30 minutes.</li>
              <li>All activity is <span className="font-medium">logged to the audit trail</span>.</li>
            </ul>
          </div>

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
            <button
              type="button"
              onClick={handleConfirm}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium text-white rounded-md transition-colors disabled:opacity-50 bg-purple-600 hover:bg-purple-700"
            >
              {loading ? (
                <span className="inline-flex items-center gap-1.5">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Starting...
                </span>
              ) : (
                'Open Broker Portal'
              )}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
