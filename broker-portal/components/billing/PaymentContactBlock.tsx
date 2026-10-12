import { BillingBlock } from './BillingBlock';

/** Payment method and billing contact. Filled by BACKLOG-3848. */
export function PaymentContactBlock() {
  return <BillingBlock id="payment" title="Payment method & billing contact" />;
}
