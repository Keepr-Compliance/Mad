import { BOOK_A_CALL_URL } from '@/lib/billing/bookCall';
import { BillingBlock } from './BillingBlock';
import { SubscribeButton } from './AgentPlanControls';
import type { PersonalPlanData } from './BillingPage';

const CARD = 'flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm';
const CARD_HI = 'flex flex-col gap-3 rounded-xl border-2 border-indigo-600 bg-white p-5 shadow-lg';

/** Plan choice for a personal owner on pay as you go (mockup v14). */
export function ChoosePlanBlock({ prices }: { prices?: PersonalPlanData['prices'] }) {
  const month = prices?.month;
  const year = prices?.year;
  return (
    <BillingBlock id="choose_plan" title="Choose a plan">
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div className={CARD} data-plan="solo">
          <p className="font-semibold text-gray-900">Solo · Pay as you go</p>
          <p className="text-sm text-gray-600">Per transaction. No subscription, nothing to cancel.</p>
          <span className="mt-auto rounded-lg bg-gray-100 px-4 py-2.5 text-center text-sm font-semibold text-gray-500">
            Your current plan
          </span>
        </div>
        <div className={CARD_HI} data-plan="agent">
          <p className="font-semibold text-gray-900">Agent</p>
          <p className="text-sm text-gray-600">Single license. Unlimited text and email exports.</p>
          {month ? (
            <>
              <p className="text-2xl font-semibold text-gray-900">
                {month.display} <span className="text-sm font-normal text-gray-500">/ month</span>
              </p>
              {year ? (
                <p className="text-sm text-gray-600">
                  or {year.display} / year
                </p>
              ) : null}
              <div className="mt-auto space-y-2">
                <SubscribeButton label={`Subscribe — ${month.display}/month`} />
                {year ? <SubscribeButton interval="year" label={`Subscribe yearly — ${year.display}/year`} /> : null}
              </div>
            </>
          ) : (
            <p className="mt-auto text-sm text-gray-500">Not available right now.</p>
          )}
        </div>
        <div className={CARD} data-plan="brokerage">
          <p className="font-semibold text-gray-900">Brokerage</p>
          <p className="text-sm text-gray-600">Purchased by a Designated Broker. Demo required.</p>
          <a
            href={BOOK_A_CALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-auto rounded-lg border border-indigo-200 px-4 py-2.5 text-center text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
          >
            Book a Call
          </a>
        </div>
      </div>
    </BillingBlock>
  );
}
