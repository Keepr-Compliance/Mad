/**
 * PlanCard — the plan this user is on, in one line (BACKLOG-3859).
 *
 * The line comes from the shared plan rule (@keepr/shared planLine), the same
 * rule the broker portal's Billing page uses. It carries the renewal (or end)
 * date, never a price or a charge amount.
 */

import { CreditCard, AlertTriangle } from 'lucide-react';
import { Card } from '@keepr/design-system';
import type { PlanLine } from '@keepr/shared';

export function PlanCard({ line }: { line: PlanLine | null }) {
  return (
    <Card>
      <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-gray-400" />
        Plan
      </h3>
      {line ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-gray-900 flex flex-wrap items-center gap-2" data-testid="plan-line">
            <span>{line.text}</span>
            {line.test && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-warning-50 text-warning-600">
                TEST
              </span>
            )}
          </p>
          {line.warning && (
            <p className="text-xs text-warning-600 flex items-center gap-1.5" data-testid="plan-warning">
              <AlertTriangle className="h-3.5 w-3.5" />
              {line.warning}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-sm text-gray-500">Plan unavailable.</p>
      )}
    </Card>
  );
}
