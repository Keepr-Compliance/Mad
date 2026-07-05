'use client';

/**
 * Admin Consent Page
 *
 * After IT admin sets up their org, they're redirected here to grant
 * org-wide admin consent for the desktop app's Microsoft Graph API
 * permissions (Mail.Read, Contacts.Read, etc.).
 *
 * This prevents individual users from seeing "admin needs to approve"
 * when connecting their mailbox in the desktop app.
 */

import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Spinner } from '@keepr/design-system';
import { Check, Loader2, ShieldCheck } from 'lucide-react';

const DESKTOP_CLIENT_ID = process.env.NEXT_PUBLIC_DESKTOP_CLIENT_ID || '';

function ConsentForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const tenant = searchParams.get('tenant');
  const orgId = searchParams.get('org');

  const handleGrantConsent = () => {
    if (!tenant || !DESKTOP_CLIENT_ID) return;
    setLoading(true);

    const redirectUri = `${window.location.origin}/setup/consent/callback`;
    const consentUrl = `https://login.microsoftonline.com/${tenant}/adminconsent?client_id=${DESKTOP_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${orgId || ''}`;

    window.location.href = consentUrl;
  };

  const handleSkip = () => {
    router.push('/dashboard');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-lg w-full space-y-8">
        <div className="text-center">
          <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-primary-100">
            <ShieldCheck className="h-8 w-8 text-primary-600" />
          </div>
          <h1 className="mt-4 text-2xl font-bold text-gray-900">Grant Desktop App Permissions</h1>
          <p className="mt-2 text-gray-600">
            One more step to set up your organization.
          </p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-4">
          <p className="text-sm text-gray-700">
            The Keepr desktop app needs permission to read emails and contacts
            for transaction auditing. As an admin, you can approve this for your entire
            organization so team members won&apos;t be prompted individually.
          </p>

          <div className="bg-gray-50 rounded-md p-4">
            <h3 className="text-sm font-medium text-gray-900 mb-2">Permissions requested:</h3>
            <ul className="text-sm text-gray-600 space-y-1">
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                Read email messages (for audit trail)
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                Read contacts (for transaction participant lookup)
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                Read user profile information
              </li>
            </ul>
          </div>

          <p className="text-xs text-gray-500">
            You&apos;ll be redirected to Microsoft to approve. This is a one-time setup.
          </p>
        </div>

        <div className="space-y-3">
          <button
            onClick={handleGrantConsent}
            disabled={loading || !tenant || !DESKTOP_CLIENT_ID}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-transparent rounded-lg shadow-sm bg-primary-600 text-white font-medium hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin text-white" />
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 23 23">
                <path fill="#f35325" d="M1 1h10v10H1z" />
                <path fill="#81bc06" d="M12 1h10v10H12z" />
                <path fill="#05a6f0" d="M1 12h10v10H1z" />
                <path fill="#ffba08" d="M12 12h10v10H12z" />
              </svg>
            )}
            <span>{loading ? 'Redirecting to Microsoft...' : 'Grant permissions with Microsoft'}</span>
          </button>

          <button
            onClick={handleSkip}
            className="w-full px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Skip for now (team members may see permission prompts)
          </button>
        </div>
      </div>
    </div>
  );
}

function ConsentLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Spinner />
    </div>
  );
}

export default function ConsentPage() {
  return (
    <Suspense fallback={<ConsentLoading />}>
      <ConsentForm />
    </Suspense>
  );
}
