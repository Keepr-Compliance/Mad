/**
 * The Billing page body — BACKLOG-3844, Agent plan blocks 1 and 2 by BACKLOG-3847,
 * personal blocks 4–6 and the payment-failed banner by BACKLOG-3848.
 *
 * Renders exactly the blocks `caps.blocks` lists, in that order. No Stripe call
 * here: the route reads everything and passes plain data. Synchronous.
 */

import type { AgentPlanState, BillingBlock, BillingCapabilities } from '@/lib/billing/capabilities';
import { PlanBlock } from './PlanBlock';
import { Alert } from '@keepr/design-system';
import { AutoRenewBlock } from './AutoRenewBlock';
import { planEndLine, type PlanEnd } from '@/lib/billing/planEnd';
import { ChoosePlanBlock } from './ChoosePlanBlock';
import { SeatsBlock, type SeatsViewer } from './SeatsBlock';
import { ManageBillingBlock } from './ManageBillingBlock';
import type { SeatsView } from '@/lib/billing/seats';
import { CreditsBlock } from './CreditsBlock';
import { PaymentContactBlock } from './PaymentContactBlock';
import { InvoicesBlock } from './InvoicesBlock';
import { PaymentFailedBanner } from './PaymentFailedBanner';
import { CardUpdateReturn } from './BillingCardControls';
import { SuspendedBanner } from './SuspendedBanner';
import { OrgSuspendedBanner, type OrgSuspensionReason } from './OrgSuspendedBanner';
import type { PersonalBillingData } from '@/lib/billing/personalBilling';

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
  /** BACKLOG-3860: state 'trial' only, when the free trial ends (ISO). */
  trialEndsOn?: string | null;
  /** BACKLOG-3860: state 'none' only, when an ended free trial ended (ISO). */
  trialEndedOn?: string | null;
  prices: { month?: PlanPrice; year?: PlanPrice };
  checkout: 'success' | 'cancelled' | null;
  sessionId: string | null;
  /** The last Checkout payment did not go through (an `incomplete` subscription). */
  paymentIncomplete?: boolean;
  /** BACKLOG-3848: blocks 4–6 (credits, card, contact, receipts/invoices). */
  billing?: PersonalBillingData;
  /** licenses.status = suspended (agentPlan view). BACKLOG-3878: banner + suspended plan. */
  suspended?: boolean;
  /** BACKLOG-3878: the latest account_suspensions row is a dispute suspension ("after a chargeback"). */
  suspendedForDispute?: boolean;
  /** BACKLOG-3848: back from the Stripe card page (`?card=`). */
  card?: 'updated' | 'cancelled' | null;
  /** BACKLOG-3848: from billingCapabilities (the server re-checks on every action). */
  canEndPlanNow?: boolean;
  canUpdateCard?: boolean;
  /** BACKLOG-3848 (SR RC4): the subscription is `unpaid`; End plan now is not offered, support is. */
  renewalUnpaid?: boolean;
}

export interface BillingPageProps {
  caps: BillingCapabilities;
  /** The organization has a billing deal on record. Ignored for a personal page. */
  orgBillingSetUp: boolean;
  /** Personal page only. */
  personal?: PersonalPlanData;
  /** BACKLOG-3853 PR-2B: the brokerage is suspended. Organization page only. */
  orgSuspension?: { reason: OrgSuspensionReason; role: string; organizationName?: string | null; payUrl?: string | null } | null;
  /** BACKLOG-4019: the brokerage plan's auto-renew state. Organization page only, not while suspended. */
  autoRenew?: { organizationId: string; planEnd: PlanEnd } | null;
  /** BACKLOG-3854: seat counts (null view = the read failed). Organization page only. */
  seats?: { view: SeatsView | null; viewer: SeatsViewer | null } | null;
  /** BACKLOG-3854: back from a failed "Manage billing" (`?portal=unavailable`). */
  portalUnavailable?: boolean;
}

function planLine(caps: BillingCapabilities, orgBillingSetUp: boolean): string {
  if (caps.kind === 'personal') return 'Solo, pay as you go';
  // Decided: an organization whose billing is not set up in the system yet.
  return orgBillingSetUp ? 'Organization plan' : 'Managed by Keepr';
}

export function BillingPage({ caps, orgBillingSetUp, personal, orgSuspension, autoRenew, seats, portalUnavailable }: BillingPageProps) {
  // Blocks 4–6 are filled for a personal page only; organization pages keep the frame (3855).
  const b = caps.kind === 'personal' ? personal?.billing : undefined;
  const suspended = personal?.suspended === true;
  const render = (block: BillingBlock) => {
    switch (block) {
      case 'plan':
        return <PlanBlock key={block} line={planLine(caps, orgBillingSetUp)} personal={personal} />;
      case 'choose_plan':
        return <ChoosePlanBlock key={block} prices={personal?.prices} suspended={suspended} />;
      case 'seats':
        // The button follows the database (can_add); caps.canAddSeats (the action's own gate) can only
        // take it away, never add it.
        return (
          <SeatsBlock
            key={block}
            view={seats?.view ? { ...seats.view, canAdd: seats.view.canAdd && caps.canAddSeats } : null}
            viewer={seats?.viewer ?? null}
          />
        );
      case 'manage_billing':
        return <ManageBillingBlock key={block} unavailable={portalUnavailable === true} />;
      case 'credits':
        return <CreditsBlock key={block} data={b && personal ? { balance: b.credits, state: personal.state, suspended } : undefined} />;
      case 'payment':
        return (
          <PaymentContactBlock
            key={block}
            data={
              b && personal
                ? { billing: b, state: personal.state, interval: personal.interval, suspended, canUpdateCard: caps.canUpdateCard }
                : undefined
            }
          />
        );
      case 'invoices':
        return <InvoicesBlock key={block} data={b && personal ? { rows: b.rows, state: personal.state } : undefined} />;
    }
  };
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold text-gray-900">Billing</h1>
      {caps.kind === 'personal' && personal?.card === 'updated' && personal.sessionId ? (
        <CardUpdateReturn sessionId={personal.sessionId} />
      ) : null}
      {caps.kind === 'personal' && personal?.card === 'cancelled' ? (
        <p role="status" className="rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-700">Your card was not changed.</p>
      ) : null}
      {/* BACKLOG-3878: one banner; a suspension outranks a failed payment. */}
      {caps.kind === 'organization' && orgSuspension ? (
        <OrgSuspendedBanner reason={orgSuspension.reason} role={orgSuspension.role} organizationName={orgSuspension.organizationName} payUrl={orgSuspension.payUrl} />
      ) : caps.kind === 'personal' && suspended ? (
        <SuspendedBanner dispute={personal?.suspendedForDispute === true} />
      ) : b && personal?.state === 'payment_failed' ? (
        <PaymentFailedBanner card={b.card} invoice={b.failedInvoice} canUpdateCard={caps.canUpdateCard && b.customer === 'present'} />
      ) : null}
      {caps.kind === 'organization' && !orgSuspension && autoRenew && planEndLine(autoRenew.planEnd) ? (
        <Alert variant="info">{planEndLine(autoRenew.planEnd)}</Alert>
      ) : null}
      {caps.blocks.map(render)}
      {caps.kind === 'organization' && !orgSuspension && autoRenew && autoRenew.planEnd.state !== 'none' ? (
        <AutoRenewBlock organizationId={autoRenew.organizationId} planEnd={autoRenew.planEnd} />
      ) : null}
    </div>
  );
}
