'use client';

/**
 * "View all invoices" under the brokerage's recent invoices — BACKLOG-3855 (founder e007a05a).
 * A text link, not a second button. Calls the same no-argument server action as "Manage billing"
 * (openBrokerageBillingPortal), which opens Stripe's billing page or comes back with
 * ?portal=unavailable.
 */

import { useState } from 'react';
import { openBrokerageBillingPortal } from '@/lib/actions/billingPortal';

export const VIEW_ALL_INVOICES_LABEL = 'View all invoices';

export function ViewAllInvoicesLink() {
  const [pending, setPending] = useState(false);
  const open = async () => {
    setPending(true);
    try {
      await openBrokerageBillingPortal();
    } finally {
      setPending(false);
    }
  };
  return (
    <button
      type="button"
      data-billing-action="view_all_invoices"
      className="text-sm font-medium text-indigo-700 hover:underline disabled:opacity-60"
      disabled={pending}
      onClick={() => void open()}
    >
      {pending ? 'Opening Stripe…' : `${VIEW_ALL_INVOICES_LABEL} ↗`}
    </button>
  );
}
