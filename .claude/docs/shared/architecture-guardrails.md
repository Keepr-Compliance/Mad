# Architecture Guardrails

**Status:** Canonical reference for code architecture standards
**Last Updated:** 2024-12-24

---

## Entry File Line Budgets

These limits are enforced in PR reviews.

| File | Target | Trigger | Purpose |
|------|--------|---------|---------|
| `App.tsx` | **70** | >100 | Root composition, providers only |
| `AppShell.tsx` | **150** | >200 | Window chrome, title bar, offline banner |
| `AppRouter.tsx` | **250** | >300 | Screen routing/selection only |
| `AppModals.tsx` | **120** | >150 | Modal rendering only |
| `useAppStateMachine.ts` | **300** | >400 | Orchestrator, delegates to flows |

**How to read this:**
- **Target**: Ideal line count - aim to stay at or below this
- **Trigger**: Hard limit - exceeding this requires mandatory extraction before merge

---

## App.tsx Rules

**App.tsx MUST only contain:**
- Top-level providers (theme, auth, context)
- Main shell/layout composition
- Router/screen selection delegation
- Minimal wiring logic (~70 lines max)

**App.tsx MUST NOT contain:**
- Business logic or feature-specific code
- API calls, IPC usage, or data fetching
- Complex useEffect hooks or state machines
- Onboarding flows, permissions logic, or secure storage setup
- Direct `window.api` or `window.electron` calls

**Example of correct App.tsx:**
```typescript
function App() {
  const app = useAppStateMachine();

  return (
    <ThemeProvider>
      <AuthProvider>
        <AppShell app={app}>
          <AppRouter app={app} />
          <AppModals app={app} />
          <BackgroundServices />
        </AppShell>
      </AuthProvider>
    </ThemeProvider>
  );
}
```

---

## Electron Layer Responsibilities

### main.ts
- Window lifecycle management
- Process-level concerns and top-level wiring
- IPC handler registration (delegating to services)
- App-level event handling

### preload.ts
- Narrow, typed bridge to renderer
- Expose minimal, well-defined API surface
- NO business logic

### Renderer Code
- Access Electron APIs via service modules/hooks only
- NEVER scatter `window.api`/`window.electron` calls in components
- Use typed service abstractions

---

## State Machine API Patterns

The app state machine exposes a **typed interface with semantic methods**, not raw state + setters.

**DO: Expose semantic transitions**
```typescript
export interface AppStateMachine {
  // State (read-only from consumer perspective)
  currentStep: AppStep;
  isAuthenticated: boolean;
  currentUser: User | null;
  modalState: { showProfile: boolean; showSettings: boolean };

  // Semantic transitions (verbs, not setters)
  openProfile(): void;
  closeProfile(): void;
  goToStep(step: AppStep): void;
  completeExport(result: ExportResult): void;
  handleLoginSuccess(data: LoginData): void;
}
```

**DON'T: Expose raw setters**
```typescript
// BAD - leaks internal state shape
state.setShowProfile(true);
state.setCurrentStep("email-onboarding");
```

**Pass state machine object to child components:**
```tsx
// GOOD - single typed API object
<AppRouter app={app} />
<AppModals app={app} />

// BAD - prop drilling dozens of individual values
<AppRouter
  currentStep={state.currentStep}
  setCurrentStep={state.setCurrentStep}
  isAuthenticated={state.isAuthenticated}
  // ... 40 more props
/>
```

---

## Complex Flow Patterns

Multi-step flows (onboarding, secure storage, permissions) MUST be implemented as:
- Dedicated hooks (`useOnboardingFlow`, `useSecureStorageSetup`)
- Feature modules (`/onboarding`, `/dashboard`, `/settings`)
- State machines for complex state transitions
- Feature-specific routers when needed

These flows MUST NOT be hard-wired into global entry files.

**Target structure:**
```
src/
├── App.tsx                        (~70 lines max)
├── app/
│   ├── AppShell.tsx               (~150 lines)
│   ├── AppRouter.tsx              (~250 lines)
│   ├── AppModals.tsx              (~120 lines)
│   ├── BackgroundServices.tsx     (~50 lines)
│   └── state/
│       ├── types.ts
│       ├── useAppStateMachine.ts  (~300 lines)
│       └── flows/
│           ├── useAuthFlow.ts
│           ├── useSecureStorageFlow.ts
│           ├── usePhoneOnboardingFlow.ts
│           ├── useEmailOnboardingFlow.ts
│           └── usePermissionsFlow.ts
```

---

## SQL Text Lives in One Layer

**Enforced by CI:** job `SQL Boundary Gate` -> `npm run check:sql-boundary`
(`scripts/ci/check-sql-boundary.mjs`, baseline `scripts/ci/sql-boundary-baseline.json`).

### The rule

> **SQL *text* is defined only in `electron/services/db/**`** -- the `*Sql.ts`
> pattern that already exists (`contactProjectionSql`, `contactRecencySql`,
> `contactSourceLinkSql`, `contactTombstoneSql`, `frozenContactSql`,
> `contactIdentitySchemaSql`).
>
> *Executing* declared SQL against a non-singleton handle is permitted where
> declared: worker threads, backup/manifest database files, schema bootstrap and
> the encryption-rebuild path. **That exception licenses EXECUTING on a
> non-singleton handle. It never licenses DEFINING text outside `db/`.**

Why it matters: a second platform can reuse SQL *text*. It can never reuse a
`better-sqlite3` statement object.

### Writing compliant code

```ts
// electron/services/db/widgetSql.ts
export const WIDGETS_BY_OWNER_SQL = `SELECT id FROM widgets WHERE owner_id = ?`;

// anywhere else
import { WIDGETS_BY_OWNER_SQL } from "../services/db/widgetSql";
db.prepare(WIDGETS_BY_OWNER_SQL).all(ownerId);
```

`electron/workers/contactQueryWorker.ts` is the working example: it opens its own
readonly handle on a worker thread and still imports every query from `db/`.

### What the gate flags

All three verbs -- `.prepare(`, `.exec(`, `.pragma(`. A `.prepare(`-only gate is
decorative: it would pass a file holding raw `db.exec()` DDL.

It classifies **where argument 0's text came from**, not the receiver name, so
`RegExp.exec` is green with no name blacklist. Every call site lands in exactly
one of three buckets -- there is no "cannot tell, assume fine":

| bucket | meaning |
|---|---|
| COMPLIANT | inside `db/**`, or text imported from `db/**`, or a proven RegExp receiver, or a declared `.pragma()` exception |
| VIOLATION | SQL text authored outside `db/**`, including hoisted consts, concatenations, ternaries, and imports from non-`db` modules |
| UNRESOLVABLE | origin not statically determinable -- **counts as a violation** |

**UNRESOLVABLE is not a loophole, it is the point.** Passing SQL through a helper
parameter (`const run = (sql: string) => db.prepare(sql)`) is exactly the
untraceability the rule prevents, so the gate reports it rather than passing it.
Resolution follows at most two alias hops; beyond that it returns UNRESOLVABLE, so
exceeding the limit can only ever produce a **false red, never a false green**.

A name written by a form the binding map does not model -- assignment, `+=`,
parameter, destructuring, catch variable, uninitialised `let` -- is **tainted** for
**the scope that declares it**, and can never be COMPLIANT. The span is the
binding's scope rather than a position around the write, so it covers every read of
that binding wherever it happens. This matters because
`let sql = <db import>; sql += ...` is the dominant query-assembly idiom in this
codebase, and without taint the append is invisible:

```ts
let sql = WIDGETS_BY_OWNER_SQL;
sql += ` LIMIT ${Math.floor(limit)}`;   // still authoring SQL outside db/
db.prepare(sql);                        // -> UNRESOLVABLE, not COMPLIANT
```

It holds across scopes too -- a write in a callback, or in a sibling function, still
taints a module-level binding read elsewhere:

```ts
let cachedSql = WIDGETS_BY_OWNER_SQL;
export function configure(t) { cachedSql = `... '%${t}%'`; }
export function run(db) { db.prepare(cachedSql); }   // -> UNRESOLVABLE
```

**Moving a query in halves does not clear it.** If you move the base SELECT into
`db/` but leave an interpolated `+=` at the call site, the site stays red. Move the
whole statement, or parameterise the part that varies.

### Layer integrity -- what keeps `from-db-import` honest

`from-db-import` asserts the text *originates* in the layer, but a specifier is
resolved one hop and only says where a module *sits*. A two-line barrel inside
`db/` would launder text defined anywhere:

```ts
// electron/services/db/barrel.ts
export { EVIL_SQL } from "../../handlers/evilSql";   // text DEFINED outside db/
export * from "../../handlers/evilSql";
```

So **a `db/` file whose `export ... from` resolves outside `db/` is itself a
violation**, raised at the barrel rather than at the importer: the PR that creates
the laundering fails, and no legitimate in-layer import is punished. Inward
re-exports are fine (`db/index.ts` has 15), and type-only re-exports are exempt.

**If you need something from outside the layer, move the declaration in. Do not
re-export it.**

### Where the classifier can be wrong

All fail **closed** -- they produce a false red, never a false green -- and none
exists in the tree today. That claim covers the classifier and rests on the
layer-integrity check above; it does **not** extend to the two unenforced axes
below, which are a different guarantee.

- **Interprocedural flow is not modelled.** It cannot tell whether the text a helper
  receives originated in `db/`, so it reports UNRESOLVABLE. That means *it cannot
  trace the origin*, not that the site is certified.
- **Nearest-preceding resolution is positional, not lexical**, so a `const` in a
  nested function can capture a later outer use.
- **Taint is scope-exact but not flow-exact.** It cannot tell a write that precedes
  a read from one that follows it, so a name written anywhere in its declaring scope
  is tainted for all of it.

### What the gate does not cover at all

A **different guarantee** from the limits above: these sites are not classified
COMPLIANT, they are never *enumerated*. Both are swept and empty today; neither is
closed in principle.

- **Matcher shape.** Only `<expr>.prepare(...)` / `.exec(...)` / `.pragma(...)`
  property-access calls are seen. `db["prepare"](sql)`, `db.prepare.bind(db)(sql)`
  and `const { prepare } = db; prepare(sql)` produce **zero** call sites -- invisible,
  absent from the census. Zero instances in the tree. Closing this would mean matching
  bare calls, which reintroduces the receiver-name blacklist the design avoids.
- **Enumeration.** `.ts`/`.tsx` only. The one non-TS source file under `electron/` or
  `src/` is a 7-line `electron/main.js` with no db calls.

### The baseline

`sql-boundary-baseline.json` records today's pre-existing sites so the gate fails
only on **new** ones. It is **identity-keyed** (`file :: verb :: hash of the SQL`),
not counted -- swapping one query for another is caught even though the count is
unchanged. Every entry names the backlog item that will remove it; `UNOWNED` is
not a legal value.

- Moving SQL into `db/**`? Run `npm run check:sql-boundary -- --update-baseline`
  **in the same commit**. A stale entry is a hard failure, which is what forces
  the file to shrink rather than rot.
- **Never** add or regenerate an entry to silence a new finding. `--update-baseline`
  refuses to grow the total without an explicit `--allow-growth`.
- `npm run check:sql-boundary -- --explain` prints every site's classification.

Permanent exceptions live in the script, not the baseline JSON: the JSON is
regenerable, so an exception stored there could be silently promoted from a
genuine new violation. They are `.pragma()`-only (connection and cipher
configuration). **No file is exempt as a whole.**

---

## PR Review Enforcement

When reviewing PRs, check for:

- [ ] **Entry file changes**: Is new code compositional or adding logic?
- [ ] **Line budget compliance**: Do entry files exceed limits?
- [ ] **New `window.api` usage**: Is it behind a service/hook abstraction?
- [ ] **Feature logic location**: Is it in a feature module or leaking into shared files?
- [ ] **Complex flows**: Are they using established patterns (hooks, state machines)?
- [ ] **Entry file growth**: Does this change push toward extraction/refactor?

**If any check fails**: Request changes with specific guidance on the correct pattern.

---

## DO / DON'T Summary

### DO
- Keep `App.tsx` under tight control: orchestrates, not implements
- Centralize complex flows into dedicated hooks/state machines
- Isolate Electron specifics behind typed services/hooks
- Reject PRs that add business logic to entry files
- Require extraction when entry files grow

### DON'T
- Let `App.tsx` become a 1,000-line mix of UI, logic, IPC, and effects
- Embed onboarding/permissions/storage logic in app shells
- Sprinkle `window.api`/`window.electron` calls across components
- Allow "just this once" hacks without a migration path
- Approve code that increases coupling across layers
