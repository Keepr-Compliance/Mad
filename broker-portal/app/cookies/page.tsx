import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * Cookie Policy — stub target (BACKLOG-2133 / BACKLOG-2122).
 *
 * The consent banner's "Cookie Policy" link points here so the mechanism has a
 * live destination. The authoritative Cookie Policy TEXT is authored separately
 * (blocked on the legal-entity decision, BACKLOG-2117, and the Cookie Policy
 * drafting item, BACKLOG-2122) and, at launch, is published on the canonical
 * marketing domain (https://keeprcompliance.com/cookies). This page therefore
 * carries NO substantive policy copy — only a mechanism-level summary and a
 * forward link. Do not add legal prose here.
 */
export const metadata: Metadata = {
  title: 'Cookie Policy - Keepr',
  description: 'How Keepr uses cookies and analytics in the broker portal.',
};

const CANONICAL_COOKIE_POLICY = 'https://keeprcompliance.com/cookies';

export default function CookiesPage() {
  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-12 text-center">
          <Link href="/" className="text-3xl font-bold text-gray-900">
            Keepr.
          </Link>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="mb-2 text-2xl font-bold text-gray-900">Cookie Policy</h1>
          <p className="mb-8 text-sm text-gray-500">
            Broker portal — analytics &amp; consent
          </p>

          <div className="space-y-4 text-sm leading-6 text-gray-700">
            <p>
              The Keepr broker portal uses a small number of cookies and
              analytics tools. These fall into two categories:
            </p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong>Strictly necessary</strong> — required for sign-in,
                security, and core functionality. These are always on.
              </li>
              <li>
                <strong>Analytics / performance</strong> — Microsoft Clarity,
                which records how the portal is used (with sensitive fields
                masked) to help us improve it. This is{' '}
                <strong>off by default</strong> and only loads if you accept.
              </li>
            </ul>
            <p>
              You can accept or decline analytics from the notice at the bottom
              of the page, and your choice is remembered. If your browser sends a
              Global Privacy Control (GPC) signal, we treat that as an opt-out and
              never load analytics.
            </p>
            <p>
              The full, authoritative Cookie Policy is published at{' '}
              <a
                href={CANONICAL_COOKIE_POLICY}
                className="font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-700"
              >
                {CANONICAL_COOKIE_POLICY}
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
