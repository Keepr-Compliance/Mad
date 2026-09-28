# BACKLOG-3596 harness — broker checklist ticks carried across versions

Runs `supabase/migrations/20260928120000_backlog_3596_broker_checklist_ticks.sql`
and then `supabase/migrations/20260928130000_backlog_3596_review_refusals.sql`
— **the shipped files themselves** — on a real Postgres 17.6, on top of the
migrations production holds for these tables, and records what every control
and every mutant did. `control-run.txt` and `mutant-run.txt` are the recorded
runs' own output, unedited. `rollback.sql` and `rollback-refusals.sql` are the
tested rollbacks; `rollback-refusals.sql` runs first.

The refusals file re-creates two functions: `add_submission_checklist_at_review`
(refuses a version that has a newer version, `superseded`) and
`set_submission_checklist_reviewer_check` (refuses new ticks and unticks on a
`needs_changes` version, `not_open_for_review`; ticks made before Request
Changes still carry). The superseded-add state is reachable only through a
hand-crafted request (an agent moving its own `needs_changes` row back to an
open status); shipped code cannot produce it, and c24's fixture says so.

It is not in CI: CI has no database. The text tripwire that runs in CI is
`broker-portal/__tests__/migrations/broker-checklist-ticks-3596.test.ts`.
No file here has a `.test.` or `.spec.` infix.

**Nothing has been applied to production, and nothing here can reach it.**

## Running it

```bash
H=supabase/tests/backlog-3596/run.sh
export SSH_HOST=<ssh alias> PG_CONTAINER=<container name>   # values: a private pm_comment on BACKLOG-3596 (no host names in the repo)

bash $H gate                  # refuses unless the venue is schema-only and checklist-free
bash $H controls              # 26 controls, each in its own rolled-back transaction
bash $H mutants               # 50 mutants from lib/mutants.py against their target controls
MATRIX=1 bash $H mutants m03  # one mutant against every control
bash $H gate                  # again: proves nothing leaked out of a transaction
```

Run under `bash`, not zsh. The transport is plain `ssh` (no ControlMaster): on
the recording machine a multiplexed master could not get a signature from the
ssh agent while plain connections could.

## Prelude

```
BEGIN
  backlog-3477's prelude, unchanged (catalogue, 3473, 3535, 3474 x2, 3476, 3477)
  -> backlog-3477/lib/fixtures-3477.sql -> 3547
  -> lib/fixtures-3596.sql (helpers only; loaded BEFORE 3596)
  -> [c22: catalogue snapshot] -> 3596 (or a mutant)
  -> [c25: snapshot] -> the refusals file (or a mutant)
  -> [c21: snapshot, 3596 and the refusals file again]
  -> [c22: snapshot, rollback-refusals.sql, rollback.sql (or a mutant)]
  -> [c25: snapshot, rollback-refusals.sql (or a mutant)]
  -> control
ROLLBACK
```

Every row a control uses is made through the real producers: the snapshot RPC
called as the agent, the tick RPC called as the broker / admin. The owner (no
JWT) only inserts version rows and uploads and moves statuses, as the desktop
and portal do outside those RPCs. The one deliberate edit to a produced row:
each v1 `reviewer_checked_at` is backdated to a fixed literal, because `now()`
is frozen inside a control's transaction and a re-stamp with `now()` would
otherwise pass.

## Controls

| # | Checks | Mutants targeting it (each went red) |
|---|---|---|
| c00 | fixture: v1 built via the RPCs (2 checklists, 6 items with ids, 5 backdated ticks, L-att-1 at two uploads); a v1 snapshot returns `no_parent` | — |
| c01 | unchanged + ticked → carried with the ORIGINAL `_by` and `_at`, silently; v2 uploads are new cloud rows | m01 m02 m03 m08 m31 m32 |
| c02 | changed + ticked → unticked, `cleared_*` set, one `checklist_review_cleared` (reason `edited`) per item naming the agent, prior reviewer and time | m07 m15 m16 |
| c03 | changed but never ticked → no marker, no entry | m17 |
| c04 | desktop-id set comparison: relabel/regroup and blank/space-padded notes carry; lost-to-re-cache, re-linked, added file clear | m03 m14 m18 |
| c05 | carry refusals: other agent, broker, anon, no JWT, parent, finalized, feature off; no parent → `no_parent`, nothing written | m26 m27 m28 m29 |
| c06 | second carry writes nothing (edited, removed, unavailable) | m23 m24 |
| c07 | snapshot refused on its last element → no copy, no entry | — |
| c08 | v2 with no checklists → `no_checklists`, no entry | — |
| c09 | v1 → v2 → v3 unchanged keeps v1's reviewer and time | m01 m02 |
| c10 | guard body = the 3477 body (md5), attached, still refuses an entry naming someone else; carry has no service-role / role switch / sentinel | — |
| c11 | agent finalize after the carry: cleared entries precede the status entry | — |
| c12 | submitter cannot insert an item with a cleared marker; pair CHECK holds | m33 |
| c13 | removed item, renamed item (same id), item moved to another template → one `removed` entry each; renamed/moved rows unmarked | m12 m13 m25 |
| c14 / c14b | tick refused on a version with a newer version — uploading and resubmitted; outsiders still `not_authorized`; v2 ticks; a lone needs_changes version refuses a new tick and an untick (`not_open_for_review`), no tick, no history growth | m05 m06 m34 m44 m49 |
| c15 | function security / search_path / grants (add-at-review included); carry signature; authenticated has no UPDATE/DELETE on items | m29 m30 m31 |
| c16 | parent only: v2 unticked by the broker → v3 unticked (no jump from v1) | m04 |
| c17 | parent must be same submitter, deal, version − 1 → otherwise 42501 and the snapshot rolls back | m09 m10 m11 |
| c18 | older desktop → one `unavailable` (`unmatched_client`); pre-migration parent → nothing; older desktop, never ticked → nothing | m19 m20 |
| c19 | parent without a copy → one `unavailable` (`no_previous_copy`) only if an earlier version was ticked | m21 m22 |
| c20 | BACKLOG-3592: reviewer UPDATE refused on needs_changes/approved/rejected; allowed on open statuses; submitter transitions and status trigger unchanged; it_admin not in this rule (unchanged) | m35 m36 m37 m38 |
| c21 | applying the file twice changes nothing | m39 |
| c22 | rollback-refusals.sql then rollback.sql restore the catalogue exactly; the restored snapshot accepts `local_item_id` | m40 m41 m42 |
| c23 | needs_changes, both ways: new tick / untick / admin untick refused with no writes; ticks made before Request Changes carry to v2 with their original reviewer and time | m44 m45 |
| c24 | add-at-review refused (`superseded`) while the newer version uploads and after it lands, no checklist and no entry written; outsiders still `not_authorized`; add allowed on an open version with no newer one. Crafted-request fixture | m46 m47 m48 |
| c25 | rollback-refusals.sql restores the catalogue as 20260928120000 left it; a lone needs_changes version ticks again | m50 m51 |

Mutants of the tick body target the refusals file: it re-creates the
function after 20260928120000, so an edit to the older body is overwritten
before any control runs. m43 (SR mS6: the tick's history append skipped on a
needs_changes row) is retired: the refusal stops every new tick on a
needs_changes version before that append, so nothing can observe it.

Not observable in a one-session harness: the parent items' `FOR SHARE` lock
(the CI text test pins the line).

## Results

Recorded 2026-09-28 on the NAS test venue, Postgres 17.6, connected as the
venue's `postgres` role, branch `feature-portal/BACKLOG-3596-cloud-refusals`.
See `control-run.txt` (26 green / 26, 171 assertions) and `mutant-run.txt`
(50 run, 0 not as expected). `gate` re-run afterwards: OK.
