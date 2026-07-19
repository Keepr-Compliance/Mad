'use client';

/**
 * BillingCreditsCard — support-facing Billing & Credits section (BACKLOG-2020).
 *
 * READ-ONLY. Shows a user's credit standing, PAYG discount-ladder position,
 * the append-only credit & payment ledger (with per-charge Stripe links and
 * refunds surfaced), and CLEARLY-DISABLED placeholders for the future
 * grant / refund / suspend actions (BACKLOG-2016 / 2078 / 2077).
 *
 * All data is fetched server-side (service-role) in the page and passed in;
 * this component renders only — it performs no mutations.
 */

import { useState } from 'react';
import {
  CreditCard,
  Coins,
  Gift,
  Receipt,
  ExternalLink,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Card, StatCard } from '@keepr/design-system';
import { formatTimestamp } from '@/lib/format';
import {
  type BillingData,
  formatCents,
  formatDelta,
  entryChip,
  ledgerView,
} from '@/lib/billing-queries';
import { CreditGrantAction } from './CreditGrantAction';

interface BillingCreditsCardProps {
  data: BillingData;
  /** The viewed user's id — target of credit grant/clawback adjustments. */
  userId: string;
}

export function BillingCreditsCard({ data, userId }: BillingCreditsCardProps) {
  const {
    creditBalance,
    ledger,
    unlocks,
    pricingTiers,
    quote,
    lifetimePaidUnlocks,
    grossPaidCents,
    grantsIssued,
    paidUnlocksThisYear,
  } = data;

  const currentTierPriceCents = quote?.unit_price_cents ?? null;
  const refundedUnlocks = unlocks.filter((u) => u.refunded_at !== null);

  // Ledger truncation — same expand-all pattern as AuditLogTable.
  const [ledgerExpanded, setLedgerExpanded] = useState(false);
  const { visibleCount, hasMore: ledgerHasMore } = ledgerView(
    ledger.length,
    ledgerExpanded
  );
  const visibleLedger = ledger.slice(0, visibleCount);

  return (
    <Card>
      <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-gray-400" />
        Billing &amp; Credits
      </h3>

      {/* Degraded state: one or more reads failed. Never let a transient error
          look like "no billing history" on a money surface. */}
      {data.hasErrors && (
        <div className="mt-4 rounded-md border border-danger-200 bg-danger-50 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-danger-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-danger-700">
                Some billing data could not be loaded.
              </p>
              <p className="mt-0.5 text-xs text-danger-600">
                Figures below may be incomplete &mdash; do not treat them as
                authoritative. Retry or check service status.
              </p>
              {data.errorMessages.length > 0 && (
                <ul className="mt-1.5 list-disc pl-4 text-xs text-danger-600">
                  {data.errorMessages.map((msg) => (
                    <li key={msg}>{msg}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Summary stat cards */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Credit balance"
          value={creditBalance}
          icon={<Coins className="h-5 w-5" />}
          hue="indigo"
        />
        <StatCard
          label="Lifetime paid unlocks"
          value={lifetimePaidUnlocks}
          trend={formatCents(grossPaidCents)}
          icon={<Receipt className="h-5 w-5" />}
          hue="green"
        />
        <StatCard
          label="Grants issued"
          value={grantsIssued}
          icon={<Gift className="h-5 w-5" />}
          hue="blue"
        />
        <StatCard
          label="Current PAYG price"
          value={formatCents(currentTierPriceCents)}
          icon={<CreditCard className="h-5 w-5" />}
          hue="gray"
        />
      </div>

      {/* PAYG discount ladder */}
      <div className="mt-6">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          PAYG discount ladder
        </h4>
        <p className="mt-1 text-sm text-gray-600">
          {paidUnlocksThisYear} paid unlock{paidUnlocksThisYear === 1 ? '' : 's'} this
          calendar year
          {quote ? (
            <>
              {' '}
              &middot; next unlock is #{quote.next_unit_index} at{' '}
              <span className="font-medium text-gray-900">
                {formatCents(quote.unit_price_cents)}
              </span>
            </>
          ) : null}
        </p>
        {pricingTiers.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {pricingTiers.map((tier) => {
              const isCurrent = quote?.pricing_tier_id === tier.id;
              const range =
                tier.max_units === null
                  ? `${tier.min_units}+`
                  : `${tier.min_units}–${tier.max_units}`;
              return (
                <span
                  key={tier.id}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium ${
                    isCurrent
                      ? 'bg-indigo-100 text-indigo-800 ring-1 ring-indigo-300'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  <span>Deals {range}</span>
                  <span className="text-gray-400">&middot;</span>
                  <span>{formatCents(tier.unit_price_cents)}</span>
                  {isCurrent && (
                    <span className="ml-0.5 text-[10px] uppercase tracking-wide">
                      current
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Credit & payment ledger */}
      <div className="mt-6">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Credit &amp; payment ledger
          {ledger.length > 0 && (
            <span className="ml-1 font-normal text-gray-400">({ledger.length})</span>
          )}
        </h4>

        {ledger.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No ledger entries.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Time
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    &Delta; Credits
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Amount
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Funding
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Stripe / Reason
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visibleLedger.map((row) => {
                  const chip = entryChip(row.entry_type, row.amount);
                  return (
                  <tr key={row.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-sm text-gray-500 whitespace-nowrap">
                      {formatTimestamp(row.created_at)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${chip.classes}`}
                      >
                        {chip.label}
                      </span>
                    </td>
                    <td
                      className={`px-3 py-2 text-sm text-right font-medium whitespace-nowrap ${
                        row.amount > 0
                          ? 'text-green-700'
                          : row.amount < 0
                            ? 'text-gray-700'
                            : 'text-gray-500'
                      }`}
                    >
                      {formatDelta(row.amount)}
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-700 text-right whitespace-nowrap">
                      {formatCents(row.unit_price_cents)}
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-600 whitespace-nowrap">
                      {row.funding_source || '--'}
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-600">
                      {row.stripe_dashboard_url && row.stripe_payment_intent_id ? (
                        <a
                          href={row.stripe_dashboard_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary-600 hover:text-primary-700 font-medium"
                          title="Open payment in Stripe Dashboard (view / resend receipt)"
                        >
                          <code className="text-xs">{row.stripe_payment_intent_id}</code>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-gray-500">{row.reason || '--'}</span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {ledgerHasMore && (
          <button
            onClick={() => setLedgerExpanded(!ledgerExpanded)}
            className="mt-3 flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 font-medium transition-colors"
          >
            {ledgerExpanded ? (
              <>
                <ChevronUp className="h-4 w-4" />
                Show less
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4" />
                Show all {ledger.length} entries
              </>
            )}
          </button>
        )}
      </div>

      {/* Refunded unlocks (surfaced from transaction_unlocks; ledger is append-only) */}
      {refundedUnlocks.length > 0 && (
        <div className="mt-6">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Refunded unlocks
            <span className="ml-1 font-normal text-gray-400">
              ({refundedUnlocks.length})
            </span>
          </h4>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Transaction
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Unlocked
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Refunded
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {refundedUnlocks.map((u) => (
                  <tr key={u.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <code className="text-xs text-gray-500">
                        {u.local_transaction_id
                          ? u.local_transaction_id.slice(0, 12)
                          : u.id.slice(0, 8)}
                      </code>
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-500 whitespace-nowrap">
                      {formatTimestamp(u.unlocked_at)}
                    </td>
                    <td className="px-3 py-2 text-sm text-danger-600 whitespace-nowrap">
                      {formatTimestamp(u.refunded_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Support actions. Credit grant/clawback is LIVE (BACKLOG-2016); refund
          and suspend remain placeholders (BACKLOG-2078 / 2077). */}
      <div className="mt-6 border-t border-gray-100 pt-4">
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Support actions
        </h4>

        {/* Live: grant / claw back credits (calls admin_adjust_credits). */}
        <div className="mt-3">
          <CreditGrantAction userId={userId} currentBalance={creditBalance} />
        </div>

        {/* Still coming soon — separate tickets. */}
        <p className="mt-4 text-xs text-gray-400">
          Refund &amp; suspend &mdash; coming soon, not yet enabled.
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          {[{ label: 'Issue refund' }, { label: 'Suspend account' }].map((action) => (
            <button
              key={action.label}
              type="button"
              disabled
              aria-disabled="true"
              title="Coming soon"
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm font-medium text-gray-400 cursor-not-allowed"
            >
              {action.label}
              <span className="text-[10px] uppercase tracking-wide">soon</span>
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}
