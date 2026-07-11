# Keepr Packaged-App E2E Driver (Playwright-Electron)

**Item:** BACKLOG-1849 (QA-H2) · **Realizes:** BACKLOG-1789 · **Epic:** BACKLOG-1847 · **Sprint:** SPRINT-166

This is the **first end-to-end automation the desktop app has ever had.** It drives the
**packaged** Keepr app with Playwright and exposes reusable, typed driver steps that the H1
ceremony runner (BACKLOG-1848) sequences: **boot → onboarding → navigate transaction → toggle
filter ON/OFF → trigger export**, with **persisted-session reuse** (no re-login on subsequent runs).

> This is separate from `admin-portal/playwright.config.ts`, which drives the Next.js web portal.

---

## TL;DR

```bash
# 1. Build a drivable QA package (inspect fuse enabled; still fully hardened otherwise).
npm run package:qa:dir      # unsigned, fast — drivable but NO session reuse (see §Session reuse)
#   or
npm run package:qa          # signed + notarized — drivable AND session-reuse capable (needs signing creds)

# 2. Type-check the driver
npm run qa:e2e:typecheck

# 3. Diagnose which launch strategy works on your build
npm run qa:e2e:probe            # Probe B (CDP renderer attach)
npm run qa:e2e:probe -- A       # Probe A (_electron.launch — expect FAIL on the standard build)

# 4. Run the smoke test (realizes BACKLOG-1789)
KEEPR_E2E_STRATEGY=electron npm run qa:e2e          # against a QA-fused build
KEEPR_E2E_STRATEGY=cdp      npm run qa:e2e          # against the hardened build (renderer-only)
```

---

## The core finding: why we drive the *packaged* build, and the fuse blocker

**Why packaged, not dev:** dev-mode Electron is ad-hoc signed, which breaks macOS **TCC** (contacts /
full-disk permissions) and the OAuth/keychain round-trip. Only a **notarized** build is trusted by
macOS, so OAuth + `safeStorage` keychain work. The installed `/Applications/Keepr.app` is
`Notarized Developer ID` (verified via `spctl`), which is exactly why the harness targets it.

**The blocker (empirically confirmed this spike):** the production build hardens Electron **fuses**
in `scripts/afterPack.js`:

| Fuse | Production | Effect on Playwright |
|------|-----------|----------------------|
| `EnableNodeCliInspectArguments` | **false** | ⛔ `_electron.launch()` can't attach to the **main** process — the `--inspect` arg is ignored, Playwright never sees `DevTools listening on ws://…`, and launch rejects with **"Process failed to launch!"** |
| `RunAsNode` | false | ⛔ no Node fallback attach |
| `OnlyLoadAppFromAsar` + `EnableEmbeddedAsarIntegrityValidation` | true | can't patch the installed asar to inject test hooks |

So the **textbook Playwright-Electron approach does not work against the production build as-is.**
This was the sprint's flagged "primary unknown." There are two validated ways forward:

### Strategy A — `electron` (recommended for the full harness)
Playwright `_electron.launch({ executablePath })`. **Full main + renderer control** (needed to stub
the native folder picker for export). Requires a build with the inspect fuse **enabled** →
`npm run package:qa`. The QA build is a **non-distributed test artifact**; all other hardening
(RunAsNode off, asar integrity, hardened runtime, notarization) stays intact.

### Strategy B — `cdp` (zero-rebuild fallback, renderer-only)
Spawn the app with `--remote-debugging-port` + `--remote-allow-origins=*` and
`chromium.connectOverCDP`. `--remote-debugging-port` is a **Chromium** switch, **not** gated by the
Node fuses, so this **attaches to the standard hardened/notarized build with no rebuild** (verified:
attached in ~4s). Limitation: **no main-process handle** — cannot stub native dialogs or read
main-process state. Sufficient for all renderer UI steps (onboarding, navigate, filter toggle,
opening the export modal). Use it for a quick packaged smoke against whatever is installed.

The `driver.strategy` is chosen by `KEEPR_E2E_STRATEGY` (`electron` | `cdp`). The driver auto-detects
the fuse blocker and prints actionable guidance if `_electron.launch` fails.

---

## Session reuse (no re-login)

The persisted profile lives at `~/Library/Application Support/keepr` (`mad.db` = seeded corpus,
`Preferences`, `Local Storage`) and the session/DB key is in the macOS keychain
(`keepr Safe Storage` / `keepr Key`). With `reuseProfile: true` (default) the driver launches
**without** `--user-data-dir`, so the app reuses that profile and lands on the ready main app with
**no re-login**. `isSessionReused()` returns true when the first observed state is `ready` (never
onboarding/login). Set `reuseProfile: false` for an isolated temp profile (fresh onboarding).

> **Signing-identity caveat:** the keychain `safeStorage` entry is scoped to the app's code-signing
> identity. An **unsigned** `package:qa:dir` build has a different identity and **cannot decrypt** the
> notarized app's DB key → it re-onboards. To validate end-to-end session reuse you need a
> **notarized QA build signed with the same identity** (`npm run package:qa`, which needs the
> Blue Spaces signing creds). This is the one remaining validation gated on machine credentials, not code.

---

## The one-time login ritual (per machine)

1. Launch the notarized app once, complete onboarding, connect the demo email account, let it sync,
   and approve the keychain prompt. This writes `~/Library/Application Support/keepr` + the keychain entry.
2. Every subsequent driver run reuses that profile — no human login. This is the model the H1
   ceremony assumes (its only manual step).

---

## Public driver API (consumed by H1)

`e2e/driver/types.ts` — `AppDriver`:

| Step | Method |
|------|--------|
| boot + first paint | `KeeprAppDriver.launch(repoRoot, opts)`, `waitForFirstPaint()` |
| detect state | `detectState()` → `'ready' \| 'onboarding' \| 'unknown'` |
| onboarding | `completeOnboarding({ skip, provider })` |
| session reuse | `isSessionReused()` |
| navigate | `gotoTransaction('742 Birchwood Lane NE')` |
| filter ON/OFF | `setAddressFilter(true\|false)`, `getAddressFilterState()` |
| export | `triggerExport({ format, destDir })` (stubs the native picker under `electron`) |
| artifacts | `screenshot(name)`, `userDataDir()` |

H1 adapter: `scripts/qa/harness/drivers/playwrightElectronDriver.ts` implements the runner's
`AppDriverComponent`. It declares that interface inline today; swap to
`import … from '../types'` once H1 (BACKLOG-1848) merges its `scripts/qa/harness/types.ts`.

---

## Selector strategy

The renderer has 383 `data-testid`s, but most onboarding / transaction-list / export UI has **none**
today, so text + role fallbacks are used there. The one high-value testid we rely on is
`address-filter-toggle` (the filter, `role="switch"` + `aria-checked`). Adding testids to the
onboarding shell and transaction cards is a follow-up (H9 UI-regression sweep) that will harden these
selectors. Central map: `e2e/driver/selectors.ts`.

## Known limitations / follow-ups

- **Native folder picker** on folder export is only drivable under `electron` (main-process dialog
  stub). Under `cdp`, `triggerExport` opens the modal but can't complete the OS picker.
- Full green `KEEPR_E2E_FULL` walkthrough needs a **notarized QA build + logged-in session** (above).
- The installed `/Applications/Keepr.app` observed this spike was a **dev-flavored** package (its
  renderer pointed at `http://localhost:5173`). Prefer a clean `dist/` artifact from `package:qa*`.
