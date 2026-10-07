# BACKLOG-3759 database controls

Runs `20261008120000_backlog_3759_function_grants.sql` against a test database
(the NAS `supabase_db_keepr-test` container, at the production schema: ledger
head `20261004232511`). One transaction per control, always ending in
`ROLLBACK`. Nothing is committed. Fixtures are synthetic rows created inside
each run (two organizations, an agent, a broker, a broker of another
organization, three submissions, a message, an attachment, a comment and the
storage object behind the attachment).

```bash
SSH_HOST=<nas ssh alias> PG_CONTAINER=supabase_db_keepr-test \
  bash supabase/tests/backlog-3759/run.sh controls
# same env:
  bash supabase/tests/backlog-3759/run.sh mutants
```

| Control | Checks |
|---|---|
| c0 | before the migration: ledger head; the three read rules `{public}` with the production `md5(qual)`; anon EXECUTE on `can_review_submission`; `can_edit_checklist_templates` already closed to anon; `postgres` and `service_role` bypass RLS |
| c1 | after: both functions anon=f, PUBLIC=f, authenticated=t, service_role=t; read rules `{authenticated}` with unchanged `md5(qual)`; anon calls refused |
| c2 | signed-out reads of submissions (desktop poll and resubmit shapes), messages, attachments, comments, storage objects, and anon UPDATE/DELETE: 0 rows, no error; same for a token without a subject |
| c3 | signed-in reads: submitter and broker see the organization's rows, a broker of another organization sees none |
| c4 | writes whose rules read `transaction_submissions` under RLS still succeed |
| c5 | a broker's review update passes the status-history guard trigger |
| c6 | the checklist-template callers still reach `can_edit_checklist_templates` signed in; anon is refused |
| c7 | applying twice: the pre-check accepts the applied state; same end state |
| c8 | rollback restores `{public}` and anon EXECUTE |
| c9 | a read rule with a different USING makes the migration abort before changing anything |

`rollback-3759.sql` is the rollback; c8 runs it.

## Reading the output

`controls` ends with `CONTROLS: pass=X fail=Y error=Z` and exits 0 only when
every control passes. `ERROR` means psql failed or the control produced no
checks: it proved nothing, which is not the same as `FAIL`.

`mutants` first runs every control against the unmutated migration and runs no
mutant unless all pass. Each mutant is an exact-string replacement that must
match exactly once (`lib/mutants.py`), and its applied diff is printed after
`MUTATION APPLIED:`.

| Verdict | Meaning |
|---|---|
| `KILLED` | at least one target control reported an assertion `FAIL`, and none errored |
| `SURVIVED` | every target control passed |
| `INVALID` | a target control errored, so the run says nothing about the mutant |

The migration's own post-check raises run as `FAIL` checks labelled
`migration post-check: ...`. They are printed but do not count towards a kill:
a control has to see the mutant on its own.

Known vacuous and not listed: dropping only the `can_edit_checklist_templates`
GRANT line (both roles already hold EXECUTE).

`control-run.txt` and `mutant-run.txt` are the recorded runs.
