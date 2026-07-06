'use client';

/**
 * PlanCard - Displays a summary card for a single plan.
 *
 * Shows plan name, tier, feature count, and active status.
 * Links to the plan detail page for editing.
 */

import Link from 'next/link';
import { CreditCard, Layers, CheckCircle2, XCircle } from 'lucide-react';
import { cardSurfaceClasses, cn } from '@keepr/design-system';
import type { PlanSummary } from './PlansPageClient';
import { TIER_LABELS } from '@/lib/plan-constants';

const tierColors: Record<string, string> = {
  individual: 'bg-blue-100 text-blue-700',
  team: 'bg-purple-100 text-purple-700',
  enterprise: 'bg-amber-100 text-amber-700',
  custom: 'bg-green-100 text-green-700',
};

interface PlanCardProps {
  plan: PlanSummary;
}

export function PlanCard({ plan }: PlanCardProps) {
  const tierClass = tierColors[plan.tier.toLowerCase()] ?? 'bg-gray-100 text-gray-700';

  return (
    <Link
      href={`/dashboard/plans/${plan.id}`}
      className={cn('block', cardSurfaceClasses, 'p-6 hover:shadow-md hover:border-gray-300 transition-all')}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary-100 text-primary-700 flex items-center justify-center">
            <CreditCard className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{plan.name}</h3>
            <span className={`inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full ${tierClass}`}>
              {TIER_LABELS[plan.tier.toLowerCase()] ?? plan.tier}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {plan.is_active ? (
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          ) : (
            <XCircle className="h-5 w-5 text-gray-400" />
          )}
        </div>
      </div>

      {plan.description && (
        <p className="mt-3 text-sm text-gray-500 line-clamp-2">{plan.description}</p>
      )}

      <div className="mt-4 flex items-center gap-1.5 text-sm text-gray-500">
        <Layers className="h-4 w-4" />
        <span>{plan.enabled_count} of {plan.feature_count} features enabled</span>
      </div>
    </Link>
  );
}
