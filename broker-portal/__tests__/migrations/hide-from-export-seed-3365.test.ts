/**
 * The migration's seed values are load-bearing — BACKLOG-3365.
 *
 * `get_org_features` looks up organization_plans first. For an org with NO plan
 * row it never reads plan_features — it falls straight through to
 * feature_definitions.default_value for every key. So a migration that seeded
 * only plan_features, or that set default_value to 'true' "because hiding is a
 * real feature", would hand the Hide control to precisely the customers most
 * likely to be on no plan at all, and every unit test in this PR would still
 * pass, because they drive the RPC from a fixture.
 *
 * min_tier matters just as much in the other direction. The founder's ruling
 * (epic BACKLOG-3227) is that EVERY plan may carry this feature — it is a
 * switch he turns on per customer, not a tier privilege. A min_tier here, or a
 * CASE in the plan_features seed, would decide that for him at migration time.
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 * WHAT IT CANNOT: that the migration has been applied. It has not been, on
 * purpose — deploying it is the founder's call, with the BACKLOG-3366 release.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION = join(
  __dirname,
  '../../../supabase/migrations/20260916190000_backlog_3365_hide_from_export_feature.sql'
);

describe('20260916190000_backlog_3365_hide_from_export_feature.sql', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('seeds the key the gate checks', () => {
    // electron/handlers/featureGateHandlers.ts HIDE_FROM_EXPORT_FEATURE_KEY,
    // and the literal in src/hooks/useHideFromExportState.ts.
    expect(sql).toContain("'desktop_hide_from_export'");
    expect(sql).toMatch(/INSERT INTO public\.feature_definitions/);
  });

  it("sets default_value to 'false' — the plan-less-org path reads ONLY this", () => {
    const values = sql
      .split('INSERT INTO public.feature_definitions')[1]
      .split('ON CONFLICT')[0];
    // Column list order is (key, name, description, category, value_type,
    // default_value, min_tier, sort_order, is_built); assert the value, not the
    // position.
    expect(values).toMatch(/'boolean',\s*\n?\s*'false'/);
    expect(values).not.toMatch(/'boolean',\s*\n?\s*'true'/);
  });

  it('leaves min_tier NULL — every plan may carry this feature', () => {
    const values = sql
      .split('INSERT INTO public.feature_definitions')[1]
      .split('ON CONFLICT')[0];
    expect(values).toMatch(/'false',\s*\n?\s*NULL/);
    for (const tier of ['team', 'enterprise', 'pro']) {
      expect(values).not.toContain(`'${tier}'`);
    }
  });

  it('files the switch beside the other export features', () => {
    // category 'export' at sort_order 46 puts it directly under
    // desktop_email_attachments (45) in the admin plan editor, rather than at
    // the bottom of a list of unrelated keys.
    const values = sql
      .split('INSERT INTO public.feature_definitions')[1]
      .split('ON CONFLICT')[0];
    expect(values).toContain("'export'");
    expect(values).toMatch(/\b46\b/);
  });

  it('ships not-built, so the admin editor does not offer it before the app has it', () => {
    const values = sql
      .split('INSERT INTO public.feature_definitions')[1]
      .split('ON CONFLICT')[0];
    expect(values).toMatch(/\bfalse\s*\n?\s*\)/);
  });

  it('disables the feature on every plan, with no tier carve-out', () => {
    const planFeatures = sql.split('INSERT INTO public.plan_features')[1];
    expect(planFeatures).toMatch(/SELECT p\.id, fd\.id, false, 'false'/);
    // A CASE here would switch hiding on for some tier at migration time, and
    // the founder has said every plan may carry it — his switch, not the
    // migration's.
    expect(planFeatures).not.toMatch(/\bCASE\b/i);
  });

  it('is re-runnable', () => {
    expect(sql.match(/ON CONFLICT[^;]*DO NOTHING/gi) ?? []).toHaveLength(2);
  });

  it('touches nothing but the two seed tables', () => {
    // Hiding is a per-user act recorded in the desktop database. Nothing in
    // this migration may reach an organization's stored state.
    expect(sql).not.toMatch(/\bUPDATE\s+public\./i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sql.match(/INSERT INTO public\.(\w+)/g) ?? []).toEqual([
      'INSERT INTO public.feature_definitions',
      'INSERT INTO public.plan_features',
    ]);
  });
});
