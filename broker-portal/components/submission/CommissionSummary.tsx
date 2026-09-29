/**
 * Commission card on the submission review page (BACKLOG-3521). READ-ONLY:
 * the figures the agent entered at submission. No correction, no split.
 */

import { Badge } from '@keepr/design-system';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import {
  NO_FIGURE,
  formatGross,
  formatRate,
  hasCommissionFigures,
  reductionRate,
  type CommissionFigures,
} from '@/lib/submissions/commission';

export function CommissionSummary({ figures }: { figures: CommissionFigures }) {
  const reduction = reductionRate(figures);

  return (
    <Card padding="none" className="overflow-hidden">
      <div data-testid="commission-card">
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">Commission</h2>
          <p className="mt-1 text-sm text-gray-500">Entered by the agent at submission</p>
        </CardHeader>
        <CardContent className="py-5">
          {hasCommissionFigures(figures) ? (
            <div className="flex flex-col gap-4">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                <Figure label="Commission offered" value={figures.offeredRate === null ? NO_FIGURE : formatRate(figures.offeredRate)} />
                <Figure label="Commission actual" value={figures.actualRate === null ? NO_FIGURE : formatRate(figures.actualRate)} />
                <Figure label="Gross commission" value={figures.grossAmount === null ? NO_FIGURE : formatGross(figures.grossAmount)} />
                {reduction !== null && (
                  <div>
                    <dt className="text-sm font-medium text-gray-500">Reduction</dt>
                    <dd className="mt-1 text-sm">
                      <Badge hue="amber" className="font-semibold">
                        <span data-testid="commission-reduction">{formatRate(reduction)}</span>
                      </Badge>
                    </dd>
                  </div>
                )}
              </dl>
              {figures.reason !== null && (
                <div>
                  <p className="text-sm font-medium text-gray-500">Reason</p>
                  <p className="mt-1 text-sm italic text-gray-700" data-testid="commission-reason">
                    &ldquo;{figures.reason}&rdquo;
                  </p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500" data-testid="commission-empty">
              No commission figures were entered for this submission.
            </p>
          )}
        </CardContent>
      </div>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm font-medium text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900 tabular-nums">{value}</dd>
    </div>
  );
}
