#!/bin/bash
# C-race: two concurrent kt-sql sessions each demote one of the brokerage's two admins.
# Session 1 holds its transaction open for 5 s; session 2 starts 1 s later. With the per-brokerage
# lock, session 2 waits, then sees no other admin and is refused (1 admin left). Prints active_admins.
set -u
here="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
ids=$(~/.claude/bin/kt-sql "$here/setup.sql" | python3 -c "import json,sys;print(' '.join(r['id'] for r in json.load(sys.stdin)))")
set -- $ids; A=$1; B=$2
sed "s/__MEMBER__/$A/; s/__SLEEP__/5/" "$here/session.sql.tmpl" > "$T/s1.sql"
sed "s/__MEMBER__/$B/; s/__SLEEP__/0/" "$here/session.sql.tmpl" > "$T/s2.sql"
(~/.claude/bin/kt-sql "$T/s1.sql" > "$T/o1" 2>&1) & sleep 1
(~/.claude/bin/kt-sql "$T/s2.sql" > "$T/o2" 2>&1) ; wait
echo "s1: $(head -c 200 "$T/o1")"; echo "s2: $(head -c 200 "$T/o2")"
~/.claude/bin/kt-sql "$here/count.sql"; echo
~/.claude/bin/kt-sql "$here/reset.sql" >/dev/null
