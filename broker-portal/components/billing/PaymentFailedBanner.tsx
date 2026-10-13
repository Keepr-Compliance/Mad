import type { CardView, FailedInvoice } from '@/lib/billing/personalBilling';
import { cardLabel, formatMoney, formatUnixDay } from './format';
import { UpdateCardButton } from './BillingCardControls';

export const FAILED_TAIL = 'Unlimited exports are off from the first failed charge and come back when it is paid.';

/** "We could not charge Visa •••• 4242 for $19.99 on Oct 9, 2026." with whatever is known. */
export function failedSentence(card: CardView | null, inv: FailedInvoice | null): string {
  const what = card ? cardLabel(card) : 'your card';
  if (!inv) return `We could not charge ${what}.`;
  return `We could not charge ${what} for ${formatMoney(inv.amountCents, inv.currency)} on ${formatUnixDay(inv.created)}.`;
}

/** Page banner for an Agent plan whose payment failed (BACKLOG-3848), with Update card. */
export function PaymentFailedBanner({
  card,
  invoice,
  canUpdateCard = false,
}: {
  card: CardView | null;
  invoice: FailedInvoice | null;
  canUpdateCard?: boolean;
}) {
  return (
    <div role="alert" data-billing-banner="payment_failed" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
      <p>
        <strong>Your card payment failed.</strong> {failedSentence(card, invoice)} {FAILED_TAIL}
      </p>
      {canUpdateCard ? (
        <div className="mt-3">
          <UpdateCardButton primary />
        </div>
      ) : null}
    </div>
  );
}
