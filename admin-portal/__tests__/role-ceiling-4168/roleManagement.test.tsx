// @vitest-environment jsdom
/**
 * BACKLOG-4168 — role editor: own role read-only, only roles below the caller editable, the editor
 * offers only keys the caller holds (Super Admin sees all), and a save never half-applies:
 * permissions are written before the rename, and a refused permissions call stops the save.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({
  rpcs: [] as Array<{ fn: string; args: unknown }>,
  results: {} as Record<string, { data: unknown; error: unknown }>,
  held: new Set<string>(),
  roleSlug: 'role-mid' as string | null,
}));

vi.mock('@/components/providers/PermissionsProvider', () => ({
  usePermissions: () => ({
    hasPermission: (k: string) => k === 'roles.manage' || s.held.has(k),
    permissions: s.held,
    roleSlug: s.roleSlug,
    refreshPermissions: async () => undefined,
  }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    rpc: async (fn: string, args: unknown) => {
      s.rpcs.push({ fn, args });
      return s.results[fn] ?? { data: { success: true }, error: null };
    },
  }),
}));

import { RoleManagement } from '@/app/dashboard/settings/components/RoleManagement';
import type { AdminPermission, AdminRole, InternalUser } from '@/app/dashboard/settings/page';

const perm = (key: string, category: string): AdminPermission => ({ id: key, key, label: `Label ${key}`, description: null, category });
const PERMS = [perm('dashboard.view', 'dashboard'), perm('users.view', 'users'), perm('roles.manage', 'settings'), perm('audit.view', 'audit')];
const role = (id: string, name: string, keys: string[], is_system = false): AdminRole => ({
  id, name, slug: id, description: null, is_system, created_at: '2026-01-01T00:00:00Z', permission_keys: keys,
});
const ROLES = [
  role('role-top', 'Top Role', PERMS.map((p) => p.key), true),
  role('role-mid', 'Mid Role', ['dashboard.view', 'users.view', 'roles.manage']),
  role('role-low', 'Low Role', ['dashboard.view']),
];
const ME = { id: 'ir-me', user_id: 'me', role_id: 'role-mid' } as InternalUser;

function renderRoles(grantable = new Set(['role-low'])) {
  return render(
    <RoleManagement roles={ROLES} permissions={PERMS} onRefresh={vi.fn()} users={[ME]} currentUserId="me" grantableRoleIds={grantable} />,
  );
}

const roleRow = (name: string) => screen.getByText(name).closest('div.px-6') as HTMLElement;

beforeEach(() => {
  s.rpcs = [];
  s.results = {};
  s.held = new Set(['dashboard.view', 'users.view', 'roles.manage']);
  s.roleSlug = 'role-mid';
});
afterEach(cleanup);

describe('which roles are editable', () => {
  it('own role is read-only even when the database would call it grantable', () => {
    renderRoles(new Set(['role-low', 'role-mid']));
    expect(within(roleRow('Mid Role')).queryByTitle('Edit role')).toBeNull();
    expect(within(roleRow('Mid Role')).queryByTitle('Delete role')).toBeNull();
    expect(within(roleRow('Mid Role')).getByText('View permissions')).toBeTruthy();
  });

  it('a role below the caller has Edit and Delete', () => {
    renderRoles();
    expect(within(roleRow('Low Role')).getByTitle('Edit role')).toBeTruthy();
    expect(within(roleRow('Low Role')).getByTitle('Delete role')).toBeTruthy();
  });

  it('a role not grantable is view-only', () => {
    renderRoles(new Set());
    expect(within(roleRow('Low Role')).queryByTitle('Edit role')).toBeNull();
  });
});

describe('keys offered in the editor', () => {
  it('a non-Super-Admin editing sees only keys they hold', () => {
    renderRoles();
    fireEvent.click(within(roleRow('Low Role')).getByTitle('Edit role'));
    expect(screen.getByText('Label dashboard.view')).toBeTruthy();
    expect(screen.queryByText('Label audit.view')).toBeNull();
  });

  it('a Super Admin sees every key', () => {
    s.roleSlug = 'role-top';
    render(
      <RoleManagement roles={ROLES} permissions={PERMS} onRefresh={vi.fn()}
        users={[{ ...ME, role_id: 'role-top' }]} currentUserId="me" grantableRoleIds={new Set(['role-low', 'role-mid'])} />,
    );
    fireEvent.click(within(roleRow('Low Role')).getByTitle('Edit role'));
    expect(screen.getByText('Label audit.view')).toBeTruthy();
  });

  it('read-only viewing still shows the role as it is', () => {
    renderRoles(new Set());
    fireEvent.click(within(roleRow('Low Role')).getByText('View permissions'));
    expect(screen.getByText('Label audit.view')).toBeTruthy();
  });
});

describe('save never half-applies', () => {
  function openLowAndRename() {
    renderRoles();
    fireEvent.click(within(roleRow('Low Role')).getByTitle('Edit role'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Compliance Officer'), { target: { value: 'Low Renamed' } });
  }

  it('permissions are written before the rename', async () => {
    openLowAndRename();
    fireEvent.click(screen.getByText('Label users.view'));
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(s.rpcs.length).toBe(2));
    expect(s.rpcs.map((r) => r.fn)).toEqual(['admin_update_role_permissions', 'admin_update_role']);
  });

  it('a refused permissions save leaves the name alone and shows the shared message', async () => {
    s.results.admin_update_role_permissions = { data: null, error: { code: '42501', message: 'Not permitted' } };
    openLowAndRename();
    fireEvent.click(screen.getByText('Label users.view'));
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(screen.getByText(/You can only manage users and roles below your own/)).toBeTruthy());
    expect(s.rpcs.map((r) => r.fn)).toEqual(['admin_update_role_permissions']);
  });

  it('a key set not strictly below the caller is refused before any call', async () => {
    openLowAndRename();
    fireEvent.click(screen.getByText('Label users.view'));
    fireEvent.click(screen.getByText('Label roles.manage'));
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(screen.getByText(/You can only manage users and roles below your own/)).toBeTruthy());
    expect(s.rpcs).toEqual([]);
  });

  it('a rename alone makes no permissions call', async () => {
    openLowAndRename();
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(s.rpcs.length).toBe(1));
    expect(s.rpcs[0].fn).toBe('admin_update_role');
  });
});
