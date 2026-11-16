#!/usr/bin/env python3
"""BACKLOG-4257 PR A: build one SQL text for a single kt-sql call on keepr-test (SR R2 composition).

Usage: compose.py <out.sql> [--applied]
  --applied leaves out steps 2-3: the controls run against the functions as applied.

  1. record the live _learn_pilot_report_invalid md5(prosrc) and proacl (set_config, txn-local)
  2. rollback-4257.sql            (fresh start: the 4219 validator, no signals validator)
  3. the 4257 migration TWICE      (fresh apply + idempotence)
  4. this directory's controls.sql (4257 controls; leaves pg_temp.p4257_result)
  5. backlog-4219/controls.sql run PLAIN against the 4257 functions (never its --with-migration,
     which would re-create the 4219 validator and test that instead), with three exact edits:
       __ROLLBACK__ = rollback-4257 + rollback-4219 (the real reverse order; 4219's S20 counts every
                      %learn_pilot% function, and the signals validator is one)
       its run() result is merged with the 4257 map, and the 4257 info is added to P4219_RESULT
Everything ends in the 4219 RAISE, so the whole call rolls back. Files are read from the working
tree, so a mutation applied by mutate.py is what runs.
"""
import hashlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build

here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.abspath(os.path.join(here, '..', '..', '..'))
rd = lambda p: open(os.path.join(repo, p)).read()
mig = rd('supabase/migrations/20261117120000_backlog_4257_learn_pilot_signals.sql')
m4219 = rd('supabase/migrations/20261112130000_backlog_4219_learn_pilot_report.sql')
rb57 = rd('supabase/tests/backlog-4257/rollback-4257.sql')
rb19 = rd('supabase/tests/backlog-4219/rollback-4219.sql')
c57 = rd('supabase/tests/backlog-4257/controls.sql')
c19 = rd('supabase/tests/backlog-4219/controls.sql')

for tag in ('$rb$', '$b$', '$f$', '$drv$', '$k4257$', '$pj$'):
    assert tag not in rb57 and tag not in rb19 and tag not in mig, tag

# the 4219 file's validator text: what rollback-4257 must put back
h = 'CREATE OR REPLACE FUNCTION public._learn_pilot_report_invalid(p JSONB)'
a = m4219.index('AS $fn$', m4219.index(h)) + len('AS $fn$')
md5_4219 = hashlib.md5(m4219[a:m4219.index('$fn$', a)].encode()).hexdigest()

fill = build.build()
fill['__MD5_4219__'] = md5_4219
fill['__RB4257__'] = rb57
for k, v in fill.items():
    assert c57.count(k) == 1, k
    if k != '__RB4257__':
        assert '$pj$' not in v and "'" not in v, k
    c57 = c57.replace(k, v)
assert '__' not in ''.join(x for x in c57.split("'") if x.startswith('__') and x.endswith('__'))


def once(text, old, new):
    assert text.count(old) == 1, 'compose edit matched %d times: %r' % (text.count(old), old[:60])
    return text.replace(old, new)


c19 = once(c19, '__ROLLBACK__', rb57 + '\n' + rb19)
c19 = once(c19, '  v_r := pg_temp.run();\n',
           '  v_r := pg_temp.run() || (SELECT r FROM pg_temp.p4257_result);\n')
# 4219's S0 needs an empty learn_pilot_reports; keepr-test is shared and may hold rows that existed
# before this run (never read here: counted only). Narrow S0 to this run's own rows: no row of a
# harness fixture user, and the total equals the count taken before the run.
S0_WHOLE = '      AND (SELECT count(*) FROM public.learn_pilot_reports) = 0\n'
S0_NARROW = ("      AND (SELECT count(*) FROM public.learn_pilot_reports WHERE user_id::text LIKE '00000000-0000-42__-8000-%') = 0\n"
             "      AND (SELECT count(*) FROM public.learn_pilot_reports) = current_setting('p4257.rows_before')::bigint\n")
c19 = once(c19, S0_WHOLE, S0_NARROW)
c19 = once(c19, "    'reds', (SELECT coalesce(",
           "    'info', (SELECT i FROM pg_temp.p4257_result),\n"
           "    'all', (SELECT jsonb_object_agg(e.key, e.value = 'PASS') FROM jsonb_each_text(v_r) e),\n"
           "    'reds', (SELECT coalesce(")

pre = ("SELECT set_config('p4257.rows_before', (SELECT count(*) FROM public.learn_pilot_reports)::text, true),\n       set_config('p4257.before_md5', coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid = "
       "to_regprocedure('public._learn_pilot_report_invalid(jsonb)')), 'none'), true),\n"
       "       set_config('p4257.before_acl', coalesce((SELECT proacl::text FROM pg_proc WHERE oid = "
       "to_regprocedure('public._learn_pilot_report_invalid(jsonb)')), 'none'), true);\n")
applied = '--applied' in sys.argv[2:]
text = pre + ('' if applied else rb57 + '\n' + mig + '\n' + mig + '\n') + c57 + '\n' + c19
out = sys.argv[1]
open(out, 'w').write(text)
print(out, len(text))
