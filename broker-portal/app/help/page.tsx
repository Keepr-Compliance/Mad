'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { FileSearch, Mail } from 'lucide-react';
import { SearchInput } from '@keepr/design-system';

// BACKLOG-3092: entries pointing at /guides/sso-setup are deliberately absent.
// That page is still served, but it asserts JIT auto-join and SCIM sync that do
// not work today, so it stays unlinked from navigation until those claims are
// true. `__tests__/app/guides/microsoft-approval.test.tsx` asserts that nothing
// under app/ or components/ links to it.
//
// BACKLOG-3097: seven entries removed, leaving the two that get a reader
// somewhere useful. The removed ones fell into two shapes:
//
//   404s — four SCIM articles pointing at /guides/scim-provisioning and an
//   "IT Admin Guides Overview" pointing at /guides. Neither route has ever
//   existed. Not replaced: SCIM articles come back with BACKLOG-2241, which
//   builds the feature, and one guide does not need an index.
//
//   Application screens dressed as documentation — "Set Up Your Organization"
//   (/setup) and "Managing User Roles" (/dashboard/users). Both return a live
//   response, so no status check catches them, and both are dead ends for this
//   audience. /setup's callback (app/auth/setup/callback/route.ts) looks up
//   organization_members first and sends a user who already has a membership
//   straight to /dashboard; /dashboard/users is the Users screen itself, with
//   no instructions on it. The approval guide already sends an administrator
//   to /setup at the point where that is the right move.
//
// `__tests__/app/help/page.test.tsx` derives this page's links from the
// rendered DOM, not from the array below, so a dead link added in JSX cannot
// slip past it.
const articles = [
  {
    href: '/guides/microsoft-approval',
    title: 'Connecting Keepr to Entra ID (Microsoft 365)',
    description:
      'How an administrator approves the desktop app for read-only access to Outlook mail and contacts, what is granted, and how to verify or revoke it.',
    tags: [
      'permissions',
      'consent',
      'admin',
      'approval',
      'desktop',
      'outlook',
      'email',
      'contacts',
      'graph',
      'microsoft',
      'entra',
    ],
  },
  {
    href: '/download',
    title: 'Download the Desktop App',
    description: 'Get the Keepr desktop app for macOS or Windows.',
    tags: ['download', 'install', 'desktop', 'mac', 'windows', 'app'],
  },
];

export default function HelpPage() {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return articles;
    const q = query.toLowerCase();
    return articles.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.tags.some((t) => t.includes(q))
    );
  }, [query]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Hero */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 py-16 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl font-bold text-gray-900">How can we help?</h1>
          <p className="mt-3 text-lg text-gray-500">
            Search our guides and documentation
          </p>

          {/* Search */}
          <div className="mt-8 max-w-xl mx-auto">
            <SearchInput
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for articles..."
              className="py-3 text-base bg-white shadow-sm"
              autoFocus
            />
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="max-w-3xl mx-auto px-4 py-10 sm:px-6 lg:px-8">
        {query.trim() && (
          <p className="text-sm text-gray-500 mb-6">
            {filtered.length} {filtered.length === 1 ? 'result' : 'results'} for &quot;{query}&quot;
          </p>
        )}

        <div className="space-y-3">
          {filtered.map((article) => (
            <Link
              key={article.href}
              href={article.href}
              className="group block bg-white border border-gray-200 rounded-lg px-6 py-4 hover:border-primary-300 hover:shadow-sm transition-all"
            >
              <h2 className="text-base font-semibold text-gray-900 group-hover:text-primary-600">
                {article.title}
              </h2>
              <p className="mt-1 text-sm text-gray-500">{article.description}</p>
            </Link>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="text-center py-12">
            <FileSearch className="mx-auto h-12 w-12 text-gray-300" />
            <p className="mt-4 text-gray-500">No articles found for &quot;{query}&quot;</p>
            <p className="mt-1 text-sm text-gray-400">
              Try a different search term or{' '}
              <Link href="/support/new" className="text-primary-600 hover:underline">
                contact support
              </Link>
            </p>
          </div>
        )}

        {/* Contact */}
        <div className="mt-12 text-center border-t border-gray-200 pt-8">
          <p className="text-sm text-gray-500">
            Can&apos;t find what you&apos;re looking for?
          </p>
          <Link
            href="/support/new"
            className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            <Mail className="h-4 w-4" />
            Contact Support
          </Link>
        </div>
      </div>
    </div>
  );
}
