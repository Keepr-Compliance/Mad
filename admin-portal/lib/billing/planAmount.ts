/**
 * The price line on a user's Plan card (BACKLOG-3852), for staff with billing.view.
 * Built from admin_get_org_billing only; brokerage members only.
 */
import { autoRenewState, formatDay, formatPeriodEnd, shouldShowBillingCard, type OrgBilling } from './dealRules';

/** 2499 -> "$24.99". */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * "$24.99 per seat / month · next invoice Nov 19, 2026", or null when there is nothing true to say:
 * no deal, a deal still waiting for setup, a canceled deal, a hidden Billing card, no price.
 */
export function planAmountLine(billing: OrgBilling | null | undefined): string | null {
  if (!shouldShowBillingCard(billing)) return null;
  const deal = billing.deal;
  const cents = billing.seat_line?.unit_price_cents;
  if (!deal || cents == null) return null;
  if (deal.status === 'draft' || deal.status === 'canceled') return null;
  const price = `${dollars(cents)} per seat / month`;
  if (deal.status === 'suspended') return price;
  const end = formatPeriodEnd(billing.stripe?.current_period_end);
  if (autoRenewState(billing) === 'ending') return end ? `${price} · ends ${end}` : price;
  if (billing.stripe?.status === 'trialing') {
    return `${price} · billing starts ${formatDay(deal.billing_starts_on ?? deal.start_date)}`;
  }
  return end ? `${price} · next invoice ${end}` : price;
}
