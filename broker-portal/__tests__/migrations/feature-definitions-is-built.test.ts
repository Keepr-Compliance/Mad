/**
 * The migration that moves "which features are unbuilt" into the database —
 * BACKLOG-3098.
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 * WHAT IT CANNOT: that the migration has been applied. It has not been, on
 * purpose — applying it is the founder's/PM's call, same as BACKLOG-3087's.
 *
 * Why guard a two-statement migration with a test at all — three ways it could
 * be wrong while every other test in this PR stayed green, because they all
 * feed the portal a fixture rather than the database:
 *
 *   1. THE DEFAULT. `DEFAULT false` would mark all 23 existing features unbuilt
 *      and hide every gated control in the portal at once. `DEFAULT true` with
 *      two named exceptions is the only shape that leaves the other 21 alone.
 *
 *   2. THE KEY LIST. One key too many silently hides a working feature's card;
 *      one too few grays an unbuilt one, which is the false purchase promise
 *      the whole gray-vs-hide rule exists to prevent. So the list is asserted
 *      as an exact set, extracted from the UPDATE itself — not as "contains
 *      scim_provisioning", which a third key would still satisfy.
 *
 *   3. RE-RUNNABILITY. Migrations get replayed. A bare ADD COLUMN aborts the
 *      whole file on a second run.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION = join(
  __dirname,
  '../../../supabase/migrations/20260905120100_backlog_3098_feature_definitions_is_built.sql'
);

const sql = readFileSync(MIGRATION, 'utf8');

/**
 * Statements only, comments stripped.
 *
 * The file's header explains the two keys in prose, so a check run over the raw
 * text could read a comment as a decision. Only executable SQL counts.
 */
const statements = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

/** The keys the UPDATE actually touches, read out of its own IN list. */
function updatedKeys(): string[] {
  const inList = statements.match(/UPDATE\s+public\.feature_definitions[\s\S]*?IN\s*\(([^)]*)\)/i);
  if (!inList) return [];
  return [...inList[1].matchAll(/'([a-z0-9_]+)'/g)].map(([, k]) => k).sort();
}

describe('20260905120100_backlog_3098_feature_definitions_is_built.sql', () => {
  it('adds the column the portal reads', () => {
    // lib/feature-availability.ts selects `key, is_built` from this table.
    expect(statements).toMatch(
      /ALTER TABLE public\.feature_definitions\s+ADD COLUMN IF NOT EXISTS is_built boolean NOT NULL DEFAULT true/i
    );
  });

  it('defaults to true — false would hide every gated control at once', () => {
    const alter = statements.match(/ADD COLUMN IF NOT EXISTS is_built[^;]*/i);
    expect(alter).not.toBeNull();
    expect(alter![0]).toMatch(/DEFAULT\s+true/i);
    expect(alter![0]).not.toMatch(/DEFAULT\s+false/i);
  });

  it('declares the column NOT NULL, so no row can mean "unknown"', () => {
    // A nullable column would give a third state the render rule has no answer
    // for; the portal reads null as unbuilt, and a row would then hide its card
    // for a reason nobody wrote down.
    expect(statements.match(/ADD COLUMN IF NOT EXISTS is_built[^;]*/i)![0]).toMatch(
      /NOT NULL/i
    );
  });

  it('flips EXACTLY the two unbuilt keys and no others', () => {
    expect(updatedKeys()).toEqual(['jit_provisioning', 'scim_provisioning']);
  });

  it('flips them to false, not true', () => {
    expect(statements).toMatch(/UPDATE\s+public\.feature_definitions\s+SET is_built = false/i);
    expect(statements).not.toMatch(/SET is_built = true/i);
  });

  it('touches feature_definitions with exactly one UPDATE', () => {
    // A second UPDATE elsewhere in the file could re-flip a key back, and the
    // exact-set check above would still pass on the first one it found.
    expect(statements.match(/UPDATE\s+public\.feature_definitions/gi) ?? []).toHaveLength(1);
  });

  it('extracts a non-empty key list — the check is worthless otherwise', () => {
    // Without this, a rewritten UPDATE the regex could not parse would yield []
    // and the exact-set assertion would fail loudly rather than silently pass,
    // but a future edit to the extractor might not. Pin the precondition.
    expect(updatedKeys().length).toBeGreaterThan(0);
  });

  it('is re-runnable', () => {
    expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS/i);
    // The UPDATE sets an absolute value rather than toggling, so replaying it
    // is a no-op. A NOT-based flip would invert the two rows on every re-run.
    expect(statements).not.toMatch(/SET is_built = NOT/i);
  });

  it('drops nothing', () => {
    expect(statements).not.toMatch(/\bDROP\b/i);
  });
});
