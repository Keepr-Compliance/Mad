# Erase two-session scripts: call classes

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
| `attach-a.sql` | commits | 10 | guard.sql first in the call: `fill()` run.sh:89-90, `holder()` run.sh:92-93 (the mutant copy: run.sh:176) |
| `attach-b.sql` | rolled_back | 3 | session B: `fill gate.sql` puts guard.sql first, then this text (run.sh:192-196) |
| `delete.sql` | commits | 3 | guard.sql first in the call: `fill()` run.sh:89-90, `holder()` run.sh:92-93 (the mutant copy: run.sh:176) |
| `drop-copies.sql` | commits | 3 | guard.sql first in the call: `fill()` run.sh:89-90, `holder()` run.sh:92-93 (the mutant copy: run.sh:176) |
| `fk-counts.sql` | commits | none | guard.sql first in the call: `fill()` run.sh:89-90, `holder()` run.sh:92-93 (the mutant copy: run.sh:176) |
| `gate.sql` | fragment | 3 | — |
| `guard.sql` | fragment | 3 | — |
| `hold-marker.sql` | fragment | none | — |
| `md5.sql` | commits | none | guard.sql first in the call: `fill()` run.sh:89-90, `holder()` run.sh:92-93 (the mutant copy: run.sh:176) |
| `own.sql` | commits | none | guard.sql first in the call: `fill()` run.sh:89-90, `holder()` run.sh:92-93 (the mutant copy: run.sh:176) |
| `precheck.sql` | commits | none | guard.sql first in the call: `fill()` run.sh:89-90, `holder()` run.sh:92-93 (the mutant copy: run.sh:176) |
| `residue.sql` | commits | none | guard.sql first in the call: `fill()` run.sh:89-90, `holder()` run.sh:92-93 (the mutant copy: run.sh:176) |
| `setup.sql` | commits | 5 | guard.sql first in the call: `fill()` run.sh:89-90, `holder()` run.sh:92-93 (the mutant copy: run.sh:176) |
| `skip-a.sql` | rolled_back | 6 | session B: `fill gate.sql` puts guard.sql first, then this text (run.sh:192-196) |
| `skip-b.sql` | rolled_back | 2 | session B: `fill gate.sql` puts guard.sql first, then this text (run.sh:192-196) |
| `stats-reset.sql` | commits | 2 | guard.sql first in the call: `fill()` run.sh:89-90, `holder()` run.sh:92-93 (the mutant copy: run.sh:176) |
| `wait-a.sql` | rolled_back | 6 | session B: `fill gate.sql` puts guard.sql first, then this text (run.sh:192-196) |
| `wait-b.sql` | rolled_back | 2 | session B: `fill gate.sql` puts guard.sql first, then this text (run.sh:192-196) |
