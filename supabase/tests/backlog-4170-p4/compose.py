#!/usr/bin/env python3
"""BACKLOG-4170 PR4: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> [--applied]
Order: prelude helpers -> [--applied: record the functions' and catalog's current state] -> rollback file
(so the call always starts from the pre-PR4 text) -> prelude fixtures + P0 matrix (read BEFORE PR4) ->
migration TWICE (the second apply proves it re-runs cleanly through its own pre-pin) -> controls.
--applied adds KA: the state keepr-test held before this call equals what the migration file produces.
Every call ends in RAISE, so the whole call rolls back. The migration is read from the working tree, so
a mutation applied to the file by mutate.py is what runs.
"""
import hashlib, json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(here, '..', '..', 'migrations', '20261111140000_backlog_4170_billing_write_permissions.sql')
RB2345 = os.path.join(here, '..', 'backlog-2345', 'rollback-2345.sql')
KEYS = {'admin_suspend_user': 'suspend', 'admin_unsuspend_user': 'unsuspend', 'admin_update_license': 'update_license',
        'admin_adjust_credits': 'adjust_credits', 'reinstate_suspended_account': 'reinstate',
        'create_active_individual_license': 'create_license', 'finalize_paid_unlock': 'finalize',
        'record_credit_purchase': 'purchase', 'record_refund': 'refund'}
SPLIT = '-- ===== fixtures + P0'


def bodies(text):
    """{harness key: md5 of the body} for every CREATE OR REPLACE FUNCTION in the text (prosrc = text between the $function$ tags)."""
    out = {}
    for name, body in re.findall(r'CREATE OR REPLACE FUNCTION public\.(\w+)\(.*?AS \$function\$(.*?)\$function\$;', text, re.S):
        if name not in KEYS:
            continue
        out[KEYS[name]] = hashlib.md5(body.encode()).hexdigest()
    return out


def c201():
    """The record_refund CREATE statement from the BACKLOG-2345 rollback (the body 2345 replaced)."""
    t = open(RB2345).read()
    i = t.index('CREATE OR REPLACE FUNCTION public.record_refund(')
    j = t.index('$rb$;', i) + len('$rb$;')
    return t[i:j]


APPLIED = "CREATE TEMP TABLE p4170p4_applied AS SELECT pg_temp.state() AS st, pg_temp.catalog() AS cat;\n"

if __name__ == '__main__':
    out = sys.argv[1]
    args = sys.argv[2:]
    pre = open(os.path.join(here, 'prelude.sql')).read()
    assert pre.count(SPLIT) == 1
    pre_defs, pre_run = pre[:pre.index(SPLIT)], pre[pre.index(SPLIT):]
    body = open(os.path.join(here, 'controls.sql')).read()
    rb = open(os.path.join(here, 'rollback-4170-p4.sql')).read()
    m = open(MIG).read()
    old = c201()
    for tag in ('$rb$', '$mg$', '$drv$', '$c201$'):
        assert tag not in rb and tag not in m, tag
    assert '$c201$' not in old
    post = bodies(m)
    assert len(post) == 9, post
    for ph in ('__ROLLBACK__', '__POSTMD5__', '__C201__'):
        assert body.count(ph) == (2 if ph == '__ROLLBACK__' else 1), ph
    assert body.count('__MIGRATION__') == 3
    body = (body.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m).replace('__POSTMD5__', json.dumps(post))
                .replace('__C201__', old))
    text = pre_defs + (APPLIED if '--applied' in args else '') + rb + '\n' + pre_run + '\n' + m + '\n' + m + '\n' + body
    open(out, 'w').write(text)
    print(out, len(text))
