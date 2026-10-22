#!/usr/bin/env python3
"""BACKLOG-3998: recompute md5(prosrc) of every function body in the 3998 migration and
write the 'this file's body' pins into its pre-check, and the handle_new_user pin into
the 3991 pre-check (20261019050000). Run after any body edit."""
import hashlib
import re
from pathlib import Path

MIGS = Path(__file__).resolve().parents[2] / 'migrations'
P = MIGS / '20261016070000_backlog_3998_users_email_from_auth.sql'
P3991 = MIGS / '20261019050000_backlog_3991_idp_names_and_member_name_edit.sql'

s = P.read_text()
assert all(ord(c) < 128 for c in s), 'non-ASCII character in the migration'

FUNCS = {
    'users_email_from_auth': 'public.users_email_from_auth()',
    'users_client_write_guard': 'public.users_client_write_guard()',
    'users_own_oauth_pair': 'public.users_own_oauth_pair()',
    'user_id_for_auth_email': 'public.user_id_for_auth_email(text)',
    'sync_email_from_auth': 'public.sync_email_from_auth()',
    'handle_new_user': 'public.handle_new_user()',
    'admin_add_internal_user': 'public.admin_add_internal_user(text,text)',
}


def body(name: str) -> str:
    m = re.findall(r'CREATE OR REPLACE FUNCTION public\.' + name + r'\(.*?AS \$function\$(.*?)\$function\$', s, re.S)
    assert len(m) == 1, name
    return m[0]


out = {}
for name, sig in FUNCS.items():
    md5 = hashlib.md5(body(name).encode()).hexdigest()
    out[name] = md5
    if name in ('handle_new_user', 'admin_add_internal_user'):
        pat = re.compile(r"(\('" + re.escape(sig) + r"',\s*'[0-9a-f]{32}',\s*')([0-9a-f]{32})('\))")
    else:
        pat = re.compile(r"(\('" + re.escape(sig) + r"',\s*')([0-9a-f]{32})('\))")
    assert len(pat.findall(s)) == 1, sig
    s = pat.sub(lambda m: m.group(1) + md5 + m.group(3), s)
    print(f'{name:26s} {md5}')
P.write_text(s)

t = P3991.read_text()
pat = re.compile(r"(NOT IN \('64c98e28c6916d1095fd70445e7812cf', ')([0-9a-f]{32})('\))")
assert len(pat.findall(t)) == 1, '3991 handle_new_user pin'
t = pat.sub(lambda m: m.group(1) + out['handle_new_user'] + m.group(3), t)
P3991.write_text(t)
print('3991 pin updated')
