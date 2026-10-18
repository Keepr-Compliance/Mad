# BACKLOG-3851 PR-2f harness (M4a + M4)

| File | Purpose |
|---|---|
| `../../../migrations/20261017230000_backlog_3851_invite_name_columns.sql` (M4a) | `organization_members.invited_first_name` / `invited_last_name` (additive) |
| `../../../migrations/20261018170000_backlog_3851_invite_without_license.sql` (M4) | invitations without a license; four functions replaced, same signatures |
| `controls.sql` | DB controls C1-C6, C21, names (N1, N2), guard edits (G), validator (F4); one DO block ending in `RAISE 'PR2F_RESULT {...}'` |
| `rollback-m4.sql`, `rollback-m4a.sql` | rollbacks (m4 first) |
| `../../backlog-3684/rollback-3684-b.sql` | now refuses while M4 is in force (R4) |
| `body_md5.py` | `md5(prosrc)` of each function body in a file, computed locally (equals the catalog's) |
| `compose.sh`, `mutate.py` | concatenate files for one call; exact-once file mutation with numstat |

## Venue

keepr-test (cloud, `xiaobikzagpyubjcrcpb`), one transaction per call, ending in RAISE (rolled back).
The NAS replica is stale for this work. Files were staged on keepr-test in schema `p2f_stage`
(not exposed by the API; table `files`), each row's `md5(body)` checked equal to the file's
`md5 -q` before use, then run as `EXECUTE (SELECT body ...)`. Mutants were applied in the
database by an exact-once replace (`p2f_stage.rep`, raises on 0 or 2+ matches) with a line
diff count, and every controls run prints the md5 of the four bodies that actually ran.

## Results (2026-10-18, keepr-test ledger head 20261016200000 before apply)

Base (live bodies, controls.sql incl. X1): every check PASS (15 PASS values plus the recorded Sc line);
X1 = an unclaimed invitation with status neither 'pending' nor 'unassigned' ('suspended') is refused invalid_invite.
X1 mutant (status line removed from the accept_invitation lookup, body md5 3c8e3606): only X1 red.
`Sc_expired_pending_insert` = "admitted; resend refused P0001" (SR S-c: known behaviour).

| Mutant (exact-once, line diff) | Reds |
|---|---|
| A: claim sets 'active' (-1/+1) | C2 (free org row active), C3 (P0001 seat_limit_reached) |
| C: detector left on 'pending' (-1/+1) | C4 only |
| P3: guard counts unlicensed (-2/+1) | C1 (42501 max seats) and everything downstream |
| P4: accept lookup left on 'pending' (-1/+1) | C2, C3, C5, N1, N2 |
| guard INSERT shape 'pending' only (-1/+1) | C1, C2, ... |
| CASE inverted (-1/+1) | C2, C3, C6b |
| names overwrite (-1/+1) | N2 |
| validator licensed always true (-1/+1) | F4_unlicensed |
| admin_free without names (-1/+1) | G_admin_edits_name, N1 |
| get_user_org_ids status filter removed (live body) | C21 (templates=2 items=2) |

Drift / rollback:
- C15a M4 without M4a -> aborts (M4a not applied). C15b M4 twice -> no-op, md5 unchanged.
- C15c foreign detector body -> aborts; mutant (md5 check removed) -> runs over it.
- C15d claim_pending_invite granted to authenticated (3684 B absent) -> aborts.
- C16a M4 then rollback-m4 -> the four md5s are back to 63048036 / 851f0b67 / 93d54ab5 / 9501ad58.
- C16b rollback-m4 with an unclaimed unlicensed invite -> refuses; mutant (refusal removed) -> runs, row stranded.
- C16c rollback-3684-b under M4 -> refuses; mutant (check removed) -> runs, and the unlicensed
  invitee's `claim_pending_invite()` succeeds with the row active/claimed (SR L3 reproduced).
- C16d rollback-3684-b with A bodies but an unclaimed unlicensed row -> refuses.
- rollback-m4a: NOT run on keepr-test (the staging insert asked for an approval that expired).
