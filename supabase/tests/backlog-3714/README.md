# BACKLOG-3714 database controls

Runs the `public.users` column UPDATE grant migration (`20261007200000`)
against a test database (the NAS `supabase_db_keepr-test` container), one
transaction per control, always ending in `ROLLBACK`. Nothing is committed.
Fixtures are three synthetic users created inside each run. The 3673
migration (`20261003160000`) runs before 3714 in every control, as it will in
production.

The rollback SQL is not kept in the repo. It is posted with the apply packet on
the backlog item; save it locally and pass its path.

```bash
SSH_HOST=<nas ssh alias> PG_CONTAINER=supabase_db_keepr-test \
ROLLBACK_FILE=<rollback-3714.sql> \
  bash supabase/tests/backlog-3714/run.sh controls
# same env:
  bash supabase/tests/backlog-3714/run.sh mutants
```

`SSH_HOST=local` runs `docker exec` on this machine instead (a local stand-in
database; its results are not NAS results).

| Control | Checks |
|---|---|
| c1 | before 3714: anon and authenticated hold UPDATE on every column; an authenticated UPDATE of `subscription_tier` on the own row is stored |
| c2 | after the apply: UPDATE columns are exactly the 16 for authenticated, none for anon / PUBLIC, all for service_role; no table-level UPDATE left for anon / authenticated / PUBLIC; attacl on exactly the 16; INSERT / SELECT / DELETE unchanged; policies unchanged (md5) |
| c3 | as authenticated: the four desktop UPDATE statements and the broker invite upsert succeed; each of the 23 other columns is refused with SQLSTATE 42501 and the stored row is unchanged; a mixed statement is refused; another user's row updates 0 rows |
| c3b | as anon: the terms statement and each of the 23 columns refused with 42501, row unchanged |
| c4 | service_role UPDATE and `admin_suspend_user` (SECURITY DEFINER) still store their values |
| c5 | 3673's write-once guard still holds with 3714 applied |
| c6 | applying twice: same privilege set |
| c7 | rollback: relacl and column ACLs equal the pre-migration state; the c1 UPDATE is stored again |

Statement sources are in the header of `controls/c3-authenticated.sql`. The
invite upsert is labelled RECONSTRUCTED there: it was captured from PostgREST
v14.5 for the same supabase-js call, and prod's PostgREST version is not
established.

## Reading the output

`controls` ends with `CONTROLS: pass=X fail=Y error=Z` (one count per control
file) and exits 0 only when every control passes. `ERROR` means psql failed
(fixture, syntax, an unexpected raise) or the control produced no checks: the
control proved nothing, which is not the same as `FAIL`; psql's error text is
printed.

`mutants` first runs every control against the unmutated migration and stops,
running no mutant, unless all of them pass. Each mutant is then:

| Verdict | Meaning |
|---|---|
| `KILLED` | at least one target control reported an assertion `FAIL`, and none errored |
| `SURVIVED` | every target control passed |
| `INVALID` | a target control errored, or the mutant changed nothing |

The run ends with `MUTANTS: killed=X survived=Y invalid=Z` and exits 0 only
when every counted mutant is `KILLED`. Mutants named `x*` are measurements,
printed as `MEASURE|name|verdict` and not counted. The verdict logic is
`mutants.py classify`; `python3 lib/test_mutants.py` checks it, and that every
migration mutant pattern occurs exactly once, without a database.

The rollback file's `RAISE EXCEPTION 'rollback verify: ...'` lines are run as
`pg_temp.check(label, false)` inside the harness (`rb_body` in `run.sh`), so a
failed verification is an assertion `FAIL`; the conditions are untouched.
