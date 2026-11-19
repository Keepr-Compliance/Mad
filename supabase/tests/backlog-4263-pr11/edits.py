"""BACKLOG-4263 PR-11a: the two replaced functions are the previous statements with exactly these edits.

`python3 edits.py` prints the two statements; gen.py asserts the migration holds them verbatim.
Each edit is an exact-string replacement that must match once."""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
rd = lambda p: open(os.path.join(REPO, p), encoding='utf-8').read()
CORE = 'supabase/migrations/20261118110000_backlog_4263_todo_server_core.sql'
SNAP = 'supabase/migrations/20261031230000_backlog_3968_checklist_text_links.sql'


def edit(s, pairs):
    for o, n in pairs:
        assert s.count(o) == 1, (o[:80], s.count(o))
        s = s.replace(o, n)
    return s


def old_item():
    m = re.findall(r'(CREATE OR REPLACE FUNCTION public\._cloud_todo_item_json\(.*?\n\$f\$;\nREVOKE ALL ON FUNCTION public\._cloud_todo_item_json\([^\n]*\n)', rd(CORE), re.S)
    assert len(m) == 1
    return m[0]


def old_snap():
    m = re.findall(r'(CREATE OR REPLACE FUNCTION public\.snapshot_submission_checklists\(\n.*?\n\$\$;\n)', rd(SNAP), re.S)
    assert len(m) == 1
    return m[0]


SNAP_GRANTS = ('REVOKE EXECUTE ON FUNCTION public.snapshot_submission_checklists(uuid, jsonb) FROM PUBLIC, anon;\n'
               'GRANT EXECUTE ON FUNCTION public.snapshot_submission_checklists(uuid, jsonb) TO authenticated, service_role;\n')
assert SNAP_GRANTS in rd(SNAP)

ITEM_EDITS = [
    ("  SELECT jsonb_build_object('entity', 'item',", "  SELECT /*BODY:4263-11a-item*/ jsonb_build_object('entity', 'item',"),
    ("'at', t.done_eff_at, 'by', t.done_by, 'edit_seq', t.done_edit_seq),",
     "'at', t.done_eff_at, 'by', t.done_by, 'edit_seq', t.done_edit_seq, 'app', t.done_app),"),
    ("'note', jsonb_build_object('rev', t.note_rev, 'value', to_jsonb(t.note), 'at', t.note_eff_at, 'by', t.note_by, 'edit_seq', t.note_edit_seq),",
     "'note', jsonb_build_object('rev', t.note_rev, 'value', to_jsonb(t.note), 'at', t.note_eff_at, 'by', t.note_by, 'edit_seq', t.note_edit_seq,\n"
     "                                        'app', t.note_app),"),
]
SNAP_AUTHOR = """      -- 4263: the note's author (attribution_v, note_by {kind, app}), read and checked before the INSERT.
      -- A value that is malformed, or that a CHECK on the row would refuse, is stored as NULL; nothing here raises.
      v_attr := CASE WHEN jsonb_typeof(it -> 'attribution_v') = 'number' AND (it -> 'attribution_v') = '1'::jsonb THEN 1 END;
      v_nk := NULL;
      v_na := NULL;
      IF v_attr = 1 AND jsonb_typeof(it -> 'note_by') = 'object'
         AND jsonb_typeof(it -> 'note_by' -> 'kind') = 'string'
         AND (it -> 'note_by' ->> 'kind') IN ('agent', 'ai_app')
         AND NULLIF(btrim(it ->> 'note'), '') IS NOT NULL THEN
        v_nk := it -> 'note_by' ->> 'kind';
        IF v_nk = 'ai_app' AND jsonb_typeof(it -> 'note_by' -> 'app') = 'string'
           AND (it -> 'note_by' ->> 'app') IN ('anthropic', 'openai') THEN
          v_na := it -> 'note_by' ->> 'app';
        END IF;
      END IF;

"""
SNAP_EDITS = [
    ("  n_dropped_links   integer := 0;\nBEGIN\n  IF p_submission_id IS NULL",
     "  n_dropped_links   integer := 0;\n  v_attr       smallint;\n  v_nk         text;\n  v_na         text;\n"
     "BEGIN\n  /*BODY:4263-11a-snapshot*/\n  IF p_submission_id IS NULL"),
    ("      INSERT INTO public.submission_checklist_items\n", SNAP_AUTHOR + "      INSERT INTO public.submission_checklist_items\n"),
    ("         expected_document_type, is_checked, note, sort_order)\n",
     "         expected_document_type, is_checked, note, sort_order, attribution_v, note_by_kind, note_by_app)\n"),
    ("              COALESCE((it ->> 'sort_order')::integer, 0))\n      RETURNING id INTO v_item_id;",
     "              COALESCE((it ->> 'sort_order')::integer, 0),\n              v_attr, v_nk, v_na)\n      RETURNING id INTO v_item_id;"),
]


def new_item():
    return edit(old_item(), ITEM_EDITS)


def new_snap():
    return edit(old_snap(), SNAP_EDITS)


def body(stmt):
    m = re.search(r'\bAS (\$[A-Za-z_]*\$)', stmt)
    a = m.end()
    return stmt[a:stmt.index(m.group(1), a)]


if __name__ == '__main__':
    print(new_item())
    print(new_snap() + SNAP_GRANTS)
