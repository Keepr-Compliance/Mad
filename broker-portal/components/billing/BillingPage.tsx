/**
 * The Billing page body — BACKLOG-3844.
 *
 * Renders exactly the blocks `caps.blocks` lists, in that order. No price, no
 * amount, no Stripe call and no server action in 3844. Synchronous, so it
 * renders inside a server component tree without a client boundary.
 */

import type { BillingBlock, BillingCapabilities } from '@/lib/billing/capabilities';
import { PlanBlock } from './PlanBlock';
import { ChoosePlanBlock } from './ChoosePlanBlock';
import { SeatsBlock } from './SeatsBlock';
import { CreditsBlock } from './CreditsBlock';
import { PaymentContactBlock } from './PaymentContactBlock';
import { InvoicesBlock } from './InvoicesBlock';

export interface BillingPageProps {
  caps: BillingCapabilities;
  /** The organization has a billing deal on record. Ignored for a personal page. */
  orgBillingSetUp: boolean;
}

function planLine(caps: BillingCapabilities, orgBillingSetUp: boolean): string {
  if (caps.kind === 'personal') return 'Solo, pay as you go';
  // Decided: an organization whose billing is not set up in the system yet.
  return orgBillingSetUp ? 'Organization plan' : 'Managed by Keepr';
}

export function BillingPage({ caps, orgBillingSetUp }: BillingPageProps) {
  const render = (block: BillingBlock) => {
    switch (block) {
      case 'plan':
        return <PlanBlock key={block} line={planLine(caps, orgBillingSetUp)} />;
      case 'choose_plan':
        return <ChoosePlanBlock key={block} />;
      case 'seats':
        return <SeatsBlock key={block} />;
      case 'credits':
        return <CreditsBlock key={block} />;
      case 'payment':
        return <PaymentContactBlock key={block} />;
      case 'invoices':
        return <InvoicesBlock key={block} />;
    }
  };
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold text-gray-900">Billing</h1>
      {caps.blocks.map(render)}
    </div>
  );
}
