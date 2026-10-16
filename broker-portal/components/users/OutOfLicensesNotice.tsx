'use client';

/**
 * Out-of-licenses prompt — BACKLOG-3851 PR-2b.
 *
 * Shown when an invite, a resent invite or a reactivation needs a licence and
 * the organization has none free. The next step depends on the CALLER's role:
 * an admin can free a licence on this page or contact Keepr support; an IT
 * admin is pointed to a Broker or Admin.
 */

import Link from 'next/link';

interface OutOfLicensesNoticeProps {
  /** The signed-in caller's role in this organization. */
  callerRole: string;
}

export default function OutOfLicensesNotice({ callerRole }: OutOfLicensesNoticeProps) {
  return (
    <div
      role="alert"
      data-testid="out-of-licenses"
      className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    >
      <p className="font-medium">You&apos;re out of licenses</p>
      {callerRole === 'it_admin' ? (
        <p className="mt-1">Ask a Broker or Admin to add a seat.</p>
      ) : (
        <p className="mt-1">
          Free a license or{' '}
          <Link href="/dashboard/support" className="underline font-medium">
            contact Keepr support
          </Link>
          .
        </p>
      )}
    </div>
  );
}
