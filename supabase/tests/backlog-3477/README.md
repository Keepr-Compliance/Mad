# BACKLOG-3477 harness — submission checklist review

Runs `supabase/migrations/20260925073000_backlog_3477_submission_checklist_review.sql`
— **the shipped file itself** — on a real Postgres 17.6, on top of the checklist
migrations production already holds, and records what every control and every
mutant did. `control-run.txt` and `mutant-run.txt` are the recorded runs'
own output, unedited.

It is not in CI: CI has no database. The text tripwire that runs in CI is
`broker-portal/__tests__/migrations/submission-checklist-review-3477.test.ts`.
No file here has a `.test.` or `.spec.` infix.

**Nothing has been applied to production, and nothing here can reach it.**

## Running it

```bash
H=supabase/tests/backlog-3477/run.sh
export SSH_HOST=<ssh alias> PG_CONTAINER=<container name>   # values on the backlog item

bash $H gate                  # refuses unless the venue is schema-only and 3477-free
bash $H controls              # 17 controls, each in its own rolled-back transaction
node supabase/tests/backlog-3477/mutants/generate.mjs --check
bash $H mutants               # every mutant against the controls on its targets line
MATRIX=1 bash $H mutants m05  # one mutant against every control
bash $H gate                  # again: proves nothing leaked out of a transaction
```

Run under `bash`, not zsh.

## Transport and prelude

Same transport as `backlog-3503/run.sh`: psql runs inside the venue's
container, over SSH, and every file is concatenated on the client into one
stream (no `\i`). Each control is one transaction:

```
BEGIN
  3473 venue-catalogue.sql (its BEGIN/COMMIT removed, verifier inlined)
  3473 file 2 -> 3473 lib/fixtures.sql -> 3473 file 1 -> 3535 min-tier
  -> 3474 save -> 3474 audit fields -> 3476 -> 3477 (or a mutant of it)
  -> lib/fixtures-3477.sql -> control
ROLLBACK
```

This is production's applied order (`supabase_migrations.schema_migrations`,
read 2026-09-25). 3473 file 3 is not in production's history and is not
loaded. The BACKLOG-3535 solo-checklists migration (open PR, not in this base)
touches only `can_edit_checklist_templates` and the seed trigger; nothing here
depends on either. The catalogue is loaded inside the transaction, so the
venue is never written.

Role switching is simulated with `set_config('role', …)` plus the
`request.jwt.claim*` settings, the shape PostgREST produces (3473's
`act_as` / `act_anon` / `act_owner`, plus `act_service` here).

## Controls

| # | Checks | Mutants that red it |
|---|---|---|
| c00 | fixture preconditions (feature on in T1, off in T2; templates) | — |
| c01 | snapshot writes every checklist; local ids map to every matching upload; unmatched ids and empty links dropped; counts returned | m09, m10 |
| c02 | a snapshot that fails on its last element writes nothing (bad kind, missing title, repeated template) | m11 |
| c03 | no snapshot when the organization lacks the feature | m07, m12 |
| c04 | no snapshot, header or item once past `uploading` | m08, m12 |
| c05 | reviewer tick: reviewer columns only, one typed entry per change, none on a repeat; admin and it_admin; added-at-review items refused | m01, m14, m15, m18, m19 |
| c06 | tick refused for submitter, other agents, other org, no JWT, service role, anon, closed statuses, feature off | m02, m16, m17, m21, m34 |
| c07 | both functions append in one UPDATE from the row's own history | m20 |
| c08 | add at review: copies the template, records who, one entry; exists / template_not_found; closed statuses; submitter header with added-at-review values refused | m01, m05, m22–m27 |
| c09 | tick and add never move the status or write a status key | m19 |
| c10 | submitter item insert with reviewer values refused, directly and through the snapshot | m06, m13 |
| c11 | submitter, broker, admin, it_admin read the submission and all six child tables; others read nothing; anon gets no rows | m01–m03, m04a–g |
| c12 | the role list exists only in `can_review_submission` | m04a–g |
| c13 | `status_history`: rewrites, removals, non-arrays and typed entries naming someone else refused; status updates, the tick, the service role and no-JWT sessions allowed | m28–m33 |
| c14 | applying the file twice changes nothing | m35 |
| c15 | security, `search_path` and EXECUTE grants of the five functions; the trigger | m03, m12, m32, m34 |
| c16 | editing an existing entry in place is refused | m28 |

Two behaviours are recorded as observed, not gated (c13): a caller may append
a typed entry naming themself, and an untyped entry is not checked for
`changed_by`.

Concurrency (two sessions ticking at once) cannot be raced in a
one-session-per-control harness; c07 reads the function bodies for the
single-statement append instead.

## Results

Recorded 2026-09-25, Postgres 17.6, connected as the venue's `postgres` role.
See `control-run.txt` (17 green / 17) and `mutant-run.txt` (41 run, 0 not as
expected). `gate` re-run afterwards: OK.
