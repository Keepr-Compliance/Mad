/**
 * Settings Page - Internal User Management + Role Management
 *
 * Server component that fetches internal users (with role from admin_roles)
 * and renders the management UI with tabs for users and roles.
 */

import { createClient, getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { PageHeader } from '@keepr/design-system';
import { SettingsManager } from './components/SettingsManager';

export const dynamic = 'force-dynamic';

export interface InternalUser {
  id: string;
  user_id: string;
  role_id: string;
  role_name: string;
  role_slug: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_by_email: string | null;
}

export interface AdminRole {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_system: boolean;
  created_at: string;
  permission_keys: string[];
}

export interface PendingInvitation {
  id: string;
  email: string;
  role_name: string;
  role_slug: string;
  created_at: string;
}

export interface AdminPermission {
  id: string;
  key: string;
  label: string;
  description: string | null;
  category: string;
}

async function getInternalUsers(): Promise<InternalUser[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('internal_roles')
    .select(`
      id,
      user_id,
      role_id,
      created_at,
      updated_at,
      created_by,
      role:admin_roles(name, slug),
      user:users!internal_roles_user_id_fkey (
        email,
        display_name,
        avatar_url
      ),
      creator:users!internal_roles_created_by_fkey (
        email
      )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch internal users:', error.message);
    return [];
  }

  return (data || []).map((row: Record<string, unknown>) => {
    const user = row.user as Record<string, unknown> | null;
    const creator = row.creator as Record<string, unknown> | null;
    const role = row.role as Record<string, unknown> | null;
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      role_id: row.role_id as string,
      role_name: (role?.name as string) ?? 'Unknown',
      role_slug: (role?.slug as string) ?? 'unknown',
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      created_by: row.created_by as string | null,
      email: (user?.email as string | null) ?? null,
      display_name: (user?.display_name as string | null) ?? null,
      avatar_url: (user?.avatar_url as string | null) ?? null,
      created_by_email: (creator?.email as string | null) ?? null,
    };
  });
}

async function getPendingInvitations(): Promise<PendingInvitation[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('pending_internal_invitations')
    .select(`
      id,
      email,
      created_at,
      role:admin_roles(name, slug)
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch pending invitations:', error.message);
    return [];
  }

  return (data || []).map((row: Record<string, unknown>) => {
    const role = row.role as Record<string, unknown> | null;
    return {
      id: row.id as string,
      email: row.email as string,
      role_name: (role?.name as string) ?? 'Unknown',
      role_slug: (role?.slug as string) ?? 'unknown',
      created_at: row.created_at as string,
    };
  });
}

async function getRoles(): Promise<AdminRole[]> {
  const supabase = await createClient();

  const { data: roles, error: rolesError } = await supabase
    .from('admin_roles')
    .select('id, name, slug, description, is_system, created_at')
    .order('is_system', { ascending: false })
    .order('name');

  if (rolesError) {
    console.error('Failed to fetch roles:', rolesError.message);
    return [];
  }

  const { data: mappings } = await supabase
    .from('admin_role_permissions')
    .select('role_id, permission:admin_permissions(key)');

  const rolePermMap = new Map<string, string[]>();
  for (const m of mappings || []) {
    const perm = m.permission as unknown as { key: string } | null;
    if (perm) {
      const existing = rolePermMap.get(m.role_id) || [];
      existing.push(perm.key);
      rolePermMap.set(m.role_id, existing);
    }
  }

  return (roles || []).map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    is_system: r.is_system,
    created_at: r.created_at,
    permission_keys: rolePermMap.get(r.id) || [],
  }));
}

async function getPermissions(): Promise<AdminPermission[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('admin_permissions')
    .select('id, key, label, description, category')
    .order('category')
    .order('key');

  if (error) {
    console.error('Failed to fetch permissions:', error.message);
    return [];
  }

  return data || [];
}

async function getCurrentUserId(): Promise<string | null> {
  const { user } = await getAuthenticatedUser();
  return user?.id ?? null;
}

export default async function SettingsPage() {
  // Defense-in-depth: verify auth, internal role, and page-level permission
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    redirect('/login');
  }

  const { data: internalRole } = await supabase
    .from('internal_roles')
    .select('role_id')
    .eq('user_id', user.id)
    .single();

  if (!internalRole) {
    redirect('/login?error=not_authorized');
  }

  const { data: hasAnyPerm } = await supabase.rpc('has_any_permission', {
    check_user_id: user.id,
    permission_keys: ['internal_users.view', 'roles.view', 'audit.view'],
  });
  if (!hasAnyPerm) {
    redirect('/dashboard?error=insufficient_permissions');
  }

  const [internalUsers, currentUserId, roles, permissions, pendingInvitations] = await Promise.all([
    getInternalUsers(),
    getCurrentUserId(),
    getRoles(),
    getPermissions(),
    getPendingInvitations(),
  ]);

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        title="Settings"
        subtitle="Manage internal users, roles, and permissions."
      />

      <SettingsManager
        initialUsers={internalUsers}
        currentUserId={currentUserId}
        initialRoles={roles}
        permissions={permissions}
        pendingInvitations={pendingInvitations}
      />
    </div>
  );
}
