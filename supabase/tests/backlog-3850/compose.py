#!/usr/bin/env python3
"""BACKLOG-3850: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> <mode>
  mode = base | M1 | M3 | M4 | M5 | M2c | rollback | live
  base/M*:  migration (mutated for M*) + controls.sql. Ends in RAISE: nothing persists.
  rollback: migration + rollback-3850.sql + a probe (md5 back to a3201c3a, no enqueue).
  live:     controls.sql only, against the functions as they are on the venue.
A mutation is an exact, once-only replacement; it must change the text, else the script exits 2.
Mutants drop the migration's POSTCHECK block (its md5 pins would refuse the mutated body).
"""
import difflib, os, sys

here = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(here, '..', '..', 'migrations', '20261111130000_backlog_3850_cancel_agent_on_join.sql')
RB = os.path.join(here, 'rollback-3850.sql')
TRIG = ('DROP TRIGGER IF EXISTS retire_personal_membership ON public.organization_members;\n'
        'CREATE TRIGGER retire_personal_membership AFTER INSERT ON public.organization_members\n'
        '  FOR EACH ROW WHEN (new.user_id IS NOT NULL) EXECUTE FUNCTION public._retire_personal_membership();\n')

MUTANTS = {
    # gate removed: enqueue on every fire
    'M1': [('  IF v_rows > 0 THEN\n', '  IF true THEN\n')],
    # enqueue before the deactivated check
    'M3': [('  -- BACKLOG-3851: a deactivated brokerage membership keeps the personal one.\n',
            '  PERFORM public._billing_enqueue_agent_cancel_on_join(NEW.user_id, NEW.organization_id, NEW.id);\n')],
    # fixed dedupe key (no clock_timestamp)
    'M4': [("p_user::text || ':' || v_stamp,", 'p_user::text,')],
    # trigger on INSERT only
    'M5': [('-- POSTCHECK BEGIN\n', TRIG + '-- POSTCHECK BEGIN\n')],
    # both EXCEPTION levels removed
    'M2c': [("    EXCEPTION WHEN OTHERS THEN\n      RAISE WARNING 'BACKLOG-3850: join cancel row not enqueued for user % (%): % %',\n        p_user, v_cust.stripe_mode, SQLSTATE, SQLERRM;\n", ''),
            ("EXCEPTION WHEN OTHERS THEN\n  RAISE WARNING 'BACKLOG-3850: join cancel enqueue failed for user %: % %', p_user, SQLSTATE, SQLERRM;\n", '')],
}

out, mode = sys.argv[1], sys.argv[2]
mig = open(MIG).read()
ctl = open(os.path.join(here, 'controls.sql')).read()


def strip_postcheck(t):
    a = t.index('-- POSTCHECK BEGIN\n') + len('-- POSTCHECK BEGIN\n')
    b = t.index('-- POSTCHECK END')
    return t[:a] + t[b:]


if mode in MUTANTS:
    m = mig
    for old, new in MUTANTS[mode]:
        n = m.count(old)
        if n != 1:
            print(f'MUTATION NOT APPLIED: {mode}: pattern found {n} times', file=sys.stderr)
            sys.exit(2)
        m = m.replace(old, new)
    m = strip_postcheck(m)
    if m == strip_postcheck(mig):
        print(f'MUTATION NOT APPLIED: {mode}: text unchanged', file=sys.stderr)
        sys.exit(2)
    diff = [l for l in difflib.unified_diff(strip_postcheck(mig).splitlines(), m.splitlines(), lineterm='', n=0)
            if l[:1] in '+-' and not l.startswith(('+++', '---'))]
    print(f'MUTATION APPLIED {mode}: ' + ' | '.join(diff)[:400])
    mig = m

head = f"SELECT set_config('p3850.mode', '{mode}', true);\n"
if mode == 'live':
    text = head + ctl
elif mode == 'rollback':
    probe = """
DO $rb$
DECLARE u uuid; b uuid;
BEGIN
  u := pg_temp.mk_user(ARRAY['test']); b := pg_temp.mk_brokerage();
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES (b, u, 'agent', 'active', now());
  RAISE EXCEPTION 'P3850_RESULT %', jsonb_build_object('mode', 'rollback',
    'md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._retire_personal_membership()'::regprocedure),
    'enqueue_fn', to_regprocedure('public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid)') IS NOT NULL,
    'outbox', pg_temp.ob(u), 'personal', pg_temp.personal(u));
END
$rb$;
"""
    helpers = ctl[:ctl.index('DO $drv$')]
    text = head + mig + '\n' + open(RB).read() + '\n' + helpers + probe
else:
    text = head + mig + '\n' + ctl
text += "\nDO $end$ BEGIN RAISE EXCEPTION 'P3850_END_NO_RESULT'; END $end$;\n"
import re
assert not re.search(r'^\s*COMMIT\b', text, re.I | re.M), 'COMMIT statement in composed text'
open(out, 'w').write(text)
