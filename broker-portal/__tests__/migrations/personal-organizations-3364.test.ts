/**
 * BACKLOG-3364 — personal organizations migration (control C9, text half).
 *
 * WHAT THIS CAN PROVE: what the migration file and the parked backfill say.
 *
 * WHAT IT CANNOT: behaviour. That is proved by the executable controls in
 * supabase/tests/backlog-3364/, run against a real Postgres + PostgREST +
 * storage stack. CI has no database, so these assertions are the tripwire that
 * does run in CI: on the lines a later edit is most likely to change quietly.
 *
 * Matchers run on the file with `--` comment lines removed, so the header's
 * prose (which names auth.users, handle_new_user and the backfill) cannot
 * satisfy or break an assertion about executable SQL.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const MIGRATION_NAME = '20260915160637_backlog_3364_personal_organizations.sql';
const BACKFILL = join(REPO, 'supabase/parked/backlog-3364/backfill_personal_organizations.sql');

const stripComments = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

/** Every statement (to its terminating `;`) that starts with `head`. Case-insensitive. */
function statements(sql: string, head: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(head.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const end = sql.indexOf(';', m.index);
    out.push(sql.slice(m.index, end === -1 ? undefined : end + 1));
  }
  return out;
}

/** The body of `CREATE OR REPLACE FUNCTION public.<name>(` through its closing `$$;`. */
function functionBlock(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('\n$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + 4);
}

describe(MIGRATION_NAME, () => {
  const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const raw = readFileSync(join(MIGRATIONS_DIR, MIGRATION_NAME), 'utf8');
  const code = stripComments(raw);

  it('is the only BACKLOG-3364 migration, under a 14-digit stamp', () => {
    const mine = migrationFiles.filter((f) => /backlog_3364/i.test(f));
    expect(mine).toEqual([MIGRATION_NAME]);
    expect(MIGRATION_NAME).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it('runs as one transaction with a lock timeout', () => {
    const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines[0]).toBe('BEGIN;');
    expect(lines[lines.length - 1]).toBe('COMMIT;');
    expect(code.match(/^\s*BEGIN;\s*$/gm)).toHaveLength(1);
    expect(code.match(/^\s*COMMIT;\s*$/gm)).toHaveLength(1);
    expect(code).toMatch(/SET LOCAL lock_timeout\s*=\s*'5s'\s*;/i);
  });

  it('creates no trigger on auth.users, and attaches triggers only to organizations and organization_members', () => {
    const triggers = statements(code, /CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/);
    expect(triggers).toHaveLength(2);
    const targets = triggers.map((t) => (t.match(/\bON\s+([a-z_."]+)/i) ?? [])[1]);
    expect(targets.sort()).toEqual(['public.organization_members', 'public.organizations']);
    for (const t of triggers) expect(t).not.toMatch(/\bauth\./i);
    expect(code).not.toMatch(/TRIGGER[\s\S]{0,200}?\bON\s+auth\.users/i);
  });

  it('does not touch handle_new_user, create_active_individual_license or admin_assign_org_plan', () => {
    expect(code).not.toMatch(/handle_new_user/i);
    expect(code).not.toMatch(/create_active_individual_license/i);
    expect(code).not.toMatch(/admin_assign_org_plan/i);
  });

  it('adds the column nullable, with no default, and a partial unique index', () => {
    const add = statements(code, /ALTER\s+TABLE\s+public\.organizations/)[0];
    expect(add).toMatch(/ADD COLUMN IF NOT EXISTS personal_owner_user_id uuid NULL/i);
    expect(add).not.toMatch(/DEFAULT/i);
    expect(add).toMatch(/REFERENCES auth\.users\(id\) ON DELETE CASCADE/i);
    const idx = statements(code, /CREATE\s+UNIQUE\s+INDEX/)[0];
    expect(idx).toMatch(/ON public\.organizations \(personal_owner_user_id\)\s+WHERE personal_owner_user_id IS NOT NULL/i);
  });

  it('keeps the internal function away from anon, authenticated and PUBLIC', () => {
    const ensure = functionBlock(code, '_ensure_personal_organization_for');
    expect(ensure).toMatch(/SECURITY DEFINER/);
    expect(ensure).toMatch(/SET search_path = public/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\._ensure_personal_organization_for\(uuid\) FROM PUBLIC;/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\._ensure_personal_organization_for\(uuid\) FROM anon, authenticated;/);
    const grants = statements(code, /GRANT\s+/);
    for (const g of grants) expect(g).not.toMatch(/_ensure_personal_organization_for/);
  });

  it('exposes a wrapper that takes no user id and acts on auth.uid()', () => {
    const wrapper = functionBlock(code, 'ensure_personal_organization');
    expect(wrapper).toMatch(/^CREATE OR REPLACE FUNCTION public\.ensure_personal_organization\(\)/);
    expect(wrapper).toMatch(/auth\.uid\(\)/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.ensure_personal_organization\(\) TO authenticated;/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.ensure_personal_organization\(\) FROM anon;/);
  });

  it('creates the personal organization as a one-seat, JIT-off org on the default individual plan, membership agent', () => {
    const ensure = functionBlock(code, '_ensure_personal_organization_for');
    const orgInsert = statements(ensure, /INSERT INTO public\.organizations/)[0];
    expect(orgInsert).toMatch(
      /\(name, slug, max_seats, jit_provisioning_enabled, default_member_role, personal_owner_user_id\)/
    );
    expect(orgInsert).toMatch(/1, false, 'agent', p_user_id\)/);
    // The legacy `plan` column is left to its default ('trial'), as admin_create_organization does.
    expect(orgInsert).not.toMatch(/\bplan\b/);
    const planPick = statements(ensure, /SELECT id\s+INTO v_plan_id/)[0];
    expect(planPick).toMatch(/tier = 'individual'/);
    expect(planPick).toMatch(/AND is_default/);
    expect(planPick).toMatch(/AND is_active/);
    const memberInsert = statements(ensure, /INSERT INTO public\.organization_members/)[0];
    expect(memberInsert).toMatch(/\(v_org_id, p_user_id, 'agent', 'active', NOW\(\), NULL\)/);
    expect(memberInsert).toMatch(/ON CONFLICT \(organization_id, user_id\) DO NOTHING/);
  });

  it('guards organizations.personal_owner_user_id with a BEFORE INSERT / UPDATE OF trigger', () => {
    const guard = statements(code, /CREATE OR REPLACE TRIGGER guard_personal_owner_user_id/)[0];
    expect(guard).toMatch(/BEFORE INSERT OR UPDATE OF personal_owner_user_id ON public\.organizations/);
    const fn = functionBlock(code, '_guard_personal_owner_user_id');
    expect(fn).not.toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/current_user = v_owner/);
  });

  it('adds the non-personal condition to both the submission and the upload policy', () => {
    const s2 = statements(code, /CREATE POLICY "agents_can_create_submissions"/)[0];
    expect(s2).toMatch(/FOR INSERT/);
    expect(s2).toMatch(/o\.personal_owner_user_id IS NULL/);
    const s3 = statements(code, /CREATE POLICY "Members can upload submission attachments"/)[0];
    expect(s3).toMatch(/ON storage\.objects/);
    expect(s3).toMatch(/bucket_id = 'submission-attachments'/);
    expect(s3).toMatch(/o\.personal_owner_user_id IS NULL/);
  });
});

describe('BACKLOG-3364 backfill stays parked', () => {
  it('exists under supabase/parked/backlog-3364/', () => {
    expect(existsSync(BACKFILL)).toBe(true);
  });

  it('is not under supabase/migrations/: no migration loops over users calling ensure', () => {
    for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql'))) {
      const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      if (f === MIGRATION_NAME) {
        expect(sql).not.toMatch(/\bFOR\s+\w+\s+IN\b/i);
        continue;
      }
      expect(sql).not.toMatch(/_ensure_personal_organization_for/);
    }
  });

  it('skips any unclaimed invite, expired or not', () => {
    const sql = stripComments(readFileSync(BACKFILL, 'utf8'));
    expect(sql).toMatch(/WHERE user_id IS NULL\s+AND LOWER\(TRIM\(invited_email\)\) = LOWER\(TRIM\(r\.email\)\)/);
    const skip = sql.slice(sql.indexOf('WHERE user_id IS NULL'), sql.indexOf('CONTINUE;'));
    expect(skip).not.toMatch(/invitation_expires_at/);
  });
});
