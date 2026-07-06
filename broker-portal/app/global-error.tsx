'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { colors } from '@keepr/design-system';

/**
 * Global error boundary for broker-portal.
 *
 * This catches errors in the root layout itself — the outermost
 * error boundary in a Next.js App Router application. Because it
 * replaces the root layout, it must render its own <html> and <body>.
 */
export default function GlobalError({
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
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'Inter, system-ui, sans-serif' }}>
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#f9fafb',
            padding: '1rem',
          }}
        >
          <div style={{ maxWidth: '28rem', width: '100%', textAlign: 'center' }}>
            <div
              style={{
                margin: '0 auto 1.5rem',
                height: '4rem',
                width: '4rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '50%',
                backgroundColor: '#fee2e2',
              }}
            >
              <svg
                style={{ height: '2rem', width: '2rem', color: '#dc2626' }}
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

            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: 0 }}>
              Application Error
            </h1>
            <p style={{ marginTop: '0.5rem', color: '#4b5563', lineHeight: 1.5 }}>
              A critical error occurred. The issue has been reported and our team will investigate.
            </p>
            {error.digest && (
              <p
                style={{
                  marginTop: '0.5rem',
                  fontSize: '0.75rem',
                  color: '#9ca3af',
                  fontFamily: 'monospace',
                }}
              >
                Error ID: {error.digest}
              </p>
            )}

            <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <button
                onClick={reset}
                style={{
                  width: '100%',
                  padding: '0.625rem 1rem',
                  // Inline styles (not Tailwind) because this boundary renders
                  // when the app CSS may be unavailable; the hex still comes
                  // from the design-system tokens via a JS import.
                  backgroundColor: colors.primary[600],
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '0.5rem',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Try again
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- global error boundary cannot use next/link */}
              <a
                href="/"
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '0.625rem 1rem',
                  border: '1px solid #d1d5db',
                  color: '#374151',
                  borderRadius: '0.5rem',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  textDecoration: 'none',
                  textAlign: 'center',
                  boxSizing: 'border-box',
                }}
              >
                Go to home page
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
