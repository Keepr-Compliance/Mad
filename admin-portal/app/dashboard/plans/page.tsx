import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { PageHeader } from '@keepr/design-system';
import { PlansPageClient } from './components/PlansPageClient';

export const dynamic = 'force-dynamic';

/**
 * Plans List Page - Admin Portal
 *
 * Server component that fetches all plans and renders plan cards.
 * Includes a button to create new plans.
 */
export default async function PlansPage() {
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

  // Check if user can manage plans (for create button visibility)
  const { data: canManage } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'plans.manage',
  });

  // Fetch all plans with total and enabled feature counts
  const { data: plans, error } = await supabase
    .from('plans')
    .select('*, plan_features(count), enabled_features:plan_features(count)')
    .eq('enabled_features.enabled', true)
    .order('sort_order');

  if (error) {
    return (
      <div className="max-w-7xl mx-auto">
        <PageHeader title="Plans" />
        <div className="bg-white rounded-lg shadow-sm border border-danger-500/20 p-8 text-center">
          <p className="text-danger-600 text-sm">Failed to load plans: {error.message}</p>
        </div>
      </div>
    );
  }

  // Transform data to extract feature counts
  const plansData = (plans ?? []).map((plan) => {
    const featureAgg = plan.plan_features as unknown as { count: number }[];
    const enabledAgg = plan.enabled_features as unknown as { count: number }[];
    return {
      id: plan.id as string,
      name: plan.name as string,
      tier: plan.tier as string,
      description: plan.description as string | null,
      is_active: plan.is_active as boolean,
      sort_order: plan.sort_order as number,
      created_at: plan.created_at as string,
      updated_at: plan.updated_at as string,
      feature_count: featureAgg?.[0]?.count ?? 0,
      enabled_count: enabledAgg?.[0]?.count ?? 0,
    };
  });

  return (
    <div className="max-w-7xl mx-auto">
      <PlansPageClient plans={plansData} canManage={!!canManage} />
    </div>
  );
}
