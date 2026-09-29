/**
 * BACKLOG-3608 — the CI tripwire for the client-role update rules on
 * transaction_submissions.
 *
 * WHAT THIS CAN PROVE: what the migration file (and its rollback) says. CI has
 * no database. The behaviour is proved on a real Postgres by
 * supabase/tests/backlog-3608 (controls e01-e12, the 3607 and 3596 controls,
 * and the mutant list); this file pins the lines a later edit is most likely
 * to drop, move or loosen, so that such a change fails in CI too.
 */

import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const SUFFIX = '_backlog_3608_status_history_client_appends.sql';
const ROLLBACK = join(REPO, 'supabase/tests/backlog-3608/rollback-3608.sql');

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
}

function migrationRaw(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(SUFFIX));
  expect(files).toHaveLength(1);
  return read(join(MIGRATIONS_DIR, files[0]));
}

/** The text between `AS $$` and `$$;` — what Postgres stores as prosrc. */
function body(raw: string): string {
  const start = raw.indexOf('AS $$');
  const end = raw.indexOf('$$;', start + 5);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return raw.slice(start + 5, end);
}

/** Comments out, whitespace collapsed. */
function statements(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

describe('BACKLOG-3608 migration', () => {
  it('guard body is the one the NAS controls ran (E05 pin)', () => {
    expect(md5(body(migrationRaw()))).toBe('7bdcafeaacb65f164c85056501724071');
  });

  it('client-statement checks come before the unchanged-history return; history refusal after it', () => {
    const g = statements(body(migrationRaw()));
    const client = g.indexOf("IF current_user IN ('authenticated', 'anon') THEN IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by");
    const unchanged = g.indexOf('IF NEW.status_history IS NOT DISTINCT FROM OLD.status_history THEN RETURN NEW; END IF;');
    const hist = g.indexOf("IF current_user IN ('authenticated', 'anon') THEN RAISE EXCEPTION 'status_history_append_only'");
    expect(client).toBeGreaterThan(-1);
    expect(unchanged).toBeGreaterThan(client);
    expect(hist).toBeGreaterThan(unchanged);
  });

  it('review fields: all three watched, reviewer of OLD organization, reviewed_by = caller', () => {
    const g = statements(body(migrationRaw()));
    expect(g).toContain(
      'IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.review_notes IS DISTINCT FROM OLD.review_notes THEN',
    );
    expect(g).toContain("IF NOT public.can_review_submission(OLD.organization_id) THEN RAISE EXCEPTION 'review_fields_reviewer_only'");
    expect(g).toContain('AND NEW.reviewed_by IS DISTINCT FROM auth.uid() THEN');
  });

  it('ownership columns: every one listed', () => {
    const g = statements(body(migrationRaw()));
    for (const col of ['id', 'organization_id', 'submitted_by', 'local_transaction_id', 'parent_submission_id', 'version']) {
      expect(g).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
    expect(g).toContain("RAISE EXCEPTION 'submission_owner_fields_locked' USING ERRCODE = '42501'");
  });

  it('UPDATE rule: submitter USING is uploading only; WITH CHECK unchanged', () => {
    const s = statements(migrationRaw());
    expect(s).toContain(
      "USING ( ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text)) OR",
    );
    expect(s).not.toContain("ARRAY['needs_changes'::text, 'uploading'::text]");
    expect(s).toContain("ARRAY['needs_changes'::text, 'resubmitted'::text, 'uploading'::text, 'submitted'::text]");
  });

  it('no SECURITY DEFINER, no BEGIN/COMMIT', () => {
    const s = statements(migrationRaw());
    expect(s).not.toMatch(/SECURITY DEFINER/i);
    expect(s).not.toMatch(/\bBEGIN\s*;|\bCOMMIT\s*;/i);
  });
});

describe('BACKLOG-3608 rollback', () => {
  it('restores the 3477 guard body (md5 46aba174…) and the 3596 USING', () => {
    const raw = read(ROLLBACK);
    expect(md5(body(raw))).toBe('46aba17498774aa04a64e679e5a39c84');
    expect(statements(raw)).toContain(
      "((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'uploading'::text])))",
    );
  });
});
