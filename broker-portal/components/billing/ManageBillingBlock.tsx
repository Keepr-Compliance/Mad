/**
 * "Manage billing" on the organization Billing page — BACKLOG-3854 (plan-3855 §3, founder
 * 546c9af1: label "Manage billing"; Stripe's page = invoices + payment method only).
 *
 * The button calls the no-argument server action openBrokerageBillingPortal: it re-checks the
 * person, takes the organization from the session and redirects to Stripe. Shown to
 * Broker, Admin and the billing-only login once billing is set up, including under the suspended
 * banner (founder d0c22cef #5) and after the plan ended (invoice history). Never IT admin.
 * A saved card does not pay invoices automatically (they are sent invoices), so the copy does not
 * say it does.
 *
 * BACKLOG-3855: above the button, the last invoices (OrgInvoicesTable), "View all invoices" (the
 * same action as the button) and the help article. `invoices` undefined = not passed (no list).
 */

import Link from 'next/link';
import { Alert } from '@keepr/design-system';
import { BillingBlock } from './BillingBlock';
import { ManageBillingButton } from './ManageBillingButton';
import { OrgInvoicesTable } from './OrgInvoicesTable';
import { ViewAllInvoicesLink } from './ViewAllInvoicesLink';
import type { OrgInvoiceRow } from '@/lib/billing/orgInvoices';

export const INVOICES_HELP_HREF = '/guides/invoices';

export function ManageBillingBlock({ unavailable, invoices }: { unavailable?: boolean; invoices?: OrgInvoiceRow[] | null }) {
  return (
    <BillingBlock id="manage-billing" title="Invoices & payment method">
      {unavailable ? (
        <div className="mt-3">
          <Alert variant="error">Stripe is unavailable right now. Try again in a minute.</Alert>
        </div>
      ) : null}
      {invoices !== undefined ? (
        <>
          <OrgInvoicesTable rows={invoices} />
          <div className="mt-2">
            <ViewAllInvoicesLink />
          </div>
        </>
      ) : null}
      <p className="mt-3 text-sm text-gray-700">Save a payment method and see every invoice on Stripe&apos;s billing page.</p>
      <div className="mt-3">
        <ManageBillingButton />
      </div>
      <p className="mt-3 text-sm">
        <Link href={INVOICES_HELP_HREF} className="font-medium text-indigo-700 hover:underline">
          Where do I find my invoices?
        </Link>
      </p>
    </BillingBlock>
  );
}
