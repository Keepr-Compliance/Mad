/**
 * Admin Queries - Helper functions for admin RPC calls
 *
 * Uses the browser Supabase client for client-side data fetching.
 */

import { createClient } from '@/lib/supabase/client';
import { withoutPlanEditorHiddenFeatures } from '@/lib/plan-constants';

export interface AdminSearchUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  org_name: string | null;
  org_slug: string | null;
  org_role: string | null;
  status: string | null;
  last_login_at: string | null;
}

/** Build a display name from available fields */
export function getUserDisplayName(user: AdminSearchUser): string {
  if (user.display_name) return user.display_name;
  if (user.first_name || user.last_name) {
    return [user.first_name, user.last_name].filter(Boolean).join(' ');
  }
  return 'Unnamed User';
}

/**
 * Search users across all organizations via admin_search_users RPC.
 *
 * @param searchQuery - Search term (name, email, org, or user ID)
 * @returns Array of matching users
 */
export async function searchUsers(
  searchQuery: string
): Promise<{ data: AdminSearchUser[] | null; error: Error | null }> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_search_users', {
    search_query: searchQuery,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data: data as AdminSearchUser[], error: null };
}

// ---------------------------------------------------------------------------
// Write Operations (Suspend / Unsuspend / License Edit)
// ---------------------------------------------------------------------------

interface RpcResult<T = Record<string, unknown>> {
  data: T | null;
  error: Error | null;
}

/**
 * Suspend a user via admin_suspend_user RPC.
 *
 * @param userId - The target user's UUID
 * @param reason - Optional reason for suspension
 */
export async function suspendUser(
  userId: string,
  reason?: string
): Promise<RpcResult<{ success: boolean; previous_status: string }>> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_suspend_user', {
    p_user_id: userId,
    ...(reason ? { p_reason: reason } : {}),
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data: data as { success: boolean; previous_status: string }, error: null };
}

/**
 * Unsuspend a user via admin_unsuspend_user RPC.
 *
 * @param userId - The target user's UUID
 */
export async function unsuspendUser(
  userId: string
): Promise<RpcResult<{ success: boolean; previous_status: string }>> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_unsuspend_user', {
    p_user_id: userId,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data: data as { success: boolean; previous_status: string }, error: null };
}

/**
 * Update a license via admin_update_license RPC.
 *
 * @param licenseId - The license UUID
 * @param changes - Object of fields to update (status, expires_at, license_type, transaction_limit)
 */
export async function updateLicense(
  licenseId: string,
  changes: Record<string, unknown>
): Promise<
  RpcResult<{ success: boolean; old_values: Record<string, unknown>; new_values: Record<string, unknown> }>
> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_update_license', {
    p_license_id: licenseId,
    p_changes: changes,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return {
    data: data as {
      success: boolean;
      old_values: Record<string, unknown>;
      new_values: Record<string, unknown>;
    },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Plan Management
// ---------------------------------------------------------------------------

export interface Plan {
  id: string;
  name: string;
  tier: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface FeatureDefinition {
  id: string;
  key: string;
  name: string;
  description: string | null;
  category: string;
  value_type: string;
  default_value: string | null;
  min_tier: string | null;
  created_at: string;
}

export interface FeatureDependency {
  feature_key: string;
  depends_on_key: string;
}

export interface PlanFeature {
  id: string;
  plan_id: string;
  feature_id: string;
  enabled: boolean;
  value: string | null;
  feature_definitions: FeatureDefinition;
}

export interface PlanWithFeatureCount extends Plan {
  feature_count: number;
}

export interface OrganizationPlan {
  id: string;
  organization_id: string;
  plan_id: string;
  assigned_at: string;
  assigned_by: string | null;
  plans: Plan;
}

/**
 * Fetch all plans with feature counts.
 */
export async function getPlans(): Promise<{ data: PlanWithFeatureCount[] | null; error: Error | null }> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('plans')
    .select('*, plan_features(count)')
    .order('sort_order');

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  const plans: PlanWithFeatureCount[] = (data ?? []).map((plan) => {
    const featureAgg = plan.plan_features as unknown as { count: number }[];
    return {
      id: plan.id,
      name: plan.name,
      tier: plan.tier,
      description: plan.description,
      is_active: plan.is_active,
      sort_order: plan.sort_order,
      created_at: plan.created_at,
      updated_at: plan.updated_at,
      feature_count: featureAgg?.[0]?.count ?? 0,
    };
  });

  return { data: plans, error: null };
}

/**
 * Fetch a single plan with all its feature assignments and definitions.
 */
export async function getPlanWithFeatures(
  planId: string
): Promise<{ data: { plan: Plan; features: PlanFeature[]; allFeatures: FeatureDefinition[] } | null; error: Error | null }> {
  const supabase = createClient();

  const [planResult, featuresResult, allFeaturesResult] = await Promise.all([
    supabase.from('plans').select('*').eq('id', planId).single(),
    supabase
      .from('plan_features')
      .select('*, feature_definitions(*)')
      .eq('plan_id', planId),
    supabase.from('feature_definitions').select('*').order('category').order('name'),
  ]);

  if (planResult.error) {
    return { data: null, error: new Error(planResult.error.message) };
  }

  return {
    data: {
      plan: planResult.data as Plan,
      features: (featuresResult.data ?? []) as unknown as PlanFeature[],
      allFeatures: withoutPlanEditorHiddenFeatures((allFeaturesResult.data ?? []) as FeatureDefinition[]),
    },
    error: null,
  };
}

/**
 * Update a single plan feature (upsert enabled + value).
 */
export async function updatePlanFeature(
  planId: string,
  featureId: string,
  enabled: boolean,
  value?: string | null
): Promise<RpcResult> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_update_plan_feature', {
    p_plan_id: planId,
    p_feature_id: featureId,
    p_enabled: enabled,
    p_value: value ?? null,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  const updateResult = data as Record<string, unknown>;
  if (updateResult?.success === false) {
    return { data: null, error: new Error(String(updateResult.error || 'Unknown error')) };
  }

  return { data: data as Record<string, unknown>, error: null };
}

/**
 * Create a new plan.
 */
export async function createPlan(
  name: string,
  tier: string,
  description?: string
): Promise<RpcResult<Plan>> {
  const supabase = createClient();

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const { data, error } = await supabase.rpc('admin_create_plan', {
    p_name: name,
    p_slug: slug,
    p_tier: tier,
    p_description: description || null,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  // RPC returns JSONB with success/error fields
  const result = data as Record<string, unknown>;
  if (result?.success === false) {
    return { data: null, error: new Error(String(result.message || result.error || 'Unknown error')) };
  }

  return { data: data as Plan, error: null };
}

/**
 * Assign a plan to an organization (upsert so changing plan just updates).
 */
export async function assignOrgPlan(
  orgId: string,
  planId: string
): Promise<RpcResult> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_assign_org_plan', {
    p_org_id: orgId,
    p_plan_id: planId,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  const assignResult = data as Record<string, unknown>;
  if (assignResult?.success === false) {
    return { data: null, error: new Error(String(assignResult.error || 'Unknown error')) };
  }

  return { data: data as Record<string, unknown>, error: null };
}

/**
 * Get the current plan assignment for an organization.
 * Uses admin_get_org_plan RPC to bypass organization_plans RLS.
 */
export async function getOrgPlan(
  orgId: string
): Promise<{ data: OrganizationPlan | null; error: Error | null }> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_get_org_plan', {
    p_org_id: orgId,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  const result = data as Record<string, unknown> | null;
  if (!result || result.success === false) {
    const errMsg = result?.error ? String(result.error) : 'Failed to fetch org plan';
    return { data: null, error: new Error(errMsg) };
  }

  // RPC returns null data when no plan is assigned
  if (result.data === null) {
    return { data: null, error: null };
  }

  // Map RPC result to OrganizationPlan shape
  return {
    data: {
      id: result.id as string,
      organization_id: result.organization_id as string,
      plan_id: result.plan_id as string,
      assigned_at: result.assigned_at as string,
      assigned_by: result.assigned_by as string | null,
      plans: result.plans as Plan,
    },
    error: null,
  };
}

/**
 * Fetch active plans eligible for organization assignment.
 * Excludes Individual-tier plans (they are for solo users only).
 */
export async function getActivePlansForOrgs(): Promise<{ data: Plan[] | null; error: Error | null }> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .eq('is_active', true)
    .neq('tier', 'individual')
    .order('sort_order');

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data: data as Plan[], error: null };
}

/**
 * Fetch all active plans (all tiers, including Individual).
 * Used for individual user invite where any plan can be selected.
 */
export async function getActivePlans(): Promise<{ data: Plan[] | null; error: Error | null }> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .eq('is_active', true)
    .order('sort_order');

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data: data as Plan[], error: null };
}

/**
 * Delete a plan. Blocked if any organizations are assigned to it.
 */
export async function deletePlan(planId: string): Promise<RpcResult> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_delete_plan', {
    p_plan_id: planId,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  const result = data as Record<string, unknown>;
  if (result?.success === false) {
    const message = result.message || result.error || 'Unknown error';
    return { data: null, error: new Error(String(message)) };
  }

  return { data: data as Record<string, unknown>, error: null };
}

/**
 * Activate or deactivate a plan.
 */
export async function togglePlanActive(planId: string, isActive: boolean): Promise<RpcResult> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_toggle_plan_active', {
    p_plan_id: planId,
    p_is_active: isActive,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  const result = data as Record<string, unknown>;
  if (result?.success === false) {
    return { data: null, error: new Error(String(result.message || result.error || 'Unknown error')) };
  }

  return { data: data as Record<string, unknown>, error: null };
}

/**
 * Update a plan's tier via admin_update_plan_tier RPC.
 * Returns error with conflicting features list if tier downgrade is blocked.
 */
export async function updatePlanTier(
  planId: string,
  newTier: string
): Promise<RpcResult> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_update_plan_tier', {
    p_plan_id: planId,
    p_new_tier: newTier,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  const result = data as Record<string, unknown>;
  if (result?.success === false) {
    const message = String(result.message || result.error || 'Unknown error');
    return { data: null, error: new Error(message) };
  }

  return { data: data as Record<string, unknown>, error: null };
}

// ---------------------------------------------------------------------------
// Organization Management
// ---------------------------------------------------------------------------

/**
 * Create a new organization via admin_create_organization RPC.
 *
 * BACKLOG-4007: maxSeats is sent only when given (Create Organization gives it while
 * brokerage billing is off). Without it the RPC default (p_max_seats DEFAULT 5) applies and
 * the deal sets seats (_billing_save_deal writes organizations.max_seats).
 *
 * @param name - Organization name
 * @param maxSeats - Maximum seats (omitted while billing is live)
 */
export async function createOrganization(
  name: string,
  maxSeats?: number
): Promise<RpcResult<{ success: boolean; id: string; slug: string }>> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_create_organization', {
    p_name: name,
    ...(maxSeats !== undefined ? { p_max_seats: maxSeats } : {}),
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  // RPC returns JSONB with success/error fields
  const result = data as Record<string, unknown>;
  if (result?.success === false) {
    return { data: null, error: new Error(String(result.message || result.error || 'Unknown error')) };
  }

  return { data: data as { success: boolean; id: string; slug: string }, error: null };
}

// ---------------------------------------------------------------------------
// Device Management
// ---------------------------------------------------------------------------

export interface AdminDevice {
  id: string;
  device_name: string | null;
  device_id: string;
  os: string | null;
  app_version: string | null;
  platform: string | null;
  is_active: boolean;
  last_seen_at: string | null;
  activated_at: string | null;
}

/**
 * List all devices for a user via admin_list_user_devices RPC.
 *
 * @param userId - The target user's UUID
 */
export async function listUserDevices(
  userId: string
): Promise<{ data: AdminDevice[] | null; error: Error | null }> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_list_user_devices', {
    p_user_id: userId,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data: data as AdminDevice[], error: null };
}

/**
 * Deactivate a device via admin_deactivate_device RPC.
 *
 * @param deviceId - The device UUID to deactivate
 * @param userId - The owning user's UUID (for verification)
 */
export async function deactivateDevice(
  deviceId: string,
  userId: string
): Promise<RpcResult<{ success: boolean; device_id: string; device_name: string | null }>> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_deactivate_device', {
    p_device_id: deviceId,
    p_user_id: userId,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return {
    data: data as { success: boolean; device_id: string; device_name: string | null },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Impersonation
// ---------------------------------------------------------------------------

interface ImpersonationResult {
  success: boolean;
  token: string;
  session_id: string;
  expires_at: string;
  error?: string;
}

/**
 * Start an impersonation session via admin_start_impersonation RPC.
 *
 * @param targetUserId - The target user's UUID to impersonate
 */
export async function startImpersonation(
  targetUserId: string
): Promise<RpcResult<ImpersonationResult>> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('admin_start_impersonation', {
    p_target_user_id: targetUserId,
  });

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data: data as ImpersonationResult, error: null };
}
