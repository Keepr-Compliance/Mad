#!/usr/bin/env python3
"""Recompute md5(prosrc) of the three function bodies in the 3991 migration and write
them into its pre-check (the 'absent or this body' pins). Run after any body edit."""
import hashlib, re
from pathlib import Path
p = Path(__file__).resolve().parents[2] / 'migrations' / '20261019050000_backlog_3991_idp_names_and_member_name_edit.sql'
s = p.read_text()
assert all(ord(c) < 128 for c in s), 'non-ASCII character in the migration'
for name in ['sync_profile_names_from_idp', 'org_names_directory_managed', 'set_member_name']:
    body = re.search(r'CREATE OR REPLACE FUNCTION public\.' + name + r'\(.*?AS \$function\$(.*?)\$function\$', s, re.S).group(1)
    new = hashlib.md5(body.encode()).hexdigest()
    pat = re.compile(r"(\('public\." + name + r"\([a-z,]*\)',\s*')([0-9a-f]{32})('\))")
    assert len(pat.findall(s)) == 1, name
    s = pat.sub(lambda m: m.group(1) + new + m.group(3), s)
    print(name, new)
p.write_text(s)
