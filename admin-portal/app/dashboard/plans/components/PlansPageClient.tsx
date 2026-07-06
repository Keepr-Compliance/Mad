'use client';

/**
 * PlansPageClient - Client wrapper for the plans list page.
 *
 * Handles the Create Plan dialog state and renders the plan cards grid.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { PageHeader, Button } from '@keepr/design-system';
import { PlanCard } from './PlanCard';
import { CreatePlanDialog } from './CreatePlanDialog';

export interface PlanSummary {
  id: string;
  name: string;
  tier: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  feature_count: number;
  enabled_count: number;
}

interface PlansPageClientProps {
  plans: PlanSummary[];
  canManage: boolean;
}

export function PlansPageClient({ plans, canManage }: PlansPageClientProps) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const router = useRouter();

  const handleCreated = (planId?: string) => {
    setShowCreateDialog(false);
    if (planId) {
      router.push(`/dashboard/plans/${planId}`);
    } else {
      router.refresh();
    }
  };

  return (
    <>
      <PageHeader
        title="Plans"
        subtitle={
          <>
            {plans.length} plan{plans.length !== 1 ? 's' : ''} total
          </>
        }
        actions={
          canManage && (
            <Button onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-4 w-4" />
              Create Plan
            </Button>
          )
        }
      />

      {plans.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <p className="text-gray-500 text-sm">No plans configured yet.</p>
          {canManage && (
            <button
              onClick={() => setShowCreateDialog(true)}
              className="mt-4 inline-flex items-center gap-2 text-sm text-primary-600 hover:text-primary-700 font-medium"
            >
              <Plus className="h-4 w-4" />
              Create your first plan
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>
      )}

      {showCreateDialog && (
        <CreatePlanDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}
