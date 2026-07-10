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
```

Type-check the harness in isolation:

```bash
npm run qa:typecheck
```

(The harness is also covered by the repo-wide `npm run type-check`.)
