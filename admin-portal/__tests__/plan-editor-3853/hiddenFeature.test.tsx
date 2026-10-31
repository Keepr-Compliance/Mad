/**
 * BACKLOG-3853 — the plan editor must not offer the per-organization `account_suspended`
 * signal as a toggle. Drives the real plan detail page with a fake Supabase client and
 * reads the props handed to the editor component.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const captured: { features?: Array<{ feature_definitions: { key: string } }>; allFeatures?: Array<{ key: string }> } = {};

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@keepr/design-system', () => ({ Card: () => null }));
vi.mock('@/app/dashboard/plans/components/FeatureToggleList', () => ({
  FeatureToggleList: () => null,
}));
vi.mock('@/app/dashboard/plans/components/DeletePlanButton', () => ({ DeletePlanButton: () => null }));
vi.mock('@/app/dashboard/plans/components/PlanStatusToggle', () => ({ PlanStatusToggle: () => null }));
vi.mock('@/app/dashboard/plans/components/PlanTierEditor', () => ({ PlanTierEditor: () => null }));

const DEFS = ['unlimited_transactions', 'broker_submission', 'account_suspended'].map((key, i) => ({
  id: `fd-${i}`, key, name: key, description: null, category: 'general', value_type: 'boolean',
  default_value: 'false', min_tier: null, created_at: '2026-01-01',
}));
const PLAN_FEATURES = DEFS.map((fd, i) => ({ id: `pf-${i}`, plan_id: 'p1', feature_id: fd.id, enabled: false, value: null, feature_definitions: fd }));

function table(name: string) {
  const rows: Record<string, unknown> = {
    plans: { id: 'p1', name: 'Team', tier: 'team', is_active: true, description: null, created_at: '2026-01-01', updated_at: '2026-01-01' },
    plan_features: PLAN_FEATURES,
    feature_definitions: DEFS,
    feature_dependencies: [],
    organization_plans: [],
    internal_roles: { role_id: 'r1' },
  };
  const result = { data: rows[name] ?? null, error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'single']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'u1' },
    supabase: { from: (n: string) => table(n), rpc: async () => ({ data: true }) },
  }),
}));

function walk(node: ReactNode, visit: (el: { type: unknown; props: Record<string, unknown> }) => void) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return; }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.props) {
    visit({ type: el.type, props: el.props });
    walk(el.props.children as ReactNode, visit);
  }
}

describe('plan editor hides account_suspended (BACKLOG-3853)', () => {
  it('does not hand the key to the editor, in definitions or in plan rows', async () => {
    const { default: Page } = await import('@/app/dashboard/plans/[id]/page');
    const tree = await Page({ params: Promise.resolve({ id: 'p1' }) });
    walk(tree as ReactNode, (el) => {
      if (el.props.allFeatures) {
        captured.allFeatures = el.props.allFeatures as typeof captured.allFeatures;
        captured.features = el.props.features as typeof captured.features;
      }
    });
    expect(captured.allFeatures, 'editor element found').toBeDefined();
    expect(captured.allFeatures!.map((f) => f.key)).toEqual(['unlimited_transactions', 'broker_submission']);
    expect(captured.features!.map((f) => f.feature_definitions.key)).toEqual(['unlimited_transactions', 'broker_submission']);
  });
});
