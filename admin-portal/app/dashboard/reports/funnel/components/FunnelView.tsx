'use client';

/**
 * FunnelView — Paywall Funnel Dashboard (BACKLOG-2014)
 *
 * Renders the funnel result from `computeFunnel`: a date-range filter, per-step
 * count cards, and a horizontal funnel bar chart (conversion vs previous step,
 * with the top of the funnel = 100%). Client component so the period filter can
 * push a searchParam without a full navigation.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { Card, Badge } from '@keepr/design-system';
import { AlertTriangle } from 'lucide-react';
import type { FunnelResult } from '@/lib/funnel-analytics';

interface Props {
  funnel: FunnelResult;
  activePeriod: string;
}

const PERIODS = [
  { key: '1', label: '24h' },
  { key: '7', label: '7d' },
  { key: '30', label: '30d' },
  { key: '90', label: '90d' },
  { key: 'all', label: 'All time' },
] as const;

/** primary-{600..300} shades, top-to-bottom of the funnel. */
const STEP_COLORS = ['#0284c7', '#0369a1', '#075985', '#0c4a6e'];

export function FunnelView({ funnel, activePeriod }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const setPeriod = (key: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (key === '30') {
      params.delete('period');
    } else {
      params.set('period', key);
    }
    router.push(`?${params.toString()}`, { scroll: false });
  };

  const { steps, topCount } = funnel;
  const hasData = topCount > 0 || steps.some((s) => s.userCount > 0);

  return (
    <div className="space-y-6">
      {/* Date-range filter */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-500 mr-1">Range:</span>
        {PERIODS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            className={`px-3 py-1 text-sm rounded-md border transition-colors ${
              activePeriod === p.key
                ? 'bg-primary-600 text-white border-primary-600'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {!hasData ? (
        <Card>
          <p className="text-sm text-gray-500">
            No funnel events in this range yet. Events are captured from the
            desktop app (paywall / unlock / export) and the payment webhook
            (payment succeeded); they will appear here once users hit the paywall
            in the selected window.
          </p>
        </Card>
      ) : (
        <>
          {/* Per-step count cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {steps.map((step, i) => (
              <Card key={step.event}>
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="inline-block h-3 w-3 rounded-sm"
                    style={{ backgroundColor: STEP_COLORS[i] }}
                    aria-hidden
                  />
                  <span className="text-sm font-medium text-gray-700">
                    {step.label}
                  </span>
                </div>
                <div className="text-3xl font-bold text-gray-900">
                  {step.userCount.toLocaleString()}
                </div>
                <div className="text-xs text-gray-500">unique users</div>
                {i > 0 && (
                  <div className="mt-2 flex items-center gap-1 flex-wrap">
                    <Badge hue={step.exceedsPrevious ? 'amber' : 'blue'}>
                      {step.conversionFromPrev}% of prev
                    </Badge>
                    <Badge hue="gray">{step.conversionFromTop}% of top</Badge>
                  </div>
                )}
              </Card>
            ))}
          </div>

          {/* Horizontal funnel bar chart */}
          <Card>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              Conversion by step
            </h3>
            <div className="space-y-3">
              {steps.map((step, i) => (
                <div key={step.event}>
                  <div className="flex items-center justify-between mb-1 text-sm">
                    <span className="text-gray-700">{step.label}</span>
                    <span className="text-gray-500">
                      {step.userCount.toLocaleString()} users
                      {i > 0 && ` · ${step.conversionFromPrev}% of previous`}
                    </span>
                  </div>
                  <div className="h-6 w-full bg-gray-100 rounded overflow-hidden">
                    <div
                      className="h-full rounded transition-all"
                      style={{
                        width: `${step.barPct}%`,
                        backgroundColor: STEP_COLORS[i],
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {steps.some((s) => s.exceedsPrevious) && (
              <div className="mt-4 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-3">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  A step shows more than 100% of the previous step (bar clamped to
                  100%). This is expected when transactions are exported without a
                  paid unlock in range &mdash; e.g. legacy or free-unlocked deals.
                </span>
              </div>
            )}
          </Card>

          {/* Diagnostic hint per the founder framing */}
          <Card>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">
              Reading this funnel
            </h3>
            <ul className="text-sm text-gray-600 space-y-1 list-disc pl-5">
              <li>
                Big drop at <strong>viewed &rarr; unlock clicked</strong>:
                paywall confusion or value not landing.
              </li>
              <li>
                Big drop at <strong>unlock clicked &rarr; payment</strong>: price
                objection or checkout friction.
              </li>
              <li>
                Drop at <strong>payment &rarr; export</strong>: fulfillment or
                export is broken.
              </li>
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
