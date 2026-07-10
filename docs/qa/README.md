# QA Harness — deterministic ceremony runner

One command drives the whole deterministic QA ceremony:

```bash
npm run qa:ceremony -- --scenario tx1-birchwood
```

It reads a **scenario manifest** and sequences:

```
wipe → seed → boot+drive app → assert DB set-diff → assert export → (optional) update-migrate → re-assert
```

Every gate asserts an **EXACT corpus-derived count**, never a threshold. Every
deviation is a finding to explain. This productizes the v2.20.0 fresh-install
ceremony (2026-07-06) — see `email-sync-methodology.md` for the human runbook and
`tx1-canonical-list-v2.20.0.md` for the canonical 69-row expected list.

> **Set-identity rule (load-bearing):** email set membership is keyed by
> `(subject, shifted-date)`, **never** by Message-ID. Corpus `.eml` files carry
> no Message-ID; Graph assigns `internetMessageId` server-side.

This item (BACKLOG-1848 / QA-H1) ships the **runner + manifest + CLI + the
component interface contract**. The real components land alongside:

| Stage             | Component interface        | Owner                  |
| ----------------- | -------------------------- | ---------------------- |
| wipe / seed       | `SeederComponent`          | H4 (BACKLOG-1851)*     |
| boot + drive app  | `AppDriverComponent`       | H2 (BACKLOG-1849)      |
| assert DB set-diff| `DbSetDiffAsserter`        | H3 (BACKLOG-1850)      |
| assert export     | `ExportManifestAsserter`   | H5 (BACKLOG-1852)      |
| update + migrate  | `UpdateMigrateRunner`      | Phase 3 (F)            |

\* The Outlook seeder is already real (wraps `scripts/qa/email/seed-m365.py`);
Gmail + other sources land in H4.

## Modes

By default the ceremony runs a **safe wiring smoke test**: every stage runs a
stub that touches **no** live mailbox, app, or filesystem. It prints what each
stage *would* do, then reports `WIRING-OK (stubbed)`.

Add `--live` to engage real, side-effecting components (only meaningful once the
owning tasks above have merged):

```bash
npm run qa:ceremony -- --scenario tx1-birchwood --live
```

### Flags

| Flag             | Effect                                                        |
| ---------------- | ------------------------------------------------------------- |
| `--scenario <id>`| Scenario id (`docs/qa/scenarios/<id>.json`) or a `.json` path |
| `--live`         | Engage real components (default: all stub)                    |
| `--skip-seed`    | Skip wipe + seed (mailbox already seeded)                     |
| `--skip-driver`  | Skip the Playwright-Electron drive stage                      |
| `--skip-export`  | Skip the export-manifest assertion                            |
| `--with-update`  | Run the update-migrate + re-assert stage                      |
| `--dry-run`      | Print intended actions; perform no real side effects          |
| `-v, --verbose`  | Debug logging                                                 |
| `-h, --help`     | Show help                                                     |

### Exit codes

| Code | Meaning                                                        |
| ---- | ------------------------------------------------------------- |
| `0`  | Passed (or wiring smoke passed with all-stub components)       |
| `1`  | An exact-count mismatch or stage failure was found            |
| `2`  | Configuration error (bad scenario / drifted checklist)        |

The runner exits **non-zero on ANY exact-count mismatch** and prints the
specific deviation — expected N, got M, and which rows differ by
`(subject, shifted-date)`.

## One-time setup per machine (the only manual step)

Live runs drive the **packaged** app and seed a live demo mailbox. Each machine
needs a **one-time demo-account login** so the driver can reuse the persisted
Electron `userData` profile + macOS Keychain approval thereafter:

1. **Seeder auth** — place the demo mailbox OAuth token JSON at
   `~/.keepr-qa/token.json` (path is configurable via `scenario.seed.tokenFile`).
   See the header of `scripts/qa/email/seed-m365.py` for the token JSON format.
   Run the seeder with **Apple system Python** (`/usr/bin/python3`) — pyenv /
   Homebrew Pythons frequently lack SSL.
2. **App login** — launch the packaged app once, complete onboarding, connect the
   demo email account, and approve the Keychain prompt. The driver (H2) reuses
   this session on every subsequent run; there is no repeated interactive login.
3. **Corpus** — ensure the `.eml` corpus is present at
   `scenario.seed.corpusDir` (default `~/Downloads/demo-mailbox`).

After this, `npm run qa:ceremony -- --scenario tx1-birchwood --live` runs
end-to-end unattended.

## Validating the DB asserter against the EXISTING DB (H3 / BACKLOG-1850)

Validate the encrypted-DB set-diff **without** wiping/re-seeding the mailbox
(e.g. the seeder token is expired, or you just want to re-assert the current
local DB). It's a **two-step** flow: provision the Keychain once, then run the
assert-DB stage as often as you like.

**Step 1 — one-time Keychain provisioning (per shell session):**

```bash
eval "$(npm run --silent qa:db-key -- --print-export)"
```

`qa:db-key` is a **foreground** Electron helper that reads the DB key from the
macOS Keychain via the app's own `safeStorage` (approve the one-time **"Always
Allow"** prompt if it appears). `--print-export` emits an
`export KEEPR_QA_DB_KEY=…` line that `eval` loads into your **shell env only** —
the key is **never written to disk**. (Run `npm run qa:db-key` without
`--print-export` to just grant the Keychain ACL and print instructions.)

**Step 2 — run the assert-DB stage (sub-second, repeatable):**

```bash
npm run qa:ceremony -- --scenario tx1-birchwood --live \
  --skip-seed --skip-driver --skip-export
```

This runs `db-assert` under **plain Node** (no GUI Electron), opens the app's own
encrypted `mad.db` **read-only** with the app's own cipher module + the env key,
replays the `email_participants` junction query, and asserts EXACTLY
`corpus / filterOff / filterOn / missing / extra / ghosts`. A green run:

```
[PASS] assert-db — 69/69 OFF · 37/37 ON · 0 deviation(s) · link/ghost checked vs txn …
Verdict: PASS — all exact counts held (128ms)
```

If you skip step 1, step 2 **fails fast (≈1 ms)** with the exact `eval …` command
to run — it never hangs waiting on a Keychain prompt.

Notes (H3 behavior, learned from live validation):

- **Why two steps.** The Keychain read needs a foreground `safeStorage` prompt
  that a spawned child process can't reliably present (that caused a 120 s hang).
  So `qa:db-key` does the interactive part once (foreground), and the ceremony
  runs key-in-hand under plain Node. This also sidesteps native-module ABI
  issues: the cipher module from a normal `npm install` is Node-ABI, which plain
  Node loads (Electron-ABI would not).
- **Source timezone.** The DB stores `sent_at` in UTC; the canonical dates are
  the corpus author's local dates. `scenario.sourceTimezone` (default
  `America/Los_Angeles`) converts `sent_at` to the local calendar day so
  `(subject, shifted-date)` matches. (FU: H1 to formalize in `ScenarioManifest`/zod.)
- **Corpus-user scoping.** The app DB can accumulate multiple accounts. The
  asserter scopes `corpus` + the sets to the user that owns the participant-
  matched emails, so a stale second account does not skew the counts.
- **CI / fixture DBs.** Provide `KEEPR_QA_DB_KEY` (raw hex key) directly and
  `KEEPR_QA_DB` to point at a specific DB file — no Keychain, no Electron.

## Authoring a scenario

A scenario is a JSON file under `docs/qa/scenarios/` validated against the
`ScenarioManifest` schema (`scripts/qa/harness/manifest.ts`). Required fields:
`source`, `transaction`, `auditWindow`, `contacts`, `ownAddressExcluded`,
`dateShiftMonths`, `expectedCounts`, `expectedManifestRef`, and
`setIdentity: "subject+shifted-date"`. `expectedManifestRef` points (relative to
the manifest) at the canonical checklist markdown; the runner parses it and
**fails fast if the checklist and manifest counts have drifted**.

## Harness internals

```
scripts/qa/harness/
  types.ts          # the published component contract (import from here)
  index.ts          # public barrel
  manifest.ts       # zod-validated scenario loader
  canonicalList.ts  # parses the 69-row checklist → machine-checkable set
  diff.ts           # (subject, shifted-date) set-diff + exact-count deviations
  runner.ts         # stage orchestrator + verdict
  cli.ts            # `qa:ceremony` entrypoint
  components/        # stubs + the real Outlook seeder + registry
  db-set-diff-asserter.ts  # H3: DbSetDiffAsserter (spawns the plain-node measure shell)
  db-assert.js             # H3: node/Electron measure shell (app cipher, tz, user-scoping)
  db-set-diff-core.js      # H3: pure DB-measure helpers (query, tz date)
  db-key.js                # H3: one-time foreground Keychain provisioning (qa:db-key)
```

Type-check the harness in isolation:

```bash
npm run qa:typecheck
```

(The harness is also covered by the repo-wide `npm run type-check`.)
