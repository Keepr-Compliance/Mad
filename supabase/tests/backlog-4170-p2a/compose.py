#!/usr/bin/env python3
"""BACKLOG-4170 PR2a: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> [--applied]
Order: [--applied: record the 23 functions' current state] -> rollback file (so the call always starts
from the production text) -> prelude (fixtures + P0 matrix read BEFORE PR2a) -> migration TWICE (the
second apply proves it re-runs cleanly through its own pre-pin) -> controls.
--applied adds KA: the state keepr-test held before this call equals what the migration file produces.
Every call ends in RAISE, so the whole call rolls back. The migration is read from the working tree, so
a mutation applied to the file by mutate.py is what runs.
"""
import hashlib, json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(here, '..', '..', 'migrations', '20261111110000_backlog_4170_support_group_d_permissions.sql')
# harness key (name/nargs) -> regprocedure signature, in the migration's order
SIGS = [
    ('support_agent_analytics/1', 'public.support_agent_analytics(integer)'),
    ('support_assign_ticket/2', 'public.support_assign_ticket(uuid,uuid)'),
    ('support_bulk_update_tickets/3', 'public.support_bulk_update_tickets(uuid[],text,uuid)'),
    ('support_bulk_update_tickets/5', 'public.support_bulk_update_tickets(uuid[],text,uuid,text,uuid)'),
    ('support_bulk_update_tickets/6', 'public.support_bulk_update_tickets(uuid[],text,uuid,text,uuid,boolean)'),
    ('support_create_template/3', 'public.support_create_template(text,text,text)'),
    ('support_delete_template/1', 'public.support_delete_template(uuid)'),
    ('support_update_template/5', 'public.support_update_template(uuid,text,text,text,boolean)'),
    ('support_list_all_templates/0', 'public.support_list_all_templates()'),
    ('support_list_templates/0', 'public.support_list_templates()'),
    ('support_get_related_tickets/1', 'public.support_get_related_tickets(uuid)'),
    ('support_get_ticket_stats/0', 'public.support_get_ticket_stats()'),
    ('support_link_tickets/3', 'public.support_link_tickets(uuid,uuid,text)'),
    ('support_unlink_tickets/2', 'public.support_unlink_tickets(uuid,uuid)'),
    ('support_list_agents/0', 'public.support_list_agents()'),
    ('support_add_participant/4', 'public.support_add_participant(uuid,text,text,text)'),
    ('support_remove_participant/1', 'public.support_remove_participant(uuid)'),
    ('support_requester_recent_tickets/1', 'public.support_requester_recent_tickets(text)'),
    ('support_search_requesters/1', 'public.support_search_requesters(text)'),
    ('support_search_tickets_for_link/2', 'public.support_search_tickets_for_link(text,uuid)'),
    ('support_update_ticket_category/2', 'public.support_update_ticket_category(uuid,uuid)'),
    ('support_update_ticket_priority/2', 'public.support_update_ticket_priority(uuid,text)'),
    ('support_update_ticket_status/3', 'public.support_update_ticket_status(uuid,text,text)'),
]


def bodies(text):
    """{harness key: md5 of the body} for every CREATE OR REPLACE FUNCTION in the text, in file order
    (prosrc = text between the $function$ tags). Overloads are told apart by position."""
    found = re.findall(r'CREATE OR REPLACE FUNCTION public\.(\w+)\(.*?AS \$function\$(.*?)\$function\$;', text, re.S)
    assert len(found) == len(SIGS), len(found)
    out = {}
    for (name, body), (k, _) in zip(found, SIGS):
        assert k.split('/')[0] == name, (k, name)
        out[k] = hashlib.md5(body.encode()).hexdigest()
    return out


def sigs_values():
    return ', '.join("('%s', '%s')" % kv for kv in SIGS)


APPLIED = ("CREATE TEMP TABLE p4170p2a_applied AS SELECT jsonb_object_agg(s.k, jsonb_build_object('md5', md5(p.prosrc), "
           "'acl', p.proacl::text, 'config', p.proconfig::text, 'vol', p.provolatile::text)) AS st "
           "FROM (VALUES " + sigs_values() + ") s(k, sig) JOIN pg_proc p ON p.oid = to_regprocedure(s.sig);\n")

if __name__ == '__main__':
    out = sys.argv[1]
    args = sys.argv[2:]
    pre = open(os.path.join(here, 'prelude.sql')).read()
    body = open(os.path.join(here, 'controls.sql')).read()
    rb = open(os.path.join(here, 'rollback-4170-p2a.sql')).read()
    m = open(MIG).read()
    for tag in ('$rb$', '$mg$', '$drv$'):
        assert tag not in rb and tag not in m, tag
    post = bodies(m)
    assert len(post) == 23, post
    assert pre.count('__SIGS__') == 1
    pre = pre.replace('__SIGS__', sigs_values())
    for ph in ('__ROLLBACK__', '__MIGRATION__', '__POSTMD5__'):
        assert body.count(ph) == 1, ph
    body = body.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m).replace('__POSTMD5__', json.dumps(post))
    text = (APPLIED if '--applied' in args else '') + rb + '\n' + pre + '\n' + m + '\n' + m + '\n' + body
    open(out, 'w').write(text)
    print(out, len(text))
