#!/usr/bin/env python3
"""BACKLOG-4263 PR-11a: writes, from the migration and the bodies it replaces:

  supabase/tests/backlog-4263-pr11/rollback-20261119100000.sql  rollback + its post-check (one transaction)
  supabase/tests/backlog-4263-pr11/harness-11a.sql              ONE call on the test database: fixtures, the old function
                                                                on a 2.48.0 payload, the md5 pre-check mutant, apply,
                                                                re-run, catalogue checks, the post-check files, controls,
                                                                mutations, timing before and after, rollback rehearsal;
                                                                ends in RAISE (nothing persists)
  supabase/tests/backlog-4263-pr11/catalog-facts.json           md5 of every body, mutant and generated file

The replaced functions must equal the previous statements with exactly the edits in edits.py (checked here).
Mutations are exact-string replacements: each must match once (else this script stops), and the harness proves in the
database that the mutated body is the one installed (md5) before its controls run.
`python3 gen.py check` regenerates in memory and fails if any written file differs.
`python3 gen.py report <kt-sql output file>` prints the harness result."""
import hashlib
import json
import os
import re
import sys

import edits

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = edits.REPO
VERSION, NAME = '20261119100000', 'backlog_4263_todo_part_app'
MIG_PATH = f'supabase/migrations/{VERSION}_{NAME}.sql'
rd = edits.rd
md5 = lambda s: hashlib.md5(s.encode()).hexdigest()
mig = rd(MIG_PATH)
lib = lambda n: rd(f'supabase/tests/backlog-4263-pr11/lib/{n}')
PROD = 'supabase/tests/backlog-4263-prod'

# ------------------------------------------------------------------------------------------------ the migration holds
NEW_ITEM, NEW_SNAP = edits.new_item(), edits.new_snap()
OLD_ITEM, OLD_SNAP = edits.old_item(), edits.old_snap()
assert mig.count(NEW_ITEM) == 1 and mig.count(NEW_SNAP + '\n\n' + edits.SNAP_GRANTS) == 1
B_ITEM_OLD, B_SNAP_OLD = md5(edits.body(OLD_ITEM)), md5(edits.body(OLD_SNAP))
B_ITEM_NEW, B_SNAP_NEW = md5(edits.body(NEW_ITEM)), md5(edits.body(NEW_SNAP))
assert (B_ITEM_OLD, B_SNAP_OLD) == ('dadfcc2f94a1bac429089ef4aa7b0d5b', '18168cc44ba03fadbd0de896e59806ea')
m = re.search(r'(CREATE OR REPLACE FUNCTION public\._cloud_todo_part_app\(\).*?\nEND \$f\$;\n)', mig, re.S)
PART_APP = m.group(1)
B_PART_APP = md5(edits.body(PART_APP))
SIG_ITEM = 'public._cloud_todo_item_json(public.cloud_deal_checklist_items)'
SIG_SNAP = 'public.snapshot_submission_checklists(uuid,jsonb)'
SIG_PART = 'public._cloud_todo_part_app()'


def edit1(s, o, n):
    assert s.count(o) == 1, (o[:80], s.count(o))
    return s.replace(o, n)


# ------------------------------------------------------------------------------------------------ mutants
APP_ONLY_AI = "    IF left(NEW.done_by, 7) = 'ai_app:' THEN                                                      /*APP:only_ai*/\n"
DONE_BLOCK = PART_APP[PART_APP.index('  IF v_done THEN\n'):PART_APP.index('  IF v_note THEN\n')]
MUTANTS = [  # (id, statement it replaces, original fragment, replacement, function signature, controls)
    ('M1a_lookup_on_every_write', PART_APP, '  IF v_done THEN\n',
     '  PERFORM 1 FROM public.mcp_connections c WHERE c.user_id = NEW.owner_user_id;\n  IF v_done THEN\n', SIG_PART, ['c_t1']),
    ('M1b_case_subselect_form', PART_APP, DONE_BLOCK,
     "  IF v_done THEN\n    NEW.done_app := CASE WHEN left(NEW.done_by, 7) = 'ai_app:' AND substr(NEW.done_by, 8) ~ v_re\n"
     "      THEN (SELECT c.provider FROM public.mcp_connections c WHERE c.id = substr(NEW.done_by, 8)::uuid AND c.user_id = NEW.owner_user_id) END;\n"
     "  END IF;\n", SIG_PART, ['c_t1', 'c_t2']),
    ('M2_cast_without_regex', PART_APP,
     '      IF v_ref ~ v_re THEN                                                                        /*APP:ref*/\n',
     '      IF true THEN                                                                        /*APP:ref*/\n', SIG_PART, ['c_t6']),
    ('M3_recompute_always', PART_APP,
     '    v_done := NEW.done_rev IS DISTINCT FROM OLD.done_rev;                                         /*APP:rev*/\n',
     '    v_done := true;                                         /*APP:rev*/\n', SIG_PART, ['c_t7']),
    ('M6_never_cleared', PART_APP, '    NEW.note_app := NULL;\n', '', SIG_PART, ['c_t3']),
    ('M5_snapshot_unchecked_values', NEW_SNAP, '              v_attr, v_nk, v_na)\n',
     "              CASE WHEN jsonb_typeof(it -> 'attribution_v') = 'number' THEN (it ->> 'attribution_v')::numeric::smallint END,\n"
     "              it -> 'note_by' ->> 'kind', it -> 'note_by' ->> 'app')\n", SIG_SNAP, ['c_s2']),
    ('M7_item_json_without_app', NEW_ITEM, ", 'app', t.done_app),", "),", SIG_ITEM, ['c_t2']),
]
MUT = []
for mid, stmt, o, n, sig, ctl in MUTANTS:
    s2 = edit1(stmt, o, n)
    MUT.append({'id': mid, 'sql': s2, 'md5': md5(edits.body(s2)), 'sig': sig, 'controls': ctl,
                'line': (n.strip() or '(line removed: ' + o.strip() + ')')[:200]})
    assert md5(edits.body(s2)) != md5(edits.body(stmt))
CONTROLS = ['c_t1', 'c_t2', 'c_t3', 'c_t4', 'c_t5', 'c_t6', 'c_t7', 'c_t8', 'c_t9', 'c_s1', 'c_s2', 'c_s3', 'c_g3']

# G2: one character of the snapshot md5 in the pre-check changed
G2_FROM, G2_TO = "'18168cc44ba03fadbd0de896e59806ea'", "'18168cc44ba03fadbd0de896e59806eb'"
MIG_G2 = edit1(mig, G2_FROM, G2_TO)


def edits_lit(s):
    return "'" + s.replace("'", "''") + "'"


def dq(s, tag):
    assert tag not in s, tag
    return tag + s + tag


# ------------------------------------------------------------------------------------------------ rollback
NEW_CHECKS = {'cloud_deal_checklist_items': ['cloud_deal_checklist_items_done_app_ck', 'cloud_deal_checklist_items_note_app_ck'],
              'submission_checklist_items': ['submission_checklist_items_attribution_v_ck', 'submission_checklist_items_note_by_kind_ck',
                                             'submission_checklist_items_note_by_app_ck', 'submission_checklist_items_note_by_app_kind_ck',
                                             'submission_checklist_items_note_by_note_ck', 'submission_checklist_items_note_by_v_ck']}
for t, cs in NEW_CHECKS.items():
    for c in cs:
        assert f'ADD CONSTRAINT {c}\n' in mig, c
rollback = f"""-- rollback-{VERSION}.sql (generated by supabase/tests/backlog-4263-pr11/gen.py; do not hand-edit)
-- Undoes {MIG_PATH}, in this order: drops the trigger cloud_deal_checklist_items_part_app and
-- _cloud_todo_part_app(); puts back _cloud_todo_item_json as 20261118110000 wrote it (md5 {B_ITEM_OLD}) and
-- snapshot_submission_checklists as 20261031230000 wrote it (md5 {B_SNAP_OLD}), with the same grants; drops the
-- eight CHECKs and the five columns (cloud_deal_checklist_items.done_app, note_app; submission_checklist_items.attribution_v,
-- note_by_kind, note_by_app); removes the ledger row.
-- The values in the five columns are dropped with them (the NOTICE gives the row counts). A submission's note author
-- dropped here cannot be recovered: the snapshot is not sent again.
-- One transaction; RAISEs (nothing changed) unless the pre-check and the post-check hold.
DO $pre11ar$
DECLARE v_i text; v_s text; v_p text;
BEGIN
  SELECT md5(p.prosrc) INTO v_i FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG_ITEM}');
  SELECT md5(p.prosrc) INTO v_s FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG_SNAP}');
  SELECT md5(p.prosrc) INTO v_p FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG_PART}');
  IF v_i IS DISTINCT FROM '{B_ITEM_NEW}' OR v_s IS DISTINCT FROM '{B_SNAP_NEW}' OR v_p IS DISTINCT FROM '{B_PART_APP}' THEN
    RAISE EXCEPTION 'ROLLBACK {VERSION}: the functions are not at the bodies {VERSION} wrote (md5 %, %, %)',
      coalesce(v_i, 'missing'), coalesce(v_s, 'missing'), coalesce(v_p, 'missing');
  END IF;
  RAISE NOTICE 'ROLLBACK {VERSION}: rows losing a value: cloud_deal_checklist_items %, submission_checklist_items %',
    (SELECT count(*) FROM public.cloud_deal_checklist_items t WHERE t.done_app IS NOT NULL OR t.note_app IS NOT NULL),
    (SELECT count(*) FROM public.submission_checklist_items i WHERE i.attribution_v IS NOT NULL OR i.note_by_kind IS NOT NULL OR i.note_by_app IS NOT NULL);
END
$pre11ar$;
DROP TRIGGER IF EXISTS cloud_deal_checklist_items_part_app ON public.cloud_deal_checklist_items;
DROP FUNCTION IF EXISTS public._cloud_todo_part_app();
{OLD_ITEM}
{OLD_SNAP}
{edits.SNAP_GRANTS}""" + ''.join(f"ALTER TABLE public.{t} DROP CONSTRAINT IF EXISTS {c};\n" for t, cs in NEW_CHECKS.items() for c in cs) + f"""ALTER TABLE public.submission_checklist_items
  DROP COLUMN IF EXISTS note_by_app,
  DROP COLUMN IF EXISTS note_by_kind,
  DROP COLUMN IF EXISTS attribution_v;
ALTER TABLE public.cloud_deal_checklist_items
  DROP COLUMN IF EXISTS note_app,
  DROP COLUMN IF EXISTS done_app;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}';
DO $post11ar$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'item_md5', (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG_ITEM}')),
    'snap_md5', (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG_SNAP}')),
    'snap_count', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'snapshot_submission_checklists'),
    'snap_secdef', (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG_SNAP}')),
    'snap_exec', jsonb_build_array(has_function_privilege('anon', '{SIG_SNAP}', 'EXECUTE'),
                                   has_function_privilege('authenticated', '{SIG_SNAP}', 'EXECUTE'),
                                   has_function_privilege('service_role', '{SIG_SNAP}', 'EXECUTE')),
    'part_app', to_regprocedure('{SIG_PART}') IS NOT NULL,
    'trigger', EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.cloud_deal_checklist_items'::regclass AND t.tgname = 'cloud_deal_checklist_items_part_app'),
    'columns', (SELECT count(*) FROM pg_attribute a WHERE a.attrelid IN ('public.cloud_deal_checklist_items'::regclass, 'public.submission_checklist_items'::regclass)
                  AND a.attname IN ('done_app', 'note_app', 'attribution_v', 'note_by_kind', 'note_by_app') AND NOT a.attisdropped),
    'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')) INTO v;
  IF v ->> 'item_md5' IS DISTINCT FROM '{B_ITEM_OLD}' OR v ->> 'snap_md5' IS DISTINCT FROM '{B_SNAP_OLD}'
     OR (v ->> 'snap_count')::int IS DISTINCT FROM 1 OR (v ->> 'snap_secdef')::boolean IS NOT FALSE
     OR v -> 'snap_exec' IS DISTINCT FROM '[false, true, true]'::jsonb OR (v ->> 'part_app')::boolean OR (v ->> 'trigger')::boolean
     OR (v ->> 'columns')::int IS DISTINCT FROM 0 OR (v ->> 'ledger')::int IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK {VERSION} FAILED, nothing changed: %', v;
  END IF;
  RAISE NOTICE 'ROLLBACK POST-CHECK {VERSION} OK: %', v;
END
$post11ar$;
"""
assert md5(edits.body(OLD_ITEM)) == B_ITEM_OLD

# ------------------------------------------------------------------------------------------------ harness
EXP_W = json.loads(rd(f'{PROD}/expected-write.json'))
PINS = EXP_W['postchecks'][VERSION]['pins']
WANT_DEF = {k[len('constraint '):-len(' definition')]: v['want'] for k, v in PINS.items() if k.endswith(' definition')}
WANT_TRG = PINS['trigger cloud_deal_checklist_items.cloud_deal_checklist_items_part_app']['want']
assert len(WANT_DEF) == 8
PC = {k: rd(f'{PROD}/postcheck-{k}.sql').rstrip().rstrip(';') for k in (VERSION, 'final-write', 'final', '20261118110000')}
GUARD = """DO $guard11a$
DECLARE n bigint := 0;
BEGIN
  IF pg_catalog.to_regclass('public.pm_backlog_items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.pm_backlog_items' INTO n;
  END IF;
  IF n > 100 THEN RAISE EXCEPTION 'harness-11a refuses to run: TEST DATABASE ONLY (production tracker rows present)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE md5(u.id::text) = '53a385187695375e2e8695625a20a77a') THEN
    RAISE EXCEPTION 'harness-11a refuses to run: TEST DATABASE ONLY (test database marker absent)';
  END IF;
END
$guard11a$;
"""
BEFORE = """DO $before11a$
DECLARE A uuid := pg_temp.id('A'); B uuid := pg_temp.id('B'); a text; s0 bigint; r jsonb;
BEGIN
  PERFORM pg_temp.rec('cat_before', pg_temp.cat());
  PERFORM pg_temp.put('cat_before', pg_temp.cat()::text);
  PERFORM pg_temp.rec('triggers_on_items_before', to_jsonb(pg_temp.cat() ->> 'triggers_items'));
  PERFORM pg_temp.rec('ledger_max_before', to_jsonb((SELECT max(version) FROM supabase_migrations.schema_migrations)));
  -- G1a: the old function on the 2.48.0 payload
  a := pg_temp.snap(A, pg_temp.id('S_old'), pg_temp.payload248());
  PERFORM pg_temp.put('g1_old_answer', a);
  PERFORM pg_temp.put('g1_old_rows', pg_temp.items(pg_temp.id('S_old'))::text);
  PERFORM pg_temp.rec('g1_old_answer', pg_temp.j(a));
  -- S3 / G3 before
  PERFORM pg_temp.put('s3_before', pg_temp.refusals()::text);
  PERFORM pg_temp.rec('s3_before', pg_temp.fxv('s3_before')::jsonb);
  PERFORM pg_temp.put('g3_before', pg_temp.snap(B, pg_temp.id('S_ref'), pg_temp.payload248()));
  PERFORM pg_temp.rec('g3_second_user_before', to_jsonb(left(pg_temp.fxv('g3_before'), 60)));
  -- reads of mcp_connections by a desktop push before the migration (baseline)
  s0 := pg_temp.scans();
  r := pg_temp.push(A, pg_temp.id('IA'), jsonb_build_array(pg_temp.op_set(pg_temp.id('m1'), 'title', '"Baseline"', 2)));
  PERFORM pg_temp.rec('reads_desktop_push_before', jsonb_build_object('reads', pg_temp.scans() - s0, 'status', pg_temp.st(r)));
  PERFORM pg_temp.rec('timing_before', jsonb_build_array(pg_temp.timed('T1'), pg_temp.timed('T2'), pg_temp.timed('T3')));
END
$before11a$;
"""
G2 = f"""DO $g2_11a$
DECLARE c0 jsonb := pg_temp.cat();
BEGIN
  BEGIN
    EXECUTE {dq(MIG_G2, '$migg2$')};
    PERFORM pg_temp.rec('g2', '"APPLIED (bad)"');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.rec('g2', jsonb_build_object('mutation', 'MUTATION APPLIED: {G2_FROM} -> {G2_TO} in the pre-check',
                                                 'sqlstate', SQLSTATE, 'msg', left(SQLERRM, 200), 'catalogue_unchanged', pg_temp.cat() = c0));
  END;
END
$g2_11a$;
"""
LEDGER = f"INSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES ('{VERSION}', '{NAME}', ARRAY['-- harness-11a']);\n"
AFTER = f"""DO $after11a$
DECLARE c jsonb; v text; w text; k text; q text; r jsonb := '{{}}';
BEGIN
  PERFORM pg_temp.rec('rowver_after_apply', pg_temp.rowver());
  PERFORM pg_temp.rec('rows_unchanged_by_apply', to_jsonb(pg_temp.rowver() = pg_temp.fxv('rowver_before')::jsonb));
  BEGIN
    EXECUTE {dq(mig, '$migrerun$')};
    PERFORM pg_temp.rec('rerun', '"ok"');
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.rec('rerun', jsonb_build_object('sqlstate', SQLSTATE, 'msg', left(SQLERRM, 200)));
  END;
  c := pg_temp.cat();
  PERFORM pg_temp.rec('cat_after', c);
  PERFORM pg_temp.rec('ledger_max_after', to_jsonb((SELECT max(version) FROM supabase_migrations.schema_migrations)));
  PERFORM pg_temp.rec('g3_catalogue', jsonb_build_object(
    'snap_attrs_equal_before', c -> 'snap_attrs' = (pg_temp.fxv('cat_before')::jsonb) -> 'snap_attrs',
    'item_json_attrs_equal_before', c -> 'item_json_attrs' = (pg_temp.fxv('cat_before')::jsonb) -> 'item_json_attrs',
    'snap_secdef', (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG_SNAP}')),
    'snap_signatures', (SELECT jsonb_agg(p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'snapshot_submission_checklists'),
    'policies_equal_before', c -> 'policies' = (pg_temp.fxv('cat_before')::jsonb) -> 'policies',
    'table_acl_equal_before', c -> 'acl_sub' = (pg_temp.fxv('cat_before')::jsonb) -> 'acl_sub' AND c -> 'acl_items' = (pg_temp.fxv('cat_before')::jsonb) -> 'acl_items',
    'part_app_exec', jsonb_build_array(has_function_privilege('anon', '{SIG_PART}', 'EXECUTE'), has_function_privilege('authenticated', '{SIG_PART}', 'EXECUTE'),
                                       has_function_privilege('service_role', '{SIG_PART}', 'EXECUTE')),
    'part_app_owner', (SELECT p.proowner::regrole::text FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG_PART}')),
    'part_app_secdef', (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG_PART}'))));
  -- the CHECK texts the post-check pins (report only there), from pg_get_constraintdef
  SELECT jsonb_object_agg(x.k, jsonb_build_array(x.got = x.want, CASE WHEN x.got = x.want THEN NULL ELSE x.got END)) INTO r
    FROM (VALUES {', '.join(f"({edits_lit(k)}, {edits_lit(v)}, (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.{k.split('.')[0]}'::regclass AND c.conname = {edits_lit(k.split('.')[1])}))" for k, v in WANT_DEF.items())}) x(k, want, got);
  PERFORM pg_temp.rec('checkdefs_match', r);
  -- the post-check files
  FOR k, q IN SELECT * FROM (VALUES ('{VERSION}', {dq(PC[VERSION], '$pcw1$')}), ('final-write', {dq(PC['final-write'], '$pcw2$')}),
                                   ('final', {dq(PC['final'], '$pcw3$')}), ('20261118110000', {dq(PC['20261118110000'], '$pcw4$')})) y(a, b) LOOP
    BEGIN
      EXECUTE q INTO v, w;
      PERFORM pg_temp.rec('postcheck_' || k, jsonb_build_object('postcheck', v, 'report_only', left(w, 1500)));
    EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.rec('postcheck_' || k, jsonb_build_object('error', left(SQLERRM, 1500)));
    END;
  END LOOP;
  -- breaks of the new pins: each must fail postcheck-{VERSION}
  FOR k, q IN SELECT * FROM (VALUES
      ('trigger_disabled', 'ALTER TABLE public.cloud_deal_checklist_items DISABLE TRIGGER cloud_deal_checklist_items_part_app'),
      ('second_trigger', 'CREATE TRIGGER x11a_extra BEFORE UPDATE ON public.cloud_deal_checklist_items FOR EACH ROW EXECUTE FUNCTION public._cloud_todo_part_app()'),
      ('trigger_columns', 'DROP TRIGGER cloud_deal_checklist_items_part_app ON public.cloud_deal_checklist_items; CREATE TRIGGER cloud_deal_checklist_items_part_app BEFORE INSERT OR UPDATE OF done_rev, done_by ON public.cloud_deal_checklist_items FOR EACH ROW EXECUTE FUNCTION public._cloud_todo_part_app()'),
      ('snapshot_granted_anon', 'GRANT EXECUTE ON FUNCTION public.snapshot_submission_checklists(uuid, jsonb) TO anon'),
      ('check_dropped', 'ALTER TABLE public.submission_checklist_items DROP CONSTRAINT submission_checklist_items_note_by_app_kind_ck')) y(a, b) LOOP
    BEGIN
      EXECUTE q;
      BEGIN
        EXECUTE {dq(PC[VERSION], '$pcw5$')} INTO v, w;
        PERFORM pg_temp.rec('break_' || k, jsonb_build_object('postcheck', v, 'report_only', left(w, 600)));
      EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.rec('break_' || k, jsonb_build_object('error', left(SQLERRM, 900)));
      END;
      RAISE EXCEPTION USING ERRCODE = 'MX003';
    EXCEPTION WHEN SQLSTATE 'MX003' THEN NULL;
              WHEN OTHERS THEN PERFORM pg_temp.rec('break_' || k, jsonb_build_object('break_error', left(SQLERRM, 300)));
    END;
  END LOOP;
END
$after11a$;
"""
CTL = "DO $ctl11a$\nBEGIN\n" + ''.join(f"  PERFORM pg_temp.rec('{c}', to_jsonb(pg_temp.iso('{c}')));\n" for c in CONTROLS) + "END\n$ctl11a$;\n"


def mutant_block(i, mt):
    calls = ''.join(f"    r := r || jsonb_build_object('{c}', pg_temp.iso('{c}'));\n" for c in mt['controls'])
    return f"""DO $mut{i}$
DECLARE r jsonb := '{{}}'; v text;
BEGIN
  BEGIN
    EXECUTE {dq(mt['sql'], f'$mbody{i}$')};
    v := (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('{mt['sig']}'));
    r := r || jsonb_build_object('applied', v = '{mt['md5']}', 'mutation', CASE WHEN v = '{mt['md5']}' THEN 'MUTATION APPLIED' ELSE 'NOT APPLIED' END,
                                 'line', {edits_lit(mt['line'])});
{calls}    RAISE EXCEPTION USING ERRCODE = 'MX002';
  EXCEPTION WHEN SQLSTATE 'MX002' THEN NULL;
            WHEN OTHERS THEN r := r || jsonb_build_object('error', left(SQLERRM, 300));
  END;
  PERFORM pg_temp.rec('{mt['id']}', r);
END
$mut{i}$;
"""


TAIL = f"""DO $tail11a$
DECLARE c0 jsonb := pg_temp.fxv('cat_before')::jsonb; c1 jsonb; d jsonb := '{{}}'; k text;
BEGIN
  PERFORM pg_temp.rec('timing_after', jsonb_build_array(pg_temp.timed('T4'), pg_temp.timed('T5'), pg_temp.timed('T6')));
  -- G1b: the rows the new function wrote, as the 6ffea3c39 loader selects them (checklists.ts:142-145, :160), ids dropped
  PERFORM pg_temp.rec('g1b_rows_as_loaded', (SELECT jsonb_agg(jsonb_build_object('title', i.title, 'description', i.description,
            'is_required', i.is_required, 'is_checked', i.is_checked, 'note', i.note, 'sort_order', i.sort_order, 'reviewer_checked', i.reviewer_checked,
            'reviewer_checked_by', i.reviewer_checked_by, 'reviewer_checked_at', i.reviewer_checked_at, 'cleared_reviewer_id', i.cleared_reviewer_id,
            'cleared_at', i.cleared_at, 'restored_from_item_id', i.restored_from_item_id) ORDER BY c.sort_order, i.sort_order)
       FROM public.submission_checklist_items i JOIN public.submission_checklists c ON c.id = i.submission_checklist_id
      WHERE i.submission_id = pg_temp.id('S_rb')));
  -- rollback rehearsal
  PERFORM pg_temp.rec('rb_rows_with_values', jsonb_build_object(
    'items', (SELECT count(*) FROM public.cloud_deal_checklist_items t WHERE t.done_app IS NOT NULL OR t.note_app IS NOT NULL),
    'sub', (SELECT count(*) FROM public.submission_checklist_items i WHERE i.attribution_v IS NOT NULL OR i.note_by_kind IS NOT NULL OR i.note_by_app IS NOT NULL)));
  BEGIN
    EXECUTE {dq(rollback, '$rb11a$')};
    c1 := pg_temp.cat();
    FOR k IN SELECT jsonb_object_keys(c0) LOOP
      IF c0 -> k IS DISTINCT FROM c1 -> k THEN d := d || jsonb_build_object(k, jsonb_build_array(c0 -> k, c1 -> k)); END IF;
    END LOOP;
    PERFORM pg_temp.rec('rollback', jsonb_build_object('ran', true, 'catalogue_differences_from_before', d));
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.rec('rollback', jsonb_build_object('error', left(SQLERRM, 600)));
  END;
  RAISE EXCEPTION 'H11A %', (SELECT jsonb_object_agg(k, v ORDER BY o) FROM pg_temp.h_out);
END
$tail11a$;
"""
# a snapshot written by the new function, for G1b (the 6ffea3c39 loader's column list)
G1B = """DO $g1b11a$
BEGIN
  PERFORM pg_temp.rec('g1b_snapshot', pg_temp.j(pg_temp.snap(pg_temp.id('A'), pg_temp.id('S_rb'), pg_temp.payload248() || jsonb_build_array(
    jsonb_build_object('template_id', NULL, 'template_name', 'With authors', 'sort_order', 2, 'items', jsonb_build_array(
      jsonb_build_object('title', 'AI note', 'local_item_id', 'p11a-li-9', 'description', NULL, 'is_required', true, 'expected_document_type', NULL,
                         'is_checked', true, 'note', 'Written by an app', 'sort_order', 0, 'links', '[]'::jsonb,
                         'attribution_v', 1, 'note_by', jsonb_build_object('kind', 'ai_app', 'app', 'anthropic'))))))));
END
$g1b11a$;
"""
harness = ("-- harness-11a.sql (generated by supabase/tests/backlog-4263-pr11/gen.py; do not hand-edit)\n"
           "-- TEST DATABASE ONLY. One call; ends in RAISE, so nothing is kept. Run: ~/.claude/bin/kt-sql harness-11a.sql,\n"
           "-- then ~/.claude/bin/kt-sql -c \"select extensions.pg_stat_statements_reset()\". Read: python3 gen.py report <output>.\n"
           + GUARD + "SET LOCAL lock_timeout = '10s';\n" + lib('helpers.sql') + lib('observe.sql') + lib('fixtures.sql') + BEFORE + G2
           + "DO $rv$ BEGIN PERFORM pg_temp.put('rowver_before', pg_temp.rowver()::text); END $rv$;\n"
           + mig + LEDGER + AFTER + lib('controls.sql') + CTL + ''.join(mutant_block(i, mt) for i, mt in enumerate(MUT)) + G1B + TAIL)

facts = {'migration_file_md5': md5(mig), 'bodies': {'item_json_old': B_ITEM_OLD, 'item_json_new': B_ITEM_NEW, 'snapshot_old': B_SNAP_OLD,
                                                    'snapshot_new': B_SNAP_NEW, 'part_app': B_PART_APP},
         'mutants': {mt['id']: {'md5': mt['md5'], 'controls': mt['controls'], 'line': mt['line']} for mt in MUT},
         'rollback_md5': md5(rollback), 'harness_md5': md5(harness), 'trigger_want': WANT_TRG}
OUTS = {'rollback-20261119100000.sql': rollback, 'harness-11a.sql': harness, 'catalog-facts.json': json.dumps(facts, indent=2) + '\n'}

if len(sys.argv) > 2 and sys.argv[1] == 'report':
    raw = open(sys.argv[2]).read()
    try:
        msg = json.loads(raw.splitlines()[0])['message']
    except Exception:
        msg = raw
    if 'H11A ' not in msg:
        print(msg[:4000])
        sys.exit(2)
    res = json.loads(msg[msg.index('H11A ') + 5:].split('\nCONTEXT')[0])
    for k, v in res.items():
        print(k, '=', json.dumps(v, ensure_ascii=False)[:1500])
    sys.exit(0)
if len(sys.argv) > 1 and sys.argv[1] == 'check':
    bad = [k for k, v in OUTS.items() if not os.path.exists(os.path.join(HERE, k)) or open(os.path.join(HERE, k)).read() != v]
    print('differs: ' + ', '.join(bad) if bad else 'all generated files match')
    sys.exit(1 if bad else 0)
for k, v in OUTS.items():
    open(os.path.join(HERE, k), 'w').write(v)
print(json.dumps({k: md5(v) for k, v in OUTS.items()}), len(harness))
