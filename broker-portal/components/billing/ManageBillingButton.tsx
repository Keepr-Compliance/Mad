'use client';

/**
 * The "Manage billing" button — BACKLOG-3854. Calls the no-argument server action, which
 * redirects to Stripe's page (or back to Billing with ?portal=unavailable). Same calling pattern
 * as "Update card" (BillingCardControls.tsx).
 */

import { useState } from 'react';
import { Button } from '@keepr/design-system';
import { openBrokerageBillingPortal } from '@/lib/actions/billingPortal';

export const MANAGE_BILLING_LABEL = 'Manage billing';

export function ManageBillingButton() {
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
    <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => void open()}>
      {pending ? 'Opening Stripe…' : `${MANAGE_BILLING_LABEL} ↗`}
    </Button>
  );
}
