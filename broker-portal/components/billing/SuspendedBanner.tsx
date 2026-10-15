import Link from 'next/link';
import { BILLING_SUSPENDED_HREF } from '@/lib/support/ticketPresets';

/** BACKLOG-3878, mockup v17 "Suspended". The lead sentence names a chargeback only for a dispute suspension. */
export const SUSPENDED_LEAD_DISPUTE = 'Your account is suspended after a chargeback.';
export const SUSPENDED_LEAD = 'Your account is suspended.';
export const SUSPENDED_BODY =
  'You can still see your plan, invoices and receipts, update your payment method and contact support. The Keepr desktop app is blocked and shows "License Suspended — contact support".';

/** "Contact support", opening a ticket preset to Billing & Subscription / Invoice/payment issue. */
export function SuspendedSupportLink() {
  return (
    <Link
      href={BILLING_SUSPENDED_HREF}
      data-billing-action="contact_support"
      className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-50"
    >
      Contact support
    </Link>
  );
}

/** Page banner for a suspended personal account (licenses.status = suspended). */
export function SuspendedBanner({ dispute }: { dispute: boolean }) {
  return (
    <div
      role="alert"
      data-billing-banner="suspended"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
    >
      <p className="min-w-0 flex-1 basis-72">
        <strong>{dispute ? SUSPENDED_LEAD_DISPUTE : SUSPENDED_LEAD}</strong> {SUSPENDED_BODY}
      </p>
      <SuspendedSupportLink />
    </div>
  );
}
