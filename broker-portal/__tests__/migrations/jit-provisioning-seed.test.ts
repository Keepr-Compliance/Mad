/**
 * The migration's default_value is load-bearing — BACKLOG-3094.
 *
 * The same trap BACKLOG-3087's seed test documents, one card up:
 *
 *   broker_get_org_features looks up organization_plans first. For an org with
 *   NO plan row it never reads plan_features — it falls straight through to
 *   feature_definitions.default_value for every key. A newly onboarded
 *   brokerage is exactly that case.
 *
 *   So a migration that seeded only plan_features, or that set default_value to
 *   'true' "because JIT is a real feature", would leave the Just-in-Time toggle
 *   VISIBLE and writable for precisely the orgs most likely to flip it — and
 *   every unit test in this PR would still pass, because they stub the RPC.
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 * WHAT IT CANNOT: that the migration has been applied. It has not been, on
 * purpose — deploying it is the founder's call.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION = join(
  __dirname,
  '../../../supabase/migrations/20260904_backlog_3094_jit_provisioning_feature.sql'
);

describe('20260904_backlog_3094_jit_provisioning_feature.sql', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('seeds the key the gate checks', () => {
    // lib/jit-access.ts JIT_FEATURE_KEY
    expect(sql).toContain("'jit_provisioning'");
    expect(sql).toMatch(/INSERT INTO public\.feature_definitions/);
  });

  it("sets default_value to 'false' — the plan-less-org path reads ONLY this", () => {
    const values = sql
      .split('INSERT INTO public.feature_definitions')[1]
      .split('ON CONFLICT')[0];
    // Column list order is (key, name, description, category, value_type,
    // default_value, min_tier, sort_order); assert the value, not the position.
    expect(values).toMatch(/'boolean',\s*\n?\s*'false'/);
    expect(values).not.toMatch(/'boolean',\s*\n?\s*'true'/);
  });

  it('disables the feature on every plan, with no tier carve-out', () => {
    const planFeatures = sql.split('INSERT INTO public.plan_features')[1];
    expect(planFeatures).toMatch(/SELECT p\.id, fd\.id, false, 'false'/);
    // A CASE here would switch JIT on for some tier at migration time, while
    // jit_join_organization still cannot be called at all.
    expect(planFeatures).not.toMatch(/\bCASE\b/i);
  });

  it('is re-runnable', () => {
    expect(sql.match(/ON CONFLICT[^;]*DO NOTHING/gi) ?? []).toHaveLength(2);
  });

  it('does not touch organizations.jit_provisioning_enabled', () => {
    // Hiding the control must not change any org's stored value — the column
    // matters again the moment BACKLOG-1954 lands.
    expect(sql).not.toMatch(/UPDATE\s+public\.organizations/i);
    expect(sql).not.toMatch(/SET\s+jit_provisioning_enabled/i);
  });
});
