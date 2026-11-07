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
 * BACKLOG-3855: the last invoices (OrgInvoicesTable). `invoices` undefined = not passed (no list).
 * BACKLOG-4187: Manage billing sits on the title line (BillingBlock's action slot); the separate
 * "View all invoices" link and the help-article link are gone from this block (the article stays
 * on the Help page and in the support forms).
 */

import { Alert } from '@keepr/design-system';
import { BillingBlock } from './BillingBlock';
import { ManageBillingButton } from './ManageBillingButton';
import { OrgInvoicesTable } from './OrgInvoicesTable';
import { ORG_INVOICES_LIMIT, type OrgInvoiceRow } from '@/lib/billing/orgInvoices';

/** Under the title when the list has rows; the number is the list's real cap. */
export const LAST_INVOICES_LINE = `Showing your last ${ORG_INVOICES_LIMIT} invoices. Click Manage billing to see all of them or change your payment method.`;
/** Under the title when there is no list or it has no rows. */
export const MANAGE_BILLING_LINE = "Save a payment method and see every invoice on Stripe's billing page.";

export function ManageBillingBlock({ unavailable, invoices }: { unavailable?: boolean; invoices?: OrgInvoiceRow[] | null }) {
  const hasRows = Array.isArray(invoices) && invoices.length > 0;
  return (
    <BillingBlock id="manage-billing" title="Invoices & payment method" action={<ManageBillingButton />}>
      <p className="mt-3 text-sm text-gray-700" data-manage-billing-line="">
        {hasRows ? LAST_INVOICES_LINE : MANAGE_BILLING_LINE}
      </p>
      {unavailable ? (
        <div className="mt-3">
          <Alert variant="error">Stripe is unavailable right now. Try again in a minute.</Alert>
        </div>
      ) : null}
      {invoices !== undefined ? <OrgInvoicesTable rows={invoices} /> : null}
    </BillingBlock>
  );
}
