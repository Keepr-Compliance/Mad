import Link from 'next/link';
import { BillingBlock } from './BillingBlock';
import { CancelPlanButton, CheckoutReturn, KeepPlanButton, PAYMENT_INCOMPLETE_NOTE, SubscribeButton } from './AgentPlanControls';
import type { PersonalPlanData } from './BillingPage';
import { EndPlanNowButton, UpdateCardButton } from './BillingCardControls';
import { onAgentPlan } from './CreditsBlock';
import { SuspendedSupportLink } from './SuspendedBanner';

/** BACKLOG-3848 (SR RC4): shown instead of End plan now for an `unpaid` subscription. */
export const RENEWAL_UNPAID_NOTE = 'To end this plan or settle the unpaid bill, please contact support.';

/** BACKLOG-3878, mockup v17 "Suspended". */
export const SUSPENDED_AGENT_LINE = 'Unlimited exports · renewal paused';
export const SUSPENDED_EXPORTS = 'Off while suspended';
export const SUSPENDED_RENEWAL = 'Paused while your account is suspended. You are not charged.';
export const SUSPENDED_DESKTOP = 'Blocked · "License Suspended — contact support"';
export const SUSPENDED_REINSTATE_NOTE = 'Support will confirm your plan when your account is reinstated.';

function SuspendedBadge() {
  return <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">Suspended</span>;
}

/**
 * BACKLOG-3878: a suspended account's plan. Takes precedence over the plan
 * state: no Cancel, Keep or End plan now, nothing to buy; Update card and
 * Contact support only (the server refuses the rest on its own).
 */
function SuspendedPlan({ p }: { p: PersonalPlanData }) {
  if (onAgentPlan(p.state)) {
    return (
      <div className="mt-2 space-y-3" data-billing-plan="suspended_agent">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-medium text-gray-900">Agent</p>
          <SuspendedBadge />
        </div>
        <p className="text-sm text-gray-600">{SUSPENDED_AGENT_LINE}</p>
        <dl>
          <Row label="Unlimited exports" value={SUSPENDED_EXPORTS} />
          <Row label="Renewal" value={SUSPENDED_RENEWAL} />
          <Row label="Keepr desktop app" value={SUSPENDED_DESKTOP} />
        </dl>
        <div className="flex flex-wrap items-start gap-3">
          {p.canUpdateCard && p.billing?.customer === 'present' ? <UpdateCardButton /> : null}
          <SuspendedSupportLink />
        </div>
        <p className="text-sm text-gray-600">{SUSPENDED_REINSTATE_NOTE}</p>
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-3" data-billing-plan="suspended_solo">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-gray-900">{p.state === 'support_grant' ? 'Unlimited exports, provided by Keepr' : 'Solo, pay as you go'}</p>
        <SuspendedBadge />
      </div>
      <dl>
        <Row label="Keepr desktop app" value={SUSPENDED_DESKTOP} />
      </dl>
    </div>
  );
}

/** "Your plan". Organization pages show the plan name only (3844). */
export function PlanBlock({ line, personal }: { line: string; personal?: PersonalPlanData }) {
  return (
    <BillingBlock id="plan" title="Your plan">
      {personal ? <PersonalPlan p={personal} /> : <p className="mt-2 text-sm text-gray-600">{line}</p>}
    </BillingBlock>
  );
}

/** "Nov 9, 2026" (UTC, so server and browser agree). */
export function formatDay(iso: string | null): string {
  if (!iso) return 'the end of the period';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso)
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-t border-gray-100 py-2 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-900">{value}</dd>
    </div>
  );
}

function PersonalPlan({ p }: { p: PersonalPlanData }) {
  const month = p.prices.month;
  const priceLine = month ? `${month.display} / month` : null;
  const until = formatDay(p.currentPeriodEnd);

  if (p.suspended) return <SuspendedPlan p={p} />;

  switch (p.state) {
    case 'active':
    case 'cancel_pending': {
      const pending = p.state === 'cancel_pending';
      return (
        <div className="mt-2 space-y-3">
          {pending && (
            <div role="status" className="rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
              Your Agent plan ends on <strong>{until}</strong>. Until then, exports stay unlimited. After that, each
              export uses a credit or is bought in the Keepr app.
            </div>
          )}
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-medium text-gray-900">Agent · Unlimited exports</p>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${pending ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'}`}
            >
              {pending ? `Cancels ${until}` : 'Active'}
            </span>
          </div>
          <p className="text-sm text-gray-600">{p.interval === 'year' ? 'Billed yearly' : 'Billed monthly'}{priceLine && p.interval !== 'year' ? ` · ${priceLine}` : ''}</p>
          <dl>
            <Row label={pending ? 'Access until' : 'Renews on'} value={until} />
          </dl>
          {pending ? <KeepPlanButton /> : <CancelPlanButton paidThrough={until} />}
        </div>
      );
    }
    case 'payment_failed':
      return (
        <div className="mt-2 space-y-2">
          <p className="font-medium text-gray-900">Agent · Unlimited exports</p>
          <p className="text-sm text-red-700">Your last payment did not go through. Update your card below.</p>
          {p.canEndPlanNow ? (
            <EndPlanNowButton />
          ) : p.renewalUnpaid ? (
            <p className="text-sm text-gray-600" data-billing-note="renewal_unpaid">
              {RENEWAL_UNPAID_NOTE}{' '}
              <Link className="font-medium text-indigo-700 hover:underline" href="/support/new">
                Contact support
              </Link>
            </p>
          ) : null}
        </div>
      );
    case 'support_grant':
      return p.supportGrantEffective ? (
        <p className="mt-2 text-sm text-gray-600">Unlimited exports, provided by Keepr.</p>
      ) : (
        <p className="mt-2 text-sm text-gray-600">
          Your Unlimited access from Keepr has ended.{' '}
          <Link className="font-medium text-indigo-700 hover:underline" href="/support/new">
            Contact support
          </Link>{' '}
          to change your plan.
        </p>
      );
    case 'none':
      return (
        <div className="mt-2 space-y-3">
          <p className="font-medium text-gray-900">Solo, pay as you go</p>
          <p className="text-sm text-gray-600">No subscription. Each export uses a credit or is bought in the Keepr app.</p>
          {p.checkout === 'success' && p.sessionId ? (
            <CheckoutReturn sessionId={p.sessionId} paymentIncomplete={p.paymentIncomplete === true} />
          ) : p.paymentIncomplete ? (
            <div className="space-y-2">
              <p role="status" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {PAYMENT_INCOMPLETE_NOTE}
              </p>
              {month ? <SubscribeButton label={`Subscribe again — ${month.display}/month`} /> : null}
            </div>
          ) : null}
          {p.checkout === 'cancelled' ? (
            <p role="status" className="text-sm text-gray-600">Checkout was cancelled. Nothing was charged.</p>
          ) : null}
        </div>
      );
  }
}
