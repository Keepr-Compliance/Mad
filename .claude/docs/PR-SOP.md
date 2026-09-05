/# Pull Request Standard Operating Procedure

This document outlines the standard procedure for creating, reviewing, and merging pull requests in Magic Audit. All agents and contributors should follow this SOP.

**LLM Note**: Claude and other AI agents can assist with all phases. Look for 🤖 markers for specific automation opportunities.

## Quick Reference

| PR Type | Target Branch | Merge Type | Required Checks |
|---------|---------------|------------|-----------------|
| Sprint Task | `int/<sprint-name>` | Traditional | Tests, Security |
| Sprint Final | `develop` (from `int/*`) | Traditional | Tests, Security |
| Standalone Feature | `develop` | Traditional | Tests, Security |
| Standalone Bug Fix | `develop` | Traditional | Tests, Security |
| Hotfix | `main` + `develop` | Traditional | Tests, Builds, Security |
| Release | `main` (from develop) | Traditional | All checks |

**CRITICAL: Always use traditional merges (not squash) to preserve commit history.**
**CRITICAL: All sprint PRs target `int/<sprint-name>`, NOT develop directly.**

---

## Phase 0: Target Branch Verification

Before creating a PR, verify you are targeting the correct branch:

| Your Branch Type | Target Branch |
|------------------|---------------|
| `feature/*` (sprint task) | `int/<sprint-name>` |
| `fix/*` (sprint task) | `int/<sprint-name>` |
| `claude/*` (sprint task) | `int/<sprint-name>` |
| `feature/*` (standalone) | `develop` |
| `fix/*` (standalone) | `develop` |
| `hotfix/*` | `main` AND `develop` |
| `develop` (release) | `main` |
| `int/*` (sprint complete) | `develop` |

**MANDATORY: All sprint PRs target the integration branch (`int/<sprint-name>`), NOT develop directly.**
Only the final integration PR (after all sprint work is merged and tested) targets develop.

**Incident Reference:** SPRINT-P Phase 1 — 4 PRs targeting develop directly caused 5+ hours of sequential CI waits due to `strict: true` branch protection cascade.

```bash
# Check your current branch
git branch --show-current

# Verify target branch is up to date
git fetch origin
git log --oneline HEAD..origin/int/<sprint-name>  # For sprint PRs
```

---

## Phase 1: Branch Preparation

### 1.1 Sync Branch
Ensure your branch is up-to-date with the target branch:

```bash
git fetch origin
git merge origin/develop  # or origin/main for hotfixes
```

Resolve any merge conflicts before proceeding.

### 1.2 Dependencies & Native Modules

**CRITICAL: Native Module Rebuild Required**

Native modules like `better-sqlite3-multiple-ciphers` must be compiled for Electron's bundled Node.js version (not your system Node.js). This is a common source of "infinite loop" bugs.

**Standard rebuild (try first):**
```bash
npm rebuild better-sqlite3-multiple-ciphers
npx electron-rebuild
```

**If standard rebuild doesn't work** (common on Windows without Python):
```powershell
# 1. Clear the prebuild cache (may have wrong version cached)
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\npm-cache\_prebuilds"

# 2. Delete the existing build
Remove-Item -Recurse -Force "node_modules\better-sqlite3-multiple-ciphers\build"

# 3. Download the correct Electron-specific prebuild (replace 35.7.5 with your Electron version)
cd node_modules/better-sqlite3-multiple-ciphers
npx prebuild-install --runtime=electron --target=35.7.5 --arch=x64 --platform=win32
```

Check your Electron version with: `npx electron --version`

**Common Error**: If you see `NODE_MODULE_VERSION` mismatch errors:
```
NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 133.
```
This means the native module was compiled for Node.js (127 = Node 22.x) but Electron needs a different version (133). Use the prebuild-install fix above.

### 1.3 Verify App Starts
**Before committing**, always verify the app actually runs:

```bash
npm run dev
```

Check for:
- [ ] No `NODE_MODULE_VERSION` errors in console
- [ ] Database initializes successfully
- [ ] App doesn't get stuck on loading/onboarding screens

---

## Phase 2: Code Cleanup

### 2.1 Remove Debug Code
Search for and remove:
- [ ] `console.log` statements (except structured logging)
- [ ] `console.warn` / `console.error` (unless intentional)
- [ ] Commented-out code blocks
- [ ] Unused imports
- [ ] Dead code / unreachable code
- [ ] TODO comments that should be resolved

```bash
# Find console statements
grep -rn "console\." src/ --include="*.ts" --include="*.tsx"
```

🤖 **LLM Assist**: Use ESLint autofix, codemods, or ask Claude to identify and remove debug code.

### 2.2 Style & Formatting
- [ ] Run Prettier/formatter
- [ ] Verify naming conventions (camelCase for variables, PascalCase for components)
- [ ] Check file structure alignment with project standards

```bash
npm run lint -- --fix
```

🤖 **LLM Assist**: Claude can propose consistent patterns and refactors for naming/structure.

### 2.3 Structured Error Logging
Use the appropriate logger for each process:

**Electron main process:** `LogService` (`electron/services/logService.ts`)
**Renderer process:** `logger` (`src/utils/logger.ts`)

- [ ] Use appropriate log levels: `debug`, `info`, `warn`, `error`
- [ ] Include context in log messages (function name, relevant IDs)
- [ ] No sensitive data in logs (tokens, passwords, PII)
- [ ] Use structured metadata for additional context

```typescript
// Electron main process
import logService from './logService';
logService.info('Processing transaction', 'TransactionService');

// Renderer process
import logger from '@/utils/logger';
logger.info('Sync started', { transactionId: '123' });
```

🤖 **LLM Assist**: Claude can generate consistent, standardized log statements using the LogService pattern.

### 2.4 React Effect Anti-Patterns

Check for these common patterns that cause infinite loops or lost navigation:

#### Callback Effects Must Use Ref Guards
Any `useEffect` that calls a prop callback (e.g., `onXChange`, `onComplete`, `onUpdate`) MUST track the last-reported value:

```typescript
// BAD - causes infinite loops if parent re-renders on callback
useEffect(() => {
  onValueChange?.(value);
}, [value, onValueChange]);

// GOOD - ref guard prevents duplicate calls
const lastValueRef = useRef<typeof value | null>(null);
useEffect(() => {
  if (onValueChange && lastValueRef.current !== value) {
    lastValueRef.current = value;
    onValueChange(value);
  }
}, [value, onValueChange]);
```

- [ ] All `useEffect` callbacks use ref guards

#### Empty State Must Navigate (Not Return Null)
Flow/wizard components that can have zero steps must actively navigate:

```typescript
// BAD - component returns null but user is stuck
if (steps.length === 0) return null;

// GOOD - actively navigates when nothing to show
useEffect(() => {
  if (steps.length === 0) app.goToStep("dashboard");
}, [steps.length, app]);
```

- [ ] Flow components navigate on empty state (not just return null)

#### Related Booleans Checked Together
When checking completion flags, ensure ALL semantically-related states are considered:

```typescript
// BAD - incomplete check
const needsEmailOnboarding = !hasCompletedEmailOnboarding;

// GOOD - checks both completion flag AND actual state
const needsEmailOnboarding = !hasCompletedEmailOnboarding && !hasEmailConnected;
```

- [ ] Related boolean flags are checked together

🤖 **LLM Assist**: Claude can audit useEffect patterns and identify missing ref guards or incomplete conditionals.

---

## Phase 3: Security & Documentation

### 3.1 Security Scan
- [ ] No hardcoded secrets, API keys, or tokens
- [ ] No sensitive data in error messages or logs
- [ ] Input validation on user inputs
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention in React components

```bash
# Check for potential secrets
grep -rn "password\|secret\|api_key\|token" src/ --include="*.ts" --include="*.tsx" | grep -v "type\|interface"
```

🤖 **LLM Assist**: Claude can spot security smells and recommend fixes. Also consider tools like gitleaks, truffleHog, or git-secrets.

### 3.2 Documentation Updates
If applicable, update:
- [ ] README.md sections affected by new features
- [ ] Code comments for complex logic
- [ ] Type definitions
- [ ] .env.example for new environment variables
- [ ] OpenAPI/Swagger JSON if endpoints were added

🤖 **LLM Assist**: Claude can draft README updates, code comments, and documentation for new features.

---

## Phase 4: Testing

### 4.1 Mock Data & Fixtures
- [ ] Test mocks match current API/schema
- [ ] Fixtures are up-to-date
- [ ] No hardcoded test data that could become stale

🤖 **LLM Assist**: Claude can generate fixture JSON, mock data, and update test fixtures to match new schemas.

### 4.2 Automated Tests
- [ ] Unit tests for new functions/utilities
- [ ] Integration tests for new features
- [ ] Component tests for UI changes
- [ ] Snapshot tests (if applicable)
- [ ] Target coverage: 40-80%

🤖 **LLM Assist**: Claude can generate test boilerplate, write full unit tests, and suggest edge cases to cover.

### 4.3 Test Suite Execution
Run the full test suite locally:

```bash
npm test          # full suite; use `npx jest <file>` for a single suite
```

All tests must pass. No skipped tests without justification.

🤖 **LLM Assist**: If tests fail, Claude can analyze failures and suggest fixes.

### 4.4 Controls — prove the mutation applied (MANDATORY for every control you report)

A **control** is: break the code on purpose, watch a test go red. Agents apply the break as a text
replacement. **If the pattern does not match — one space differs, an earlier commit reworded the
line — nothing is replaced.** The file is byte-identical, the suite passes, and the green result is
recorded as *"I broke it and the tests did not catch it."* Nothing was ever broken, and the record
now points at the wrong thing: it reads as a gap in the tests when it is a gap in the harness.
Someone then "fixes" a test that was fine.

**An unverified mutation is an unrun control.**

- [ ] **1. A mutation's result does not count until the mutation is proven to have applied.**
      An exact-string replace that **raises on no-match**, or a `git diff --numstat` check on the
      file. **Print `MUTATION APPLIED` and the mutated line before running anything.**
- [ ] **2. `Tests: 0 total` is a FAILURE.** Jest exits 0 when it matches no test files — **zero
      tests passing is indistinguishable from all tests passing if only the exit code is read.**
      Assert a non-zero count, and report counts (`RED ×3`), not "went red".
- [ ] **3. Commit the fix BEFORE any control that reverts with `git checkout --`.** That command
      discards uncommitted work, and until you commit, the fix *is* uncommitted work.

**Worked example — PR #2279 (BACKLOG-2628), 11 Aug 2026. Both shapes, one PR.**

| | Reported | What had actually happened | How it was caught |
|---|---|---|---|
| Occurrence 1 | control green → "the suite does not cover this" | the replacement never matched; the file was unchanged | someone opened the file and read the mutated line — it still held the original text |
| Occurrence 2 | control green, jest exited 0 | `Tests: 0 total` — jest matched no test files | the test count was read instead of the exit code |

Both were written down as evidence *about the tests*. Neither said anything about the tests.

**Rule 3's incident, same night:** in PR #2278 (BACKLOG-2639) a control reverted the engineer's
**own uncommitted fix** with `git checkout --`. It surfaced only because `git diff --stat` showed
two changed files where three were expected — the bug the PR had just proven nearly shipped
unfixed.

**Reviewer's heuristic (not a substitute for rule 1):** an unapplied mutation can only ever report
**green**. In an all-red control table it announces itself; in a mixed table it hides completely.
The engineer proves the mutation applied; the reviewer never infers it from the colour.

**In the handoff**, state each control as *break applied → mutation proven applied → observed
result with counts*. A control reported without its mutation proof is an unrun control.

---

## Phase 5: Static Analysis

### 5.1 Type Check
```bash
npm run type-check
```
- [ ] No TypeScript errors
- [ ] No `any` types without justification

### 5.2 Lint Check

`npm run lint` is `eslint electron src scripts .claude/scripts`. It does **not**
reach `broker-portal/` or `admin-portal/` — each portal has its own ESLint config
and its own command (BACKLOG-3099). Run the ones your branch touches:

```bash
npm run lint          # desktop: electron/, src/, scripts/, .claude/scripts/
npm run portal:lint   # broker-portal/   (run if the branch touches it)
npm run admin:lint    # admin-portal/    (run if the branch touches it)
```

- [ ] No lint errors (warnings acceptable with justification)
- [ ] Portal command run for every portal the branch touches — a clean `npm run lint`
      says nothing about portal files, and CI's `Run linter` step runs that identical
      command, so it will not catch them either
- [ ] Errors block, warnings do not: the CI jobs (`Broker Portal Lint`, `Admin Portal Lint`)
      and the pre-push hook both run these commands without `--max-warnings=0`

The pre-push hook runs the portal commands automatically, scoped to which portal the
pushed files touch. It prints its decision on every run (`portal lint: broker-portal
RUN|SKIP`), and `PREPUSH_DRYRUN=1 git push …` shows the decision without running anything.

### 5.3 Performance Check
Review for:
- [ ] Unnecessary re-renders in React components
- [ ] Missing memoization for expensive computations
- [ ] O(n²) or worse algorithmic complexity
- [ ] Large bundle size additions
- [ ] Inefficient database queries
- [ ] Inefficient use of state or APIs

🤖 **LLM Assist**: Claude can spot performance issues and generate optimization suggestions without manual benchmarking.

---

## Phase 6: Final Automated Code Review

**This is a critical quality gate.** Run the entire branch through Claude to check for:

### 6.1 Code Quality Issues
- [ ] Anti-patterns and code smells
- [ ] Missing error checks / error handling
- [ ] Duplicate logic that should be abstracted
- [ ] Unnecessary complexity
- [ ] Missing null-checks / undefined handling
- [ ] Inconsistent naming conventions
- [ ] Code that needs refactoring
- [ ] **Optional props with silent failures** - verify all interface props are passed from parent components (see "Common Issues" section)

### 6.2 Architecture Compliance
- [ ] Entry file guardrails respected (App.tsx < 70 lines)
- [ ] Business logic not in entry files
- [ ] IPC boundaries respected (main/preload/renderer)
- [ ] Service abstractions used (no direct `window.api` in components)

### 6.2b Database Writes — ACID (MANDATORY for any PR that writes to the database)

**Nothing in this document asked for this until 2026-08-05, which is exactly how a rename came to
silently do nothing and an edit came to be able to wipe a contact's email addresses. The reviewer
did not miss it — nobody had ever asked.**

**Atomicity**
- [ ] Does one user-visible action write **more than one statement**? If so, are they in a
      single transaction (`db.transaction(fn)()`)?
- [ ] **Name the intermediate state a crash would leave**, concretely — *"a contact with no
      origin, indistinguishable from one a path never wrote"*, not *"data could be inconsistent"*.
- [ ] Is there a **forced-crash test**? Throw between the statements and assert the prior state
      survives. **A test that saves successfully and checks the result passes with or without a
      transaction** — it proves nothing about atomicity.

**Consistency**
- [ ] Is the invariant already enforced by a **constraint** (FK, CHECK, UNIQUE)? If so, name it
      and do NOT add a redundant application-level check.
- [ ] If the change introduces a state the schema permits but the product forbids, say so.

**Isolation**
- [ ] Can two paths write this concurrently? The main process is single-threaded, but the query
      worker is a second connection. **If a check and the write that makes it true are separated
      by an `await`, the check does not hold** — that is how BACKLOG-2525's re-entry bug worked.

**Durability**
- [ ] `synchronous = NORMAL` is set (`databaseService.ts:383`). A committed write survives an app
      crash but **can be lost on power failure**. If a change depends on stronger durability,
      raise it — do not change the pragma inside an unrelated PR.

**Silent field loss**
- [ ] Does the write use an **allow-list or filter**? A filter drops unrecognised fields *silently*.
      Compare the fields the caller sends against the fields the writer accepts, **as two lists**,
      and account for every difference.
- [ ] **A `@deprecated` comment is not a constraint.** BACKLOG-2528's broken call was type-correct;
      a sentence was the only guard.

**Asserting that a database write FAILED**
- [ ] Use the **captured** form, not `.rejects.toThrow()` / `.toThrow()`:
      ```ts
      let outcome = "NO THROW";
      try { await thing(); } catch (e) { outcome = `THREW: ${(e as Error).message}`; }
      expect(outcome).toMatch(/^THREW: .*<exact expected text>/);
      ```
      It asserts both **that** it threw and **what it said**, so it is stricter than
      what it replaces, not weaker.
- [ ] **Why:** two `expect` packages coexist in this tree — hoisted 30.4.1 and
      `jest-circus/node_modules/expect` 29.7.0, which is the one jest actually runs — and
      a `SqliteError` built inside the native addon does not reliably survive that
      boundary. **BACKLOG-2539 established the failure is a spurious RED on CI, not a
      silent green**, so this is about CI reliability, not blindness. Only sites asserting
      a rejection from the native driver need it; there is no sweep to do.

**Establishing a violation from a tool's output**
- [ ] **A tool reporting a violation has not established one.** Open the code and read it
      before writing the finding down.
- [ ] **Incident (BACKLOG-2543, 2026-08-06):** the write-atomicity guard reported nine
      unwrapped multi-write functions. **Seven were false positives** — it did not
      recognise `db.transaction(...)` as wrapping, and it counted branch-exclusive upsert
      writes (`if (existing) { UPDATE…; return; } INSERT…;`) as sequential. All nine were
      filed with fluent, specific damage descriptions **before any of them was opened.**
- [ ] A generated list needs a per-entry human confirmation, and the confirmation is
      "I read the function", not "the description sounds plausible".

**Engine parity**
- [ ] Database tests must run under the **shipping** driver:
      `ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <path>`
      (`--bail=0` is mandatory). `better-sqlite3` and `node:sqlite` **disagree** — `undefined`
      binds as NULL on the former and throws on the latter. **A test on the wrong engine can
      report a clean error where production silently destroys data.**

### 6.2c Refactors — behaviour-preserving changes (MANDATORY for any PR that moves code without changing what it does)

**A refactor makes exactly one claim: *nothing changed*. The test suite is the only evidence for
that claim.** Which makes the reviewer's first question not *"is the new structure better?"* but
***"can these tests tell us if it isn't?"***

**§6.1 already says "code that needs refactoring." This section is the counterweight — when NOT to,
and what to establish first.**

**Before the move — prove the suite can see**
- [ ] **Name the behaviours this refactor could break**, and for a sample, **break each one
      deliberately in the new code and confirm a test goes red.** Not the old code — the new.
      A suite that stays green while the refactored code is wrong is the only failure mode a
      refactor has, and it is invisible without this step.
- [ ] **Are there known blind spots in the suite covering this area?** Mocked-away transactions,
      assertions that cannot observe the error they assert, snapshot tests that were regenerated
      rather than read. **A blind spot under a refactor is worse than under a fix** — a fix at
      least changes behaviour the founder can see.
- [ ] **Is the code reachable?** Refactoring code no user can reach is work with no upside and a
      real downside: it makes the dead code look maintained. See ENGINEER-WORKFLOW Step 1a.

**Sequencing — refactors go last**
- [ ] **Correctness fixes first, then test-suite integrity, then structure.** A refactor performed
      on a suite with unmapped holes converts a known-good state into an unknown one. If the same
      area has open correctness work, the refactor waits.
- [ ] **Size alone is not a reason.** A 2,600-line file is harder to read, not more likely to be
      wrong. Splitting it buys readability; it does not buy correctness, and it spends the one
      thing a refactor costs — confidence that the code still does what it did. **Ask what the
      split makes possible that is currently blocked.** If the answer is "nothing yet," it waits.
- [ ] **The refactor that removes a class of bug outranks the one that moves code.** Collapsing
      four definitions of a record's fields into one eliminates the drift; moving those four into
      a tidier file preserves it.

**In the PR**
- [ ] **Never in the same commit as a behaviour change**, and preferably not the same PR. When a
      mixed PR regresses, the bisect cannot separate "the move broke it" from "the change broke it."
- [ ] **State the controls run and what went red** — an unstated control is an unrun control.
- [ ] File lifecycle: no orphans, no dangling imports, old tests removed
      (`.claude/docs/shared/file-lifecycle-protocol.md`).

**Incident (2026-08-05):** the atomicity sweep found ten test files that mock `dbTransaction` as a
passthrough, and 121 assertions that may be unable to observe an error raised inside the native
database module — two of which were **passing on CI while blind to the exact defect they existed
for**. Any refactor of contact writes performed before those are fixed would have been protected by
tests that could not report a break.

### 6.2d Red Checks — fix or file, never quiet (MANDATORY)

**When a check goes red, exactly two moves are permitted:**

1. **Fix the cause.**
2. **File the finding** as a backlog item and obtain a **recorded SR ruling** that the red is
   environmental or out of scope for this PR.

**Never quiet the check.** No baselining, no exemption-list entries, no raised timeouts, no widened
allow-lists, no `--quiet` flags, no skipped suites — not without the recorded ruling above. A
quieted check still renders green and therefore reads as coverage; it is worse than a deleted
check, because a deleted check at least announces its absence.

Why this exists (all from 2026-08-06, one PR train):

| The tempting quiet move | What fix-or-file found instead |
|---|---|
| Add the flagged function to `KNOWN_UNWRAPPED` | The guard had a blind spot; the function was dead code — both fixed |
| Widen `FICTIONAL_NAMES` so the PII guard passes | The fixtures carried real-name shapes; renamed to sanctioned invented names |
| Raise the 30s timeout on a flaking Windows suite | The suite has a real 168s Windows I/O problem — filed with the constraint that the fix must not be a raised timeout |

Each quiet move would have turned a true signal into permanent silence. The pattern compounds:
every "small" exemption makes the next one look normal, until the suite is green and means
nothing.

**Reviewer's check:** any diff hunk touching a baseline file, exemption list, timeout constant,
lint flag, or CI-guard configuration requires a linked SR ruling in the PR body. Absent that link,
the hunk is a blocker regardless of why the author says it was needed.

### 6.2e Rules kept by hand — ask whether the compiler could hold them (MANDATORY for any PR that adds or edits a hand-maintained list of names, or relies on a call being remembered)

**A rule the compiler cannot see is a rule that will drift.** Three shapes recur here, and each has
already shipped a live bug that passed `tsc`, eslint, the full suite and CI:

| Shape | The instance | What the user got |
|---|---|---|
| **A — a hand-typed list beside a schema** | `transactionDbService.ts:419` keeps its own `allowedFields`. `detection_status`, `reviewed_at` and `rejection_reason` are real columns (`sqlFieldWhitelist.ts:151,155,156`) that appear on **zero lines** of that writer | **Approve** writes 1 of 3 fields and returns **success**; the transaction stays in the queue. **Reject** loses all 3, so nothing is left to write and it hard-fails "No valid fields to update" (BACKLOG-2558) |
| **B — a companion call kept by convention** | `auditService.log` is called in the handler, by agreement. Ten sites honour it; `transactions:create-audited` and `transactions:resubmit` do not — and resubmit calls `logService.info` instead, so the handler *reads* as logged | The compliance trail is missing the creation event for exactly the transactions built for compliance, and drops every resubmit (BACKLOG-2563) |
| **C — `??` collapsing "absent" and "explicitly null"** | `null ?? 3 === 3`, at four sites. "All time" is spelled `null` | Choosing **All time** imported 3 months, while the count on the same screen showed the full total (BACKLOG-2561) |

**Two questions the reviewer must ask, and record the answer to in `pm_comments`:**

1. **Could a type hold this instead of a person?** If the same names are typed out in two places
   that must agree, the second copy is a defect with a delay on it. Derive one from the other.
2. **Is the failure a WRONG name or a MISSING one?** This decides the fix and is the most common
   review error. A union of string literals catches a **typo**. It does not catch an **omission** —
   nothing about `"status" | "detection_status"` notices that a writer never mentioned the second.
   Absence needs **exhaustiveness**: a `Record<Column, Decision>` that fails to compile until
   someone declares each new column writable or deliberately excluded. **BACKLOG-2558 is an
   omission, so a union alone would not have caught it.** Deliberate exclusions stop being
   comments and become entries — here, `last_exported_at` (`:444`) and the unfreeze override.

**Why the compiler is powerless in this codebase today, and it is one wrapper:**
`sqlFieldWhitelist.ts:18-213` is declared `as const` — but wraps each table's fields in
`new Set([...])`, which **erases the string literals**. What survives is `Set<string>`, and
`validateFields(fields: string[])` takes plain strings. Every field name in the system is text as
far as `tsc` is concerned. Removing the `Set` wrapper is the precondition for any type-level fix.

**A validator placed after the discard cannot see the discard.** `validateFields` runs at `:559`;
the filter that drops unknown keys runs at `:539` and the throw at `:555`. The check the codebase
relies on to catch this drift executes **after** the evidence is gone. When reviewing any
guard, establish *where in the sequence it runs*, not merely that it exists.

**What does NOT belong at compile time.** Structural facts — which fields exist, which calls are
required — belong to `tsc`. Facts about the world do not: no type system knows whether an address
in a fixture belongs to a real person. That needs a check executed against the world (BACKLOG-2731
was found by intersecting the repo against a real address book, not by any type). Do not propose a
type as the fix for a fact the compiler cannot know.

**Reviewer's check:** any diff hunk that adds or edits an array/Set of field, column, channel,
preference or event names — or that adds a call site to an existing "always also call X" convention
— requires an explicit answer to the two questions above in the review. "It matches today" is not
an answer; today is when every one of these matched.

### 6.2f An item ships only when its own promise is true (MANDATORY for any finding deferred to a new backlog item)

**When a finding means the item under review does not do what it says, it belongs to that item — not
to a new one.** Splitting is how an incomplete item passes review, and the justification sounds
reasonable every time it is offered.

The test is one question: **ship this as-is — is the thing it promised true?**

- **No** → the finding is in scope. Keep working the item.
- **Yes, but something else surfaced** → file it separately.

A second test settles the borderline cases: **did this change make it consequential?** A
pre-existing defect that was harmless until this PR made it reachable is this PR's to close.

**"It regresses nothing" is not the bar.** An item can regress nothing and still ship a control that
lies — which is the specific failure this rule exists to stop.

Why this exists (BACKLOG-2986, 2026-08-30). The item added a Settings switch for Android contact
import, after a founder ruling that contacts must not be auto-imported. Mid-build it emerged that
the `androidContacts` preference gates the contact picker but **not** the write path —
`promoteToMainContacts` reads no preference at all — so switching it off would hide contacts from
the picker while the next sync kept writing new ones into the main `contacts` table.

That was filed as a separate item and approved as a split, on the recorded grounds that *"2986
regresses nothing."* True, and beside the point: it would have shipped a control that disagrees with
its own effect — the exact defect BACKLOG-2486 closed for the iPhone switch — into the same settings
panel, in the same release, as the fix for that class of bug. A second finding went the same way: a
swallowed write in the shared toggle handler, harmless while every absent key meant *enabled*, and
newly able to make the switch lie precisely because this PR introduced the first derived-OFF switch.

**Both the engineer and the reviewer accepted the split.** The founder rejected it. Applying the test
above resolves both correctly and takes one sentence.

| finding | promise still true if shipped without it? | call |
|---|---|---|
| write path ungated | No — "a control over Android contact import" is false | same item |
| switch can lie on a failed write | No — "a working switch" is false | same item |
| `tsconfig` excludes test files from type-check | Yes — the toggle works regardless | separate item |

**Reviewer's check:** for any finding deferred to a new backlog item, state in the ruling why the
item under review still keeps its promise without it. **If that sentence cannot be written, the
finding is in scope**, and approving the split is a blocker rather than a note.

### 6.2g A claim you inherited is not a claim you checked

Recorded 2026-08-30. Three separate documents — a backlog item body, a PM engineer brief, and
an implementation plan — all asserted that CI never runs `npm run build`. It has run it all
along, in a job called "Build Application", in a step labelled "Build Vite app". The label
reads as renderer-only, so nobody opened the file. Cost: a deliverable planned that already
existed, and a second correction after the first.

**The rule: any claim about what CI does, what a file contains, or which lines import versus
inline, is verifiable by opening one file. Open it.** Inheriting the claim costs one read to
verify and three documents to unwind.

The same day, in the same item: a plan asserted that closing a classifier gap "needs type
information plus dataflow". The reviewer wrote the resolver in ~40 lines and recovered 15 real
violations that would otherwise have been permanently baselined as clean. **"This cannot be
done" is a claim like any other. Try it before you write it down.**

### 6.2h `npm run type-check` does not check your tests

`npm run type-check` runs against the production tsconfig. Test files are covered only by
`npm run type-check:tests` (`tsc -p tsconfig.test.json`), which CI runs as its own step.

An engineer who edits `*.test.ts`, runs `npm run type-check`, and reports "tsc clean" has
verified nothing about the files they touched. This took PR #2434 red on both platforms after
a truthful "tsc clean" report — 22 errors invisible to the check that was run.

**Before pushing any PR that touches a test file, run BOTH targets and state both results in
the handoff.** This is the omitted-check shape from §6.2: the verification set left out the
only check that would fail.

### 6.2i A sum that cannot come apart proves nothing

A gate built on 2026-08-30 classified every SQL call site into three buckets and asserted the
three counts summed to the total, as a guard against silently skipping input.

**The assertion was tautological.** Each site was bucketed in an exhaustive if/else *before*
being counted, so both sides of the equation moved together and a skipped file contributed zero
to each. It could only ever hold. Its real value was narrow — proving no fourth, silent bucket
existed — and it was described as proving far more.

It also did not catch the bug that mattered: a site in the exemplar file was misclassified, and
the total summed correctly both before and after. What caught it was a breakdown of *why* each
site was classified as it was.

**Before asserting an invariant, ask what would have to be true for it to fail.** If you cannot
construct that state, the assertion is documentation, not a control. Prefer assertions on
identity — which sites, classified how, and for what reason — over assertions on counts.

### 6.2j Suspect your own change before you suspect the world

A failure in something you just built is almost never the fault of the service it talks to.
Rule out what you controlled before you name anything you didn't.

**2026-08-30, three instances in one session, all the same shape:**

| Symptom | Blamed | Actual cause |
|---|---|---|
| `REQUEST_DENIED` from Google Places | "the API key is restricted, or billing lapsed — check the Cloud console" | A locally-built app shipped `.env.production` containing the literal `${GOOGLE_MAPS_API_KEY}`. CI substitutes it from a secret; a local build does not. The shipped release was fine. |
| `npm run dev` broken | reported as "dev is OK" three times | A packaging step run from a worktree with a symlinked `node_modules` had rebuilt the shared native module for the wrong architecture. |
| "CI never runs `npm run build`" | asserted in three documents | It always has. Nobody opened `ci.yml`. |

**The rule:**

1. **What did I just build, change, or run?** Rule that out first. If the answer is "I produced this artifact minutes ago", it is the leading suspect, not the last resort.
2. **Compare against a known-good artifact** before blaming a service. A shipped release, a previous build, the same call from a different binary. In the Places case the shipped release carried the real key — one comparison would have ended it.
3. **An external error message is authoritative about the symptom, never about the cause.** `REQUEST_DENIED` means "the key I received is invalid". It says nothing about where that key came from, and it is not evidence about the far end's configuration.
4. **Before routing anything to the founder, state what you have already ruled out.** If you cannot list it, you have not earned the handoff — see the Tool-First Rule in `CLAUDE.md`. Handing over a console to go check, while holding the file that contains the defect, is the failure this section exists to prevent.

This is distinct from 6.2g. That one is about inheriting a claim without checking it. This one is about **ordering**: even when you check honestly, checking the far end first wastes the founder's attention and often ends in an accusation you have to withdraw.

### 6.3 Review Prompt Template

Use this prompt to request a code review:

```
Please review this branch for PR readiness. Check for:
1. Anti-patterns and code smells
2. Missing error handling
3. Duplicate logic
4. Unnecessary complexity
5. Missing null-checks
6. Inconsistent naming
7. Architecture boundary violations
8. Performance issues
9. Security concerns
10. Rules kept by hand that a type could hold instead (§6.2e) — any list of field,
    column, channel, preference or event names typed out in two places that must
    agree, and any "always also call X" convention with a new call site. For each:
    state whether the failure mode is a WRONG name (a union catches it) or a
    MISSING one (only exhaustiveness catches it).
11. Any finding you propose to defer to a NEW backlog item (§6.2f) — for each,
    write the sentence "this item still does what it says without the fix,
    because ___". If that sentence cannot be written, the finding is in scope
    and deferring it is a blocker, not a note. "It regresses nothing" does not
    complete the sentence.

Provide specific file:line references and suggested fixes.
```

🤖 **LLM Assist**: This phase replaces manual pre-review and significantly increases PR quality.

---

## Phase 7: PR Creation

### 7.1 Commit History
- [ ] Commits are atomic and focused
- [ ] Commit messages follow conventional format:
  - `feat:` - New feature
  - `fix:` - Bug fix
  - `docs:` - Documentation
  - `refactor:` - Code refactoring
  - `test:` - Adding tests
  - `chore:` - Maintenance

### 7.2 Create PR

```bash
git push -u origin your-branch-name

gh pr create --base int/<sprint-name> --title "type: description" --body "..."  # Use int branch for sprint PRs
```

🤖 **LLM Assist**: Claude can draft PR descriptions based on the changes made.

### 7.3 PR Description Template

```markdown
## Summary
- Bullet points describing what this PR does

## Changes
- List of specific changes made

## Test Plan
- [ ] How to test this change
- [ ] What was tested

## Screenshots (if UI changes)
[Add screenshots here]

## Checklist
- [ ] Tests pass locally
- [ ] Type check passes
- [ ] Lint check passes
- [ ] Documentation updated (if needed)
```

---

## Phase 7.5: MANDATORY Sync with Target Branch

**⚠️ NON-NEGOTIABLE: Always merge the target branch INTO your feature branch before final CI run.**

This step MUST be performed before pushing for final CI verification:

```bash
# 1. Fetch latest from target branch
git fetch origin

# 2. Merge target branch into your feature branch
git merge origin/develop  # or origin/main for hotfixes

# 3. If conflicts exist, resolve them NOW
# 4. Run tests locally to verify nothing broke
npm run type-check
npm test

# 5. Push (this triggers CI on the merged state)
git push
```

**Why this is mandatory:**
- Other PRs may have been merged since you started
- Merge conflicts caught BEFORE merge to develop, not after
- CI runs against the FINAL merged state
- Prevents broken `develop` branch from conflicting changes

**If conflicts exist:**
1. Resolve them in your feature branch
2. Test locally
3. Push the resolution
4. CI will run on the conflict-resolved code

**DO NOT skip this step even if:**
- Your PR was just created
- CI already passed once before
- You think develop hasn't changed

---

## Phase 8: CI Verification

**⚠️ CRITICAL: Never claim CI passed without explicit verification. False CI claims waste user time and erode trust.**

### 8.1 Wait for ALL Checks to Complete

Use `--watch` to block until all checks finish:

```bash
# REQUIRED: Wait for all checks to complete (blocks until done)
gh pr checks <PR-NUMBER> --watch
```

**DO NOT** use `gh pr checks` without `--watch` and assume checks passed - they may still be running.

### 8.2 Verify ALL Jobs Passed

After checks complete, verify EVERY job shows `pass`:

| Check | Required | Description |
|-------|----------|-------------|
| Test & Lint (macOS) | Yes | Unit tests + linting |
| Test & Lint (Windows) | Yes | Cross-platform verification |
| Security Audit | Yes | npm audit |
| Build Application | Yes | Vite + Electron build |
| Package Application | develop/main only | Creates DMG/NSIS installers |

```bash
# Verify all checks passed (should show all green checkmarks)
gh pr checks <PR-NUMBER>

# For develop/main PRs, also check the Package Application step explicitly
gh run list --branch <BRANCH-NAME> --limit 5
gh run view <RUN-ID>  # Check Package Application job status
```

### 8.3 Special Attention: Package Application

**The Package Application job only runs on `develop` and `main` branches.** This means:

1. **Feature branch PRs** - Package job doesn't run. CI may pass on feature branch but fail after merge.
2. **After merging to develop** - ALWAYS verify Package Application succeeded:
   ```bash
   # Check the develop branch CI after merge
   gh run list --branch develop --limit 3
   gh run view <LATEST-RUN-ID>
   ```

### 8.4 QA Routing Rule

**QA agents MUST verify CI is green before presenting test cases to the user.** If CI is failing on a PR:
1. Do NOT present QA test cases — the PR is not ready for user testing
2. Route back to the engineer agent to fix the failing tests
3. Only proceed with QA after all CI checks pass

This prevents wasted user testing time on code that will need to change.

### 8.5 LLM Guardrails (for Claude and AI agents)

When verifying CI status, you MUST:

1. **Run `gh pr checks --watch`** and wait for it to complete (don't interrupt)
2. **Include the actual command output** in your response to the user
3. **Check all jobs** - if any show `fail` or `pending`, CI has NOT passed
4. **After merge to develop/main**, verify Package Application job separately
5. **Never say "CI passed"** without showing evidence from `gh pr checks` or `gh run view`

**Example verification response:**
```
CI Status for PR #114:
✓ Test & Lint (macos-latest, 20.x)  pass
✓ Test & Lint (windows-latest, 20.x)  pass
✓ Build Application (macos-latest)  pass
✓ Build Application (windows-latest)  pass
✓ Security Audit  pass

All 5 checks passed. Ready to merge.
```

**If Package Application needs verification (after merge to develop):**
```bash
gh run list --branch develop --limit 1
# Then check that specific run
gh run view <RUN-ID>
```

---

## Phase 9: Merge

**CRITICAL: Creating a PR is step 3 of 4, not the final step. The task is NOT complete until the PR is MERGED.**

**Full lifecycle reference:** `.claude/docs/shared/pr-lifecycle.md`

### Pre-Merge Checklist
- [ ] All CI checks pass
- [ ] No merge conflicts (verified in Phase 7.5)
- [ ] PR approved (if reviews required)
- [ ] Target branch is correct

### 9.1 Merge Command

```bash
# ALWAYS use traditional merge (--merge), NEVER squash
# Do NOT auto-delete branches - deletion is a separate, manual step
gh pr merge <PR-NUMBER> --merge
```

**Branch Deletion:** See `.claude/docs/shared/git-branching.md` for deletion policy. Do NOT use `--delete-branch` unless explicitly requested.

### 9.2 Merge Verification (MANDATORY)

**After running the merge command, you MUST verify the merge succeeded.**

```bash
# Verify merge state - MUST show "MERGED"
gh pr view <PR-NUMBER> --json state --jq '.state'
```

| Result | Meaning | Action |
|--------|---------|--------|
| `MERGED` | Success - task can be marked complete | Proceed to Post-Merge |
| `OPEN` | Merge failed or didn't run | Investigate and retry |
| `CLOSED` | PR was closed without merge | Work is LOST - investigate |

**Do NOT mark the task as complete until you see `MERGED`.**

### --admin Flag (PROHIBITED)

NEVER use `--admin` to bypass branch protection. This includes:
- `gh pr merge --admin`
- Any workaround to skip required status checks

If merge is blocked, the fix is ALWAYS: merge base branch into feature branch, push, wait for CI.

**Incident Reference:** PRs #1411/#1412 were merged with `--admin` without explicit user approval.

### 9.3 Post-Merge
- [ ] Verify merge completed: `gh pr view <PR> --json state` shows `MERGED`
- [ ] Delete local branch: `git branch -d your-branch-name`
- [ ] Pull latest changes: `git checkout develop && git pull`
- [ ] Update Supabase: `pm_update_task_status('<task_uuid>', 'completed')` + `pm_update_item_status('<backlog_item_uuid>', 'completed')` (do NOT edit any `.claude/plans/tasks/*.md` file)
- [ ] Notify PM that task is complete (only AFTER merge verified)

### 9.5 Debugging Metrics Verification (MANDATORY)

Before merging, SR Engineer MUST verify debugging metrics are accurately captured.

**Goal:** Capture ALL debugging for estimation accuracy, block only on clear discrepancies.

**Step 1: Collect evidence**
```bash
# Count fix commits
FIX_COUNT=$(git log --oneline origin/develop..HEAD | grep -iE "fix" | wc -l)
echo "Fix commits: $FIX_COUNT"

# Check PR age
gh pr view --json createdAt --jq '.createdAt'
```

**Step 2: Tiered response based on evidence vs reported**

| Fix Commits | Debugging Reported | Response |
|-------------|-------------------|----------|
| 0 | 0 | PASS |
| 0 | >0 | PASS (honest about investigation time) |
| 1-2 | 0 | ASK engineer: "These fix commits took 0 debugging time?" |
| 1-2 | >0 | PASS |
| 3-5 | 0 | BLOCK - Require metrics update before merge |
| 3-5 | >0 | PASS (verify roughly proportional) |
| 6+ | any | INCIDENT REPORT required |

**Step 3: Timeline as signal (not blocker)**

PR open time does not equal work time. Engineers wait for CI, answers, dependencies.

**If PR >4h AND Debugging: 0, ASK:**
- "Was there waiting time (CI, blocked, waiting for answer)?"
- "Were there any unexpected issues that required debugging?"
- "Did investigation/troubleshooting happen that didn't result in fix commits?"

**Only block if:** fix commits present + Debugging: 0 (clear discrepancy)

**Why this matters:** Without accurate debugging metrics, PM estimates appear more accurate than they are. Even 10 minutes of debugging affects estimation calibration.

**Reference:** BACKLOG-126 (TASK-704 incident - 22h debugging reported as 0)

---

## Hotfix Procedure

For urgent production fixes:

```bash
# 1. Branch from main
git checkout main
git pull origin main
git checkout -b hotfix/description

# 2. Make fix and test

# 3. Create PR to main
gh pr create --base main --title "hotfix: description"

# 4. After merge to main, also merge to develop
git checkout develop
git pull origin develop
git merge origin/main
git push origin develop
```

---

## CI Failure Recovery

If CI fails after creating the PR:

1. **Check the failing job logs** on GitHub Actions
2. **Run the failing check locally** to reproduce
3. **Fix the issue**
4. **Re-run the checklist** starting from the earliest relevant phase:
   - Type error → Phase 5.1
   - Lint error → Phase 5.2
   - Test failure → Phase 4.3
   - Security issue → Phase 3.1
5. **Push the fix** and wait for CI to re-run

🤖 **LLM Assist**: Claude can analyze CI failure logs and suggest fixes.

---

## Review Checklist (for reviewers)

When reviewing PRs, verify:

- [ ] **Phase 0**: Correct target branch
- [ ] **Phase 1**: Branch is synced, no conflicts
- [ ] **Phase 2**: No debug code, proper formatting, uses LogService
- [ ] **Phase 3**: No security issues, docs updated
- [ ] **Phase 4**: Adequate test coverage
- [ ] **Phase 4a**: Test hygiene — behavioral changes have matching test updates (see below)
- [ ] **Phase 5**: Type check + lint pass
- [ ] **Phase 6**: Automated code review completed
- [ ] **Phase 7**: Clear PR description
- [ ] **Phase 7.5**: Target branch merged into feature branch (MANDATORY)
- [ ] **Phase 8**: CI passes (after Phase 7.5 sync)

### Phase 4a: Test Hygiene Verification (MANDATORY)

**Reference:** BACKLOG-1356 — SPRINT-O had repeated CI failures from stale tests.

SR Engineer MUST verify the following during code review:

- [ ] **All test files referencing changed functions/components have been updated.** Search for the changed function names across `*.test.*` files and verify expectations match the new behavior.
- [ ] **Behavioral changes have corresponding test updates.** If a function's return value, call count, parameters, or error handling changed, tests MUST reflect the new behavior.
- [ ] **Mock alignment.** If a function signature changed (new params, changed return type), all mocks of that function must match the updated signature.
- [ ] **No stale assertions.** Check that `expect()` calls match actual behavior — stale `.toHaveBeenCalledTimes()`, `.toEqual()`, or `.toHaveBeenCalledWith()` values are the most common CI failure cause.

**If test hygiene is not met:** Request changes. Do not approve PRs where behavioral changes lack matching test updates.

### Review Output Format

```
## PR Review Summary
**Branch**: source → target
**Merge Type**: Traditional (required)
**Status**: APPROVED / CHANGES REQUESTED / BLOCKED
**Risk Level**: LOW / MEDIUM / HIGH

## Checklist Results
[✓/✗/⚠️ for each phase]

## Issues Found
[List any blockers or recommendations]
```

---

## Common Issues & Fixes

### Native Module Mismatch
```bash
npm rebuild better-sqlite3-multiple-ciphers
npx electron-rebuild
```

### Merge Conflicts
```bash
git fetch origin
git merge origin/develop
# Resolve conflicts in editor
git add .
git commit
```

### CI Failures
1. Check the failing job logs on GitHub Actions
2. Run the failing check locally
3. Fix and push

### Optional Props with Silent Failures (Component Refactoring Bug)

**Pattern**: When extracting components during refactoring, optional props (`prop?: type`) can be defined in the interface but never passed from the parent. This causes **silent failures** - the UI renders, buttons appear clickable, but handlers do nothing.

**Example** (from commit `3b481ef` - EmailOnboardingScreen bug):
```tsx
// Interface defines optional props:
interface EmailOnboardingScreenProps {
  selectedPhoneType?: "iphone" | "android";  // Optional - no compile error if missing
  onPhoneTypeChange?: (type: "iphone" | "android") => void;  // Silent failure
  onBack?: () => void;  // Back button breaks silently
}

// Parent component never passes them:
<EmailOnboardingScreen
  userId={...}
  authProvider={...}
  onComplete={handleEmailOnboardingComplete}
  // selectedPhoneType - MISSING! No compile error
  // onPhoneTypeChange - MISSING! Buttons do nothing
  // onBack - MISSING! Back button appears but fails silently
/>
```

**Prevention Checklist** (add to Phase 6.1):
- [ ] When extracting/refactoring components, verify ALL props in the interface are passed from parent
- [ ] Pay special attention to optional props (`?`) - they won't cause compile errors when missing
- [ ] Test interactive elements (buttons, selects) actually trigger their handlers
- [ ] Check that state flows bidirectionally (parent → child AND child → parent)

**Detection**:
```bash
# Find optional props in component interfaces that might be missing
grep -rn "?: .*=>.*void" src/components --include="*.tsx"
```

---

## Session-End Checklist (MANDATORY)

**Before ending ANY working session, verify no orphaned PRs exist.**

> **Incident Reference:** SPRINT-051/052 had 20+ orphaned PRs that were created but never merged, causing fixes to be "lost" and reimplemented multiple times.

### Quick Verification

```bash
# Check for any open PRs you created
gh pr list --state open --author @me

# Check for any sprint-related open PRs
gh pr list --state open --search "TASK-"
```

### For Each Open PR Found

| PR State | Action Required |
|----------|-----------------|
| CI failing | Fix before ending session OR document blocker |
| Awaiting review | Note for next session (acceptable) |
| Approved but not merged | **MERGE NOW** - do not leave approved PRs unmerged |
| Has merge conflicts | Resolve before ending session |

### Session-End Checklist

Copy this to your notes:

```markdown
## Before Ending Session

- [ ] `gh pr list --state open --author @me` - reviewed all open PRs
- [ ] All approved PRs have been merged
- [ ] All merges verified with `gh pr view <PR> --json state`
- [ ] No PRs with failing CI left unattended (or blocker documented)
- [ ] Task files updated with merge confirmations
```

**Do NOT end a session with approved-but-unmerged PRs.**

---

## Questions?

- **Architecture decisions**: Consult senior-engineer-pr-lead agent
- **CI/CD issues**: Check `.github/workflows/ci.yml`
- **Branching strategy**: See `CLAUDE.md`
- **PR lifecycle**: See `.claude/docs/shared/pr-lifecycle.md`
