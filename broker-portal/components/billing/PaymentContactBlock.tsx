import { BillingBlock } from './BillingBlock';
import type { AgentPlanState } from '@/lib/billing/capabilities';
import type { PersonalBillingData } from '@/lib/billing/personalBilling';
import { onAgentPlan } from './CreditsBlock';
import { cardLabel, formatUnixDay } from './format';

export const NO_CARD = 'No card saved. A card is saved at your first purchase in the Keepr app.';
export const CARD_UNAVAILABLE = 'Your payment method is unavailable right now.';

export interface PaymentContactData {
  billing: PersonalBillingData;
  state: AgentPlanState;
  interval: string | null;
  suspended: boolean;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-t border-gray-100 py-2 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className="break-words text-right text-gray-900">{children}</dd>
    </div>
  );
}

function cardSubLine(d: PaymentContactData): string {
  if (d.state === 'payment_failed') {
    const f = d.billing.failedInvoice;
    return f ? `Last charge failed on ${formatUnixDay(f.created)}` : 'Last charge failed';
  }
  if (d.suspended) return 'Card on file';
  if (onAgentPlan(d.state)) return `Charged automatically each ${d.interval === 'year' ? 'year' : 'month'}`;
  return 'Saved at your last purchase';
}

/**
 * Block 5 — Payment method & billing contact (BACKLOG-3848). Display only:
 * Update card and Edit contact arrive in a later change. Organization pages
 * render the frame only (BACKLOG-3855).
 */
export function PaymentContactBlock({ data }: { data?: PaymentContactData }) {
  const title = 'Payment method & billing contact';
  if (!data) return <BillingBlock id="payment" title={title} />;
  const { billing } = data;
  const failed = data.state === 'payment_failed';
  const sentTo = onAgentPlan(data.state) ? 'Invoices sent to' : 'Receipts sent to';
  let pay: React.ReactNode;
  if (billing.card) {
    pay = (
      <>
        <p className={`text-sm ${failed ? 'text-red-700' : 'text-gray-500'}`}>{cardSubLine(data)}</p>
        <dl className="mt-2">
          <Row label="Card">
            {cardLabel(billing.card)}
            {failed ? (
              <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">Charge failed</span>
            ) : null}
          </Row>
          <Row label="Expires">
            {String(billing.card.expMonth).padStart(2, '0')} / {billing.card.expYear}
          </Row>
        </dl>
      </>
    );
  } else {
    pay = <p className="text-sm text-gray-600">{billing.customer === 'unavailable' ? CARD_UNAVAILABLE : NO_CARD}</p>;
  }
  return (
    <BillingBlock id="payment" title={title}>
      <div className="mt-3 grid gap-6 md:grid-cols-2">
        <div className="min-w-0" data-payment-method>
          <h3 className="text-sm font-semibold text-gray-900">Payment method</h3>
          {pay}
        </div>
        <div className="min-w-0" data-billing-contact>
          <h3 className="text-sm font-semibold text-gray-900">Billing contact</h3>
          <dl className="mt-2">
            <Row label="Name">{billing.contact.name ?? '—'}</Row>
            <Row label={sentTo}>{billing.contact.email ?? '—'}</Row>
          </dl>
        </div>
      </div>
    </BillingBlock>
  );
}
