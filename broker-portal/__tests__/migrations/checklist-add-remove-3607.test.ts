/**
 * BACKLOG-3607 — the CI tripwire for the checklist add/remove/restore migration.
 *
 * WHAT THIS CAN PROVE: what the migration file (and its rollback) says. CI has
 * no database. The behaviour is proved on a real Postgres by
 * supabase/tests/backlog-3607 (controls d01-d17 plus the 3596 controls, and
 * the mutant list); this file pins the lines a later edit is most likely to
 * drop or loosen, so that such a change fails in CI too.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const SUFFIX = '_backlog_3607_checklist_add_remove.sql';
const ROLLBACK = join(REPO, 'supabase/tests/backlog-3607/rollback-3607.sql');

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
}

function migrationFile(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(SUFFIX));
  expect(files).toHaveLength(1);
  return files[0];
}

/** Comments out, whitespace collapsed: the checks read statements only. */
function statements(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sql(): string {
  return statements(read(join(MIGRATIONS_DIR, migrationFile())));
}

/** One CREATE FUNCTION / CREATE POLICY statement, through its end marker. */
function block(text: string, start: string, end: string): string {
  const s = text.indexOf(start);
  expect(s).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(start, s + 1)).toBe(-1);
  const e = text.indexOf(end, s);
  expect(e).toBeGreaterThan(s);
  return text.slice(s, e + end.length);
}

const fn = (name: string) => block(sql(), `CREATE OR REPLACE FUNCTION public.${name}(`, '$$;');
const remove = () => fn('remove_submission_checklist_at_review');
const restore = () => fn('restore_submission_checklist_at_review');
const policy = (name: string, table: string) => block(sql(), `CREATE POLICY ${name} ON public.${table}`, ' );');

describe('BACKLOG-3607 — checklist add/remove/restore migration', () => {
  it('sorts after the last BACKLOG-3596 migration and opens no transaction', () => {
    expect(migrationFile().slice(0, 14) > '20260928170000').toBe(true);
    expect(sql()).not.toMatch(/(^|;)\s*(BEGIN|COMMIT)\s*;/i);
  });

  it('adds its columns only if absent, and the pair CHECK only once (safe to run twice)', () => {
    const s = sql();
    for (const col of [
      'ADD COLUMN IF NOT EXISTS removed_at_review_by uuid NULL',
      'ADD COLUMN IF NOT EXISTS removed_at_review_at timestamptz NULL',
      'ADD COLUMN IF NOT EXISTS restored_from_checklist_id uuid NULL',
      'ADD COLUMN IF NOT EXISTS restored_from_item_id uuid NULL',
    ]) {
      expect(s).toContain(col);
    }
    expect(s).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
    expect(s).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'submission_checklists_removed_pair_check'");
    expect(s).toContain(
      'ADD CONSTRAINT submission_checklists_removed_pair_check CHECK ((removed_at_review_by IS NULL) = (removed_at_review_at IS NULL));',
    );
  });

  it('the submitter can never insert a review-only value (SR C-1)', () => {
    const h = policy('submission_checklists_insert', 'submission_checklists');
    for (const col of ['added_at_review_by', 'added_at_review_at', 'removed_at_review_by', 'removed_at_review_at', 'restored_from_checklist_id']) {
      expect(h).toContain(`submission_checklists.${col} IS NULL`);
    }
    const i = policy('submission_checklist_items_insert', 'submission_checklist_items');
    expect(i).toContain('submission_checklist_items.restored_from_item_id IS NULL');
    expect(i).toContain('submission_checklist_items.reviewer_checked = false');
  });

  it('both new RPCs run as definer with an empty search_path, and only authenticated may call them', () => {
    expect(remove()).toContain(
      "remove_submission_checklist_at_review( p_checklist_id uuid ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''",
    );
    expect(restore()).toContain(
      "restore_submission_checklist_at_review( p_submission_id uuid, p_source_checklist_id uuid ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''",
    );
    const s = sql();
    for (const sig of ['remove_submission_checklist_at_review(uuid)', 'restore_submission_checklist_at_review(uuid, uuid)']) {
      expect(s).toContain(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC, anon;`);
      expect(s).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated;`);
    }
  });

  it('both RPCs lock the submission row FOR UPDATE, never NO KEY (SR C-8)', () => {
    expect(remove()).toContain('FROM public.transaction_submissions ts WHERE ts.id = v_hdr.submission_id FOR UPDATE;');
    expect(restore()).toContain('FROM public.transaction_submissions ts WHERE ts.id = p_submission_id FOR UPDATE;');
    expect(remove()).not.toContain('NO KEY');
    expect(restore()).not.toContain('NO KEY');
  });

  it('restore takes its source only from the qualified DIRECT parent (SR R-1)', () => {
    const r = restore();
    expect(r).toContain(
      'WHERE p.id = v_rs.parent_submission_id AND p.organization_id = v_rs.organization_id AND p.local_transaction_id = v_rs.local_transaction_id AND p.submitted_by = v_rs.submitted_by AND v_rs.version IS NOT NULL AND p.version = v_rs.version - 1;',
    );
    expect(r).toContain('WHERE h.id = p_source_checklist_id AND h.submission_id = v_par.id;');
    expect(r).toContain("AND h.e ->> 'source' = 'version' AND h.e ->> 'checklist_key' = v_key) THEN RETURN jsonb_build_object('status', 'not_removed');");
  });

  it('restore copies the broker ticks with their ORIGINAL reviewer and time, never the agent state or the template', () => {
    const r = restore();
    expect(r).toContain('si.expected_document_type, false, si.sort_order, si.reviewer_checked, si.reviewer_checked_by, si.reviewer_checked_at, si.id');
    expect(r).not.toMatch(/si\.note|si\.is_checked|si\.local_item_id/);
    expect(r).not.toContain('checklist_templates');
  });

  it('the remove count is documents and emails by local id, skipping members with none (R-4)', () => {
    const r = remove();
    expect(r).toContain("count(DISTINCT COALESCE(a.local_attachment_id, m.local_message_id)) FILTER (WHERE lm.kind = 'attachment')");
    expect(r).toContain("count(DISTINCT COALESCE(a.local_attachment_id, m.local_message_id)) FILTER (WHERE lm.kind = 'email')");
    expect(r).toContain('AND COALESCE(a.local_attachment_id, m.local_message_id) IS NOT NULL;');
    expect(r).toContain("'linked_documents', v_docs, 'linked_emails', v_emails");
  });

  it('the rollback drops both functions and all four columns', () => {
    const rb = statements(read(ROLLBACK));
    expect(rb).toContain('DROP FUNCTION IF EXISTS public.restore_submission_checklist_at_review(uuid, uuid);');
    expect(rb).toContain('DROP FUNCTION IF EXISTS public.remove_submission_checklist_at_review(uuid);');
    for (const col of ['removed_at_review_by', 'removed_at_review_at', 'restored_from_checklist_id', 'restored_from_item_id']) {
      expect(rb).toContain(`DROP COLUMN IF EXISTS ${col}`);
    }
    expect(rb).not.toMatch(/(^|;)\s*(BEGIN|COMMIT)\s*;/i);
  });
});
