/**
 * The My Transactions feature seed — BACKLOG-3080 (R8).
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 * WHAT IT CANNOT: that it has been applied. It has not been, on purpose: the
 * apply needs the founder's yes and comes after the portal deploy that carries
 * the pages. Until then the key is absent and the portal reads it fail-closed.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DIR = join(__dirname, '../../../supabase/migrations');
const FILE = readdirSync(DIR).filter((f) => f.endsWith('_backlog_3080_my_transactions_feature.sql'));

/** Production's latest applied version (supabase_migrations.schema_migrations, read 2026-09-25). */
const PRODUCTION_MAX_VERSION = '20260925053321';

describe('backlog_3080_my_transactions_feature.sql', () => {
  it('exists exactly once, stamped after production\'s latest version', () => {
    expect(FILE).toHaveLength(1);
    expect(FILE[0].slice(0, 14) > PRODUCTION_MAX_VERSION).toBe(true);
  });

  const sql = FILE.length === 1 ? readFileSync(join(DIR, FILE[0]), 'utf8') : '';
  const definition = () => sql.split('INSERT INTO public.feature_definitions')[1].split('ON CONFLICT')[0];

  it('says in its header that it is not applied and needs the founder\'s yes after the deploy', () => {
    const header = sql.split('INSERT INTO')[0];
    expect(header).toMatch(/NOT APPLIED/);
    expect(header).toMatch(/founder's yes is required/i);
    expect(header).toMatch(/AFTER the portal deploy/);
  });

  it('seeds the key the gate checks, in the access category', () => {
    // lib/my-transactions-access.ts MY_TRANSACTIONS_FEATURE_KEY
    expect(definition()).toContain("'portal_my_transactions'");
    expect(definition()).toContain("'access'");
    expect(definition()).toContain("'My Transactions'");
  });

  it("default_value 'false' then min_tier NULL, with no tier named", () => {
    expect(definition()).toMatch(/'boolean',\s*\n?\s*'false',\s*\n?\s*NULL/);
    expect(definition()).not.toMatch(/'boolean',\s*\n?\s*'true'/);
    for (const tier of ['individual', 'team', 'enterprise', 'pro']) expect(definition()).not.toContain(`'${tier}'`);
  });

  it('is_built true (D2): the page ships in the same PR', () => {
    expect(definition()).toMatch(/\btrue\s*\n?\s*\)/);
  });

  it('disables the feature on every plan, with no carve-out', () => {
    const planFeatures = sql.split('INSERT INTO public.plan_features')[1];
    expect(planFeatures).toMatch(/SELECT p\.id, fd\.id, false, 'false'/);
    expect(planFeatures).toContain("fd.key = 'portal_my_transactions'");
    expect(planFeatures).not.toMatch(/\bCASE\b/i);
  });

  it('is re-runnable and touches only the two seed tables', () => {
    expect(sql.match(/ON CONFLICT[^;]*DO NOTHING/gi) ?? []).toHaveLength(2);
    expect(sql).not.toMatch(/\bUPDATE\s+public\./i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\b(ALTER|CREATE|DROP)\s+(TABLE|POLICY|FUNCTION)\b/i);
    expect(sql.match(/INSERT INTO public\.(\w+)/g) ?? []).toEqual([
      'INSERT INTO public.feature_definitions',
      'INSERT INTO public.plan_features',
    ]);
  });
});
