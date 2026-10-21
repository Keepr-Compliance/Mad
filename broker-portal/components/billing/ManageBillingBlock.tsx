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
 */

import { Alert } from '@keepr/design-system';
import { BillingBlock } from './BillingBlock';
import { ManageBillingButton } from './ManageBillingButton';

export function ManageBillingBlock({ unavailable }: { unavailable?: boolean }) {
  return (
    <BillingBlock id="manage-billing" title="Invoices & payment method">
      {unavailable ? (
        <div className="mt-3">
          <Alert variant="error">Stripe is unavailable right now. Try again in a minute.</Alert>
        </div>
      ) : null}
      <p className="mt-2 text-sm text-gray-700">View, download and pay invoices, and save a payment method, on Stripe&apos;s billing page.</p>
      <div className="mt-3">
        <ManageBillingButton />
      </div>
    </BillingBlock>
  );
}
