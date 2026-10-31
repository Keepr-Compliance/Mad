/**
 * BACKLOG-4098 PR1: the Organizations page maps is_personal / is_test from admin_list_organizations.
 *  - A reply WITHOUT the flag keys (the function before 20261031160000 is applied) reaches the table
 *    as null, never false. false would read as "brokerage, not test" for every organization.
 *  - A reply WITH the flags passes the booleans through unchanged.
 *  - A non-boolean value is not coerced.
 *  - The page can be called with no argument.
 * Drives the real server page with a fake Supabase client (same harness as
 * onboarding-4007/billingDarkPages.test.tsx) and reads the props handed to OrganizationsTable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('@keepr/design-system', () => ({ PageHeader: () => null }));
function OrganizationsTableStub() { return null; }
vi.mock('@/app/dashboard/organizations/components/OrganizationsTable', () => ({ OrganizationsTable: OrganizationsTableStub }));

const BASE_ROW = {
  id: 'org-1', name: 'Alpha', slug: 'alpha', max_seats: 5, created_at: '2026-01-01T00:00:00Z',
  plan_name: 'Team', plan_tier: 'team', member_count: 1,
};

const state: { rows: Array<Record<string, unknown>>; listCalls: number } = { rows: [], listCalls: 0 };

function table() {
  const result = { data: { role_id: 'r1' }, error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'single']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'u1' },
    supabase: {
      from: () => table(),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'has_permission') return { data: args.required_permission === 'organizations.view', error: null };
        if (fn === 'admin_list_organizations') {
          state.listCalls += 1;
          return { data: { success: true, organizations: state.rows }, error: null };
        }
        return { data: null, error: null };
      },
    },
  }),
}));

function findProps(node: ReactNode, type: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const p = findProps(n, type); if (p) return p; }
    return null;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type) return el.props ?? {};
  return el.props ? findProps(el.props.children as ReactNode, type) : null;
}

async function tableRows(): Promise<Array<Record<string, unknown>>> {
  const { default: Page } = await import('@/app/dashboard/organizations/page');
  const tree = (await Page()) as ReactNode;
  const props = findProps(tree, OrganizationsTableStub);
  expect(props, 'OrganizationsTable is rendered').not.toBeNull();
  expect(state.listCalls, 'the list RPC was called (non-vacuous)').toBeGreaterThan(0);
  return props!.organizations as Array<Record<string, unknown>>;
}

describe('organizations page: is_personal / is_test mapping', () => {
  beforeEach(() => {
    state.rows = [];
    state.listCalls = 0;
  });

  it('reply without the flag keys -> null, not false', async () => {
    state.rows = [{ ...BASE_ROW }, { ...BASE_ROW, id: 'org-2', name: 'Beta', slug: 'beta' }];
    const rows = await tableRows();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.is_personal).toBeNull();
      expect(r.is_test).toBeNull();
    }
  });

  it('reply with the flags -> booleans pass through', async () => {
    state.rows = [
      { ...BASE_ROW, is_personal: false, is_test: false },
      { ...BASE_ROW, id: 'org-2', name: 'Beta', slug: 'beta', is_personal: true, is_test: false },
      { ...BASE_ROW, id: 'org-3', name: 'Gamma', slug: 'gamma', is_personal: false, is_test: true },
    ];
    const rows = await tableRows();
    expect(rows.map((r) => [r.id, r.is_personal, r.is_test])).toEqual([
      ['org-1', false, false],
      ['org-2', true, false],
      ['org-3', false, true],
    ]);
  });

  it('non-boolean flag values are not coerced', async () => {
    state.rows = [{ ...BASE_ROW, is_personal: 'true', is_test: 1 }];
    const [r] = await tableRows();
    expect(r.is_personal).toBeNull();
    expect(r.is_test).toBeNull();
  });

  it('the other keys are unchanged', async () => {
    state.rows = [{ ...BASE_ROW, is_personal: true, is_test: false }];
    const [r] = await tableRows();
    expect(r).toEqual({
      id: 'org-1', name: 'Alpha', slug: 'alpha', plan_name: 'Team', plan_tier: 'team',
      created_at: '2026-01-01T00:00:00Z', member_count: 1, is_personal: true, is_test: false,
    });
  });
});
