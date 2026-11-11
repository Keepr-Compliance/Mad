#!/usr/bin/env python3
"""BACKLOG-4170 PR1: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> [--applied]
Order: [--applied: record the six functions' current state] -> rollback file (so the call always starts
from the production text) -> prelude (fixtures + P0 matrix read BEFORE PR1) -> migration TWICE (the
second apply proves it re-runs cleanly through its own pre-pin) -> controls.
--applied adds KA: the state keepr-test held before this call equals what the migration file produces.
Every call ends in RAISE, so the whole call rolls back. The migration is read from the working tree, so
a mutation applied to the file by mutate.py is what runs.
"""
import hashlib, json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(here, '..', '..', 'migrations', '20261111100000_backlog_4170_admin_group_a_permissions.sql')
KEYS = {'admin_search_users': 'search_users', 'admin_get_user_detail': 'get_user_detail',
        'admin_list_organizations': 'list_organizations', 'admin_get_audit_logs': 'get_audit_logs',
        'admin_get_brokerage_billing_live': 'billing_live', 'admin_get_solo_trial_setting': 'solo_trial'}


def bodies(text):
    """{harness key: md5 of the body} for every CREATE OR REPLACE FUNCTION in the text (prosrc = text between the $function$ tags)."""
    out = {}
    for name, body in re.findall(r'CREATE OR REPLACE FUNCTION public\.(\w+)\(.*?AS \$function\$(.*?)\$function\$;', text, re.S):
        out[KEYS[name]] = hashlib.md5(body.encode()).hexdigest()
    return out


APPLIED = ("CREATE TEMP TABLE p4170p1_applied AS SELECT jsonb_object_agg(s.k, jsonb_build_object('md5', md5(p.prosrc), "
           "'acl', p.proacl::text, 'config', p.proconfig::text, 'vol', p.provolatile::text)) AS st "
           "FROM (VALUES ('search_users', 'public.admin_search_users(text,integer)'), ('get_user_detail', 'public.admin_get_user_detail(uuid)'), "
           "('list_organizations', 'public.admin_list_organizations()'), "
           "('get_audit_logs', 'public.admin_get_audit_logs(integer,integer,text,text,timestamptz,timestamptz)'), "
           "('billing_live', 'public.admin_get_brokerage_billing_live()'), ('solo_trial', 'public.admin_get_solo_trial_setting()')) s(k, sig) "
           "JOIN pg_proc p ON p.oid = to_regprocedure(s.sig);\n")

if __name__ == '__main__':
    out = sys.argv[1]
    args = sys.argv[2:]
    pre = open(os.path.join(here, 'prelude.sql')).read()
    body = open(os.path.join(here, 'controls.sql')).read()
    rb = open(os.path.join(here, 'rollback-4170-p1.sql')).read()
    m = open(MIG).read()
    for tag in ('$rb$', '$mg$', '$drv$'):
        assert tag not in rb and tag not in m, tag
    post = bodies(m)
    assert len(post) == 6, post
    for ph in ('__ROLLBACK__', '__MIGRATION__', '__POSTMD5__'):
        assert body.count(ph) == 1, ph
    body = body.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m).replace('__POSTMD5__', json.dumps(post))
    text = (APPLIED if '--applied' in args else '') + rb + '\n' + pre + '\n' + m + '\n' + m + '\n' + body
    open(out, 'w').write(text)
    print(out, len(text))
