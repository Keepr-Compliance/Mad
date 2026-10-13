import { BillingBlock } from './BillingBlock';

/** Seats and licenses for an organization. Filled by BACKLOG-3854. */
export function SeatsBlock() {
  return <BillingBlock id="seats" title="Seats & licenses" />;
}
