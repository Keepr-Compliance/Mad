# S1 two-session scripts: call classes

`offline_check.py` reads the table below. A change to a file's class or first write needs a change here, or the
offline check goes red.

Each text is one of:
- `rolled_back`: its call must end in its result RAISE (one final result block, the last statement, nothing after it,
  no top-level transaction control);
- `commits`: by design (setup, teardown, mutant copies, the sessions that must commit, read-only probes); it must not
  end in a result RAISE and has no top-level transaction control;
- `fragment`: a piece run.sh puts into a call (the guard, the gate, the hold marker, timeouts, role and end tags).

"First write" is the line of the file's first statement that writes or may write (a DO block counts; `none` = it
writes nothing). The guard is the first statement of every call run.sh sends (checked on every call of the offline
run), so it precedes every write. No `commits` file carries a guard of its own.

| File | Class | First write (line) | Guard before the first write |
|---|---|---|---|
| `as-user.sql` | fragment | none | — |
| `assert.sql` | commits | none | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `auth-count.sql` | commits | none | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `claim-ib-replace.sql` | commits | 3 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `drop-mutants.sql` | commits | 3 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `end-hold.sql` | fragment | none | — |
| `end.sql` | fragment | none | — |
| `fk-counts.sql` | commits | none | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `gate.sql` | fragment | 4 | — |
| `guard.sql` | fragment | 2 | — |
| `hold-marker.sql` | fragment | none | — |
| `lock-timeout-b.sql` | fragment | none | — |
| `lock-timeout.sql` | fragment | none | — |
| `md5.sql` | commits | none | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `mutant-claim-read-before-lock.sql` | commits | 4 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `mutant-confirm-nolock.sql` | commits | 4 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `mutant-deal-gate-before-lock.sql` | commits | 4 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `mutant-off-check-before-lock.sql` | commits | 4 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `own.sql` | commits | none | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `precheck.sql` | commits | none | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `r1-write-hold.sql` | commits | 5 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `r2-confirm-hold.sql` | commits | 5 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `r3-claim-ia-hold.sql` | commits | 5 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `r3-claim-ib.sql` | commits | 3 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `r4-claim-ib-hold.sql` | commits | 5 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `r4-off-ia.sql` | commits | 3 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `r5-claim-ib.sql` | commits | 3 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `r5-off-ia-hold.sql` | commits | 5 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `r6-claim-ib-hold.sql` | commits | 5 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `r6-write-ia.sql` | commits | 3 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `setup.sql` | commits | 6 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `stats-reset.sql` | commits | 2 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `teardown.sql` | commits | 4 | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
| `verify.sql` | commits | none | guard.sql first in the call: `guarded()` run.sh:104-107, `holder()` run.sh:108-111 |
