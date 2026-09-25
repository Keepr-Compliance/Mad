/**
 * BACKLOG-3477 — the CI tripwire for the submission checklist review migration.
 *
 * WHAT THIS CAN PROVE: what the migration file says. CI has no database. The
 * behaviour is proved on a real Postgres by supabase/tests/backlog-3477
 * (controls c00-c17, 46 mutants); this file pins the statements a later edit
 * is most likely to drop, so that a change to them fails in CI too.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../../../supabase/migrations');
const SUFFIX = '_backlog_3477_submission_checklist_review.sql';

function migrationFile(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(SUFFIX));
  expect(files).toHaveLength(1);
  return files[0];
}

function migrationSql(): string {
  const raw = readFileSync(join(MIGRATIONS_DIR, migrationFile()), 'utf8').replace(/\r\n?/g, '\n');
  // Comments out, whitespace collapsed: the checks read statements only.
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The body of one CREATE OR REPLACE FUNCTION, through its closing $$. */
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  return sql.slice(start, close + 2);
}

/** One CREATE POLICY statement, through its semicolon. */
function policy(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE POLICY ${name} ON`);
  expect(start).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf(';', start) + 1);
}

const READ_POLICIES = [
  'transaction_submissions_select_public',
  'message_access_via_submission',
  'attachment_access_via_submission',
  'submission_checklists_select',
  'submission_checklist_items_select',
  'submission_checklist_links_select',
  'submission_checklist_link_members_select',
];

describe('BACKLOG-3477 — submission checklist review migration', () => {
  it('sorts after the BACKLOG-3476 migration', () => {
    expect(migrationFile().slice(0, 14) > '20260924234221').toBe(true);
  });

  it('opens no transaction of its own', () => {
    expect(migrationSql()).not.toMatch(/(^|;)\s*(BEGIN|COMMIT)\s*;/i);
  });

  it('adds the reviewer and frozen-copy columns re-runnably', () => {
    const sql = migrationSql();
    for (const col of [
      'reviewer_checked boolean NOT NULL DEFAULT false',
      'reviewer_checked_by uuid NULL',
      'reviewer_checked_at timestamptz NULL',
      'description text NULL',
      'expected_document_type text NULL',
      'added_at_review_by uuid NULL',
      'added_at_review_at timestamptz NULL',
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    // Attribution survives the member's removal: no foreign key on either user column.
    expect(sql).not.toMatch(/(reviewer_checked_by|added_at_review_by)[^;,]*REFERENCES/i);
  });

  it('keeps one role list, in can_review_submission', () => {
    const sql = migrationSql();
    const helper = functionBody(sql, 'can_review_submission');
    expect(helper).toContain("om.role IN ('broker', 'admin', 'it_admin')");
    expect(helper).toContain('SECURITY DEFINER');
    expect(helper).toContain("SET search_path = ''");
    // Nowhere else in the file names a reviewer role.
    const rest = sql.replace(helper, '');
    expect(rest).not.toMatch(/'(broker|it_admin)'/);
    for (const name of READ_POLICIES) {
      const p = policy(sql, name);
      expect(p).toContain('public.can_review_submission(');
      expect(p).not.toMatch(/'admin'/);
    }
  });

  it('refuses reviewer values in the submitter INSERT rules', () => {
    const sql = migrationSql();
    expect(policy(sql, 'submission_checklists_insert')).toContain(
      'submission_checklists.added_at_review_by IS NULL AND submission_checklists.added_at_review_at IS NULL',
    );
    expect(policy(sql, 'submission_checklist_items_insert')).toContain(
      'submission_checklist_items.reviewer_checked = false AND submission_checklist_items.reviewer_checked_by IS NULL AND submission_checklist_items.reviewer_checked_at IS NULL',
    );
    expect(policy(sql, 'submission_checklists_insert')).toContain("check_feature_access(ts.organization_id, 'transaction_checklists')");
    expect(policy(sql, 'submission_checklists_insert')).toContain("ts.status = 'uploading'");
  });

  it('runs the snapshot as the caller and the reviewer functions as definer, all with an empty search_path', () => {
    const sql = migrationSql();
    expect(functionBody(sql, 'snapshot_submission_checklists')).toContain('SECURITY INVOKER');
    for (const name of ['set_submission_checklist_reviewer_check', 'add_submission_checklist_at_review']) {
      const body = functionBody(sql, name);
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain("SET search_path = ''");
      expect(body).toContain('public.can_review_submission(');
      // The history append is one statement on the row's own value.
      expect(body).toContain("SET status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(");
      // The appended entry carries no status key (status entries belong to the status trigger).
      const append = body.slice(body.indexOf('SET status_history'), body.indexOf(' WHERE id =', body.indexOf('SET status_history')));
      expect(append).toContain("'type', ");
      expect(append).not.toMatch(/'status',/);
    }
    for (const name of ['snapshot_submission_checklists', 'guard_status_history_append_only']) {
      expect(functionBody(sql, name)).toContain("SET search_path = ''");
    }
  });

  it('never lets the tick write the agent\'s is_checked', () => {
    const body = functionBody(migrationSql(), 'set_submission_checklist_reviewer_check');
    expect(body).not.toMatch(/\bis_checked\s*=/);
  });

  it('revokes EXECUTE from PUBLIC and anon on the three API functions', () => {
    const sql = migrationSql();
    for (const sig of [
      'snapshot_submission_checklists(uuid, jsonb)',
      'set_submission_checklist_reviewer_check(uuid, boolean)',
      'add_submission_checklist_at_review(uuid, uuid)',
    ]) {
      expect(sql).toContain(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC, anon;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated;`);
    }
  });

  it('attaches the append-only guard to transaction_submissions, on INSERT and UPDATE', () => {
    const sql = migrationSql();
    expect(sql).toContain(
      'CREATE TRIGGER status_history_append_only BEFORE INSERT OR UPDATE ON public.transaction_submissions FOR EACH ROW EXECUTE FUNCTION public.guard_status_history_append_only();',
    );
    // BEFORE triggers fire in name order: the guard must sort before the status trigger.
    const trigger = sql.match(/CREATE TRIGGER (\w+) BEFORE INSERT OR UPDATE ON public\.transaction_submissions/);
    expect(trigger).not.toBeNull();
    expect(trigger![1] < 'track_status_changes').toBe(true);
    const guard = functionBody(sql, 'guard_status_history_append_only');
    expect(guard).toContain("IF v_role IS NULL OR v_role = 'service_role' THEN");
    expect(guard).toContain('FOR i IN 0 .. v_old_len - 1 LOOP IF (v_new -> i) IS DISTINCT FROM (v_old -> i) THEN');
    expect(guard).toContain("jsonb_typeof(v_new) <> 'array'");
  });

  it('refuses a new row that already carries history', () => {
    const guard = functionBody(migrationSql(), 'guard_status_history_append_only');
    expect(guard).toContain(
      "IF TG_OP = 'INSERT' THEN IF v_new IS NOT NULL AND v_new <> '[]'::jsonb THEN RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501'; END IF; RETURN NEW; END IF;",
    );
  });

  it('requires every appended entry to be typed and to name the caller', () => {
    const guard = functionBody(migrationSql(), 'guard_status_history_append_only');
    expect(guard).toContain(
      "IF jsonb_typeof(v_elem) <> 'object' OR NOT (v_elem ? 'type') OR lower(COALESCE(v_elem ->> 'changed_by', '')) IS DISTINCT FROM COALESCE(auth.uid()::text, '-') THEN RAISE EXCEPTION 'status_history_append_only'",
    );
  });

  it('refuses a tick on a checklist added at review', () => {
    const body = functionBody(migrationSql(), 'set_submission_checklist_reviewer_check');
    expect(body).toContain(
      "IF v_row.added_at_review_by IS NOT NULL THEN RAISE EXCEPTION 'added_at_review' USING ERRCODE = '42501'; END IF;",
    );
  });

  it('adds a checklist at review only while the submission is open for review, never in needs_changes', () => {
    const body = functionBody(migrationSql(), 'add_submission_checklist_at_review');
    expect(body).toContain(
      "IF v_sub.status IS NULL OR v_sub.status NOT IN ('submitted', 'resubmitted', 'under_review') THEN RAISE EXCEPTION 'not_open_for_review'",
    );
    expect(body).not.toMatch(/'needs_changes'/);
  });
});
