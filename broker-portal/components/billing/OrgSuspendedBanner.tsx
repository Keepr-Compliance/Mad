'use client';

/**
 * Billing page banner for a suspended BROKERAGE — BACKLOG-3853 PR-2B.
 *
 * Mockup v35, state "Brokerage suspended (non-payment)", pageBanner(orgSuspended),
 * without the Pay button and the invoice amount: the page makes no Stripe read,
 * and the billing-page Pay button is BACKLOG-3855's (founder 64e00066). The
 * suspension email carries the Pay link.
 *
 * Not the 3878 SuspendedBanner: that one is about the person's own licence.
 */

import { ORG_PAYER_ROLES } from './orgPayerRoles';
import { orgSuspendedSupportPreset, openSupportRequest } from '@/lib/support/openSupportRequest';

export type OrgSuspensionReason = 'non_payment' | 'other' | null;

const PAUSED = 'Submissions, approvals and invites are paused. Agents can still view their own past submissions.';

/** The banner's text for this reason and role. Exported for the tests. */
export function orgSuspendedBannerText(reason: OrgSuspensionReason, role: string): { lead: string; body: string } {
  if (reason !== 'non_payment') {
    return { lead: 'Your brokerage account is suspended.', body: `${PAUSED} Contact Keepr to restore it.` };
  }
  const payer = ORG_PAYER_ROLES.includes(role);
  const close = payer
    ? 'Pay from the link in the suspension email; access returns once every overdue invoice is paid.'
    : 'A Broker or Admin can pay it; access returns once every overdue invoice is paid.';
  return { lead: 'Your brokerage is suspended for an unpaid invoice.', body: `${PAUSED} ${close}` };
}

/** "Contact support": opens the in-app support form preset for a suspended brokerage (Urgent priority). */
function OrgSuspendedSupportButton({ organizationName }: { organizationName?: string | null }) {
  return (
    <button
      type="button"
      data-billing-action="contact_support"
      onClick={() => openSupportRequest(orgSuspendedSupportPreset(organizationName))}
      className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-50"
    >
      Contact support
    </button>
  );
}

export function OrgSuspendedBanner({
  reason,
  role,
  organizationName,
  payUrl,
}: {
  reason: OrgSuspensionReason;
  role: string;
  organizationName?: string | null;
  payUrl?: string | null;
}) {
  const { lead, body } = orgSuspendedBannerText(reason, role);
  // Non-payment only, and only for the roles that can pay.
  const showPay = reason === 'non_payment' && ORG_PAYER_ROLES.includes(role) && !!payUrl;
  return (
    <div
      role="alert"
      data-billing-banner="org_suspended"
      className="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
    >
      <p>
        <strong>{lead}</strong> {body}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {showPay ? (
          <a
            href={payUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            data-billing-action="pay_overdue_invoice"
            className="inline-flex items-center justify-center rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800"
          >
            Pay overdue invoice
          </a>
        ) : null}
        <OrgSuspendedSupportButton organizationName={organizationName} />
      </div>
    </div>
  );
}
