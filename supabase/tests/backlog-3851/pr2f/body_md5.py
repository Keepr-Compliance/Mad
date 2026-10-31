#!/usr/bin/env python3
"""Print md5(prosrc) of every function body in a migration file, as Postgres stores it.

prosrc is the exact text between the $function$ delimiters, so the md5 can be computed
from the file and compared with the catalog after an apply.
Usage: body_md5.py <file.sql>
"""
import hashlib, re, sys
s = open(sys.argv[1]).read()
for m in re.finditer(r"CREATE OR REPLACE FUNCTION\s+(public\.[a-z_]+)\s*\(.*?AS \$function\$(.*?)\$function\$", s, re.S):
    print(m.group(1), hashlib.md5(m.group(2).encode()).hexdigest())
