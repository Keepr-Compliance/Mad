'use client';

/**
 * Paywall Funnel report — composition shell (BACKLOG-2014, moved onto the
 * report kit in BACKLOG-3722)
 *
 * Renders the `computeFunnel` result: the period picker, one StatCard per
 * step (distinct users, with "% of prev" / "% of top"), the bar chart and the
 * reading guide. Navigation is a prop, so this renders in a plain Node test.
 *
 * A failed read is NOT an empty funnel: it shows a banner and no cards, never
 * the "No funnel events" text.
 */

import { FilterBar, FilterCaption, PeriodPicker, StatCard, TruncationNotice } from '@keepr/ui';
import { AlertTriangle } from 'lucide-react';
import type { FunnelResult } from '@/lib/funnel-analytics';
import {
  buildFunnelPeriodUrl,
  FUNNEL_PERIOD_OPTIONS,
  type FunnelPeriod,
  type FunnelPeriodKey,
} from '@/lib/reports/funnel-period';

export const FAILED_TEXT =
  'The funnel events could not be read. This is a query failure, not an empty funnel — no count on this page can be trusted.';
export const EMPTY_TEXT =
  'No funnel events in this range yet. Events are captured from the desktop app (paywall / unlock / export) and the payment webhook (payment succeeded); they will appear here once users hit the paywall in the selected window.';
export const EXCEEDS_TEXT =
  'A step shows more than 100% of the previous step (bar clamped to 100%). This is expected when transactions are exported without a paid unlock in range — e.g. legacy or free-unlocked deals.';

/** primary-{600..900} shades, top-to-bottom of the funnel. */
const STEP_COLORS = ['#0284c7', '#0369a1', '#075985', '#0c4a6e'];

const PANEL_CLASS = 'rounded-lg border border-gray-200 bg-white p-5';

export interface FunnelReportProps {
  funnel: FunnelResult;
  period: FunnelPeriod;
  failed?: boolean;
  truncated?: boolean;
  rowCap: number;
  onNavigate?: (url: string) => void;
}

export function FunnelReport({
  funnel,
  period,
  failed = false,
  truncated = false,
  rowCap,
  onNavigate,
}: FunnelReportProps) {
  const { steps, topCount } = funnel;
  const hasData = topCount > 0 || steps.some((s) => s.userCount > 0);

  function navigateToPeriod(nextPeriod: string, from?: string, to?: string) {
    const search = typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/, '');
    onNavigate?.(buildFunnelPeriodUrl(search, nextPeriod, from, to));
  }

  return (
    <div className="space-y-6">
      {failed ? (
        <div
          data-banner="events-failed"
          className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900"
        >
          {FAILED_TEXT}
        </div>
      ) : null}

      <FilterBar hasFilters={false} onClear={() => undefined}>
        <PeriodPicker<FunnelPeriodKey>
          options={FUNNEL_PERIOD_OPTIONS}
          value={period.key}
          customKey="custom"
          from={period.customFrom ?? undefined}
          to={period.customTo ?? undefined}
          onChange={navigateToPeriod}
        />
      </FilterBar>

      {truncated ? (
        <TruncationNotice
          noun="funnel events"
          capPhrase={`at most ${rowCap} events`}
          periodLabel={period.label}
          scope="every count and percentage"
        />
      ) : null}

      {failed ? null : !hasData ? (
        <div className={PANEL_CLASS} data-empty="funnel">
          <p className="text-sm text-gray-500">{EMPTY_TEXT}</p>
        </div>
      ) : (
        <>
          <div>
            <FilterCaption
              className="mb-2 text-xs"
              lead="Every card and bar follows the period"
              periodLabel={period.label}
              filterNames={[]}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map((step, i) => (
                <StatCard
                  key={step.event}
                  data-tile={step.event}
                  label={step.label}
                  value={step.userCount}
                  subtitle="unique users"
                  valueProps={{ 'data-tile-value': step.event }}
                  footer={
                    i > 0 ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <span
                          data-conv-prev={step.event}
                          className={`rounded px-2 py-0.5 text-xs font-medium ${
                            step.exceedsPrevious ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
                          }`}
                        >
                          {step.conversionFromPrev}% of prev
                        </span>
                        <span
                          data-conv-top={step.event}
                          className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700"
                        >
                          {step.conversionFromTop}% of top
                        </span>
                      </div>
                    ) : undefined
                  }
                />
              ))}
            </div>
          </div>

          <div className={PANEL_CLASS}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Conversion by step</h3>
            <div className="space-y-3">
              {steps.map((step, i) => (
                <div key={step.event}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="text-gray-700">{step.label}</span>
                    <span className="text-gray-500">
                      {step.userCount.toLocaleString()} users
                      {i > 0 && ` · ${step.conversionFromPrev}% of previous`}
                    </span>
                  </div>
                  <div className="h-6 w-full overflow-hidden rounded bg-gray-100">
                    <div
                      data-bar={step.event}
                      className="h-full rounded transition-all"
                      style={{ width: `${step.barPct}%`, backgroundColor: STEP_COLORS[i] }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {steps.some((s) => s.exceedsPrevious) ? (
              <div
                data-note="exceeds-previous"
                className="mt-4 flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{EXCEEDS_TEXT}</span>
              </div>
            ) : null}
          </div>

          <div className={PANEL_CLASS}>
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Reading this funnel</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm text-gray-600">
              <li>
                Big drop at <strong>viewed &rarr; unlock clicked</strong>: paywall confusion or value not landing.
              </li>
              <li>
                Big drop at <strong>unlock clicked &rarr; payment</strong>: price objection or checkout friction.
              </li>
              <li>
                Drop at <strong>payment &rarr; export</strong>: fulfillment or export is broken.
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
