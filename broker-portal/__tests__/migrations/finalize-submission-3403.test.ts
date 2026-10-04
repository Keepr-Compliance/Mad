/**
 * BACKLOG-3403 — CI tripwire for the finalize_submission migration.
 *
 * WHAT THIS CAN PROVE: what the migration file and its rollback say. CI has no
 * database. Behaviour is proved on a real Postgres and a local Supabase stack
 * by supabase/tests/backlog-3403 (controls, lib/mutants.py, live/live-run.mjs).
 * This file pins the lines a later edit is most likely to drop or loosen.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const FILE = '20261004200000_backlog_3403_finalize_submission.sql';
const ROLLBACK = join(REPO, 'supabase/tests/backlog-3403/rollback-3403.sql');

const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');

/** Comments out, whitespace collapsed: statement checks only. */
function statements(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RAW = read(join(MIGRATIONS_DIR, FILE));
const SQL = statements(RAW);
const RB = statements(read(ROLLBACK));

/** CREATE OR REPLACE FUNCTION public.<name>( ... through the closing `$fn$;`. */
function fnBlock(name: string): string {
  const start = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const s = SQL.indexOf(start);
  expect(s).toBeGreaterThanOrEqual(0);
  expect(SQL.indexOf(start, s + 1)).toBe(-1);
  const bodyOpen = SQL.indexOf('$fn$', s) + 4;
  return SQL.slice(s, SQL.indexOf('$fn$;', bodyOpen) + 5);
}

/** CREATE POLICY <name> ON <table> ... up to the next `;`. */
function policy(name: string, table: string): string {
  const start = `CREATE POLICY ${name} ON ${table}`;
  const s = SQL.indexOf(start);
  expect(s).toBeGreaterThanOrEqual(0);
  expect(SQL.indexOf(start, s + 1)).toBe(-1);
  return SQL.slice(s, SQL.indexOf(';', s) + 1);
}

describe('BACKLOG-3403 migration file', () => {
  it('has a version above the production ledger head that no other migration uses', () => {
    const version = FILE.slice(0, 14);
    expect(version > '20261003195046').toBe(true);
    const same = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith(version));
    expect(same).toEqual([FILE]);
  });

  it('opens no transaction of its own', () => {
    expect(SQL).not.toMatch(/\b(BEGIN|COMMIT)\s*;/i);
  });
});

describe('finalize_submission', () => {
  const fn = fnBlock('finalize_submission');

  it('is SECURITY DEFINER with an empty search_path, executable by authenticated only', () => {
    expect(fn).toContain('SECURITY DEFINER SET search_path = \'\'');
    expect(SQL).toContain('REVOKE EXECUTE ON FUNCTION public.finalize_submission(uuid, jsonb) FROM PUBLIC, anon;');
    expect(SQL).toContain('GRANT EXECUTE ON FUNCTION public.finalize_submission(uuid, jsonb) TO authenticated;');
  });

  it('checks the caller, locks the row and refuses an abandoned upload', () => {
    expect(fn).toContain('IF v_uid IS NULL THEN');
    expect(fn).toContain('WHERE id = p_submission_id FOR UPDATE;');
    expect(fn).toContain("IF v_sub.submitted_by <> v_uid THEN RETURN jsonb_build_object('ok', false, 'code', 'not_owner');");
    expect(fn).toContain("IF coalesce(v_sub.submission_metadata->>'abandoned', '') = 'true' THEN RETURN jsonb_build_object('ok', false, 'code', 'abandoned');");
    // the fence check sits after the status checks, before any verification
    expect(fn.indexOf("'not_uploading'")).toBeLessThan(fn.indexOf("'abandoned'"));
    expect(fn.indexOf("'abandoned'")).toBeLessThan(fn.indexOf('v_msg_missing FROM'));
  });

  it('compares message id SETS (missing and extra), not counts', () => {
    expect(fn).toContain('WHERE NOT EXISTS (SELECT 1 FROM public.submission_messages m WHERE m.id = d AND m.submission_id = p_submission_id);');
    expect(fn).toContain('WHERE m.submission_id = p_submission_id AND NOT (m.id = ANY(v_msgs));');
  });

  it('checks objects by exact name, the folder prefix, links and undeclared rows', () => {
    expect(fn).toContain("o.bucket_id = 'submission-attachments' AND o.name = d.path");
    expect(fn).toContain("v_prefix := v_sub.organization_id::text || '/' || p_submission_id::text || '/';");
    expect(fn).toContain('left(d.path, length(v_prefix)) <> v_prefix');
    expect(fn).toContain('a.message_id IS DISTINCT FROM d.message_id');
    expect(fn).toContain("AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_att) e WHERE (e->>'id')::uuid = a.id);");
  });

  it('merges submission_metadata (keeps excluded_files) and counts distinct attachment ids', () => {
    expect(fn).toContain("submission_metadata = coalesce(submission_metadata, '{}'::jsonb) || jsonb_build_object('finalized_by', 'finalize_submission')");
    expect(fn).toContain('count(DISTINCT d.id)');
    expect(fn).toContain('attachment_count = v_att_ids,');
  });

  it('marks the attempt row committed in the same call', () => {
    expect(fn).toContain("INSERT INTO public.submission_attempts AS a");
    expect(fn).toContain("SET outcome = 'committed', stage = 'finalize', reason_code = NULL, updated_at = now(), ended_at = now() WHERE a.user_id = v_uid;");
  });
});

describe('submission_attempts', () => {
  it('has no client grants except SELECT, and no write policies', () => {
    expect(SQL).toContain('REVOKE ALL ON public.submission_attempts FROM PUBLIC, anon, authenticated;');
    expect(SQL).toContain('GRANT SELECT ON public.submission_attempts TO authenticated;');
    expect(SQL).not.toMatch(/CREATE POLICY \S+ ON public\.submission_attempts FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  it('is readable by the agent, reviewers of the org, and internal users', () => {
    const p = policy('submission_attempts_select', 'public.submission_attempts');
    expect(p).toContain('FOR SELECT TO authenticated');
    expect(p).toContain('(user_id = (SELECT auth.uid()))');
    expect(p).toContain('public.can_review_submission(organization_id)');
    expect(p).toContain('EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = (SELECT auth.uid()))');
  });

  it('keeps reason and stage as snake_case codes, never free text', () => {
    expect(SQL).toContain("CONSTRAINT submission_attempts_reason_check CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,63}$')");
    expect(SQL).toContain("CONSTRAINT submission_attempts_stage_check CHECK (stage IS NULL OR stage ~ '^[a-z][a-z0-9_]{0,63}$')");
  });

  it('record_submission_attempt: DEFINER, caller checks, committed rows final, counts sanitised', () => {
    const fn = fnBlock('record_submission_attempt');
    expect(fn).toContain('SECURITY DEFINER SET search_path = \'\'');
    expect(fn).toContain("RETURN jsonb_build_object('ok', false, 'code', 'not_member');");
    // only finalize_submission writes 'committed'
    expect(fn).toContain("IF p_outcome = 'committed' THEN RETURN jsonb_build_object('ok', false, 'code', 'committed_is_server_only');");
    expect(fn).toContain('(s.submitted_by <> v_uid OR s.organization_id <> p_organization_id)');
    expect(fn).toContain("IF v_existing.outcome = 'committed' THEN");
    expect(fn).toContain("WHERE a.user_id = v_uid AND a.outcome <> 'committed'");
    expect(fn).toContain("WHERE e.key ~ '^[a-z][a-z0-9_]{0,39}$' AND jsonb_typeof(e.value) = 'number'");
    expect(SQL).toContain(
      'REVOKE EXECUTE ON FUNCTION public.record_submission_attempt(uuid, uuid, text, text, text, integer, jsonb, boolean, text, text) FROM PUBLIC, anon;'
    );
  });
});

describe('row-level security', () => {
  it('message and attachment rows go in only while the parent is uploading', () => {
    expect(policy('agents_can_insert_messages', 'public.submission_messages')).toContain(
      "AND (transaction_submissions.status)::text = 'uploading'::text"
    );
    const att = policy('agents_can_insert_attachments', 'public.submission_attachments');
    expect(att).toContain("AND (ts.status)::text = 'uploading'::text");
  });

  it('an attachment path must sit in its own {org}/{submission}/ folder', () => {
    const att = policy('agents_can_insert_attachments', 'public.submission_attachments');
    expect(att).toContain("split_part(submission_attachments.storage_path, '/'::text, 1) = (ts.organization_id)::text");
    expect(att).toContain("split_part(submission_attachments.storage_path, '/'::text, 2) = (ts.id)::text");
  });

  it('the reviewer branch of the submission UPDATE rule cannot write uploading', () => {
    const p = policy('transaction_submissions_update_public', 'public.transaction_submissions');
    const check = p.slice(p.indexOf('WITH CHECK'));
    expect(check).toContain("OR (((status)::text <> 'uploading'::text) AND (organization_id IN");
  });

  it('attachment-row DELETE also needs the abandon fence', () => {
    const p = policy('agents_can_delete_own_attachments', 'public.submission_attachments');
    expect(p).toContain('FOR DELETE');
    expect(p).toContain('transaction_submissions.submitted_by = (SELECT auth.uid() AS uid)');
    expect(p).toContain("(transaction_submissions.status)::text = 'uploading'::text");
    expect(p).toContain("coalesce(transaction_submissions.submission_metadata->>'abandoned', '') = 'true'");
  });

  it('storage DELETE: submitter of an uploading, abandoned submission, signed in', () => {
    const p = policy('"Submitters can delete attachments of their abandoned upload"', 'storage.objects');
    expect(p).toContain('FOR DELETE TO authenticated');
    expect(p).toContain("(bucket_id = 'submission-attachments'::text)");
    expect(p).toContain("(s.organization_id)::text = split_part(objects.name, '/'::text, 1)");
    expect(p).toContain('s.submitted_by = (SELECT auth.uid() AS uid)');
    expect(p).toContain("(s.status)::text = 'uploading'::text");
    expect(p).toContain("coalesce(s.submission_metadata->>'abandoned', '') = 'true'");
  });
});

describe('rollback-3403.sql', () => {
  it('drops what the migration adds and restores the three changed policies', () => {
    expect(RB).toContain('DROP POLICY IF EXISTS "Submitters can delete attachments of their abandoned upload" ON storage.objects;');
    expect(RB).toContain('DROP FUNCTION IF EXISTS public.finalize_submission(uuid, jsonb);');
    expect(RB).toContain('DROP FUNCTION IF EXISTS public.record_submission_attempt(uuid, uuid, text, text, text, integer, jsonb, boolean, text, text);');
    expect(RB).toContain('DROP TABLE IF EXISTS public.submission_attempts;');
    for (const name of [
      'transaction_submissions_update_public',
      'agents_can_delete_own_attachments',
      'agents_can_insert_attachments',
      'agents_can_insert_messages',
    ]) {
      expect(RB).toContain(`CREATE POLICY ${name} ON`);
    }
    expect(RB).not.toContain("'uploading'::text) AND (organization_id IN");
    expect(RB).not.toContain("submission_metadata->>'abandoned'");
  });
});
