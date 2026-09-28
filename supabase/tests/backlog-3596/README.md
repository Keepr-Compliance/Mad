# BACKLOG-3596 harness — broker checklist ticks carried across versions

Runs `supabase/migrations/20260928120000_backlog_3596_broker_checklist_ticks.sql`,
then `supabase/migrations/20260928130000_backlog_3596_review_refusals.sql`, then
`supabase/migrations/20260928170000_backlog_3596_added_checklist_ticks.sql`
— **the shipped files themselves** — on a real Postgres 17.6, on top of the
migrations production holds for these tables, and records what every control
and every mutant did. `control-run.txt` and `mutant-run.txt` are the recorded
runs' own output, unedited. `rollback.sql`, `rollback-refusals.sql` and
`rollback-added.sql` are the tested rollbacks; they run in reverse order
(`rollback-added.sql` first).

The added-ticks file re-creates two functions:
`set_submission_checklist_reviewer_check` (the refusals-file body without the
`added_at_review` refusal: the broker ticks the items of a checklist they
added at review) and `carry_submission_checklist_reviews` (an added item is
matched on its parent's CLOUD id, which the desktop's pulled local item
takes; an unmatched ticked added item gets one `not_carried` entry; agent
items unchanged).

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
bash $H controls              # 32 controls, each in its own rolled-back transaction
bash $H mutants               # 62 mutants from lib/mutants.py against their target controls
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
  -> [c25: snapshot r0] -> the refusals file (or a mutant) -> [c25: snapshot r1]
  -> [c30: snapshot a0] -> the added-ticks file (or a mutant)
  -> [c21: snapshot, all three files again]
  -> [c22: snapshot, rollback-added.sql, rollback-refusals.sql, rollback.sql (or a mutant)]
  -> [c25: rollback-added.sql, rollback-refusals.sql (or a mutant)]
  -> [c30: snapshot a1, rollback-added.sql (or a mutant)]
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
| c13 | removed item, renamed item (same id), item moved to another template → one `removed` entry each; renamed/moved rows unmarked | m12 m13 m25 m61 |
| c14 / c14b | tick refused on a version with a newer version — uploading and resubmitted; outsiders still `not_authorized`; v2 ticks; a lone needs_changes version refuses a new tick and an untick (`not_open_for_review`), no tick, no history growth | m05 m06 m34 m44 m49 m53 |
| c15 | function security / search_path / grants (add-at-review included); carry signature; authenticated has no UPDATE/DELETE on items | m29 m30 m31 m62 |
| c16 | parent only: v2 unticked by the broker → v3 unticked (no jump from v1) | m04 |
| c17 | parent must be same submitter, deal, version − 1 → otherwise 42501 and the snapshot rolls back | m09 m10 m11 |
| c18 | older desktop → one `unavailable` (`unmatched_client`); pre-migration parent → nothing; older desktop, never ticked → nothing | m19 m20 m54 |
| c19 | parent without a copy → one `unavailable` (`no_previous_copy`) only if an earlier version was ticked | m21 m22 |
| c20 | BACKLOG-3592: reviewer UPDATE refused on needs_changes/approved/rejected; allowed on open statuses; submitter transitions and status trigger unchanged; it_admin not in this rule (unchanged) | m35 m36 m37 m38 |
| c21 | applying the file twice changes nothing | m39 |
| c22 | rollback-added.sql, rollback-refusals.sql then rollback.sql restore the catalogue exactly; the restored snapshot accepts `local_item_id` | m40 m41 m42 |
| c23 | needs_changes, both ways: new tick / untick / admin untick refused with no writes; ticks made before Request Changes carry to v2 with their original reviewer and time | m44 m45 m53 |
| c24 | add-at-review refused (`superseded`) while the newer version uploads and after it lands, no checklist and no entry written; outsiders still `not_authorized`; add allowed on an open version with no newer one. Crafted-request fixture | m46 m47 m48 |
| c25 | rollback-refusals.sql restores the catalogue as 20260928120000 left it (r0/r1 bracket the refusals file only; rollback-added.sql runs first); a lone needs_changes version ticks again | m50 m51 |
| c26 | the broker ticks an added item on an open version (under_review, resubmitted), one history entry; other-org broker / submitter `not_authorized`; needs_changes `not_open_for_review`; superseded `superseded`; refused calls write nothing | m52 m53 |
| c27 | added item keyed on its cloud id carries with the original broker and time; a renamed added item gets one `not_carried` entry; a dropped agent item on the same version keeps `removed`; second carry writes nothing | m55 m56 m57 m58 |
| c28 | two same-title items in one added checklist: the tick lands on the v2 copy of the ticked one (id key, not title) | m55 |
| c29 | added item changed on v2 (evidence attached / note written) → unticked, marked, one `edited` entry each; unchanged → carried (PM ruling) | m55 m60 |
| c30 | rollback-added.sql restores the catalogue as the refusals file left it; added-item tick refused again (`added_at_review`); an existing added tick no longer carries | m59 m63 |
| c31 | chain: v1 added ticks → v2 (pulled) → v3 keep the v1 broker and time; never pulled → one `not_carried` on v2 (also after a second carry), nothing on v3 | m55 m57 m58 |

A mutant must edit the LAST file that re-creates its body. The added-ticks
file re-creates both the tick and the carry, so the 32 mutants a census on
the three-file stack found inert (m01-m07, m09-m29, m31, m34, m44, m49; m29
because the file re-issues the carry's REVOKE from anon) target it. m45
stays on the refusals file: it appends a trigger no later file replaces. m43 (SR mS6: the tick's history append skipped on a
needs_changes row) is retired: the refusal stops every new tick on a
needs_changes version before that append, so nothing can observe it.

Not observable in a one-session harness: the parent items' `FOR SHARE` lock
(the CI text test pins the line).

## Results

Recorded 2026-09-28 on the NAS test venue, Postgres 17.6, connected as the
venue's `postgres` role, branch `feature-portal/BACKLOG-3596-added-checklist-ticks`.
See `control-run.txt` (32 green / 32, 230 assertions) and `mutant-run.txt`
(62 run, 0 not as expected). `gate` re-run afterwards: OK.
