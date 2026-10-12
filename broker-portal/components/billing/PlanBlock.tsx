import { BillingBlock } from './BillingBlock';

/** "Your plan". BACKLOG-3844 shows the plan name only, never a price. */
export function PlanBlock({ line }: { line: string }) {
  return (
    <BillingBlock id="plan" title="Your plan">
      <p className="mt-2 text-sm text-gray-600">{line}</p>
    </BillingBlock>
  );
}
