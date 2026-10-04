/**
 * BACKLOG-3726 — CI tripwire for the submission sweep migrations.
 *
 * WHAT THIS CAN PROVE: what the migration files, the rollback and config.toml
 * say. CI has no database. Behaviour is proved on a local Supabase stack by
 * supabase/tests/backlog-3726 (controls, lib/mutants.py, live/run-live.sh).
 * This file pins the lines a later edit is most likely to drop or loosen.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8').replace(/\r\n?/g, '\n');
const statements = (raw: string): string =>
  raw.split('\n').map((l) => l.replace(/--.*$/, '')).join(' ').replace(/\s+/g, ' ').trim();

const SQL = statements(read('supabase/migrations/20261005120000_backlog_3726_submission_sweep.sql'));
const SCHED = statements(read('supabase/migrations/20261005120100_backlog_3726_submission_sweep_schedule.sql'));
const RB = statements(read('supabase/tests/backlog-3726/rollback-3726.sql'));
const CONFIG = read('supabase/config.toml');

function fnBody(name: string): string {
  const start = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const s = SQL.indexOf(start);
  expect(s).toBeGreaterThanOrEqual(0);
  expect(SQL.indexOf(start, s + 1)).toBe(-1);
  const open = SQL.indexOf('AS $$', s) + 5;
  return SQL.slice(open, SQL.indexOf('$$;', open));
}

describe('BACKLOG-3726 submission sweep migration', () => {
  it('claim defaults to a dry run with the founder thresholds and floors', () => {
    expect(SQL).toContain('p_dry_run boolean DEFAULT true,');
    expect(SQL).toContain("p_stalled interval DEFAULT interval '2 hours'");
    expect(SQL).toContain("p_abandoned_grace interval DEFAULT interval '1 hour'");
    expect(SQL).toContain("p_orphan_age interval DEFAULT interval '7 days'");
    const body = fnBody('submission_sweep_claim');
    expect(body).toContain("p_stalled < interval '2 hours'");
    expect(body).toContain("p_orphan_age < interval '3 days'");
    expect(body).toContain('p_dry_run IS NULL');
  });

  it('claim fences with SKIP LOCKED and lists only uploading rows', () => {
    const body = fnBody('submission_sweep_claim');
    expect(body).toContain('FOR UPDATE SKIP LOCKED');
    expect(body).toContain("WHERE t.id = cand.id AND t.status::text = 'uploading' AND t.abandoned_at IS NULL");
    expect(body).toContain("WHERE t.status::text = 'uploading' AND ( (t.abandoned_at IS NOT NULL");
    // SR condition 2: a future abandoned_at cannot hide an old row
    expect(body).toContain("OR coalesce(t.created_at, t.updated_at, 'infinity'::timestamptz) < now() - p_stalled OR t.id = ANY (v_fenced)");
  });

  it('stalled = no activity for p_stalled, in both the dry and the live arm (founder 2026-10-04)', () => {
    const body = fnBody('submission_sweep_claim');
    const activity =
      "AND coalesce(greatest( t.created_at, (SELECT max(a.created_at) FROM public.submission_attachments a WHERE a.submission_id = t.id AND a.created_at <= now()), " +
      "(SELECT max(o.created_at) FROM storage.objects o WHERE o.bucket_id = 'submission-attachments' " +
      "AND split_part(o.name, '/', 1) = t.organization_id::text AND split_part(o.name, '/', 2) = t.id::text) ), " +
      "t.updated_at, 'infinity'::timestamptz) < now() - p_stalled";
    expect(body.split(activity).length - 1).toBe(2);
  });

  it('the attachment activity term ignores a future-dated row (SR condition D1)', () => {
    const body = fnBody('submission_sweep_claim');
    expect(body.split('WHERE a.submission_id = t.id AND a.created_at <= now())').length - 1).toBe(2);
    expect(body).not.toContain('least(');
  });

  it('attachment paths and object names must sit in the row\'s own {org}/{id}/ folder (SR condition 3)', () => {
    const body = fnBody('submission_sweep_claim');
    expect(body).toContain("AND split_part(a.storage_path, '/', 1) = s.organization_id::text AND split_part(a.storage_path, '/', 2) = s.id::text");
    expect(body).toContain("AND split_part(o.name, '/', 1) = s.organization_id::text AND split_part(o.name, '/', 2) = s.id::text");
  });

  it('orphans: no attachment row, no submission at segment 2, older than the age', () => {
    const body = fnBody('submission_sweep_claim');
    expect(body).toContain('AND o.created_at < now() - p_orphan_age');
    expect(body).toContain("AND NOT EXISTS (SELECT 1 FROM public.transaction_submissions t WHERE t.id::text = split_part(o.name, '/', 2))");
  });

  it('finish re-checks status, abandon, no object left and no child row (SR condition 1)', () => {
    const body = fnBody('submission_sweep_finish');
    expect(body).toContain("AND s.status::text = 'uploading' AND s.abandoned_at IS NOT NULL");
    expect(body).toContain("AND split_part(o.name, '/', 1) = s.organization_id::text AND split_part(o.name, '/', 2) = s.id::text)");
    expect(body).toContain('AND NOT EXISTS (SELECT 1 FROM public.transaction_submissions c WHERE c.parent_submission_id = s.id)');
    expect(body).toContain("WHERE k ~ '^[a-z][a-z0-9_]{0,63}$' AND jsonb_typeof(v) = 'number'");
  });

  it('every DEFINER function checks the service role in its body', () => {
    for (const fn of ['submission_sweep_secret', 'submission_sweep_claim', 'submission_sweep_finish']) {
      expect(fnBody(fn)).toContain("IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role only' USING ERRCODE = '42501'");
    }
  });

  it('invoke reads the URL and secret from Vault and sets a 150 s timeout (SR conditions 5, 6)', () => {
    const body = fnBody('submission_sweep_invoke');
    expect(body).toContain("WHERE name = 'submission_sweep_url'");
    expect(body).toContain("WHERE name = 'submission_sweep_secret'");
    expect(body).toContain('timeout_milliseconds := 150000');
    expect(body).not.toContain('https://');
  });

  it('grants: client roles get nothing; service_role reads the run table and runs the sweep', () => {
    expect(SQL).toContain('REVOKE ALL ON TABLE public.submission_sweep_runs FROM PUBLIC, anon, authenticated, service_role;');
    expect(SQL).toContain('GRANT SELECT ON TABLE public.submission_sweep_runs TO service_role;');
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.submission_sweep_claim(boolean, interval, interval, interval, integer, integer) FROM PUBLIC, anon, authenticated;');
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.submission_sweep_finish(uuid, uuid[], jsonb, text) FROM PUBLIC, anon, authenticated;');
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.submission_sweep_secret() FROM PUBLIC, anon, authenticated;');
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.submission_sweep_invoke() FROM PUBLIC, anon, authenticated, service_role;');
  });

  it('the schedule is its own file, minute 41, calling invoke', () => {
    expect(SQL).not.toContain('cron.schedule');
    expect(SCHED).toContain("SELECT cron.schedule('submission-sweep', '41 * * * *', 'SELECT public.submission_sweep_invoke()');");
  });

  it('rollback unschedules and removes everything the migration created', () => {
    expect(RB).toContain("PERFORM cron.unschedule('submission-sweep')");
    for (const s of [
      'DROP FUNCTION IF EXISTS public.submission_sweep_invoke();',
      'DROP FUNCTION IF EXISTS public.submission_sweep_finish(uuid, uuid[], jsonb, text);',
      'DROP FUNCTION IF EXISTS public.submission_sweep_claim(boolean, interval, interval, interval, integer, integer);',
      'DROP FUNCTION IF EXISTS public.submission_sweep_secret();',
      'DROP TABLE IF EXISTS public.submission_sweep_runs;',
      "DELETE FROM vault.secrets WHERE name IN ('submission_sweep_secret', 'submission_sweep_url');",
    ]) expect(RB).toContain(s);
  });

  it('config.toml pins verify_jwt = false for the function', () => {
    expect(CONFIG).toMatch(/\[functions\.submission-sweep\]\nverify_jwt = false\n/);
  });
});
