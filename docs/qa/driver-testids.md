# QA Driver `data-testid` Convention (BACKLOG-1940)

The packaged-app QA driver (`e2e/driver/`) navigates the renderer through **stable
`data-testid` attributes** instead of guessing at visible text or ARIA roles. This document is
the single source of truth for that convention. The canonical list of values lives in code at
`e2e/driver/selectors.ts` (`Testids`), so the renderer and the driver can never drift.

## Why testids (and not text/role)

Tonight's live demo proved the driver *can* pilot the packaged app to the dashboard, but it
**stalled on the phone-type card** because it was guessing selectors. Text/role selectors break on
copy changes, i18n, and layout tweaks. A `data-testid` is an explicit, stable contract between the
UI and the harness. After BACKLOG-1940 the driver's navigation helpers (`gotoSettings`,
`gotoTransactions`, `clickFirstTransaction`, `dismissTour`) are built **entirely** on testids — so a
missing/renamed testid surfaces as a **`HARNESS_ERROR`** (see `e2e/driver/outcome.ts`) rather than a
silent miss or a false failure.

## Convention

- **kebab-case**, matching the existing renderer convention (`contact-card-email`, `sync-status`, …).
- Grouped by area with a stable prefix: `onboarding-*`, `nav-*`, `settings-*`, `tx-*`.
- Indexed collections use a numeric suffix: `tx-row-0`, `tx-row-1`, …
- Attribute-only: adding a testid **never** changes behaviour or logic.
- Added **alongside** any existing `data-tour` attribute (never replacing it — the tour still needs it).

## Registry

| `data-testid` | Where | Purpose |
|---|---|---|
| `onboarding-phone-iphone` | `onboarding/steps/PhoneTypeStep.tsx` | Select iPhone |
| `onboarding-phone-android` | `onboarding/steps/PhoneTypeStep.tsx` | Select Android |
| `onboarding-continue` | `onboarding/shell/NavigationButtons.tsx` | Shell Continue/Next |
| `onboarding-back` | `onboarding/shell/NavigationButtons.tsx` | Shell Back |
| `onboarding-skip` | `onboarding/shell/NavigationButtons.tsx` | Shell Skip |
| `onboarding-skip-confirm` | `onboarding/shell/NavigationButtons.tsx` | "Skip anyway" (two-step confirm) |
| `onboarding-secure-storage-continue` | `onboarding/steps/SecureStorageStep.tsx` | Secure-storage Continue |
| `onboarding-contacts-continue` | `onboarding/steps/ContactSourceStep.tsx` | Contact-source Continue |
| `onboarding-permissions-open-settings` | `onboarding/steps/PermissionsStep.tsx` | Open System Settings |
| `onboarding-permissions-check` | `onboarding/steps/PermissionsStep.tsx` | Check Permissions |
| `onboarding-email-connect-primary` | `onboarding/steps/EmailConnectStep.tsx` | Connect primary provider |
| `onboarding-email-connect-secondary` | `onboarding/steps/EmailConnectStep.tsx` | Connect secondary provider |
| `onboarding-email-continue-primary` | `onboarding/steps/EmailConnectStep.tsx` | Continue after primary connected |
| `onboarding-email-continue-secondary` | `onboarding/steps/EmailConnectStep.tsx` | Continue after secondary connected |
| `nav-profile` | `appCore/AppShell.tsx` | Profile avatar (opens Profile modal) |
| `nav-settings` | `components/Profile.tsx` | Settings button inside Profile modal |
| `nav-new-audit` | `components/Dashboard.tsx` | "New Audit" tile |
| `nav-transactions` | `components/Dashboard.tsx` | "All Audits" / transactions tile |
| `nav-clients-contacts` | `components/Dashboard.tsx` | "Clients & Contacts" tile |
| `settings-page` | `components/Settings.tsx` | Settings modal is open (header) |
| `settings-close` | `components/Settings.tsx` | Close/Back control that dismisses the Settings modal |
| `settings-tabs` | `components/settings/SettingsTabBar.tsx` | Settings tab bar container |
| `settings-tab-{name}` | `components/settings/SettingsTabBar.tsx` | Individual tab, e.g. `settings-tab-general` |
| `tx-list` | `components/TransactionList.tsx` | Transactions list container — **always present** on the transactions view |
| `tx-empty` | `components/TransactionList.tsx` | Empty-state ("No transactions yet") |
| `tx-rows` | `components/TransactionList.tsx` | Populated rows container |
| `tx-row-{index}` | `components/TransactionList.tsx` | Nth transaction row (0-based) |

### `settings-tab-{name}` derivation

The Settings tab ids are `settings-general`, `settings-email`, …; the testid strips the leading
`settings-` so tabs read cleanly: `settings-tab-general`, `settings-tab-email`, `settings-tab-about`.

## The feature tour (react-joyride) — a deliberate exception

react-joyride renders its own Skip/Next buttons and does **not** let us inject a `data-testid` onto
them. Its buttons carry a **stable `data-action`** attribute, which is the library's public contract:

- `[data-action="skip"]` — Skip the tour
- `[data-action="primary"]` — Next / Done
- `[data-action="back"]` — Back

The driver targets those via `TourActions` in `selectors.ts`. This is intentional: `data-action` is as
stable as a testid for this third-party component, and wrapping joyride's internals would be a larger,
behaviour-touching change than this attribute-only sweep warrants.

## The trust boundary this enables

`tx-list` is rendered **whenever the transactions view is shown** — empty or populated. That is
load-bearing:

- `tx-list` **present** + `tx-empty` rendered → the list is correctly **empty** → **PASS**.
- `tx-list` **present** + `tx-row-*` rows → populated → **PASS**.
- `tx-list` **absent** → the harness could not find the list → **`HARNESS_ERROR`** — it must **never**
  be reported as "0 transactions" (a false FAIL) nor swallowed as PASS.

See `e2e/driver/outcome.ts` and `e2e/driver/__tests__/outcome.test.ts` for the enforced classification.

## Running the verification (the "founder command")

The reliable path is the **unpackaged** driver — see **[docs/qa/driver-pivot.md](./driver-pivot.md)** for the
full command, safety contract, and internals.

```bash
# One command: builds if needed → seeds an isolated profile → launches UNPACKAGED and foregrounded →
# injects a seeded session (NO OAuth) → drives (dismiss tour, Settings, transactions, open first tx) →
# reports PASS / FAIL / HARNESS_ERROR. Headful — a window WILL appear (isolated profile, safe).
npm run qa:drive
# exit code: 0 = PASS   1 = FAIL   2 = HARNESS_ERROR
```

There is **no packaging, no codesign, and no Gatekeeper** in this path — that is the whole point of the
pivot (it sidesteps the macOS-15 signing kill documented below). The old packaged `qa:drive:verify`
command (`scripts/qa/drive-verify.ts`) was **deleted** in the BACKLOG-1940 pivot.

## ENVIRONMENT finding — macOS 15 strict code-signing (BACKLOG-1940) — WHY the pivot exists

On **macOS 15**, the runtime code-signing monitor is strict: a freshly `npm run package:qa:dir` build
(`CSC_IDENTITY_AUTO_DISCOVERY=false` → default "Electron"/unsigned signature) is **SIGKILLed on launch**
(`EXC_BAD_ACCESS` / `Namespace CODESIGNING` / "Invalid Page", in dyld, before app code runs). This is
**not** a driver bug and **not** an app bug — it is an invalid QA-build signature.

**The pivot's resolution:** the reliable driver no longer packages or signs anything. It runs the
node_modules `electron` binary (default fuses → the Node inspector works, so `_electron.launch()` attaches)
against the built `dist-electron/main.js` — so the strict-signing monitor has nothing to kill. See
**[docs/qa/driver-pivot.md](./driver-pivot.md)**.

The outcome classifier retains a dedicated `environment-signing` `HARNESS_ERROR` category for the
occasional full-fidelity **packaged** smoke test (real notarized artifact + real keychain), which is a
separate use case from the unpackaged feature-verification driver. If that packaged path ever SIGKILLs on
launch, it surfaces distinctly (never as an app PASS/FAIL) and must not loop-relaunch.
