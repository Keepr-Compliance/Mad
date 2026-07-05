'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Route-level error boundary for broker-portal.
 *
 * Catches errors in any route segment and renders a branded fallback UI.
 * The error is reported to Sentry automatically and can also be retried.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
          <AlertTriangle className="h-8 w-8 text-red-600" aria-hidden="true" />
        </div>

        <div>
          <h1 className="text-2xl font-bold text-gray-900">Something went wrong</h1>
          <p className="mt-2 text-gray-600">
            An unexpected error occurred. The issue has been reported and our team will investigate.
          </p>
          {error.digest && (
            <p className="mt-2 text-xs text-gray-400 font-mono">
              Error ID: {error.digest}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <button
            onClick={reset}
            className="w-full px-4 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 transition-colors font-medium"
          >
            Try again
          </button>
          <a
            href="/dashboard"
            className="w-full inline-block px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 transition-colors font-medium"
          >
            Go to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
