import Link from 'next/link';
import { Wordmark } from '@keepr/ui';

/**
 * Support Section Layout - Broker Portal
 *
 * Minimal layout for public-facing support pages (e.g., /support/new).
 * Authenticated users access tickets via /dashboard/support instead.
 */
export default function SupportLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-5 flex items-center justify-between">
          <Link href="/" className="flex items-baseline gap-2">
            <Wordmark className="text-xl font-bold text-gray-900" />
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Support</span>
          </Link>
          <Link
            href="/login"
            className="text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            Log In
          </Link>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 flex-1 w-full">
        {children}
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white mt-auto">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4">
          <p className="text-xs text-gray-400 text-center">
            <Wordmark /> Compliance &mdash; Product Support
          </p>
        </div>
      </footer>
    </div>
  );
}
