'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { FileSearch, Mail } from 'lucide-react';
import { SearchInput } from '@keepr/design-system';

const articles = [
  {
    href: '/guides/sso-setup',
    title: 'Single Sign-On (SSO) Setup',
    description: 'Enable your team to sign in with their existing Microsoft or Google accounts.',
    tags: ['sso', 'microsoft', 'google', 'login', 'entra', 'azure', 'authentication'],
  },
  {
    href: '/guides/scim-provisioning',
    title: 'Automatic User Provisioning (SCIM)',
    description: 'Automatically create, update, and deactivate users when changes are made in Microsoft Entra ID.',
    tags: ['scim', 'provisioning', 'azure', 'entra', 'users', 'sync', 'automatic'],
  },
  {
    href: '/guides/admin-consent',
    title: 'Desktop App Permissions (Admin Consent)',
    description: 'Grant organization-wide permissions so team members can connect their email and contacts.',
    tags: ['permissions', 'consent', 'admin', 'desktop', 'email', 'contacts', 'graph'],
  },
  {
    href: '/setup',
    title: 'Set Up Your Organization',
    description: 'Register your organization with Keepr and link your Microsoft tenant.',
    tags: ['setup', 'organization', 'tenant', 'onboarding', 'getting started'],
  },
  {
    href: '/download',
    title: 'Download the Desktop App',
    description: 'Get the Keepr desktop app for macOS or Windows.',
    tags: ['download', 'install', 'desktop', 'mac', 'windows', 'app'],
  },
  {
    href: '/guides',
    title: 'IT Admin Guides Overview',
    description: 'Everything you need to set up Keepr for your organization.',
    tags: ['guides', 'admin', 'it', 'overview', 'setup'],
  },
  {
    href: '/guides/sso-setup',
    title: 'How to Configure SSO for Your Organization',
    description:
      'Walk through the /setup flow, the Microsoft consent prompt, and granting admin consent for the desktop app.',
    tags: ['sso', 'configure', 'setup', 'consent', 'microsoft', 'entra', 'how to'],
  },
  {
    href: '/guides/scim-provisioning',
    title: 'How to Configure SCIM for Your Organization',
    description:
      'End-to-end guide: generate a token in Settings, copy the endpoint URL, create an enterprise app in Azure, configure provisioning, and assign users.',
    tags: ['scim', 'configure', 'token', 'azure', 'enterprise app', 'provisioning', 'how to'],
  },
  {
    href: '/guides/scim-provisioning',
    title: 'How to Generate a SCIM Token',
    description:
      'Step-by-step instructions for creating a SCIM bearer token from Settings > SCIM and copying the endpoint URL.',
    tags: ['scim', 'token', 'bearer', 'settings', 'endpoint', 'generate', 'how to'],
  },
  {
    href: '/dashboard/users',
    title: 'Managing User Roles',
    description:
      'How to change user roles (agent, broker, admin, IT admin) from the Users page.',
    tags: ['roles', 'users', 'agent', 'broker', 'admin', 'it_admin', 'permissions'],
  },
  {
    href: '/guides/scim-provisioning',
    title: 'How SCIM User Provisioning Works',
    description:
      'What happens when Azure AD creates or deactivates users via SCIM, and how changes sync to Keepr.',
    tags: ['scim', 'provisioning', 'azure', 'sync', 'create', 'deactivate', 'users'],
  },
  {
    href: '/guides/sso-setup',
    title: 'Troubleshooting: "Organization Not Set Up" Error',
    description:
      'Why this error appears and what to do — your IT admin needs to visit /setup first, or you can sign up for an individual account.',
    tags: ['error', 'organization', 'not set up', 'troubleshooting', 'setup', 'individual'],
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
              <a href="mailto:support@keeprcompliance.com" className="text-primary-600 hover:underline">
                contact support
              </a>
            </p>
          </div>
        )}

        {/* Contact */}
        <div className="mt-12 text-center border-t border-gray-200 pt-8">
          <p className="text-sm text-gray-500">
            Can&apos;t find what you&apos;re looking for?
          </p>
          <a
            href="mailto:support@keeprcompliance.com"
            className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            <Mail className="h-4 w-4" />
            Contact Support
          </a>
        </div>
      </div>
    </div>
  );
}
