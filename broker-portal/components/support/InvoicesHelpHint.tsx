/**
 * The "Where do I find my invoices?" hint in the support forms — BACKLOG-3855.
 * Shown by TicketForm and SupportWidget only when the Billing & Subscription category is picked.
 */

import Link from 'next/link';
import { AlertBanner } from '@keepr/ui';
import { BILLING_CATEGORY_SLUG } from '@/lib/support/openSupportRequest';

export const INVOICES_GUIDE_HREF = '/guides/invoices';

/** True for the Billing & Subscription category only. */
export function showsInvoicesHint(categorySlug: string | null | undefined): boolean {
  return categorySlug === BILLING_CATEGORY_SLUG;
}

export function InvoicesHelpHint({ categorySlug }: { categorySlug: string | null | undefined }) {
  if (!showsInvoicesHint(categorySlug)) return null;
  return (
    <AlertBanner variant="info" data-support-hint="invoices">
      Looking for an invoice?{' '}
      <Link href={INVOICES_GUIDE_HREF} target="_blank" className="font-medium underline">
        Where do I find my invoices?
      </Link>
    </AlertBanner>
  );
}
