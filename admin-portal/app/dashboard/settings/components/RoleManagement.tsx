'use client';

/**
 * RoleManagement - Create/edit/delete roles with permission matrix.
 *
 * Users with roles.manage can edit roles below their own (BACKLOG-4168): never their
 * own role, and only with permission keys they hold (Super Admins hold every key).
 * Other users with roles.view can see them read-only.
 */

import { useState, useCallback, useMemo } from 'react';
import { Plus, Pencil, Trash2, Shield, ShieldAlert, Check, X, Lock, Users } from 'lucide-react';
import { Card, CardHeader, Button, Checkbox } from '@keepr/design-system';
import { ConfirmationDialog } from '@keepr/ui';
import { createClient } from '@/lib/supabase/client';
import type { AdminRole, AdminPermission, InternalUser } from '../page';
import { usePermissions } from '@/components/providers/PermissionsProvider';
import { PERMISSIONS, PERMISSION_CATEGORIES } from '@/lib/permissions';
import { describeRoleError, isStrictlyBelow, NOT_PERMITTED_MESSAGE } from '@/lib/internal-roles';

interface RoleManagementProps {
  roles: AdminRole[];
  permissions: AdminPermission[];
  onRefresh: () => void;
  users?: InternalUser[];
  currentUserId?: string | null;
  /** Role ids the signed-in user may grant (can_grant_role); null while loading. */
  grantableRoleIds?: Set<string> | null;
  onNavigateToUsersWithRole?: (roleSlug: string) => void;
}

export function RoleManagement({ roles, permissions, onRefresh, users = [], currentUserId = null, grantableRoleIds = null, onNavigateToUsersWithRole }: RoleManagementProps) {
  const { hasPermission, permissions: heldKeys, roleSlug } = usePermissions();
  const canManage = hasPermission(PERMISSIONS.ROLES_MANAGE);

  // The caller's own role: from the users list, else from the permissions provider.
  const ownRole = useMemo(() => {
    const ownRoleId = users.find((u) => u.user_id === currentUserId)?.role_id;
    return roles.find((r) => r.id === ownRoleId) ?? roles.find((r) => r.slug === roleSlug) ?? null;
  }, [users, currentUserId, roles, roleSlug]);
  const isSuperAdmin = ownRole?.is_system ?? false;

  // Editable = roles.manage, not a system role, not the caller's own role, and below the caller.
  const canEditRole = useCallback(
    (role: AdminRole) =>
      canManage && !role.is_system && role.id !== ownRole?.id && (grantableRoleIds?.has(role.id) ?? false),
    [canManage, ownRole, grantableRoleIds],
  );
  const [editingRole, setEditingRole] = useState<AdminRole | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<AdminRole | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Count users per role id
  const userCountByRoleId = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const u of users) {
      counts[u.role_id] = (counts[u.role_id] || 0) + 1;
    }
    return counts;
  }, [users]);

  // Group permissions by category
  const groupedPermissions = useMemo(() => {
    const grouped: Record<string, AdminPermission[]> = {};
    for (const p of permissions) {
      if (!grouped[p.category]) grouped[p.category] = [];
      grouped[p.category].push(p);
    }
    return grouped;
  }, [permissions]);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Roles list */}
      <Card padding="none">
        <CardHeader
          action={
            canManage && (
              <button
                onClick={() => { setIsCreating(true); setEditingRole(null); }}
                className="inline-flex items-center gap-2 rounded-md bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors"
              >
                <Plus className="h-4 w-4" />
                New Role
              </button>
            )
          }
        >
          <h2 className="text-lg font-semibold text-gray-900">Roles</h2>
          <p className="text-sm text-gray-500">{roles.length} role{roles.length !== 1 ? 's' : ''} defined</p>
        </CardHeader>

        <div className="divide-y divide-gray-200">
          {roles.map((role) => {
            const userCount = userCountByRoleId[role.id] || 0;
            return (
            <div key={role.id} className="px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {role.is_system ? (
                  <ShieldAlert className="h-5 w-5 text-red-500" />
                ) : (
                  <Shield className="h-5 w-5 text-gray-400" />
                )}
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">{role.name}</span>
                    {role.is_system && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-700">
                        <Lock className="h-2.5 w-2.5" />
                        System
                      </span>
                    )}
                    {onNavigateToUsersWithRole ? (
                      <button
                        type="button"
                        onClick={() => onNavigateToUsersWithRole(role.slug)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-600 hover:bg-primary-100 hover:text-primary-700 transition-colors cursor-pointer"
                        title={`View ${userCount} user${userCount !== 1 ? 's' : ''} with this role`}
                      >
                        <Users className="h-2.5 w-2.5" />
                        {userCount} user{userCount !== 1 ? 's' : ''}
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-600">
                        <Users className="h-2.5 w-2.5" />
                        {userCount} user{userCount !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">{role.description || 'No description'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{role.permission_keys.length} permission{role.permission_keys.length !== 1 ? 's' : ''}</p>
                </div>
              </div>
              {canEditRole(role) && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { setEditingRole(role); setIsCreating(false); }}
                    className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                    title="Edit role"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setDeleteConfirm(role)}
                    className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                    title="Delete role"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
              {canManage && role.is_system && (
                <span className="text-xs text-gray-400">All permissions</span>
              )}
              {(!canManage || (!role.is_system && !canEditRole(role))) && (
                <button
                  onClick={() => { setEditingRole(role); setIsCreating(false); }}
                  className="text-xs text-primary-600 hover:text-primary-800"
                >
                  View permissions
                </button>
              )}
            </div>
          ); })}
        </div>
      </Card>

      {/* Permission matrix (shown when editing/creating) */}
      {(editingRole || isCreating) && (
        <RoleEditor
          role={editingRole}
          isNew={isCreating}
          permissions={permissions}
          groupedPermissions={groupedPermissions}
          canManage={!!editingRole ? canEditRole(editingRole) : canManage}
          heldKeys={heldKeys}
          isSuperAdmin={isSuperAdmin}
          onClose={() => { setEditingRole(null); setIsCreating(false); }}
          onSave={onRefresh}
          onError={setError}
        />
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <DeleteRoleDialog
          role={deleteConfirm}
          onConfirm={() => { setDeleteConfirm(null); onRefresh(); }}
          onCancel={() => setDeleteConfirm(null)}
          onError={setError}
        />
      )}
    </div>
  );
}

/** Role editor with permission matrix */
function RoleEditor({
  role,
  isNew,
  permissions,
  groupedPermissions,
  canManage,
  heldKeys,
  isSuperAdmin,
  onClose,
  onSave,
  onError,
}: {
  role: AdminRole | null;
  isNew: boolean;
  permissions: AdminPermission[];
  groupedPermissions: Record<string, AdminPermission[]>;
  /** May edit THIS role (or create one); false shows it read-only. */
  canManage: boolean;
  heldKeys: Set<string>;
  isSuperAdmin: boolean;
  onClose: () => void;
  onSave: () => void;
  onError: (msg: string) => void;
}) {
  const { refreshPermissions } = usePermissions();
  const [name, setName] = useState(role?.name || '');
  const [description, setDescription] = useState(role?.description || '');
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(
    new Set(role?.permission_keys || [])
  );
  const [saving, setSaving] = useState(false);
  const readOnly = !canManage || (role?.is_system ?? false);

  // While editing, offer only keys the caller holds (Super Admins hold every key).
  const visiblePermissions = useMemo(() => {
    if (readOnly || isSuperAdmin) return groupedPermissions;
    const out: Record<string, AdminPermission[]> = {};
    for (const [cat, perms] of Object.entries(groupedPermissions)) {
      const held = perms.filter((p) => heldKeys.has(p.key));
      if (held.length > 0) out[cat] = held;
    }
    return out;
  }, [readOnly, isSuperAdmin, groupedPermissions, heldKeys]);

  const togglePerm = useCallback((key: string) => {
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((category: string) => {
    const categoryPerms = visiblePermissions[category] || [];
    setSelectedPerms((prev) => {
      const allSelected = categoryPerms.every((p) => prev.has(p.key));
      const next = new Set(prev);
      for (const p of categoryPerms) {
        if (allSelected) next.delete(p.key);
        else next.add(p.key);
      }
      return next;
    });
  }, [visiblePermissions]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      onError('Role name is required');
      return;
    }
    // Refuse before writing anything, so a save never half-applies (BACKLOG-4168).
    if (!isSuperAdmin) {
      const allHeld = Array.from(selectedPerms).every((k) => heldKeys.has(k));
      if (isNew ? !allHeld : !isStrictlyBelow(selectedPerms, heldKeys)) {
        onError(NOT_PERMITTED_MESSAGE);
        return;
      }
    }
    setSaving(true);
    try {
      const supabase = createClient();

      if (isNew) {
        const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const { error } = await supabase.rpc('admin_create_role', {
          p_name: name.trim(),
          p_slug: slug,
          p_description: description.trim() || null,
          p_permission_keys: Array.from(selectedPerms),
        });
        if (error) { onError(describeRoleError(error, 'Failed to create role')); return; }
      } else if (role) {
        // Permissions first: it is the call the ceiling can refuse, so a refusal
        // leaves the role untouched instead of renamed-but-not-updated.
        const before = new Set(role.permission_keys);
        const permsChanged =
          before.size !== selectedPerms.size || Array.from(selectedPerms).some((k) => !before.has(k));
        if (permsChanged) {
          const { error: permErr } = await supabase.rpc('admin_update_role_permissions', {
            p_role_id: role.id,
            p_permission_keys: Array.from(selectedPerms),
          });
          if (permErr) { onError(describeRoleError(permErr, 'Failed to update permissions')); return; }
        }

        const nextDescription = description.trim() || null;
        if (name.trim() !== role.name || nextDescription !== (role.description || null)) {
          const { error: updateErr } = await supabase.rpc('admin_update_role', {
            p_role_id: role.id,
            p_name: name.trim(),
            p_description: nextDescription,
          });
          if (updateErr) { onError(describeRoleError(updateErr, 'Failed to update role')); return; }
        }
      }

      await refreshPermissions();
      onSave();
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save role');
    } finally {
      setSaving(false);
    }
  }, [isNew, role, name, description, selectedPerms, heldKeys, isSuperAdmin, onSave, onClose, onError, refreshPermissions]);

  return (
    <Card padding="none">
      <CardHeader
        action={
          <button onClick={onClose} className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100">
            <X className="h-5 w-5" />
          </button>
        }
      >
        <h3 className="text-lg font-semibold text-gray-900">
          {readOnly ? `${role?.name} — Permissions` : isNew ? 'Create New Role' : `Edit: ${role?.name}`}
        </h3>
      </CardHeader>

      <div className="px-6 py-4 space-y-4">
        {/* Name and description (editable only for non-system roles) */}
        {!readOnly && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Role Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                placeholder="e.g. Compliance Officer"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                placeholder="Brief description of this role"
              />
            </div>
          </div>
        )}

        {/* Permission matrix */}
        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-3">Permissions</h4>
          <div className="space-y-4">
            {PERMISSION_CATEGORIES.map(({ key: catKey, label: catLabel }) => {
              const catPerms = visiblePermissions[catKey];
              if (!catPerms || catPerms.length === 0) return null;
              const allChecked = catPerms.every((p) => selectedPerms.has(p.key));
              const someChecked = catPerms.some((p) => selectedPerms.has(p.key));

              return (
                <div key={catKey} className="border border-gray-200 rounded-lg overflow-hidden">
                  <div
                    className={`px-4 py-2.5 bg-gray-50 flex items-center gap-3 ${!readOnly ? 'cursor-pointer' : ''}`}
                    onClick={!readOnly ? () => toggleCategory(catKey) : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
                      onChange={() => !readOnly && toggleCategory(catKey)}
                      onClick={(e) => e.stopPropagation()}
                      disabled={readOnly}
                      className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                    />
                    <span className="text-sm font-medium text-gray-900">{catLabel}</span>
                    <span className="text-xs text-gray-400 ml-auto">
                      {catPerms.filter((p) => selectedPerms.has(p.key)).length}/{catPerms.length}
                    </span>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {catPerms.map((perm) => (
                      <label
                        key={perm.key}
                        className={`flex items-center gap-3 px-4 py-2 ${!readOnly ? 'hover:bg-gray-50 cursor-pointer' : ''}`}
                      >
                        <Checkbox
                          checked={selectedPerms.has(perm.key)}
                          onChange={() => !readOnly && togglePerm(perm.key)}
                          disabled={readOnly}
                        />
                        <div>
                          <span className="text-sm text-gray-900">{perm.label}</span>
                          {perm.description && (
                            <span className="ml-2 text-xs text-gray-400">{perm.description}</span>
                          )}
                        </div>
                        {selectedPerms.has(perm.key) && (
                          <Check className="h-4 w-4 text-green-500 ml-auto" />
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Actions */}
      {!readOnly && (
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : isNew ? 'Create Role' : 'Save Changes'}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Delete role confirmation dialog */
function DeleteRoleDialog({
  role,
  onConfirm,
  onCancel,
  onError,
}: {
  role: AdminRole;
  onConfirm: () => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}) {
  const { refreshPermissions } = usePermissions();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc('admin_delete_role', {
        p_role_id: role.id,
      });
      if (error) {
        onError(describeRoleError(error, 'Failed to delete role'));
        onCancel();
        return;
      }
      await refreshPermissions();
      onConfirm();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to delete role');
      setDeleting(false);
    }
  }, [role.id, onConfirm, onCancel, onError, refreshPermissions]);

  return (
    <ConfirmationDialog
      open
      title="Delete Role"
      description={`Are you sure you want to delete ${role.name}? This action cannot be undone. The role must have no users assigned to it.`}
      confirmLabel={deleting ? 'Deleting...' : 'Delete Role'}
      cancelLabel="Cancel"
      onConfirm={handleDelete}
      onCancel={onCancel}
      isDestructive
      loading={deleting}
    />
  );
}
