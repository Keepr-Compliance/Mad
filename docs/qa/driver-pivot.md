# Reliable QA Driver — the unpackaged pivot (BACKLOG-1940)

The **reliable, watchable** QA driver that makes the app drive itself for feature-verification /
agent-self-verify. It replaces the old packaged + ad-hoc-signed path (`scripts/qa/drive-verify.ts`,
deleted) which fought macOS-15 strict code-signing.

## The founder command

```bash
npm run qa:drive
# exit code:  0 = PASS   1 = FAIL   2 = HARNESS_ERROR
```

One command that, in a single headful pass:

1. **Builds if needed** — `npm run build` (skips if `dist-electron/main.js` + `dist/index.html` exist;
   force with `QA_FORCE_BUILD=1`).
2. **Seeds an isolated profile** — creates the encrypted DB + a known fixture (a user, a session, three
   contacts, one transaction at *742 Birchwood Lane NE*, three emails + links) and writes a matching
   `session.json`. NEVER touches the real `~/Library/Application Support/keepr` profile.
3. **Launches UNPACKAGED and foregrounded** — via Playwright `_electron.launch()` against the
   node_modules `electron` binary + the built `dist-electron/main.js`. No packaging, no codesign, no
   Gatekeeper. The window is brought to the FRONT so you can watch it.
4. **Lands logged-in with NO OAuth** — the seeded `session.json` + DB session authenticate the app; there
   is no login wall and no `keepr://` deep-link.
5. **Drives** — dismiss the feature tour → open **Settings** (via testid, screenshot) → open the
   **Transactions** list (via testid) → click the **first** row, which opens the **real seeded
   transaction** (its address is asserted visible, screenshot).
6. **Reports the 3-way outcome** — every step is classified PASS / FAIL / HARNESS_ERROR
   (`e2e/driver/outcome.ts`) with a distinct exit code, then tears down gracefully (no orphan, no crash
   dialog).

Screenshots land in `.qa-scratch/drive-pivot/` (override with `QA_ARTIFACTS_DIR`).

### Environment knobs

| Env | Default | Effect |
|-----|---------|--------|
| `QA_PROFILE_DIR` | `.qa-scratch/keepr-pivot-profile` | Isolated userData profile. |
| `QA_KEEP_PROFILE=1` | (off — fresh each run) | Reuse the existing seeded profile instead of re-seeding. |
| `QA_FORCE_BUILD=1` | (off) | Rebuild even if artifacts exist. |
| `QA_ARTIFACTS_DIR` | `.qa-scratch/drive-pivot` | Screenshot output dir. |

## How each piece works

### 1. Unpackaged launch (`e2e/driver/launch.ts` → `launchUnpackaged`)

`_electron.launch({ executablePath: node_modules/.bin/electron, args: ['.', '--user-data-dir=<isolated>'],
env: { KEEPR_E2E: '1' } })`. The `.` entry resolves `package.json` `"main"` to the built
`dist-electron/main.js`. Default Electron fuses leave the Node inspector enabled, so Playwright attaches to
the **main process** (unlike the hardened packaged build, which blocks `_electron.launch`). An isolated
`--user-data-dir` is **mandatory** — the launcher refuses to run against the real profile.

### 2. Serving built assets, not the dev server (the one app-code hook)

Unpackaged, `app.isPackaged` is `false`, so the normal load path would point the renderer at the Vite dev
server (`http://localhost:5173`), which is not running under the driver. The driver sets `KEEPR_E2E=1`, and
a **dev-only, ship-guarded** hook in `electron/main.ts` (`isE2EServeDistMode()` =
`!app.isPackaged && process.env.KEEPR_E2E === '1'`) makes an unpackaged build load the already-built
`dist/` assets via the `app://` protocol instead. It is **double-gated**: a packaged/notarized artifact
always has `app.isPackaged === true`, so this branch is dead code in any shipped build regardless of the
env var. It only chooses which local asset source is loaded; it injects no auth and adds no IPC.

### 3. Auth injection — a pure fixture, zero auth-code change

`electron/handlers/sessionHandlers.ts` `handleGetCurrentUser` authenticates from:
- a loadable `session.json` (`sessionService`), and
- a matching row in the local encrypted DB (`sessions` JOIN `users_local`, `validateSession`).

All the real-Supabase `setSession`/`getUser` validation blocks are gated on `session.supabaseTokens` being
present. The seeded `session.json` **omits** `supabaseTokens`, so those blocks are skipped entirely and the
app authenticates offline from the fixture — no OAuth, no network. `preAuthValidationHandler` likewise
returns valid on the no-`supabaseTokens` path.

### 4. Seeded fixture (`e2e/driver/seed/seedProfile.ts` + `scripts/qa/harness/seed-fixture.js`)

- Launch the app once on the isolated profile so its boot-time DB init (LoadingOrchestrator PHASE 2)
  creates `mad.db` + the safeStorage-wrapped `db-key-store.json`.
- `seed-fixture.js` (Electron-main, reusing the H3 cipher-open approach from `db-assert.js`) reads the
  profile's DB key via `safeStorage`, opens `mad.db` with the app's cipher pragmas
  (`cipher_compatibility = 4`), and raw-INSERTs the fixture.
- `seedProfile.ts` then writes `session.json` with the seeded `sessionToken`.

The seeder **refuses** to run against the real keepr profile.

## Trust classification (unchanged from #1910)

Every step maps to exactly one of PASS / FAIL / HARNESS_ERROR via `e2e/driver/outcome.ts`. A thrown error
inside a driving step is ALWAYS a HARNESS_ERROR (never a false PASS/FAIL). Key boundaries the driver
enforces:
- missing `tx-list` testid → HARNESS_ERROR (never a false "0 transactions");
- still at the login wall after seeding → `login-not-completed` HARNESS_ERROR;
- opened a row but the seeded address is not confirmed → HARNESS_ERROR (does not claim PASS).

The run is **single-pass**: on any failure it screenshots, records the correct outcome, and STOPS — it
never loop-relaunches.

## CI placement

The Playwright spec `e2e/tests/driver-pivot.spec.ts` runs under the Playwright config
(`e2e/playwright.electron.config.ts`, `testDir: ./tests`) via `npm run qa:e2e` — **outside**
`e2e/driver/__tests__/`, which is the Node-jest CI glob. The 34 pure trust-classification proofs in
`e2e/driver/__tests__/outcome.test.ts` continue to gate CI as Node-only unit tests.
