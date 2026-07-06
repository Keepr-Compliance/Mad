'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/**
 * Route-level error boundary for admin-portal.
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
          <svg
            className="h-8 w-8 text-red-600"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
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
