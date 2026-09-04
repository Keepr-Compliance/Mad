/**
 * The migration's default_value is load-bearing — BACKLOG-3087.
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 * WHAT IT CANNOT: that the migration has been applied. It has not been, on
 * purpose — deploying it is the founder's call.
 *
 * Why guard a single column value with a test at all:
 *
 *   broker_get_org_features looks up organization_plans first. For an org with
 *   NO plan row it never reads plan_features — it falls straight through to
 *   feature_definitions.default_value for every key. The brokerage this item
 *   was filed for is exactly that case (verified 2026-09-03): no plan row, all
 *   21 features resolving with source 'default'.
 *
 *   So a migration that seeded only plan_features, or that set default_value
 *   to 'true' "because enterprise gets SCIM", would leave the SCIM surface
 *   VISIBLE for precisely the brokerage that prompted the item — and every
 *   unit test in this PR would still pass, because they mock the RPC.
 *
 * This is the one place that connection is written down where an editor of the
 * migration will see it.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION = join(
  __dirname,
  '../../../supabase/migrations/20260903_backlog_3087_scim_provisioning_feature.sql'
);

describe('20260903_backlog_3087_scim_provisioning_feature.sql', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('seeds the key the gate checks', () => {
    // lib/scim-access.ts SCIM_FEATURE_KEY
    expect(sql).toContain("'scim_provisioning'");
    expect(sql).toMatch(/INSERT INTO public\.feature_definitions/);
  });

  it("sets default_value to 'false' — the plan-less-org path reads ONLY this", () => {
    const values = sql
      .split('INSERT INTO public.feature_definitions')[1]
      .split('ON CONFLICT')[0];
    // The column list order is (key, name, description, category, value_type,
    // default_value, min_tier, sort_order); assert the value, not the position.
    expect(values).toMatch(/'boolean',\s*\n?\s*'false'/);
    expect(values).not.toMatch(/'boolean',\s*\n?\s*'true'/);
  });

  it('disables the feature on every plan, with no tier carve-out', () => {
    const planFeatures = sql.split('INSERT INTO public.plan_features')[1];
    expect(planFeatures).toMatch(/SELECT p\.id, fd\.id, false, 'false'/);
    // A CASE here would mean some tier gets SCIM switched on at migration time,
    // before the edge function exists.
    expect(planFeatures).not.toMatch(/\bCASE\b/i);
  });

  it('is re-runnable', () => {
    expect(sql.match(/ON CONFLICT[^;]*DO NOTHING/gi) ?? []).toHaveLength(2);
  });
});
