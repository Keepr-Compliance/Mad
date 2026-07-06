import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Building2, CreditCard } from 'lucide-react';
import { Card } from '@keepr/design-system';
import { FeatureToggleList } from '../components/FeatureToggleList';
import { DeletePlanButton } from '../components/DeletePlanButton';
import { PlanStatusToggle } from '../components/PlanStatusToggle';
import { PlanTierEditor } from '../components/PlanTierEditor';
import { formatDate } from '@/lib/format';
import type { Plan, PlanFeature, FeatureDefinition, FeatureDependency } from '@/lib/admin-queries';

export const dynamic = 'force-dynamic';

/**
 * Plan Detail Page - Admin Portal
 *
 * Server component that loads a plan with all feature definitions and assignments.
 * Passes data to FeatureToggleList client component for interactive editing.
 */
export default async function PlanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    redirect('/login');
  }

  // Verify internal role
  const { data: internalRole } = await supabase
    .from('internal_roles')
    .select('role_id')
    .eq('user_id', user.id)
    .single();

  if (!internalRole) {
    redirect('/login?error=not_authorized');
  }

  // Defense-in-depth: verify page-level permission
  const { data: hasPerm } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'plans.view',
  });
  if (!hasPerm) {
    redirect('/dashboard?error=insufficient_permissions');
  }

  // Check manage permission
  const { data: canManage } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'plans.manage',
  });

  // Fetch plan, plan features, all feature definitions, dependencies, and orgs using this plan in parallel
  const [planResult, planFeaturesResult, allFeaturesResult, depsResult, orgsOnPlanResult] = await Promise.all([
    supabase.from('plans').select('*').eq('id', id).single(),
    supabase
      .from('plan_features')
      .select('*, feature_definitions(*)')
      .eq('plan_id', id),
    supabase.from('feature_definitions').select('*').order('category').order('name'),
    supabase.from('feature_dependencies').select('feature_key, depends_on_key'),
    supabase
      .from('organization_plans')
      .select('organization_id, assigned_at, organizations(id, name)')
      .eq('plan_id', id)
      .order('assigned_at', { ascending: false }),
  ]);

  if (!planResult.data) {
    notFound();
  }

  const plan = planResult.data as unknown as Plan;
  const planFeatures = (planFeaturesResult.data ?? []) as unknown as PlanFeature[];
  const allFeatures = (allFeaturesResult.data ?? []) as unknown as FeatureDefinition[];
  const dependencies = (depsResult.data ?? []) as unknown as FeatureDependency[];
  const orgsOnPlan = (orgsOnPlanResult.data ?? []) as unknown as Array<{
    organization_id: string;
    assigned_at: string;
    organizations: { id: string; name: string } | null;
  }>;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Back navigation */}
      <Link
        href="/dashboard/plans"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Plans
      </Link>

      {/* Plan header card */}
      <Card>
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-primary-100 text-primary-700 flex items-center justify-center">
            <CreditCard className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">{plan.name}</h1>
              <PlanStatusToggle planId={plan.id} isActive={plan.is_active} canManage={!!canManage} />
            </div>
            {plan.description && (
              <p className="text-sm text-gray-500 mt-1">{plan.description}</p>
            )}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Tier</dt>
            <dd className="mt-1">
              <PlanTierEditor planId={plan.id} currentTier={plan.tier} canManage={!!canManage} />
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Features Configured</dt>
            <dd className="mt-1 text-sm text-gray-900">{planFeatures.length} / {allFeatures.length}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Created</dt>
            <dd className="mt-1 text-sm text-gray-900">{formatDate(plan.created_at)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Last Updated</dt>
            <dd className="mt-1 text-sm text-gray-900">{formatDate(plan.updated_at)}</dd>
          </div>
        </div>
      </Card>

      {/* Feature toggles */}
      <div>
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">
          Feature Configuration
        </h2>
        <FeatureToggleList
          planId={plan.id}
          planTier={plan.tier}
          features={planFeatures}
          allFeatures={allFeatures}
          dependencies={dependencies}
          canManage={!!canManage}
        />
      </div>

      {/* Organizations using this plan */}
      <div>
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">
          Organizations Using This Plan
        </h2>
        {orgsOnPlan.length === 0 ? (
          <p className="text-sm text-gray-500">No organizations are using this plan.</p>
        ) : (
          <Card padding="none" className="divide-y divide-gray-100">
            {orgsOnPlan.map((op) => (
              <Link
                key={op.organization_id}
                href={`/dashboard/organizations/${op.organization_id}`}
                className="flex items-center justify-between p-4 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Building2 className="h-4 w-4 text-gray-400" />
                  <span className="text-sm font-medium text-primary-600 hover:text-primary-700">
                    {op.organizations?.name || 'Unnamed Organization'}
                  </span>
                </div>
                <span className="text-xs text-gray-500">
                  Assigned {formatDate(op.assigned_at)}
                </span>
              </Link>
            ))}
          </Card>
        )}
      </div>

      {/* Danger zone */}
      {canManage && (
        <div className="border border-red-200 rounded-lg p-6">
          <h2 className="text-sm font-semibold text-red-700 uppercase tracking-wider mb-2">
            Danger Zone
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Deleting a plan is permanent. Plans with assigned organizations cannot be deleted.
          </p>
          <DeletePlanButton planId={plan.id} planName={plan.name} />
        </div>
      )}
    </div>
  );
}
