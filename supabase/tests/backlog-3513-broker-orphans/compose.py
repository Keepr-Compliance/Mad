#!/usr/bin/env python3
"""BACKLOG-3513 orphans (migration 20261112210000): build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> [--regression]
Default: tracking off; 20261112200000 twice; a ledger row for 20261112200000 (inside the call, so it
rolls back); 20261112210000 twice (the second apply proves the pin's second-run branch); the PR-2
prelude (fixtures); controls.sql here. The controls end in RAISE, so the whole call rolls back.
--regression: the PR-2 harness (../backlog-3513-broker) unchanged, with the ledger row and
20261112210000 applied after its migrations: every PR-2 control must still pass on top of this file.
Migration texts are read from the working tree, so a mutation applied by mutate.py is what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
p2 = os.path.join(here, '..', 'backlog-3513-broker')
migs = os.path.join(here, '..', '..', 'migrations')
m200 = open(os.path.join(migs, '20261112200000_backlog_3513_broker_report_definitions.sql')).read()
m210 = open(os.path.join(migs, '20261112210000_backlog_3513_broker_report_orphans.sql')).read()
pre = open(os.path.join(p2, 'prelude.sql')).read()
ledger = ("INSERT INTO supabase_migrations.schema_migrations (version, name) "
          "VALUES ('20261112200000', 'backlog_3513_broker_report_definitions') ON CONFLICT DO NOTHING;\n")
out = sys.argv[1]
track = "set local pg_stat_statements.track = 'none';\n"
if '--regression' in sys.argv:
    ctl = open(os.path.join(p2, 'controls.sql')).read()
    rb = open(os.path.join(p2, 'rollback.sql')).read()
    assert ctl.count('__ROLLBACK__') == 1 and ctl.count('__MIGRATION__') == 1
    ctl = ctl.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m200)
    text = track + m200 + '\n' + m200 + '\n' + ledger + m210 + '\n' + pre + '\n' + ctl
else:
    ctl = open(os.path.join(here, 'controls.sql')).read()
    rb = open(os.path.join(here, 'rollback.sql')).read()
    assert ctl.count('__ROLLBACK__') == 1 and ctl.count('__MIGRATION__') == 3
    for tag in ('$rb$', '$mg$', '$b$', '$q$', '$drv$'):
        assert tag not in rb and tag not in m210, tag
    ctl = ctl.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m210)
    text = track + m200 + '\n' + m200 + '\n' + ledger + m210 + '\n' + m210 + '\n' + pre + '\n' + ctl
open(out, 'w').write(text)
print(out, len(text))
