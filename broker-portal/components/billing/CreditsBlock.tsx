import { BillingBlock } from './BillingBlock';

/** Credits for a personal owner. Filled by a later billing slice. */
export function CreditsBlock() {
  return <BillingBlock id="credits" title="Credits" />;
}
