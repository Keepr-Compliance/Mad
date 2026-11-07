#!/usr/bin/env python3
"""BACKLOG-4192: write the migration and the rollback from the LIVE bodies of
pm_get_board_tasks(uuid,uuid,text) and pm_update_item_status(uuid,text).

The live definitions are read from keepr-test with ~/.claude/bin/kt-sql (pg_get_functiondef) and
saved under base/ (md5(prosrc) on keepr-test == production, checked 2026-11-07). With --offline the
saved base/ files are used instead. The body between the $function$ markers is checked against the
expected md5(prosrc) before any edit, every edit is an exact-once replace, and the new md5 is
computed from the edited body and written into the migration's post-check.

Usage: build_migration.py [--offline]   (writes the migration, the rollback; prints the md5s)
"""
import hashlib, json, os, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..', '..')
base_dir = os.path.join(here, 'base')
os.makedirs(base_dir, exist_ok=True)
VERSION = '20261107120000'
NAME = 'backlog_4192_pending_uat_board'

FUNCS = [
    # (signature, base file, expected md5(prosrc) before this change)
    ('public.pm_get_board_tasks(uuid,uuid,text)', 'pm_get_board_tasks.sql', 'cf39c28a71417a23e7e1ed0b950a5598'),
    ('public.pm_update_item_status(uuid,text)', 'pm_update_item_status.sql', 'dcb70919845b12cbe1bdc7ed68c9d3ec'),
]
GRANT_SIG = {
    'public.pm_get_board_tasks(uuid,uuid,text)': 'public.pm_get_board_tasks(uuid, uuid, text)',
    'public.pm_update_item_status(uuid,text)': 'public.pm_update_item_status(uuid, text)',
}
ACL_BEFORE = '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
ACL_AFTER = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'


def md5(s):
    return hashlib.md5(s.encode()).hexdigest()


def live_def(sig):
    out = subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), '-c',
                          f"select pg_get_functiondef('{sig}'::regprocedure) d"],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)[0]['d']


def split(d):
    a = d.index('AS $function$') + len('AS $function$')
    b = d.index('$function$', a)
    assert d.count('$function$') == 2, 'unexpected $function$ count'
    return d[:a], d[a:b], d[b:]


def once(text, old, new):
    n = text.count(old)
    assert n == 1, f'expected exactly one match, found {n}: {old[:60]!r}'
    return text.replace(old, new)


def edit_board(body):
    start = "    'testing', COALESCE(("
    end = "    ), '[]'::jsonb),\n"
    i = body.index(start)
    assert body.count(start) == 1
    j = body.index(end, i) + len(end)
    block = body[i:j]
    assert block.count("'testing'") == 2, 'testing block shape changed'
    new_block = block.replace("'testing'", "'pending_uat'")
    return body[:j] + new_block + body[j:]


def edit_status(body):
    body = once(body,
                "IF p_new_status NOT IN ('pending', 'in_progress', 'testing', 'completed',",
                "IF p_new_status NOT IN ('pending', 'in_progress', 'testing', 'pending_uat', 'completed',")
    body = once(body,
                "Must be one of: pending, in_progress, testing, completed,",
                "Must be one of: pending, in_progress, testing, pending_uat, completed,")
    return body


EDITS = {
    'public.pm_get_board_tasks(uuid,uuid,text)': edit_board,
    'public.pm_update_item_status(uuid,text)': edit_status,
}

offline = '--offline' in sys.argv
parts = []
for sig, fname, old_md5 in FUNCS:
    path = os.path.join(base_dir, fname)
    if offline:
        d = open(path).read()
    else:
        d = live_def(sig)
        open(path, 'w').write(d)
    head, body, tail = split(d)
    assert md5(body) == old_md5, f'{sig}: live md5(prosrc) {md5(body)} != expected {old_md5}'
    new_body = EDITS[sig](body)
    new_md5 = md5(new_body)
    assert new_md5 != old_md5
    parts.append(dict(sig=sig, head=head, tail=tail.rstrip('\n'), old=body, new=new_body,
                      old_md5=old_md5, new_md5=new_md5))


def precheck(label, want_any):
    lines = [f'DO $pre$\nDECLARE v_md5 text;\nBEGIN']
    for p in parts:
        allowed = ', '.join(f"'{m}'" for m in want_any(p))
        lines.append(f"""  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('{p['sig']}');
  IF v_md5 IS NULL OR v_md5 NOT IN ({allowed}) THEN
    RAISE EXCEPTION '{label}: {p['sig']} differs from the expected body (md5(prosrc) %)', v_md5;
  END IF;""")
    lines.append('END $pre$;\n')
    return '\n'.join(lines)


def postcheck(label, key, acls):
    allowed = ', '.join(f"'{a}'" for a in acls)
    lines = ['DO $post$\nDECLARE v_md5 text; v_acl text;\nBEGIN']
    for p in parts:
        lines.append(f"""  SELECT md5(prosrc), proacl::text INTO v_md5, v_acl FROM pg_proc WHERE oid = to_regprocedure('{p['sig']}');
  IF v_md5 IS DISTINCT FROM '{p[key]}' THEN
    RAISE EXCEPTION '{label}: {p['sig']} md5(prosrc) is %, expected {p[key]}', v_md5;
  END IF;
  IF v_acl IS NULL OR v_acl NOT IN ({allowed}) THEN
    RAISE EXCEPTION '{label}: {p['sig']} ACL is %', v_acl;
  END IF;""")
    lines.append('END $post$;\n')
    return '\n'.join(lines)


grants = []
for p in parts:
    g = GRANT_SIG[p['sig']]
    grants.append(f'REVOKE EXECUTE ON FUNCTION {g} FROM PUBLIC, anon;\n'
                  f'GRANT EXECUTE ON FUNCTION {g} TO authenticated, service_role;')

mig = f"""-- BACKLOG-4192: the PM board shows items whose status is 'pending_uat'.
--
-- pm_get_board_tasks(uuid,uuid,text): adds a 'pending_uat' key (built exactly like 'testing').
-- pm_update_item_status(uuid,text): accepts 'pending_uat' (the status CHECK on pm_backlog_items
-- already allows it).
-- Bodies: generated from the live definitions by supabase/tests/backlog-4192/build_migration.py;
-- every other line is unchanged. Caller checks unchanged (internal role; service_role bypass on
-- pm_update_item_status only).
-- Grants: EXECUTE revoked from PUBLIC and anon, granted to authenticated and service_role.
-- Pre-check: each md5(prosrc) must be the pre-4192 body or this body (a re-run is a no-op that
-- still runs the post-check).
-- ORDER: apply to production only after the admin portal that tolerates the new key is live.
-- Rollback: supabase/tests/backlog-4192/rollback-4192.sql. No transaction control in this file.

{precheck('4192 pre-check', lambda p: [p['old_md5'], p['new_md5']])}
"""
for p in parts:
    mig += f"{p['head']}{p['new']}{p['tail']};\n\n"
mig += '\n'.join(grants) + '\n\n'
mig += postcheck('4192 post-check', 'new_md5', [ACL_AFTER])

rb = f"""-- BACKLOG-4192 rollback: restores the pre-4192 bodies of pm_get_board_tasks and
-- pm_update_item_status. The EXECUTE revoke from PUBLIC/anon is deliberately kept (no client
-- calls these signed out); the post-check accepts either ACL.
-- Pre-check: each md5(prosrc) must be the 4192 body or the pre-4192 body (already rolled back).
-- Run as one transaction. Also remove the ledger row {VERSION} by hand if the venue keeps one.

{precheck('4192 rollback refused', lambda p: [p['new_md5'], p['old_md5']])}
"""
for p in parts:
    rb += f"{p['head']}{p['old']}{p['tail']};\n\n"
rb += postcheck('4192 rollback post-check', 'old_md5', [ACL_AFTER, ACL_BEFORE])

open(os.path.join(root, 'migrations', f'{VERSION}_{NAME}.sql'), 'w').write(mig)
open(os.path.join(here, 'rollback-4192.sql'), 'w').write(rb)
for p in parts:
    print(p['sig'], 'old', p['old_md5'], 'new', p['new_md5'])
