# BACKLOG-3618 harness — agents' own checklist templates

Runs `supabase/migrations/20261001054306_backlog_3618_agent_checklist_templates.sql`
— **the shipped file itself** — on a real Postgres, on top of every checklist
migration production runs (the backlog-3607 prelude plus `20260921101758` and
`20260925044046`, the three 3596 files and the 3607 file). `control-run.txt`,
`regression-run.txt` and `mutant-run.txt` are the recorded runs' own output,
unedited. `rollback-3618.sql` is the tested rollback.

It is not in CI: CI has no database. The CI tripwire is
`broker-portal/__tests__/migrations/agent-checklists-3618.test.ts`.
No file here has a `.test.` or `.spec.` infix.

**Nothing has been applied to production, and nothing here can reach it.**

## Running it

```bash
H=supabase/tests/backlog-3618/run.sh
export SSH_HOST=<ssh alias> PG_CONTAINER=<container name>   # values: a private pm_comment (no host names in the repo)

bash $H controls      # e00-e16, each in its own rolled-back transaction
bash $H regression    # the 3607 (d*) and 3596 (c*) controls on top of the 3618 file
bash $H mutants       # lib/mutants.py against their target controls
```

Run under `bash`, not zsh.

## What runs

```
BEGIN
  catalogue -> 3473/3474/3476/3477/3535/3547 files + fixtures -> 3596 x3 -> 3607
  -> lib/fixtures-3618.sql -> fingerprint (t3618_before)
  -> the 3618 file (or a mutant) -> [e14: the 3618 file again]
  -> the control  [e13: its first half, rollback-3618.sql, its second half]
ROLLBACK
```

- `lib/fp-3618.sql` is the catalogue fingerprint: md5 of every changed
  function body with its security, search_path and ACL, the template/item
  policies, column grants, columns, constraints and indexes. The same text was
  run read-only on production; `lib/fixtures-3618.sql` `prod3618()` holds the
  result. **e00** proves the venue's prelude equals production before the
  file; **e13** proves the rollback returns to it; **e15** pins the state
  after the file.
- **e12** proves the two re-created bodies (add at review, snapshot) are the
  production bodies plus exactly one inserted hunk each (`lib/hunks-3618.sql`).

## Mutants

`lib/mutants.py`: every edit is an exact-string replace matched exactly once,
or the run aborts; the runner refuses a mutant whose diff is empty and prints
`MUTATION APPLIED` with the first changed line.

Equivalent mutants (measured green, kept in the run with `want green`):
- n03, the owner term on the item SELECT policy: the template SELECT policy
  hides the parent row first. Kept as defence in depth; the CI tripwire pins
  it.
- n14, the snapshot skip without `owner_user_id = auth.uid()`: the snapshot
  runs as the submitter, and RLS hides any template that is not brokerage or
  the submitter's own.
