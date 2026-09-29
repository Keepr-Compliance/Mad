# BACKLOG-3607 harness — checklists removed, added and restored at review

Runs `supabase/migrations/20260929120000_backlog_3607_checklist_add_remove.sql`
— **the shipped file itself** — on a real Postgres 17.6, on top of the
backlog-3596 prelude and the three shipped 3596 files, and records what every
control and every mutant did. `control-run.txt` and `mutant-run.txt` are the
recorded runs' own output, unedited. `rollback-3607.sql` is the tested
rollback; it runs BEFORE the three 3596 rollbacks.

It is not in CI: CI has no database. The text tripwire that runs in CI is
`broker-portal/__tests__/migrations/checklist-add-remove-3607.test.ts`.
No file here has a `.test.` or `.spec.` infix.

**Nothing has been applied to production, and nothing here can reach it.**

## Running it

```bash
H=supabase/tests/backlog-3607/run.sh
export SSH_HOST=<ssh alias> PG_CONTAINER=<container name>   # values: a private pm_comment (no host names in the repo)

bash $H gate          # the 3596 gate: refuses unless the venue is schema-only and checklist-free
bash $H controls      # d01-d17 plus the 3596 controls, each in its own rolled-back transaction
bash $H mutants       # lib/mutants.py against their target controls
bash $H gate          # again: proves nothing leaked out of a transaction
```

Run under `bash`, not zsh.

## What runs

```
BEGIN
  the backlog-3596 prelude -> lib/fixtures-3607.sql (helpers only)
  -> the three 3596 files -> [d14: snapshot] -> the 3607 file (or a mutant)
  -> [d15: the 3607 file again] -> [d14: rollback-3607.sql] -> the control
ROLLBACK
```

- `controls/d*.sql` are this file's controls. `controls/c05`, `c08`, `c19` are
  copies of the 3596 controls of the same number, changed on purpose (plan rev
  2): the runner uses the copy in place of the 3596 original.
- 3596 controls c21, c22, c25 and c30 snapshot or roll back the 3596 files and
  are not run on top of 3607; d14 and d15 are this file's rollback and
  apply-twice controls.

## Mutants

`lib/mutants.py`: every edit is an exact-string replace matched exactly once,
or the run aborts; the runner refuses a mutant whose diff is empty
(`MUTATION NOT APPLIED`) and prints `MUTATION APPLIED` with the first changed
line for every one it runs.

- **Ported**: every backlog-3596 mutant of kind `added` or `refusals`, moved
  onto this file (it re-creates the tick, carry and add bodies).
- **New**: n01-n52 for this file's code. n49-n52 are the SR re-review's S1-S4.

Equivalent mutants (measured green, kept out of the gating set):
- dropping ONE of the two `removed_at_review_*` predicates from the header
  INSERT policy: the pair CHECK plus the other predicate refuse every insert.
  d13 pins the CHECK's definition (n44).
- dropping the remove count's `IS NOT NULL` guard alone: `count(DISTINCT x)`
  skips a NULL `x`. n42 is the shape that is not equivalent (a
  `(kind, local id)` row, never NULL, with no guard).
