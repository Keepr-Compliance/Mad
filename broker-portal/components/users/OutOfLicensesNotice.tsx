'use client';

/**
 * Out-of-licenses prompt — BACKLOG-3851 PR-2b, PR-2f.
 *
 * Shown when an invite, a resent invite or a reactivation needs a licence and
 * the organization has none free. The next step depends on the CALLER's role:
 * an admin can free a licence on this page or contact Keepr support; an IT
 * admin is pointed to a Broker or Admin.
 *
 * PR-2f: "contact Keepr support" opens the in-app support form (with its
 * screenshot) preset to Billing & Subscription / Plan/seat change. The invite
 * form also passes onInviteWithoutLicense, which adds "Invite without a
 * license" (Resend and Reactivate never pass it).
 */

import { moreLicensesSupportPreset, openSupportRequest } from '@/lib/support/openSupportRequest';

interface OutOfLicensesNoticeProps {
  /** The signed-in caller's role in this organization. */
  callerRole: string;
  /** The organization's name, used in the prefilled support message. */
  organizationName?: string | null;
  /** Invite form only: send the same invitation without a license. */
  onInviteWithoutLicense?: () => void;
  /** True while that invitation is being sent. */
  inviteWithoutLicensePending?: boolean;
}

export default function OutOfLicensesNotice({
  callerRole,
  organizationName,
  onInviteWithoutLicense,
  inviteWithoutLicensePending = false,
}: OutOfLicensesNoticeProps) {
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
          <button
            type="button"
            onClick={() => openSupportRequest(moreLicensesSupportPreset(organizationName))}
            className="underline font-medium"
          >
            contact Keepr support
          </button>
          .
        </p>
      )}
      {onInviteWithoutLicense && (
        <div className="mt-3">
          <button
            type="button"
            onClick={onInviteWithoutLicense}
            disabled={inviteWithoutLicensePending}
            className="rounded-md border border-amber-300 bg-white px-3 py-1.5 font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
          >
            {inviteWithoutLicensePending ? 'Sending...' : 'Invite without a license'}
          </button>
          <p className="mt-1 text-xs">
            They can sign in to the broker portal (My Account and Support only) until you assign a license.
          </p>
        </div>
      )}
    </div>
  );
}
