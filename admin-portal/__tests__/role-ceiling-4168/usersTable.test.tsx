// @vitest-environment jsdom
/**
 * BACKLOG-4168 — the internal users table offers only roles can_grant_role allows, acts only on
 * users whose current role is grantable, never on the caller's own row, and surfaces the 42501
 * refusal with the shared message. Also covers fetchGrantableRoleIds (one RPC per role).
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({
  rpcs: [] as Array<{ fn: string; args: unknown }>,
  rpcResult: { data: null as unknown, error: null as unknown },
  deleteRows: [{ id: 'inv-low' }] as unknown[],
}));

vi.mock('@/components/providers/PermissionsProvider', () => ({
  usePermissions: () => ({ hasPermission: () => true }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    rpc: async (fn: string, args: unknown) => {
      s.rpcs.push({ fn, args });
      return s.rpcResult;
    },
    from: () => {
      const b: Record<string, unknown> = {};
      b.delete = () => b;
      b.eq = () => b;
      b.select = async () => ({ data: s.deleteRows, error: null });
      return b;
    },
  }),
}));

import { InternalUsersTable } from '@/app/dashboard/settings/components/InternalUsersTable';
import { fetchGrantableRoleIds, isStrictlyBelow } from '@/lib/internal-roles';
import type { AdminRole, InternalUser, PendingInvitation } from '@/app/dashboard/settings/page';

const role = (id: string, name: string, is_system = false): AdminRole => ({
  id, name, slug: id, description: null, is_system, created_at: '2026-01-01T00:00:00Z', permission_keys: [],
});
const ROLES = [role('role-top', 'Top Role', true), role('role-mid', 'Mid Role'), role('role-low', 'Low Role')];
const user = (id: string, roleId: string): InternalUser => ({
  id: `ir-${id}`, user_id: id, role_id: roleId, role_name: ROLES.find((r) => r.id === roleId)!.name,
  role_slug: roleId, created_at: '2026-01-01T00:00:00Z', created_by: null, email: `${id}@example.test`,
  display_name: `Name ${id}`, avatar_url: null, created_by_email: null,
} as InternalUser);
const USERS = [user('me', 'role-mid'), user('peer', 'role-mid'), user('below', 'role-low'), user('boss', 'role-top')];
const invite = (id: string, roleId: string): PendingInvitation => ({
  id, email: `${id}@example.test`, role_id: roleId, role_name: roleId, role_slug: roleId, created_at: '2026-01-01T00:00:00Z',
});

function renderTable(grantable: Set<string> | null = new Set(['role-low'])) {
  return render(
    <InternalUsersTable
      users={USERS}
      currentUserId="me"
      onRemoveClick={vi.fn()}
      onBulkRemoveClick={vi.fn()}
      roles={ROLES}
      grantableRoleIds={grantable}
      onRoleChange={vi.fn()}
      pendingInvitations={[invite('inv-low', 'role-low'), invite('inv-top', 'role-top')]}
    />,
  );
}

const row = (text: string) => screen.getByText(text).closest('tr') as HTMLElement;

beforeEach(() => {
  s.rpcs = [];
  s.rpcResult = { data: null, error: null };
  s.deleteRows = [{ id: 'inv-low' }];
});
afterEach(cleanup);

describe('role select follows can_grant_role', () => {
  it('only a user whose current role is grantable gets a select, listing only grantable roles', () => {
    renderTable(new Set(['role-low', 'role-mid-sub']));
    const selects = screen.getAllByRole('combobox');
    expect(selects).toHaveLength(1);
    const options = within(selects[0]).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Low Role']);
    expect(within(row('Name below')).getByRole('combobox')).toBeTruthy();
  });

  it('with Mid and Low grantable, the select offers exactly those two', () => {
    renderTable(new Set(['role-low', 'role-mid']));
    const sel = within(row('Name below')).getByRole('combobox');
    expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['Mid Role', 'Low Role']);
  });

  it('nothing is offered while grantability is loading', () => {
    renderTable(null);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByText('Remove')).toHaveLength(0);
  });
});

describe('self and above-caller rows', () => {
  it('own row has no select, no Remove and no checkbox even when its role is grantable', () => {
    renderTable(new Set(['role-low', 'role-mid', 'role-top']));
    const mine = row('Name me');
    expect(within(mine).queryByRole('combobox')).toBeNull();
    expect(within(mine).queryByText('Remove')).toBeNull();
    expect(within(mine).queryByRole('checkbox')).toBeNull();
  });

  it('rows whose role is not grantable have no Remove', () => {
    renderTable(new Set(['role-low']));
    expect(within(row('Name boss')).queryByText('Remove')).toBeNull();
    expect(within(row('Name peer')).queryByText('Remove')).toBeNull();
    expect(within(row('Name below')).getByText('Remove')).toBeTruthy();
  });

  it('Resend shows only on invitations whose role is grantable', () => {
    renderTable(new Set(['role-low']));
    expect(within(row('inv-low@example.test')).queryByText('Resend')).not.toBeNull();
    expect(within(row('inv-top@example.test')).queryByText('Resend')).toBeNull();
  });

  it('Cancel shows only on invitations whose role is grantable', () => {
    renderTable(new Set(['role-low']));
    expect(within(row('inv-low@example.test')).queryByText('Cancel')).not.toBeNull();
    expect(within(row('inv-top@example.test')).queryByText('Cancel')).toBeNull();
  });
});

describe('refusals', () => {
  it('a 42501 on role change shows the shared message', async () => {
    s.rpcResult = { data: null, error: { code: '42501', message: 'Not permitted' } };
    renderTable(new Set(['role-low', 'role-mid']));
    fireEvent.change(within(row('Name below')).getByRole('combobox'), { target: { value: 'role-mid' } });
    await waitFor(() => expect(screen.getByText(/You can only manage users and roles below your own/)).toBeTruthy());
    expect(s.rpcs[0]).toEqual({ fn: 'admin_update_internal_user_role', args: { p_user_id: 'below', p_role_slug: 'role-mid' } });
  });

  it('a cancel that removes zero rows reports Not permitted instead of succeeding silently', async () => {
    s.deleteRows = [];
    renderTable(new Set(['role-low']));
    fireEvent.click(within(row('inv-low@example.test')).getByText('Cancel'));
    await waitFor(() => expect(screen.getByText(/Failed to cancel invitation: Not permitted/)).toBeTruthy());
  });
});

describe('helpers', () => {
  it('fetchGrantableRoleIds asks once per role and keeps only true answers', async () => {
    const answers: Record<string, unknown> = { a: true, b: false, c: null };
    const asked: unknown[] = [];
    const client = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        asked.push([fn, args]);
        return args.p_role_id === 'c'
          ? { data: null, error: { code: '42501', message: 'Not permitted' } }
          : { data: answers[args.p_role_id as string], error: null };
      },
    };
    const set = await fetchGrantableRoleIds(client, ['a', 'b', 'c']);
    expect([...set]).toEqual(['a']);
    expect(asked).toEqual([
      ['can_grant_role', { p_role_id: 'a' }],
      ['can_grant_role', { p_role_id: 'b' }],
      ['can_grant_role', { p_role_id: 'c' }],
    ]);
  });

  it('isStrictlyBelow: subset with one key left out only', () => {
    const held = new Set(['x', 'y']);
    expect(isStrictlyBelow(['x'], held)).toBe(true);
    expect(isStrictlyBelow([], held)).toBe(true);
    expect(isStrictlyBelow(['x', 'y'], held)).toBe(false);
    expect(isStrictlyBelow(['x', 'z'], held)).toBe(false);
  });
});
