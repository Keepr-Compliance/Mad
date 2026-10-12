/**
 * The Billing page body — BACKLOG-3844, Agent plan blocks 1 and 2 by BACKLOG-3847.
 *
 * Renders exactly the blocks `caps.blocks` lists, in that order. No Stripe call
 * here: the route reads everything and passes plain data. Synchronous.
 */

import type { AgentPlanState, BillingBlock, BillingCapabilities } from '@/lib/billing/capabilities';
import { PlanBlock } from './PlanBlock';
import { ChoosePlanBlock } from './ChoosePlanBlock';
import { SeatsBlock } from './SeatsBlock';
import { CreditsBlock } from './CreditsBlock';
import { PaymentContactBlock } from './PaymentContactBlock';
import { InvoicesBlock } from './InvoicesBlock';

export interface PlanPrice {
  id: string;
  /** e.g. "$19.99", formatted on the server from the Stripe Price. */
  display: string;
}

/** The personal owner's Agent plan, as plain props (BACKLOG-3847). */
export interface PersonalPlanData {
  state: AgentPlanState;
  interval: string | null;
  currentPeriodEnd: string | null;
  supportGrantEffective: boolean;
  prices: { month?: PlanPrice; year?: PlanPrice };
  checkout: 'success' | 'cancelled' | null;
  sessionId: string | null;
  /** The last Checkout payment did not go through (an `incomplete` subscription). */
  paymentIncomplete?: boolean;
}

export interface BillingPageProps {
  caps: BillingCapabilities;
  /** The organization has a billing deal on record. Ignored for a personal page. */
  orgBillingSetUp: boolean;
  /** Personal page only. */
  personal?: PersonalPlanData;
}

function planLine(caps: BillingCapabilities, orgBillingSetUp: boolean): string {
  if (caps.kind === 'personal') return 'Solo, pay as you go';
  // Decided: an organization whose billing is not set up in the system yet.
  return orgBillingSetUp ? 'Organization plan' : 'Managed by Keepr';
}

export function BillingPage({ caps, orgBillingSetUp, personal }: BillingPageProps) {
  const render = (block: BillingBlock) => {
    switch (block) {
      case 'plan':
        return <PlanBlock key={block} line={planLine(caps, orgBillingSetUp)} personal={personal} />;
      case 'choose_plan':
        return <ChoosePlanBlock key={block} prices={personal?.prices} />;
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
