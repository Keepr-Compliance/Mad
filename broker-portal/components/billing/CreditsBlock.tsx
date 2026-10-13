import { BillingBlock } from './BillingBlock';
import type { AgentPlanState } from '@/lib/billing/capabilities';

export const CREDITS_UNAVAILABLE = 'Credits are unavailable right now.';
export const CREDITS_SUSPENDED = 'Credits cannot be used or bought while your account is suspended. They are kept.';
export const CREDITS_BUY = 'Buy credits in the Keepr desktop app, at its export paywall. Bulk buying on the website comes later.';
export const CREDITS_FAILED_SUB = 'Usable now, while Unlimited exports are off';
export const CREDITS_FAILED_BODY = 'Each export in the Keepr app uses one credit until your payment goes through.';

/** True while the person holds an Agent plan (paid, ending, or payment failed). */
export function onAgentPlan(state: AgentPlanState): boolean {
  return state === 'active' || state === 'cancel_pending' || state === 'payment_failed';
}

export interface CreditsData {
  balance: number | null;
  state: AgentPlanState;
  /** licenses.status = suspended (agentPlan view). */
  suspended: boolean;
}

/** Block 4 — Credits (BACKLOG-3848). Organization pages never render it. */
export function CreditsBlock({ data }: { data?: CreditsData }) {
  if (!data) return <BillingBlock id="credits" title="Credits" />;
  const agent = onAgentPlan(data.state);
  const failed = data.state === 'payment_failed';
  const body = data.suspended ? CREDITS_SUSPENDED : agent ? (failed ? CREDITS_FAILED_BODY : null) : CREDITS_BUY;
  return (
    <BillingBlock id="credits" title="Credits">
      {failed && !data.suspended ? <p className="mt-1 text-sm text-gray-500">{CREDITS_FAILED_SUB}</p> : null}
      {data.balance === null ? (
        <p className="mt-3 text-sm text-gray-600">{CREDITS_UNAVAILABLE}</p>
      ) : (
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-4xl font-bold tabular-nums text-gray-900" data-credits-balance>
            {data.balance}
          </span>
          <span className="text-sm text-gray-500">
            {data.balance === 1 ? 'credit' : 'credits'} {agent ? 'saved' : 'available'}
          </span>
        </div>
      )}
      {body ? <p className="mt-3 text-sm text-gray-600">{body}</p> : null}
    </BillingBlock>
  );
}
