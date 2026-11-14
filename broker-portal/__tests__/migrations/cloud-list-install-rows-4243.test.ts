/**
 * BACKLOG-4243 — CI tripwire for migration 20261114130000 (cloud_list_install_rows).
 *
 * WHAT THIS CAN PROVE: what the migration and its rollback say. CI has no database. Behaviour
 * is proved by supabase/tests/backlog-4243 (controls in one rolled-back transaction, owner-term
 * and install-term mutants).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
function statements(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const RAW = read(join(REPO, 'supabase/migrations/20261114130000_backlog_4243_cloud_list_install_rows.sql'));
const M = statements(RAW);
const RB = statements(read(join(REPO, 'supabase/tests/backlog-4243/rollback-20261114130000.sql')));
const SHAPE = JSON.parse(read(join(REPO, 'supabase/contracts/cloud-deal-shape-v1.json')));
const SIG = 'public.cloud_list_install_rows(uuid, uuid, text, uuid, integer)';

describe('BACKLOG-4243 cloud_list_install_rows migration', () => {
  it('creates exactly one function, STABLE SECURITY DEFINER with an empty search_path', () => {
    expect(M.match(/CREATE (OR REPLACE )?FUNCTION/g)).toHaveLength(1);
    expect(M).toContain(
      'CREATE OR REPLACE FUNCTION public.cloud_list_install_rows( p_expected_user_id uuid, p_source_install_id uuid, p_kind text, p_after uuid, p_limit integer ) RETURNS jsonb',
    );
    expect(M).toContain("LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''");
  });

  it('alters no table, drops nothing and creates no table, view, trigger, policy or index', () => {
    expect(M).not.toMatch(/\b(ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/);
    expect(M).not.toMatch(/CREATE (TABLE|VIEW|TRIGGER|POLICY|INDEX|UNIQUE INDEX)/);
  });

  it('revokes from PUBLIC, anon, authenticated and service_role, then grants EXECUTE to authenticated only', () => {
    expect(M).toContain(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(M).toContain(`GRANT EXECUTE ON FUNCTION ${SIG} TO authenticated;`);
    expect(M.match(/GRANT /g)).toHaveLength(1);
  });

  it('refuses a missing user and a mismatched expected user before any read', () => {
    const body = M.slice(M.indexOf('BEGIN'));
    const nul = body.indexOf("IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');");
    const who = body.indexOf(
      "IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account');",
    );
    const read1 = body.indexOf('EXECUTE format(');
    expect(nul).toBeGreaterThan(0);
    expect(who).toBeGreaterThan(nul);
    expect(read1).toBeGreaterThan(who);
  });

  it('every read carries the owner term and the install term', () => {
    expect(M).toContain('WHERE t.owner_user_id = $1 AND d.owner_user_id = $1 /*OWNER:list_rows*/');
    expect(M).toContain('AND d.source_install_id = $2 /*INSTALL:list_rows*/');
    expect(M.match(/EXECUTE format\(/g)).toHaveLength(1);
  });

  it('the four kinds and a capped limit', () => {
    for (const k of ['deal', 'party', 'checklist', 'checklist_item']) expect(M).toContain(`('${k}',`);
    expect(M).toContain('v_limit := least(greatest(coalesce(p_limit, 1000), 1), 1000);');
  });

  it('uses only envelope error codes the shape contract already lists', () => {
    const codes = [...RAW.matchAll(/'error', '([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(2);
    for (const c of codes) expect(SHAPE.tolerance.known.client_envelope_errors).toContain(c);
  });

  it('the rollback drops the function and its ledger row', () => {
    expect(RB).toContain(`DROP FUNCTION IF EXISTS ${SIG};`);
    expect(RB).toContain("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261114130000';");
  });
});
