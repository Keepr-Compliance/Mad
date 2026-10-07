/**
 * BACKLOG-3596 — the CI tripwire for the broker-tick carry-over migration.
 *
 * WHAT THIS CAN PROVE: what the migration file (and its rollback) says. CI has
 * no database. The behaviour is proved on a real Postgres by
 * supabase/tests/backlog-3596 (controls c00-c31, 62 mutants); this file pins
 * the lines a later edit is most likely to drop or loosen, so that such a
 * change fails in CI too.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const SUFFIX = '_backlog_3596_broker_checklist_ticks.sql';
const MIG_3477 = '20260925073000_backlog_3477_submission_checklist_review.sql';
const ROLLBACK = join(REPO, 'supabase/tests/backlog-3596/rollback.sql');
const REFUSALS = '20260928130000_backlog_3596_review_refusals.sql';
const REFUSALS_RB = join(REPO, 'supabase/tests/backlog-3596/rollback-refusals.sql');
const ADDED = '20260928170000_backlog_3596_added_checklist_ticks.sql';
const ADDED_RB = join(REPO, 'supabase/tests/backlog-3596/rollback-added.sql');

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

const carry = () => block(sql(), 'CREATE OR REPLACE FUNCTION public.carry_submission_checklist_reviews(', '$$;');
const snapshot = () => block(sql(), 'CREATE OR REPLACE FUNCTION public.snapshot_submission_checklists(', '$$;');
const tick = () => block(sql(), 'CREATE OR REPLACE FUNCTION public.set_submission_checklist_reviewer_check(', '$$;');
const updateRule = () =>
  block(sql(), 'CREATE POLICY transaction_submissions_update_public ON public.transaction_submissions', ' );');

/** A function's body as written (not collapsed), for verbatim comparison. */
function rawBody(text: string, name: string): string {
  const s = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(s).toBeGreaterThanOrEqual(0);
  const e = text.indexOf('$$;', text.indexOf('AS $$', s) + 5);
  return text.slice(s, e + 3);
}

const REVIEWER_ROLES =
  "(organization_id IN ( SELECT organization_members.organization_id FROM organization_members WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text])))))";

describe('BACKLOG-3596 — broker checklist ticks migration', () => {
  it('sorts after the BACKLOG-3547 migration and opens no transaction', () => {
    expect(migrationFile().slice(0, 14) > '20260927120000').toBe(true);
    expect(sql()).not.toMatch(/(^|;)\s*(BEGIN|COMMIT)\s*;/i);
  });

  it('adds no actor, no exemption and no role switch (ruling f581efb4)', () => {
    const s = sql();
    expect(s).not.toContain('guard_status_history_append_only');
    expect(s).not.toMatch(/service_role/i);
    expect(s).not.toMatch(/set_config|SET ROLE|SET LOCAL ROLE/i);
    expect(s).not.toContain('00000000-0000-0000-0000-000000000000');
    expect(s).not.toMatch(/DROP TRIGGER/i);
  });

  it('the carry takes only the submission id, runs as definer with an empty search_path, and only authenticated may call it', () => {
    const c = carry();
    expect(c).toContain('carry_submission_checklist_reviews( p_submission_id uuid ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = \'\'');
    expect(sql()).toContain('REVOKE EXECUTE ON FUNCTION public.carry_submission_checklist_reviews(uuid) FROM PUBLIC, anon;');
    expect(sql()).toContain('GRANT EXECUTE ON FUNCTION public.carry_submission_checklist_reviews(uuid) TO authenticated;');
  });

  it('the carry checks the caller before anything else', () => {
    const c = carry();
    expect(c).toContain(
      "IF NOT FOUND OR v_sub.submitted_by IS DISTINCT FROM v_uid OR v_sub.status IS DISTINCT FROM 'uploading' THEN RAISE EXCEPTION 'not_authorized'",
    );
    expect(c).toContain(
      "IF NOT COALESCE((public.check_feature_access(v_sub.organization_id, 'transaction_checklists') ->> 'allowed')::boolean, false) THEN RAISE EXCEPTION 'not_authorized'",
    );
  });

  it('the parent must be the same organization, deal and submitter, one version back (SR C-2)', () => {
    const c = carry();
    for (const term of [
      'OR v_parent.organization_id IS DISTINCT FROM v_sub.organization_id',
      'OR v_parent.local_transaction_id IS DISTINCT FROM v_sub.local_transaction_id',
      'OR v_parent.submitted_by IS DISTINCT FROM v_sub.submitted_by',
      'OR v_parent.version <> v_sub.version - 1 THEN',
    ]) {
      expect(c).toContain(term);
    }
  });

  it('matches on local item id AND title AND template, parent only (SR C-3)', () => {
    const c = carry();
    expect(c).toContain('AND ni.local_item_id = pi.local_item_id AND ni.title = pi.title AND nh.template_id IS NOT DISTINCT FROM ph.template_id');
    expect(c).toContain('WHERE pi.submission_id = v_parent.id AND pi.reviewer_checked AND pi.local_item_id IS NOT NULL');
  });

  it('carries the ORIGINAL reviewer and time, never the caller or now()', () => {
    const c = carry();
    expect(c).toContain(
      'SET reviewer_checked = true, reviewer_checked_by = r.reviewer_checked_by, reviewer_checked_at = r.reviewer_checked_at WHERE id = r.new_item_id;',
    );
    expect(c).not.toMatch(/reviewer_checked_by\s*=\s*v_uid/);
    expect(c).not.toMatch(/reviewer_checked_at\s*=\s*(v_now|now\(\))/);
  });

  it('compares the desktop ids of the evidence, never cloud row ids, and the note after trimming', () => {
    const c = carry();
    expect(c).toContain('COALESCE(a.local_attachment_id, m.local_message_id) AS local_id');
    expect(c).not.toMatch(/COALESCE\(lm\.submission_attachment_id/);
    expect(c).toContain("NULLIF(btrim(p.new_note), '') IS DISTINCT FROM NULLIF(btrim(p.parent_note), '')");
    // both directions of the set difference
    expect(c.match(/EXCEPT SELECT e\.kind, e\.local_id FROM evidence e/g)).toHaveLength(2);
  });

  it('locks the parent items and appends every entry in one statement', () => {
    const c = carry();
    expect(c).toMatch(/PERFORM 1 FROM public\.submission_checklist_items pi WHERE pi\.submission_id = v_parent\.id FOR SHARE;/);
    expect(c).toContain("SET status_history = COALESCE(status_history, '[]'::jsonb) || v_entries WHERE id = v_sub.id;");
    expect(c.match(/UPDATE public\.transaction_submissions/g)).toHaveLength(1);
  });

  it('writes the two typed entry kinds, each naming the caller', () => {
    const c = carry();
    expect(c.match(/'type', 'checklist_review_cleared', 'changed_at', v_now, 'changed_by', v_uid,/g)).toHaveLength(2);
    expect(c).toContain("'type', 'checklist_review_unavailable', 'changed_at', v_now, 'changed_by', v_uid, 'reason', v_unavailable");
    expect(c).toContain("v_unavailable := 'no_previous_copy';");
    expect(c).toContain("v_unavailable := 'unmatched_client';");
    expect(c).not.toMatch(/'changed_by', (?!v_uid)/);
  });

  it('the snapshot stays SECURITY INVOKER, stores local_item_id, and calls the carry after every insert', () => {
    const s = snapshot();
    expect(s).toContain("RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''");
    expect(s).toContain("NULLIF(it ->> 'local_item_id', ''),");
    const call = s.indexOf('v_carry := public.carry_submission_checklist_reviews(p_submission_id);');
    expect(call).toBeGreaterThan(s.lastIndexOf('INSERT INTO public.submission_checklist_link_members'));
    expect(call).toBeLessThan(s.indexOf('RETURN jsonb_build_object('));
    expect(s.match(/carry_submission_checklist_reviews/g)).toHaveLength(1);
  });

  it('the tick refuses a superseded version, any child status, after the authorization checks', () => {
    const t = tick();
    const sup = t.indexOf(
      "IF EXISTS (SELECT 1 FROM public.transaction_submissions c WHERE c.parent_submission_id = v_row.submission_id) THEN RAISE EXCEPTION 'superseded' USING ERRCODE = '42501';",
    );
    expect(sup).toBeGreaterThan(t.indexOf("RAISE EXCEPTION 'added_at_review'"));
    expect(sup).toBeGreaterThan(t.lastIndexOf("RAISE EXCEPTION 'not_authorized'"));
  });

  it('the submitter still inserts no reviewer or cleared value', () => {
    const p = block(sql(), 'CREATE POLICY submission_checklist_items_insert ON', ' );');
    for (const term of [
      'submission_checklist_items.reviewer_checked = false',
      'AND submission_checklist_items.reviewer_checked_by IS NULL',
      'AND submission_checklist_items.reviewer_checked_at IS NULL',
      'AND submission_checklist_items.cleared_reviewer_id IS NULL',
      'AND submission_checklist_items.cleared_at IS NULL',
      "AND ts.status = 'uploading'",
    ]) {
      expect(p).toContain(term);
    }
  });

  it('BACKLOG-3592: the reviewer UPDATE branch admits only open statuses; the rest is unchanged', () => {
    const u = updateRule();
    expect(u).toContain('FOR UPDATE TO public');
    expect(u).toContain(
      "USING ( ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'uploading'::text]))) OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text])) AND " +
        REVIEWER_ROLES +
        ') )',
    );
    expect(u).toContain(
      "WITH CHECK ( ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'resubmitted'::text, 'uploading'::text, 'submitted'::text]))) OR " +
        REVIEWER_ROLES +
        ' );',
    );
  });
});

describe('BACKLOG-3596 — rollback.sql', () => {
  const rb = () => read(ROLLBACK);
  const m3477 = () => read(join(MIGRATIONS_DIR, MIG_3477));

  it('restores the snapshot and tick bodies verbatim from BACKLOG-3477', () => {
    for (const name of ['snapshot_submission_checklists', 'set_submission_checklist_reviewer_check']) {
      expect(rawBody(rb(), name)).toBe(rawBody(m3477(), name));
    }
  });

  it('drops the carry and the new columns, and restores both rules', () => {
    const s = statements(rb());
    expect(s).toContain('DROP FUNCTION IF EXISTS public.carry_submission_checklist_reviews(uuid);');
    for (const col of ['cleared_at', 'cleared_reviewer_id', 'local_item_id']) {
      expect(s).toContain(`DROP COLUMN IF EXISTS ${col}`);
    }
    expect(s).toContain(
      "USING ( ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'uploading'::text]))) OR " + REVIEWER_ROLES + ' )',
    );
    const ins = block(s, 'CREATE POLICY submission_checklist_items_insert ON', ' );');
    expect(ins).not.toContain('cleared');
  });
});

describe('BACKLOG-3596 — the refusals file (add on a superseded version; new ticks on needs_changes)', () => {
  const raw = () => read(join(MIGRATIONS_DIR, REFUSALS));
  const s = () => statements(raw());
  const add = () => block(s(), 'CREATE OR REPLACE FUNCTION public.add_submission_checklist_at_review(', '$$;');
  const tk = () => block(s(), 'CREATE OR REPLACE FUNCTION public.set_submission_checklist_reviewer_check(', '$$;');
  const SUPERSEDED_ADD =
    "IF EXISTS (SELECT 1 FROM public.transaction_submissions c WHERE c.parent_submission_id = p_submission_id) THEN RAISE EXCEPTION 'superseded' USING ERRCODE = '42501';";
  const NEEDS_CHANGES =
    "IF v_row.status = 'needs_changes' THEN RAISE EXCEPTION 'not_open_for_review' USING ERRCODE = '42501';";

  it('sorts after the 3596 migration, opens no transaction, and touches only the two functions', () => {
    expect(REFUSALS.slice(0, 14) > migrationFile().slice(0, 14)).toBe(true);
    expect(s()).not.toMatch(/(^|;)\s*(BEGIN|COMMIT)\s*;/i);
    expect(s().match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2);
    expect(s()).not.toMatch(/CREATE (POLICY|TRIGGER)|DROP |ALTER TABLE|service_role|SET ROLE/i);
  });

  it('add refuses a superseded version, any child status, after the authorization, feature and status checks', () => {
    const a = add();
    const sup = a.indexOf(SUPERSEDED_ADD);
    expect(sup).toBeGreaterThan(a.lastIndexOf("RAISE EXCEPTION 'not_authorized'"));
    expect(sup).toBeGreaterThan(a.indexOf("RAISE EXCEPTION 'not_open_for_review'"));
    expect(sup).toBeLessThan(a.indexOf('INSERT INTO public.submission_checklists'));
  });

  it('the tick refuses a needs_changes version AFTER the superseded refusal', () => {
    const t = tk();
    const sup = t.indexOf("RAISE EXCEPTION 'superseded' USING ERRCODE = '42501';");
    const nc = t.indexOf(NEEDS_CHANGES);
    expect(sup).toBeGreaterThan(t.lastIndexOf("RAISE EXCEPTION 'not_authorized'"));
    expect(nc).toBeGreaterThan(sup);
    expect(nc).toBeLessThan(t.indexOf('UPDATE public.submission_checklist_items'));
  });

  it('the refusals are the only changes: bodies otherwise verbatim from their sources', () => {
    const m3477 = read(join(MIGRATIONS_DIR, MIG_3477));
    const m3596 = read(join(MIGRATIONS_DIR, migrationFile()));
    const strip = (body: string, lines: RegExp) => body.replace(lines, '');
    const addExtra = /  -- BACKLOG-3596: a newer version exists[\s\S]*?RAISE EXCEPTION 'superseded' USING ERRCODE = '42501';\n  END IF;\n/;
    const tickExtra = /  -- BACKLOG-3596: changes were requested[\s\S]*?RAISE EXCEPTION 'not_open_for_review' USING ERRCODE = '42501';\n  END IF;\n/;
    expect(rawBody(raw(), 'add_submission_checklist_at_review')).not.toBe(rawBody(m3477, 'add_submission_checklist_at_review'));
    expect(strip(rawBody(raw(), 'add_submission_checklist_at_review'), addExtra)).toBe(rawBody(m3477, 'add_submission_checklist_at_review'));
    expect(strip(rawBody(raw(), 'set_submission_checklist_reviewer_check'), tickExtra)).toBe(
      rawBody(m3596, 'set_submission_checklist_reviewer_check'),
    );
  });

  it('keeps both grants (definer, authenticated only)', () => {
    for (const fn of ['add_submission_checklist_at_review(uuid, uuid)', 'set_submission_checklist_reviewer_check(uuid, boolean)']) {
      expect(s()).toContain(`REVOKE EXECUTE ON FUNCTION public.${fn} FROM PUBLIC, anon;`);
      expect(s()).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
    }
    expect(add()).toContain("RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''");
    expect(tk()).toContain("RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''");
  });

  it('rollback-refusals.sql restores the add body from BACKLOG-3477 and the tick body from 3596, verbatim', () => {
    const rb = read(REFUSALS_RB);
    expect(rawBody(rb, 'add_submission_checklist_at_review')).toBe(
      rawBody(read(join(MIGRATIONS_DIR, MIG_3477)), 'add_submission_checklist_at_review'),
    );
    expect(rawBody(rb, 'set_submission_checklist_reviewer_check')).toBe(
      rawBody(read(join(MIGRATIONS_DIR, migrationFile())), 'set_submission_checklist_reviewer_check'),
    );
  });
});

describe('BACKLOG-3596 — the added-ticks file (ticks on a checklist added at review)', () => {
  const raw = () => read(join(MIGRATIONS_DIR, ADDED));
  const s = () => statements(raw());
  const tk = () => block(s(), 'CREATE OR REPLACE FUNCTION public.set_submission_checklist_reviewer_check(', '$$;');
  const cr = () => block(s(), 'CREATE OR REPLACE FUNCTION public.carry_submission_checklist_reviews(', '$$;');
  const ADDED_REFUSAL =
    "  IF v_row.added_at_review_by IS NOT NULL THEN\n    RAISE EXCEPTION 'added_at_review' USING ERRCODE = '42501';\n  END IF;\n";
  const CARRY_EDITS: Array<[string, string]> = [
    [
      '               pi.reviewer_checked_by, pi.reviewer_checked_at, pi.note AS parent_note,\n',
      '               pi.reviewer_checked_by, pi.reviewer_checked_at, pi.note AS parent_note,\n               ph.added_at_review_by AS added_by,\n',
    ],
    [
      '           AND ni.local_item_id = pi.local_item_id\n',
      '           AND ni.local_item_id = COALESCE(pi.local_item_id, CASE WHEN ph.added_at_review_by IS NOT NULL THEN pi.id::text END)\n',
    ],
    [
      '           AND pi.local_item_id IS NOT NULL\n',
      '           AND (pi.local_item_id IS NOT NULL OR ph.added_at_review_by IS NOT NULL)\n',
    ],
    [
      "          'reason', 'removed',\n",
      "          'reason', CASE WHEN r.added_by IS NOT NULL THEN 'not_carried' ELSE 'removed' END,\n",
    ],
  ];

  it('sorts after the refusals file, opens no transaction, and touches only the tick and the carry', () => {
    expect(ADDED.slice(0, 14) > REFUSALS.slice(0, 14)).toBe(true);
    expect(s()).not.toMatch(/(^|;)\s*(BEGIN|COMMIT)\s*;/i);
    expect(s().match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2);
    expect(s()).not.toMatch(/CREATE (POLICY|TRIGGER)|DROP |ALTER TABLE|service_role|SET ROLE/i);
  });

  it('the tick is the refusals-file body minus the added_at_review refusal; every other refusal stays, in order', () => {
    const before = rawBody(read(join(MIGRATIONS_DIR, REFUSALS)), 'set_submission_checklist_reviewer_check');
    expect(before.split(ADDED_REFUSAL)).toHaveLength(2);
    expect(rawBody(raw(), 'set_submission_checklist_reviewer_check')).toBe(before.replace(ADDED_REFUSAL, ''));
    const t = tk();
    expect(t).not.toContain("'added_at_review'");
    const auth = t.lastIndexOf("RAISE EXCEPTION 'not_authorized'");
    const open = t.indexOf("RAISE EXCEPTION 'not_open_for_review'");
    const sup = t.indexOf("RAISE EXCEPTION 'superseded'");
    const nc = t.indexOf("IF v_row.status = 'needs_changes' THEN RAISE EXCEPTION 'not_open_for_review'");
    expect(auth).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(auth);
    expect(sup).toBeGreaterThan(open);
    expect(nc).toBeGreaterThan(sup);
    expect(nc).toBeLessThan(t.indexOf('UPDATE public.submission_checklist_items'));
  });

  it('the carry is the 3596 body plus exactly the four added-item edits', () => {
    let expected = rawBody(read(join(MIGRATIONS_DIR, migrationFile())), 'carry_submission_checklist_reviews');
    for (const [from, to] of CARRY_EDITS) {
      expect(expected.split(from)).toHaveLength(2);
      expected = expected.replace(from, to);
    }
    expect(rawBody(raw(), 'carry_submission_checklist_reviews')).toBe(expected);
  });

  it('the carry still requires the same title and template for an added item', () => {
    const c = cr();
    expect(c).toContain('AND ni.title = pi.title AND nh.template_id IS NOT DISTINCT FROM ph.template_id');
  });

  it('keeps both grants (definer, empty search_path, authenticated only)', () => {
    for (const fn of ['set_submission_checklist_reviewer_check(uuid, boolean)', 'carry_submission_checklist_reviews(uuid)']) {
      expect(s()).toContain(`REVOKE EXECUTE ON FUNCTION public.${fn} FROM PUBLIC, anon;`);
      expect(s()).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
      expect(s()).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} TO [^;]*anon`));
    }
    expect(tk()).toContain("RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''");
    expect(cr()).toContain("RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''");
  });

  it('rollback-added.sql restores the tick from the refusals file and the carry from 3596, verbatim', () => {
    const rb = read(ADDED_RB);
    expect(rawBody(rb, 'set_submission_checklist_reviewer_check')).toBe(
      rawBody(read(join(MIGRATIONS_DIR, REFUSALS)), 'set_submission_checklist_reviewer_check'),
    );
    expect(rawBody(rb, 'carry_submission_checklist_reviews')).toBe(
      rawBody(read(join(MIGRATIONS_DIR, migrationFile())), 'carry_submission_checklist_reviews'),
    );
  });
});
