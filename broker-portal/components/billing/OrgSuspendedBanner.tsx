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

import { SuspendedSupportLink } from './SuspendedBanner';

export type OrgSuspensionReason = 'non_payment' | 'other' | null;

const PAUSED = 'Submissions, approvals and invites are paused. Agents can still view their own past submissions.';

/** The banner's text for this reason and role. Exported for the tests. */
export function orgSuspendedBannerText(reason: OrgSuspensionReason, role: string): { lead: string; body: string } {
  if (reason !== 'non_payment') {
    return { lead: 'Your brokerage account is suspended.', body: `${PAUSED} Contact Keepr to restore it.` };
  }
  const payer = role === 'broker' || role === 'admin';
  const close = payer
    ? 'Pay from the link in the suspension email; access returns once every overdue invoice is paid.'
    : 'A Broker or Admin can pay it; access returns once every overdue invoice is paid.';
  return { lead: 'Your brokerage is suspended for an unpaid invoice.', body: `${PAUSED} ${close}` };
}

export function OrgSuspendedBanner({ reason, role }: { reason: OrgSuspensionReason; role: string }) {
  const { lead, body } = orgSuspendedBannerText(reason, role);
  return (
    <div
      role="alert"
      data-billing-banner="org_suspended"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
    >
      <p className="min-w-0 flex-1 basis-72">
        <strong>{lead}</strong> {body}
      </p>
      <SuspendedSupportLink />
    </div>
  );
}
