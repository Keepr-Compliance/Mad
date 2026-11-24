# BACKLOG-4263 sync 2.49, P11: test files for migration 20261123150000 (approval page version 2)

**TEST DATABASE ONLY. Never run a `harness-n*.sql` file on production.** `gen.py` writes every file here from the
migration and `lib/*.sql`. `python3 gen.py check` fails when a written file is stale or a mutant fragment does not match
exactly once, and prints `MUTATION APPLIED` for each mutant. `broker-portal/__tests__/migrations/ai-approval-notice-2-4263.test.ts`
and `apply-wrappers-4263.test.ts` check the files' text in CI (no database there). After changing anything here, run
`gen.py` here, then `gen.py` in `../backlog-4263-sync2-t` (its `roles-report.txt` reads every .sql file of this folder).

## What the harness needs

20261123140000 applied and 20261123150000 **not** applied (`mcp_settings.notice_version` 1). Every call applies T-N's
text itself, inside its own transaction, and ends in RAISE, so nothing is kept. Before applying T-N to a database, run the
calls there; afterwards they refuse (the not-applied check).

## Order on the test project (one engineer at a time; a before-note to the coordinator for each call)

0. Dry run on the self-hosted dry-run database first (guarded copies: the marker md5 replaced by an exact-string replace
   that must match once per file and prints `SUBSTITUTION APPLIED <file> 1`). Never cited as a result for the test project.
   **Each stage runs three times on the dry-run database, each as one rolled-back call:** plain, and twice with a
   prefix of invented rows belonging to other users sent first in the same call (one variant without and one with
   read-log rows). Among those rows are a pending, unexpired authorization request and a version-1 connection. All
   three must read the same verdict. The prefix file is kept outside the repository for now. Expected effects of T-N
   on those rows, by design: the bump expires every pending request of every user, and `mcp_authorize_begin` deletes
   anyone's expired requests. Nothing else of theirs may change.
1. Fixtures: `kt-sql harness-n-fixtures.sql > fx.txt; python3 gen.py report-fixtures fx.txt` -> `decision: FULL` (the
   timing probes: the fixture, one approval chain, one application of T-N's text; the estimate must be at most 45 s).
2. Structure (only if the coordinator allows it as a stage): `kt-sql harness-n-structure.sql > st.txt;
   python3 gen.py report st.txt structure` -> last line `structure: OK`.
3. Full: `kt-sql harness-n.sql > out.txt; python3 gen.py report out.txt full` -> last line
   `controls=16 mutant_entries=18 (real=17 + negative_control_required_not_applied=1) problems=0`.
4. After every call: `kt-sql -c "select extensions.pg_stat_statements_reset()"`.

Locks held by every call (each mutant and control block for milliseconds; the last step until the RAISE): EXCLUSIVE
on `mcp_authorization_requests`, SHARE ROW EXCLUSIVE on `mcp_settings` and `mcp_connections`, the `cloud_release_switches`
row. T-N takes them in the order requests, settings, connections; a turn-off or "Disconnect all AI apps" at the same
moment takes connections then requests, so one of the two can end with SQLSTATE 40P01: nothing of that call is applied
(stop, as for 57014 / 55P03, and run again later).

Rules: never between minute 15 and minute 30 of the hour (the call holds the `cloud_release_switches` row; the erase job
takes it at minute 23). One full call. No re-send. Stop on SQLSTATE `57014` or `55P03`. HTTP 200 on any harness file
means it committed: an incident, stop and report.

## What each call does

- **Fixtures** (`lib/fixtures.sql`): two licensed users with Keepr Cloud on, one confirmed deal with three messages
  (linked; matched by a contact only; a text hidden from exports), one registered client with both allowlisted
  addresses, and connection K1 (user A) and KB1 (user B), each made through the real chain
  (begin -> view -> approve -> exchange) at version 1.
- **T-N's text** is stored as its top-level statements (`pg_temp.t_tn`, kind `tn`), and so is the rollback file's (kind
  `rb`). `pg_temp.tn()` / `pg_temp.rb()` run the variant in force through EXECUTE. A mutant replaces, drops or adds
  statements of one variant; it never edits a function in place.
- **Controls** (`lib/controls.sql`), each in a block that is undone, each applying T-N itself:
  C-N1 a version-1 connection stays at 1 and reads nothing; C-N2 a new approval is stamped exactly 2 and reads the deal's
  messages; C-N3 a request viewed at 1 cannot be approved after T-N; C-N4 T-N holds EXCLUSIVE on the request table;
  C-N5 a re-run changes nothing and at version 3 refuses; C-N6 refresh, tool calls, the reader, a disconnect leave a
  version-1 connection at 1 (regression, no mutant); C-N7 approval while `messages_upload` is off; C-N8 disconnect ends
  access at once and keeps the read rows (regression); C-N9 the reader (own rows, the permission, signed out, anon,
  support session); C-N9b the reader follows the permission, not the switch; C-N10 grants; C-N11 the rollback refuses
  while a version-2 connection exists and then restores version-1 behaviour; C-N13 a notice-version change made outside
  T-N also expires a request viewed before it; C-N14 an UPDATE of a connection's version is refused (postgres and
  service_role) while other columns still change; C-N15 T-N applies with its own trigger present, and the trigger is what
  expires pending requests (viewed and not); C-N16 the value written is `'-infinity'` (for a viewed request, for one
  whose expiry time has passed by T-N's clock, and for a change made outside T-N).
- **Mutants** (17 + the negative control): each is proven applied in a block of its own before its primary controls run;
  the catalogue fingerprint is compared after every one (`MUTANT NOT RESTORED <id>`).
- **Samples**: the view answer at version 2, the reader's answer and the read log after one list call, taken once (undone).
  The portal's test fixture `broker-portal/__tests__/mcp/fixtures/ai-approval-notice-2-4263.json` is transcribed from them.
- **Last step**: T-N at top level, then the rollback file, then a fingerprint compare with the baseline, then RAISE.

## Not covered by one call

An approve whose transaction began before T-N's needs two sessions (one call has one transaction start time):
`two-session/` (see its README). It commits T-N on the dry-run database and is not run without the coordinator's go.

## Files

| File | What it is |
|---|---|
| `gen.py` | Generator, `check`, `report`, `report-fixtures`, `selftest`, `dry-wrappers` |
| `lib/helpers.sql` | Temp tables, call-as-role, the approval chain, tool calls as the portal makes them, `tn()` / `rb()` |
| `lib/fixtures.sql` | Two licensed users, one deal with three messages, two version-1 connections |
| `lib/controls.sql` | The controls C-N1 ... C-N16 |
| `apply-20261123150000.sql` | The migration text unchanged + its ledger row |
| `rollback-20261123150000.sql` | Undoes 20261123150000; refuses while any connection holds version 2 or later |
| `harness-n.sql` | The full call |
| `harness-n-structure.sql` | Six controls, five mutants (one of each kind, the negative control among them), the fingerprint twice, the last step |
| `harness-n-fixtures.sql` | The fixtures and the timing probes |
| `answers-report.txt` | `answers.py` (backlog-4263-sync2-t) over `lib/*.sql` against the migrations through 20261123150000 |
| `two-session/` | The approve-before-T-N two-session control (hand-written; not run without the coordinator's go) |
