/**
 * BACKLOG-3725 — CI tripwire for the abandoned_at migration.
 *
 * WHAT THIS CAN PROVE: what the migration file and its rollback say. CI has no
 * database. Behaviour is proved on a local Supabase stack by
 * supabase/tests/backlog-3725 (controls, lib/mutants.py, live/live-run.mjs).
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const FILE = '20261004213050_backlog_3725_abandoned_at.sql';
const PRIOR = '20261004192647_backlog_3403_finalize_submission.sql';
const ROLLBACK = join(REPO, 'supabase/tests/backlog-3725/rollback-3725.sql');

const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
function statements(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const SQL = statements(read(join(MIGRATIONS_DIR, FILE)));
const PRIOR_SQL = statements(read(join(MIGRATIONS_DIR, PRIOR)));
const RB = statements(read(ROLLBACK));

function slice(text: string, start: string, end: string): string {
  const s = text.indexOf(start);
  expect(s).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(start, s + 1)).toBe(-1);
  return text.slice(s, text.indexOf(end, s) + end.length);
}
const policy = (text: string, name: string, table: string) => slice(text, `CREATE POLICY ${name} ON ${table}`, ';');
const fnBlock = (text: string, name: string) => slice(text, `CREATE OR REPLACE FUNCTION public.${name}(`, '$fn$;');

describe('BACKLOG-3725 migration file', () => {
  it('sorts after the applied 3403 migration and is the only file with its version', () => {
    expect(FILE.slice(0, 14) > PRIOR.slice(0, 14)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith(FILE.slice(0, 14)))).toEqual([FILE]);
    expect(SQL).not.toMatch(/\b(BEGIN|COMMIT)\s*;/i);
  });

  it('adds the nullable column', () => {
    expect(SQL).toContain('ALTER TABLE public.transaction_submissions ADD COLUMN IF NOT EXISTS abandoned_at timestamptz NULL;');
  });

  it('finalize refuses on abandoned_at and no longer reads the metadata flag', () => {
    const fn = fnBlock(SQL, 'finalize_submission');
    expect(fn).toContain("IF v_sub.abandoned_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'abandoned');");
    expect(fn).not.toContain("submission_metadata->>'abandoned'");
    expect(fn).toContain('WHERE id = p_submission_id FOR UPDATE;');
  });

  it('finalize is the 3403 body except the abandon check', () => {
    const before = fnBlock(PRIOR_SQL, 'finalize_submission');
    const after = fnBlock(SQL, 'finalize_submission');
    expect(after.replace('IF v_sub.abandoned_at IS NOT NULL THEN', 'IF coalesce(v_sub.submission_metadata->>\'abandoned\', \'\') = \'true\' THEN')).toBe(before);
  });

  it('the submitter UPDATE branch cannot reach a fenced row', () => {
    const p = policy(SQL, 'transaction_submissions_update_public', 'public.transaction_submissions');
    const using = p.slice(p.indexOf('USING'), p.indexOf('WITH CHECK'));
    expect(using).toContain("((submitted_by = (SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text) AND (abandoned_at IS NULL))");
    // the reviewer WITH CHECK from 3403 is kept
    expect(p).toContain("OR (((status)::text <> 'uploading'::text) AND (organization_id IN");
  });

  it('both delete policies need abandoned_at, not the metadata flag', () => {
    expect(policy(SQL, 'agents_can_delete_own_attachments', 'public.submission_attachments')).toContain(
      'AND transaction_submissions.abandoned_at IS NOT NULL'
    );
    const s = policy(SQL, '"Submitters can delete attachments of their abandoned upload"', 'storage.objects');
    expect(s).toContain('AND s.abandoned_at IS NOT NULL');
    expect(SQL).not.toContain("submission_metadata->>'abandoned'");
  });

  it('the guard: clients only, insert NULL, submitter once while uploading; service role passes', () => {
    const fn = fnBlock(SQL, 'guard_submission_abandoned_at');
    expect(fn).toContain("IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;");
    expect(fn).toContain("IF NEW.abandoned_at IS NOT NULL THEN RAISE EXCEPTION 'abandoned_at_insert'");
    expect(fn).toContain('OR OLD.submitted_by IS DISTINCT FROM auth.uid()');
    expect(fn).toContain("OR (NEW.status)::text <> 'uploading' THEN");
    // server time, whatever the client sent
    expect(fn).toContain("RAISE EXCEPTION 'abandoned_at_submitter_once_while_uploading' USING ERRCODE = '42501'; END IF; NEW.abandoned_at := now(); END IF;");
    expect(SQL).toContain('BEFORE INSERT OR UPDATE ON public.transaction_submissions FOR EACH ROW EXECUTE FUNCTION public.guard_submission_abandoned_at();');
    expect(SQL).toContain('REVOKE EXECUTE ON FUNCTION public.guard_submission_abandoned_at() FROM PUBLIC, anon, authenticated;');
  });
});

describe('rollback-3725.sql', () => {
  it('restores the 3403 text and drops what 3725 adds', () => {
    expect(fnBlock(RB, 'finalize_submission')).toBe(fnBlock(PRIOR_SQL, 'finalize_submission'));
    for (const [name, table] of [
      ['transaction_submissions_update_public', 'public.transaction_submissions'],
      ['agents_can_delete_own_attachments', 'public.submission_attachments'],
      ['"Submitters can delete attachments of their abandoned upload"', 'storage.objects'],
    ]) {
      expect(policy(RB, name, table)).toBe(policy(PRIOR_SQL, name, table));
    }
    expect(RB).toContain('DROP FUNCTION IF EXISTS public.guard_submission_abandoned_at();');
    expect(RB).toContain('ALTER TABLE public.transaction_submissions DROP COLUMN IF EXISTS abandoned_at;');
  });
});
