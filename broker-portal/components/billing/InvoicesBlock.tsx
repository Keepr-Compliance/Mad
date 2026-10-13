import { BillingBlock } from './BillingBlock';
import type { AgentPlanState } from '@/lib/billing/capabilities';
import type { BillingRow, RowStatus } from '@/lib/billing/personalBilling';
import { onAgentPlan } from './CreditsBlock';
import { formatMoney, formatUnixDay } from './format';

export const ROWS_EMPTY = 'No payments yet.';
export const ROWS_UNAVAILABLE = 'Your payment history is unavailable right now.';

const STATUS: Record<RowStatus, [string, string]> = {
  paid: ['Paid', 'bg-green-100 text-green-800'],
  payment_failed: ['Payment failed', 'bg-red-100 text-red-800'],
  open: ['Due', 'bg-yellow-100 text-yellow-800'],
  void: ['Void', 'bg-gray-100 text-gray-800'],
  uncollectible: ['Unpaid', 'bg-red-100 text-red-800'],
  refunded: ['Refunded', 'bg-gray-100 text-gray-800'],
  partly_refunded: ['Partly refunded', 'bg-gray-100 text-gray-800'],
  disputed: ['Disputed', 'bg-red-100 text-red-800'],
};

export interface InvoicesData {
  rows: BillingRow[] | null;
  state: AgentPlanState;
}

/**
 * Block 6 — Receipts (pay as you go) / Invoices (Agent plan), BACKLOG-3848.
 * Rows come live from Stripe for this mode's customer. Organization pages
 * render the frame only (BACKLOG-3855).
 */
export function InvoicesBlock({ data }: { data?: InvoicesData }) {
  if (!data) return <BillingBlock id="invoices" title="Invoices" />;
  const agent = onAgentPlan(data.state);
  const rows = data.rows;
  return (
    <BillingBlock id="invoices" title={agent ? 'Invoices' : 'Receipts'}>
      {/* Stripe emails the receipt after every per-export payment (founder 2026-10-13, BACKLOG-3648). */}
      {!agent ? <p className="mt-1 text-sm text-gray-500">Emailed after every payment</p> : null}
      {rows === null || rows.length === 0 ? (
        <p className="mt-3 text-sm text-gray-600">{rows === null ? ROWS_UNAVAILABLE : ROWS_EMPTY}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {['Date', 'Description', 'Amount', 'Status', ''].map((h, i) => (
                  <th key={i} className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {rows.map((r) => {
                const [label, hue] = STATUS[r.status];
                return (
                  <tr key={r.id} data-billing-row={r.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-900">{formatUnixDay(r.created)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-700">{r.description}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-gray-700">{formatMoney(r.amountCents, r.currency)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${hue}`}>{label}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {r.link ? (
                        <a className="font-medium text-indigo-700 hover:underline" href={r.link} target="_blank" rel="noopener noreferrer">
                          {r.linkLabel}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </BillingBlock>
  );
}
