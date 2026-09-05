/**
 * BACKLOG-3096 — /setup must not hand admin to every employee in the tenant.
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 *
 * WHAT IT CANNOT: that the function behaves correctly, or that the migration
 * has been applied. It has not been applied, on purpose — deploying it is the
 * PM's call. Behaviour is proved by the six executable controls in
 * supabase/tests/backlog-3096/, which are run against a disposable database
 * and are NOT a thing this file substitutes for.
 *
 * So why does this file exist? Because the controls need a database and CI has
 * none, while a future edit that quietly deletes the row lock or the
 * claimed-rows filter would sail through every other check in this repo. These
 * assertions are the tripwire on those two lines, and on the carried-over
 * behaviour around them.
 *
 * Matchers here are STATEMENT-scoped, not line- or VALUES-scoped. A regex like
 * /VALUES\s*\([^)]*\)/ stops at the closing paren of NOW() and would miss an
 * 'admin' literal placed after it.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION = join(
  __dirname,
  '../../../supabase/migrations/20260905_backlog_3096_setup_first_user_wins.sql'
);

/** The statement that starts at `needle`, up to and including its terminating `;`. */
function statementAt(sql: string, needle: string): string {
  const start = sql.indexOf(needle);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf(';', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + 1);
}

describe('20260905_backlog_3096_setup_first_user_wins.sql', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  // Comments carry the words 'admin' and FOR UPDATE all over the place. Strip
  // them so every assertion below is about executable SQL.
  const code = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  it('replaces the function under its existing signature and return shape', () => {
    // Format-tolerant on purpose: the mutants include the production body as
    // pg_get_functiondef prints it, and a red from whitespace or letter case
    // would be noise, not a finding.
    expect(code).toMatch(
      /CREATE OR REPLACE FUNCTION public\.auto_provision_it_admin\s*\(\s*p_tenant_id\s+TEXT\s*,\s*p_org_name\s+TEXT\s*,\s*p_org_slug\s+TEXT\s*\)/i
    );
    expect(code).toMatch(/RETURNS\s+JSONB/i);
    // A DROP would revoke the grants that CREATE OR REPLACE preserves, and
    // /setup would start failing for authenticated callers.
    expect(code).not.toMatch(/DROP\s+FUNCTION/i);
  });

  it('keeps SECURITY DEFINER and the pinned search_path', () => {
    // The body calls auth.uid() and reads auth.users; without SECURITY DEFINER
    // an ordinary caller could not run it at all. An unpinned search_path on a
    // SECURITY DEFINER function is a privilege-escalation surface in its own
    // right.
    expect(code).toMatch(/SECURITY DEFINER/i);
    // Accepts either spelling; pg_get_functiondef prints TO 'public'.
    expect(code).toMatch(/SET\s+search_path\s*(=|TO)\s*'?public'?/i);
  });

  it('locks the organizations row, and does it BEFORE reading the membership', () => {
    const lockStatement = statementAt(code, 'SELECT COALESCE(default_member_role');
    expect(lockStatement).toMatch(/FROM organizations/);
    expect(lockStatement).toMatch(/WHERE id = v_org_id/);
    expect(lockStatement).toMatch(/FOR UPDATE/);

    // Ordering is the whole point: a lock taken after the membership work
    // serialises nothing. Two employees opening /setup in the same second
    // would both read "zero claimed members" and both insert themselves as
    // admin. Compared against the INSERT rather than against the count, so
    // that a mutant which deletes the count reds the count assertion only —
    // one finding, one red.
    const lockAt = code.indexOf('FOR UPDATE');
    const memberInsertAt = code.indexOf('INSERT INTO organization_members');
    expect(lockAt).toBeGreaterThan(-1);
    expect(memberInsertAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(memberInsertAt);
  });

  it('counts only CLAIMED members when deciding admin', () => {
    const roleResolution = statementAt(code, 'v_role := CASE');

    expect(roleResolution).toMatch(/NOT EXISTS/);
    expect(roleResolution).toMatch(/FROM organization_members/);
    expect(roleResolution).toMatch(/organization_id = v_org_id/);
    // Load-bearing. Pre-created white-glove orgs carry unclaimed invite rows
    // (user_id IS NULL); counting those demotes the org's own IT admin to the
    // default role on arrival, and nobody can administer the org.
    expect(roleResolution).toMatch(/AND user_id IS NOT NULL/);
    expect(roleResolution).toMatch(/THEN 'admin'/);
    expect(roleResolution).toMatch(/ELSE v_default_role/);

    // "admin iff the org has no admin yet" was considered and rejected: an org
    // whose last admin departed would promote whoever arrived next.
    expect(roleResolution).not.toMatch(/role\s*=\s*'admin'/);
  });

  it("does not hard-code 'admin' in the membership INSERT", () => {
    const insert = statementAt(code, 'INSERT INTO organization_members');
    expect(insert).toMatch(/VALUES \(v_org_id, v_user_id, v_role,/);
    expect(insert).not.toMatch(/'admin'/);
    // 'admin' may appear exactly once in executable SQL: as the THEN branch of
    // the role resolution. Anywhere else is a regression.
    expect(code.match(/'admin'/g) ?? []).toHaveLength(1);
  });

  it('returns the role it wrote, so the callback need not re-query', () => {
    // BACKLOG-3096: the /setup callback branches on this key. Two reads — one
    // in the function, one in the route — could disagree; one read cannot.
    // Additive: the three original keys stay, so existing consumers are
    // unaffected.
    const successReturn = code.slice(code.lastIndexOf('RETURN jsonb_build_object('));
    expect(successReturn).toMatch(/'success', true/);
    expect(successReturn).toMatch(/'organization_id', v_org_id/);
    expect(successReturn).toMatch(/'user_id', v_user_id/);
    expect(successReturn).toMatch(/'role', v_role/);

    // The already-a-member path must populate v_role too, or a repeat caller
    // gets a null role back and the route fails them closed to /download.
    expect(code).toMatch(/SELECT role\s+INTO v_role\s+FROM organization_members/);
  });

  it('carries the rest of the live body over unchanged', () => {
    // The email fallback chain for tenants where Microsoft leaves
    // auth.users.email empty.
    expect(code).toMatch(/raw_user_meta_data->>'preferred_username'/);
    // The TOCTOU-safe org insert and the slug-collision retry.
    expect(code.match(/ON CONFLICT \(microsoft_tenant_id\) DO NOTHING/g) ?? []).toHaveLength(2);
    expect(code).toMatch(/substr\(gen_random_uuid\(\)::text, 1, 6\)/);
    // The public.users upsert.
    expect(code).toMatch(/INSERT INTO users \(id, email, oauth_provider, oauth_id\)/);
    expect(code).toMatch(/'azure'/);
    // The return shape the /setup callback route reads.
    expect(code).toMatch(/'organization_id', v_org_id/);
    expect(code).toMatch(/'user_id', v_user_id/);
  });

  it('touches no membership row it did not create', () => {
    // A repair pass that re-roled existing members would be a different, much
    // larger change, and would need the founder's sign-off.
    expect(code).not.toMatch(/UPDATE\s+organization_members/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+organization_members/i);
  });
});
