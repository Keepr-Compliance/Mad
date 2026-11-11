#!/usr/bin/env python3
"""Compose and run the BACKLOG-3976 keepr-test harness, one rolled-back kt-sql call per mode.

Usage: compose.py [--with-migration] [mode ...]   (default: every mode)
Each mode's mutation is an exact-once replace on a live function body (pg_temp.mutate raises
'MUTATION NOT APPLIED' if the text is absent or the body does not change).
"""
import json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(HERE, '..', '..', 'migrations', '20261110130000_backlog_3976_support_role_change.sql')
RPC = "'public.admin_update_org_member_role(uuid,uuid,text)'"

def m(fn, a, b):
    q = lambda s: "$x$" + s + "$x$"
    return f"SELECT pg_temp.mutate({fn}::regprocedure, {q(a)}, {q(b)});"

MODES = {
    'base': [],
    # The permission check removed: the likely wrong build (a check only in the client).
    'no_permission_check': [m(RPC, "IF NOT public.has_permission(v_caller_id, 'users.edit') THEN", "IF false THEN")],
    # The last-admin rule removed (it lives in the shared trigger, not in the RPC).
    'no_last_admin_rule': [m("'public._guard_last_admin()'", "IF NOT (OLD.role = 'admin'", "IF TRUE OR NOT (OLD.role = 'admin'")],
    # The audit write removed.
    'no_audit_write': [
        "CREATE FUNCTION pg_temp.no_audit(text, text, text, jsonb) RETURNS void LANGUAGE sql AS $x$ SELECT $x$;",
        m(RPC, "PERFORM public.log_admin_action(", "PERFORM pg_temp.no_audit("),
    ],
    # The REVOKE undone.
    'anon_granted': ["GRANT EXECUTE ON FUNCTION public.admin_update_org_member_role(uuid,uuid,text) TO anon;"],
    # The IdP rule removed.
    'no_idp_rule': [m("'public._guard_idp_role()'", "IF current_setting('role', true) IN ('authenticated', 'anon')", "IF false AND current_setting('role', true) IN ('authenticated', 'anon')")],
    # The member lookup no longer scoped to the organization.
    'no_org_scope': [m(RPC, "   WHERE m.organization_id = p_organization_id\n     AND m.user_id = p_user_id", "   WHERE m.user_id = p_user_id")],
}

def run(mode, with_mig):
    ctl = open(os.path.join(HERE, 'controls.sql')).read()
    ctl = ctl.replace('-- __MUTATION__', '\n'.join(MODES[mode])).replace('__MODE__', mode)
    sql = 'BEGIN;\n' + (open(MIG).read() + '\n' if with_mig else '') + ctl
    fd, path = tempfile.mkstemp(suffix='.sql'); os.close(fd)
    open(path, 'w').write(sql)
    p = subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), path], capture_output=True, text=True)
    os.unlink(path)
    out = p.stdout + p.stderr
    r = re.search(r'P3976_RESULT (\{.*?\})(?:\\n|")', out)
    if not r:
        return 'NO RESULT ' + out[:400].replace('\n', ' ')
    return json.loads(r.group(1).encode().decode('unicode_escape'))

if __name__ == '__main__':
    args = sys.argv[1:]
    with_mig = '--with-migration' in args
    modes = [a for a in args if not a.startswith('--')] or list(MODES)
    for k in modes:
        v = run(k, with_mig)
        if isinstance(v, dict):
            print(f"{k}: pass={v['pass']} fail={v['fail']} reds={json.dumps(v['reds'])}")
        else:
            print(f'{k}: {v}')
