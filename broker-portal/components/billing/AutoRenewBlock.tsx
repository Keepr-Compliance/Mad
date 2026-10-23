'use client';

/**
 * Auto-renew on the organization Billing page — BACKLOG-4019.
 *
 * Shows whether the brokerage's plan renews, ends or has ended. The buttons appear only when the
 * database says this person may switch it (broker_get_plan_end.can_change: the brokerage's Admin
 * or billing contact, and never while suspended). Turning it off asks first (ConfirmationDialog,
 * as ChecklistsListClient.tsx does); the server action calls set_org_auto_renew with the user's
 * session. Design-system components only.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmationDialog, FieldError } from '@keepr/design-system';
import { BillingBlock } from './BillingBlock';
import { setAutoRenew } from '@/lib/actions/autoRenew';
import { formatPlanDate, type PlanEnd } from '@/lib/billing/planEnd';

export const AUTO_RENEW_OFF_TITLE = 'Turn off auto-renew?';

export function autoRenewOffBody(periodEnd: string | null): string {
  const date = formatPlanDate(periodEnd);
  return `Your plan ends on ${date ?? 'the last day of this billing period'}. Contact Keepr to restart it after that.`;
}

export function autoRenewStatusLine(p: PlanEnd): string {
  const date = formatPlanDate(p.endsOn);
  if (p.state === 'ending') return `Off. Your plan ends on ${date ?? 'the last day of this billing period'}.`;
  if (p.state === 'ended') return `Your plan ended${date ? ` on ${date}` : ''}.`;
  return 'On. Your plan renews each month.';
}

export function AutoRenewBlock({ organizationId, planEnd }: { organizationId: string; planEnd: PlanEnd }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (on: boolean) => {
    if (planEnd.version === null) return;
    setBusy(true);
    setError(null);
    const res = await setAutoRenew(organizationId, on, planEnd.version);
    setBusy(false);
    setConfirming(false);
    if (!res.ok) return setError(res.error);
    router.refresh();
  };

  const showOff = planEnd.canChange && planEnd.state === 'renewing';
  const showOn = planEnd.canChange && planEnd.state === 'ending';

  return (
    <BillingBlock id="auto-renew" title="Auto-renew">
      <p className="mt-2 text-sm text-gray-700" data-auto-renew-state={planEnd.state}>
        {autoRenewStatusLine(planEnd)}
      </p>
      {showOff || showOn ? (
        <div className="mt-3">
          {showOff ? (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
              Turn off auto-renew
            </Button>
          ) : (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => run(true)}>
              {busy ? 'Working…' : 'Turn auto-renew back on'}
            </Button>
          )}
        </div>
      ) : null}
      {error ? <FieldError className="mt-3">{error}</FieldError> : null}
      <ConfirmationDialog
        open={confirming}
        title={AUTO_RENEW_OFF_TITLE}
        description={autoRenewOffBody(planEnd.periodEnd)}
        confirmLabel="Turn off auto-renew"
        isDestructive
        loading={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => run(false)}
      />
    </BillingBlock>
  );
}
