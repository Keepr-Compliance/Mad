import { BillingBlock } from './BillingBlock';

/** Plan choice for a personal owner on pay as you go. Filled by BACKLOG-3847. */
export function ChoosePlanBlock() {
  return <BillingBlock id="choose_plan" title="Choose a plan" />;
}
