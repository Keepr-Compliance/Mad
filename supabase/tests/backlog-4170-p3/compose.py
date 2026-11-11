#!/usr/bin/env python3
"""BACKLOG-4170 PR3: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> [--applied]
Order: [--applied: record the current digest of every policy on the 16 target tables] -> rollback file
(so the call always starts from the production text) -> prelude (B0 counts, fixtures, P0 matrix read
BEFORE PR3) -> migration TWICE (the second apply proves it re-runs cleanly) -> controls.
--applied adds KA: the state keepr-test held before this call equals what the migration file produces.
Every call ends in RAISE, so the whole call rolls back. The migration is read from the working tree, so
a mutation applied to the file by mutate.py is what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(here, '..', '..', 'migrations', '20261111120000_backlog_4170_shared_table_policies.sql')
TARGETS = ['account_suspensions', 'admin_audit_logs', 'admin_permissions', 'admin_role_permissions', 'admin_roles',
           'app_lifecycle_events', 'credit_ledger', 'email_delivery_log', 'email_delivery_queue',
           'individual_invitations', 'organization_plans', 'payment_intents', 'pending_internal_invitations',
           'stripe_customers', 'support_response_templates', 'transaction_unlocks']
APPLIED = ("CREATE TEMP TABLE p4170p3_applied AS SELECT count(*) || '/' || md5(string_agg(tablename || policyname "
           "|| permissive || cmd || roles::text || coalesce(qual, '') || coalesce(with_check, ''), ',' ORDER BY tablename, "
           "policyname)) AS d FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (ARRAY["
           + ','.join("'%s'" % t for t in TARGETS) + "]);\n"
           "UPDATE p4170p3_applied SET d = d || '+' || (SELECT count(*) || '/' || md5(string_agg(tablename || policyname "
           "|| permissive || cmd || roles::text || coalesce(qual, '') || coalesce(with_check, ''), ',' ORDER BY tablename, "
           "policyname)) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'support_sla_settings');\n")

if __name__ == '__main__':
    out = sys.argv[1]
    args = sys.argv[2:]
    pre = open(os.path.join(here, 'prelude.sql')).read()
    body = open(os.path.join(here, 'controls.sql')).read()
    rb = open(os.path.join(here, 'rollback-4170-p3.sql')).read()
    m = open(MIG).read()
    for tag in ('$rb$', '$mg$', '$drv$'):
        assert tag not in rb and tag not in m, tag
    assert body.count('__ROLLBACK__') == 1 and body.count('__MIGRATION__') == 1
    body = body.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m)
    text = (APPLIED if '--applied' in args else '') + rb + '\n' + pre + '\n' + m + '\n' + m + '\n' + body
    open(out, 'w').write(text)
    print(out, len(text))
