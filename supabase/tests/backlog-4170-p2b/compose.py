#!/usr/bin/env python3
"""BACKLOG-4170 PR2b: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> [--applied]
Order: [--applied: record the 9 functions' current state] -> rollback file (so the call always starts
from the production text) -> prelude (fixtures + P0 matrix read BEFORE PR2b) -> migration TWICE (the
second apply proves it re-runs cleanly through its own pre-pin) -> controls.
--applied adds KA: the state keepr-test held before this call equals what the migration file produces.
Every call ends in RAISE, so the whole call rolls back. The migration is read from the working tree, so
a mutation applied to the file by mutate.py is what runs.
"""
import hashlib, json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(here, '..', '..', 'migrations', '20261111115000_backlog_4170_support_group_e_permissions.sql')
# harness key (name/nargs) -> regprocedure signature, in the migration's order
SIGS = [
    ('support_add_message/5', 'public.support_add_message(uuid,text,text,text,text)'),
    ('support_get_ticket_detail/2', 'public.support_get_ticket_detail(uuid,text)'),
    ('support_list_tickets/10', 'public.support_list_tickets(text,text,uuid,uuid,text,text,integer,integer,text,text)'),
    ('support_add_attachment/6', 'public.support_add_attachment(uuid,uuid,text,bigint,text,text)'),
    ('support_add_diagnostic_attachment/6', 'public.support_add_diagnostic_attachment(uuid,text,bigint,text,text,integer)'),
    ('support_delete_own_attachment/1', 'public.support_delete_own_attachment(uuid)'),
    ('support_list_attachments/1', 'public.support_list_attachments(uuid)'),
    ('support_list_events/1', 'public.support_list_events(uuid)'),
    ('support_record_attachment_access/1', 'public.support_record_attachment_access(uuid)'),
]


def bodies(text):
    """{harness key: md5 of the body} for every CREATE OR REPLACE FUNCTION in the text, in file order
    (prosrc = text between the $function$ tags)."""
    found = re.findall(r'CREATE OR REPLACE FUNCTION public\.(\w+)\(.*?AS \$function\$(.*?)\$function\$;', text, re.S)
    assert len(found) == len(SIGS), len(found)
    out = {}
    for (name, body), (k, _) in zip(found, SIGS):
        assert k.split('/')[0] == name, (k, name)
        out[k] = hashlib.md5(body.encode()).hexdigest()
    return out


def sigs_values():
    return ', '.join("('%s', '%s')" % kv for kv in SIGS)


APPLIED = ("CREATE TEMP TABLE p4170p2b_applied AS SELECT jsonb_object_agg(s.k, jsonb_build_object('md5', md5(p.prosrc), "
           "'acl', p.proacl::text, 'config', p.proconfig::text, 'vol', p.provolatile::text)) AS st "
           "FROM (VALUES " + sigs_values() + ") s(k, sig) JOIN pg_proc p ON p.oid = to_regprocedure(s.sig);\n")

if __name__ == '__main__':
    out = sys.argv[1]
    args = sys.argv[2:]
    pre = open(os.path.join(here, 'prelude.sql')).read()
    body = open(os.path.join(here, 'controls.sql')).read()
    rb = open(os.path.join(here, 'rollback-4170-p2b.sql')).read()
    m = open(MIG).read()
    for tag in ('$rb$', '$mg$', '$drv$'):
        assert tag not in rb and tag not in m, tag
    post = bodies(m)
    assert len(post) == 9, post
    assert pre.count('__SIGS__') == 1
    pre = pre.replace('__SIGS__', sigs_values())
    for ph in ('__ROLLBACK__', '__MIGRATION__', '__POSTMD5__'):
        assert body.count(ph) == 1, ph
    body = body.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m).replace('__POSTMD5__', json.dumps(post))
    text = (APPLIED if '--applied' in args else '') + rb + '\n' + pre + '\n' + m + '\n' + m + '\n' + body
    open(out, 'w').write(text)
    print(out, len(text))
