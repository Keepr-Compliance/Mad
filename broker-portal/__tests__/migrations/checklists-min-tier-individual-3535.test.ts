/**
 * BACKLOG-3535 — the migration's one statement is load-bearing.
 *
 * The founder's ruling (pm_comments d2b7e372 on BACKLOG-2237) is that step
 * one is ONLY to let the Individual plan hold the transaction_checklists
 * feature — not to turn it on for anyone. admin_update_plan_feature refuses
 * to enable a feature for a plan whose tier_rank sits below the feature's
 * min_tier, so lowering min_tier to 'individual' is what unblocks the admin
 * plan editor's Individual switch. Enabling it is a separate, later act.
 *
 * A migration that also flipped plan_features.enabled for Individual, or
 * that touched any other key, would hand the feature to solo customers with
 * no way yet to build a template for it (BACKLOG-3535 items 2-5 are not
 * built). That is exactly the mistake this test guards against.
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 * WHAT IT CANNOT: that the migration has been applied. It has not been, on
 * purpose — the PM brief is explicit that this PR does not apply it.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION = join(
  __dirname,
  '../../../supabase/migrations/20260924183422_backlog_3535_checklists_min_tier_individual.sql'
);

/** Drop full-line `--` comments so header prose (which names plan_features
 * in explaining what this migration deliberately does NOT do) cannot be
 * mistaken for code. Every line in this file is either a whole-line comment
 * or blank/code — no trailing `--` or block comments are used here. */
const codeOnly = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');

describe('20260924183422_backlog_3535_checklists_min_tier_individual.sql', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const code = codeOnly(sql);

  it('contains exactly one UPDATE, on feature_definitions', () => {
    const updates = sql.match(/\bUPDATE\s+public\.\w+/gi) ?? [];
    expect(updates).toEqual(['UPDATE public.feature_definitions']);
  });

  it('sets min_tier to individual', () => {
    const stmt = sql.slice(sql.indexOf('UPDATE public.feature_definitions'));
    expect(stmt).toMatch(/SET\s+min_tier\s*=\s*'individual'/i);
  });

  it('is scoped to the transaction_checklists key', () => {
    const stmt = sql.slice(sql.indexOf('UPDATE public.feature_definitions'));
    const whereClause = stmt.slice(stmt.search(/\bWHERE\b/i));
    expect(whereClause).toMatch(/key\s*=\s*'transaction_checklists'/);
  });

  it('only matches the row while it still reads team — re-runnable, and never widens scope', () => {
    const stmt = sql.slice(sql.indexOf('UPDATE public.feature_definitions'));
    const whereClause = stmt.slice(stmt.search(/\bWHERE\b/i));
    expect(whereClause).toMatch(/min_tier\s*=\s*'team'/);
  });

  it('does NOT touch plan_features — enabling the feature is a separate, later act', () => {
    expect(code).not.toMatch(/\bplan_features\b/i);
  });

  it('touches no other table or row', () => {
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(code.match(/\bUPDATE\s+public\.\w+/gi) ?? []).toHaveLength(1);
  });

  it('carries no BEGIN/COMMIT/ROLLBACK — the caller supplies the transaction', () => {
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
  });

  it('is named with a 14-digit stamp after the 3473 files', () => {
    expect('20260924183422_backlog_3535_checklists_min_tier_individual.sql').toMatch(
      /^\d{14}_[a-z0-9_]+\.sql$/
    );
    expect(Number('20260924183422')).toBeGreaterThan(Number('20260921101758'));
  });
});
