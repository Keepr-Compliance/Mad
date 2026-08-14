# Keepr - Claude Development Guide

This guide is for all Claude agents working on Keepr. Follow these standards for all development work.

---

## Response Style

Keep responses concise. For large results (logs, query dumps, file lists), summarize and offer detail on request instead of dumping full output.

---

## MANDATORY: Agent Workflow for Sprint Tasks

**CRITICAL: READ THIS BEFORE ANY SPRINT/TASK WORK**

When working on sprint tasks (tracked in Supabase `pm_backlog_items` / `pm_tasks`; plan stored in `pm_backlog_items.body`), you MUST follow the **15-step agent-handoff workflow**. Direct implementation is PROHIBITED. Do NOT create or rely on `.claude/plans/tasks/*.md` files for new work — Supabase is the source of truth.

### Authoritative Reference

**READ THIS FIRST:** `.claude/skills/agent-handoff/SKILL.md`

This skill defines:
- The complete 15-step lifecycle (4 phases)
- Which agent owns which steps
- Handoff message templates
- Decision trees for approvals/rejections

### Quick Summary

```
PHASE A: PM Setup (Steps 1-5)
   → Verify task, create branch, update status, handoff to Engineer

PHASE B: Planning (Steps 6-8)
   → Engineer plans, SR reviews plan, PM updates status

PHASE C: Implementation (Steps 9-11)
   → Engineer implements, SR reviews, PM updates status

PHASE D: Merge & Cleanup (Steps 12-15)
   → SR merges PR, deletes worktree, PM records metrics, closes sprint
```

### Critical Rules

1. **DO NOT implement tasks directly.** Follow all 15 steps.
2. **DO NOT skip PM setup steps.** Branch and status updates happen BEFORE invoking Engineer.
3. **DO NOT merge without SR Engineer review.** Every PR goes through `senior-engineer-pr-lead` agent.
4. **DO NOT handoff without the template.** Use `.claude/skills/agent-handoff/templates/handoff-message.template.md`

### Why This Matters

- **Metrics tracking**: Effort captured at each handoff
- **Quality gates**: SR Engineer validates architecture and tests
- **Audit trail**: Proper handoffs create accountability
- **Consistency**: Same workflow every sprint

**FAILURE TO FOLLOW THIS WORKFLOW IS A PROCESS VIOLATION.**

---

## MANDATORY: Issue Documentation

**Full reference:** `.claude/skills/issue-log/SKILL.md`

Before ANY handoff or task completion, you MUST document issues encountered.

**This applies to work with no task, too.** A branch prune, a hook edit, a one-off script — ad-hoc work produces the same lessons and loses them faster, because nothing surfaces them at a handoff. If there is no task item, put the lesson on the item the work was for, or the item it is a lesson ABOUT, or file a new one. **Anything that cost more than ten minutes to diagnose gets written down — even when the fix was one line and nothing was blocked.**

### When to Document

- Something doesn't work as expected
- You try an approach and abandon it
- You spend significant time debugging (>10 min)
- You discover a workaround
- Before ANY handoff to another agent
- Before marking a task complete

### Format

```markdown
### Issue #1: [Brief title]
- **When:** Step X / Phase Y
- **What happened:** [Description]
- **Root cause:** [If known]
- **Resolution:** [How fixed / workaround]
- **Time spent:** [Estimate]
```

### No Issues?

If nothing went wrong, explicitly state: `**Issues/Blockers:** None`

This confirms issues were considered, not forgotten.

### Why This Matters

Undocumented issues lead to:
- Repeated debugging of the same problems
- Lost knowledge when context resets
- Inaccurate time estimates for similar tasks

**FAILURE TO DOCUMENT ISSUES IS A PROCESS VIOLATION.**

---

## Workflow Rules

When in plan mode, fully complete the plan and wait for user approval before implementing. Do not exit plan mode prematurely or start implementing without explicit "go ahead" from the user.

### Pre-Work Confirmation (MANDATORY)

Before starting any non-trivial implementation, confirm your approach with the user:

1. **Confirm you're on the correct branch** — run `git branch --show-current` and state it
2. **List the specific files you plan to modify** — no surprises
3. **Describe your approach in 3 bullet points** — what you'll do and why

Wait for user approval before writing any code. This prevents wasted effort from wrong-approach starts.

---

## Verification Before Claiming Success

When verifying a fix or process (sync jobs, reindexing, CI automations), confirm the outcome by OBSERVING it — query the record, read the log, re-run the check — not by exit codes or absence of errors. A green run is not proof the work happened.

**Incident Reference:** BACKLOG-1875 — pm-task-sync ran "successfully" while every RPC call was rejected; the error was masked as "task not found".

### Prove the mutation applied before you count its result (MANDATORY)

**An unverified mutation is an unrun control.** When you break your own code on purpose to prove a test can see the break, you apply the break as a text replacement — and **if the pattern does not match, nothing is replaced**. The code is untouched, the suite passes, and the green run gets written down as *"I broke it and the tests did not catch it."* Nothing was ever broken. The record then points at the wrong thing: it reads as a weak test when it is a broken harness, and the next person "fixes" a test that was fine.

1. **A mutation's result does not count until the mutation is proven to have applied.** Use an exact-string replace that raises when it matches nothing, or check `git diff --numstat`, and print `MUTATION APPLIED` plus the mutated line before running anything.
2. **`Tests: 0 total` is a FAILURE.** Jest exits 0 when it matches no test files, so zero tests passing is indistinguishable from all tests passing if only the exit code is read. Assert a non-zero test count and report the counts.
3. **Commit the fix BEFORE running any control that reverts with `git checkout --`.** On 2026-08-11 an agent discarded its own uncommitted fix that way and nearly shipped the bug it had just proven.

Three occurrences in one night, 10–11 Aug 2026 (BACKLOG-2645). Worked example: `.claude/docs/PR-SOP.md` → §4.4.

### Derive sets by execution, not by grep (MANDATORY)

**grep finds a TOKEN. It does not find the PROPERTY you are counting.** A symbol appears in a comment, a test, a dead branch, a file grep skips because one raw NUL byte makes it read as binary. Every one of those inflates or deflates a count, and the number reaches the founder with no way to tell.

1. **Cite the command next to any number you state.** "17 call sites (`git grep -c ... | wc -l`)" is checkable; "17 call sites" is not.
2. **To count things with a property, break the property and see what goes red.** Reachability, "is this filtered", "does this path run" — none of these are greppable. Run it.
3. **An empty grep result is a claim, not a fact.** Run `file <path>` before concluding a symbol is absent — `contactManualLink.ts` read as binary for weeks and every repo-wide sweep silently skipped it (BACKLOG-2637).

Three separate undercounts in one night, 30 Jul 2026.

### State a mechanism as traced, or mark it untraced (MANDATORY)

**An item's stated mechanism becomes the engineer's fixture.** Whoever picks the item up builds a test that reproduces the mechanism as written. If it was inferred rather than traced, they build a fixture for a state the code cannot produce — and it passes, because nothing contradicts it.

1. **Trace the mechanism to a running line, or write "MECHANISM UNTRACED" in the item.** Either is fine. Silence is not.
2. **Name the real producer.** BACKLOG-2672 was filed as an `external_contacts` row when the records are synthesised from `messages` by `getMessageDerivedContacts` — a fix keyed on `isExternal` would have missed every one. Caught by the engineer *after* implementation began.
3. **Quote literals from the code, not from memory.** A string assembled by interpolation has no fixed literal to quote — cite the template and the variable's fallback instead.
4. **Do not infer a universal negative from a local trace.** *"This function falls back to Y, therefore Z never appears"* is not established until you check **every writer of that function's input.** A fallback only tells you what happens when the input is empty — it says nothing about what the input contains.
5. **A CORRECTION IS A CLAIM TOO, and carries the same burden.** It is trusted *more* than the original and therefore checked *less*.

### The worked example — three passes over one sentence, in the rule about mechanisms

**Pass 1.** This rule's first draft cited BACKLOG-2679's string as emitted from `contactDbService.ts:529`. Wrong **citation**: `:529` is `[`, the parameter-array opener. The sentence is assembled at `electron/services/contactLinkEvidence.ts:187` — `` `…saved against ${who} — but ${who}'s own entry in that ${ctx.sourceLabel} no longer lists it.` `` — which is where 2679 already pointed. The mistake was conflating the **writer** of `"Unknown"` with the **emitter** of the sentence.

**Pass 2.** SR review called it false in all three parts, having traced `contactDisplayName()` (`contactLinkEvidence.ts:274-280`) to `return name && name.length > 0 ? name : "this contact"` and concluded `"Unknown"` never appears there.

**Pass 3.** The delta review overturned its own finding. `contactDisplayName()` returns `contacts.display_name` **verbatim**; the fallback fires only when the column is empty, and **five live writers guarantee it is not**:

```
electron/handlers/contactHandlers.ts:1875, :2355   display_name: validatedData.name || "Unknown"
electron/services/db/contactDbService.ts:371, :532 contactData.display_name || "Unknown"
electron/services/localSyncService.ts:1581         display_name: contact.displayName || "Unknown"
```

**So `"Unknown's own entry in that Mac address book"` IS emittable, and the first draft was substantively right about the literal while wrong about where it comes from.** Verified at `develop` @ `a2a98d540`.

Pass 2 is the instance of rule 4, and it is the one to learn from: **a single function's fallback was traced correctly, and a universal negative was inferred from it.** Emittability is not prevalence — gate 4 found zero such rows in the founder's own corpus.

---

## MANDATORY: Follow Instructions Exactly

**Do ONLY what is explicitly requested. Nothing more.**

### Rules

1. **No extras**: If asked to merge with `--merge`, do NOT add `--delete-branch` or any other flags.

2. **Ask first**: Before doing anything not explicitly requested, ASK:
   - "Should I delete the branch after merge?"
   - "Should I also push to remote?"
   - "Should I update X while I'm here?"

3. **Branch deletion**: NEVER delete branches unless explicitly asked. Integration branches (`int/*`) especially may be needed for reference.

4. **Merge command**: Use exactly `gh pr merge <PR> --merge` unless told otherwise.

5. **--admin flag**: NEVER use `gh pr merge --admin` or any flag to bypass CI or branch protection. If merge is blocked:
   a. Merge the target branch into your feature branch: `git fetch origin <base> && git merge origin/<base> --no-edit`
   b. Push to trigger fresh CI: `git push origin <branch>`
   c. Wait for all CI checks to pass
   d. Merge normally: `gh pr merge <PR> --merge`
   Even if tests appear to be passing, `strict: true` exists for a reason — it ensures code is tested against the latest target branch. Using `--admin` bypasses this safety check.

   **Incident Reference:** PRs #1411/#1412 were merged with `--admin` without user permission, bypassing `strict: true` branch protection.

### Why This Matters

Adding unrequested actions:
- Creates confusion about what was done
- Can lose work (deleted branches)
- Shows disregard for instructions
- Erodes trust

**When in doubt, ASK.**

---

## Tech Stack

This project uses TypeScript (primary), Supabase (database), Electron (desktop app), and Next.js (broker portal). Always use TypeScript for new code. Run type checks after edits with `npx tsc --noEmit`.

---

## Available MCP Servers

Agents in this repo have the following MCP servers available **in addition to** the standard file/search/Bash tools. They are available but agents will **NOT** reach for them unless prompted — if a task touches the database, a production error, or a deployment, use the matching server instead of guessing.

| Server | Use it for | Representative tools |
|--------|-----------|----------------------|
| **Supabase** | Backlog/sprint data (source of truth) and all DB work — queries, migrations, advisors, logs | `mcp__supabase__execute_sql`, `mcp__supabase__apply_migration`, `mcp__supabase__list_tables`, `mcp__supabase__get_advisors`, `mcp__supabase__get_logs` |
| **Sentry** | Production error/crash triage — pull real stack traces, tags, and events when investigating a bug | `mcp__sentry__search_issues`, `mcp__sentry__get_sentry_resource`, `mcp__sentry__search_events` |
| **Vercel** | Broker-portal (Next.js) deployment debugging — build/runtime logs, deployment status, project config | `mcp__vercel__list_deployments`, `mcp__vercel__get_deployment_build_logs`, `mcp__vercel__get_runtime_logs` |
| **GitHub** | PRs, issues, CI status | **Prefer the `gh` CLI** (already authenticated: `gh pr`, `gh api`, …); the `github-full` MCP is a fallback |

**Notes:**
- Org/project context: Supabase project `Keepr` (`nercleijfrxqcvfjskbc`) · Sentry org `keeprcompliancecom` · Vercel team `danieizzy's projects`.
- If MCP tools are **deferred** (not preloaded in a session), discover them via ToolSearch (e.g. `select:mcp__sentry__search_issues`) before calling.
- Exact MCP tool prefixes vary by session/connector (e.g. Supabase may appear as `mcp__supabase__*` or `mcp__claude_ai_Supabase__*` depending on how it is connected) — treat the names in this table as representative and resolve the live name via ToolSearch before calling.
- **Bug / QA / fix work:** query **Sentry** for real error data *before* theorizing a root cause.

### Tool-First Rule: Exhaust Tools Before Asking the Founder (MANDATORY)

**Never hand the founder a manual/UI step without FIRST verifying no authed tool on this machine can do it.** This gate applies at PLANNING time — before you draft any "your steps" list — not just at execution time.

1. **Check what's already authed**: CLIs (`vercel`, `gh`, `stripe`, `supabase`, `git`, …) via `which` + `<cli> whoami`/config, and the MCP servers above. If a tool can do it, DO IT and report the result.
2. **Secrets already held by local authed tools can be moved machine-to-machine** — file + stdin pipes (e.g. `stripe` CLI config → `vercel env add <NAME> preview` via stdin), with values never displayed, never read into context, temp files scrubbed. Check presence/prefix only (e.g. `sk_test` vs `sk_live`), never print values.
3. **Only route to the founder what is genuinely his**: spending money / plan changes, domain/DNS at the registrar, creating or revealing NEW credentials (dashboards, password managers), and outward/irreversible decisions needing his sign-off.

**Incident references:** 2026-07-17 — founder was walked through the Vercel new-project dashboard while the authed `vercel` CLI could do it in one command. 2026-07-18 — founder was handed a "7-minute" Stripe-dashboard + Vercel-env paste list (BACKLOG-2104/2105) that the `stripe` CLI + env pipes then did entirely without him.

### Supabase PM RPCs vs MCP sessions

Nearly all `pm_*` RPCs (writes AND reads — e.g. `pm_create_item`, `pm_update_task_status`, `pm_get_item_by_legacy_id`) are guarded by an `internal_roles` check and FAIL from MCP sessions with "Access denied: internal role required" (the MCP connector runs as `postgres`; `auth.uid()`/`auth.role()` are NULL). Service-role REST callers (CI, hooks) pass only where the guard has the service-role bypass: `pm_add_comment`, `pm_log_agent_metrics`, and — post-BACKLOG-1875 — `pm_update_task_status`, `pm_get_task_by_legacy_id`, `pm_update_item_status`, `pm_get_item_by_legacy_id`, `pm_get_item_detail`.

**From MCP sessions: use direct SQL on the `pm_*` tables.** On INSERT into `pm_backlog_items`, set `item_number` (MAX+1) and `legacy_id` (`BACKLOG-<n>`) manually; add a `pm_events` row for audit when it matters. Unguarded RPCs safe from MCP: `pm_record_task_tokens`, `pm_label_agent_metrics`.

---

## Project Overview

Keepr is an Electron-based desktop application for real estate transaction auditing. It features:
- Electron main/preload/renderer architecture
- React 18 with TypeScript (strict mode)
- SQLite with encryption for local storage
- Supabase for cloud sync
- Microsoft Graph and Gmail API integrations

## Git Workflow

Before starting any work, confirm the correct branch. Check `git branch` and verify with the user if uncertain. Never commit to `claude/*` branches or wrong feature branches without explicit instruction.

Use separate git worktrees for docs, plans, and sprint files to avoid polluting the user's active testing environment. Run `git worktree add ../worktree-name branch-name` when creating non-code deliverables.

## Git Branching Strategy

```
main (production)
  │
  └── PR (traditional merge)
        │
develop (integration/staging)
  │
  └── PR (traditional merge)
        │
feature/*, fix/*, claude/* (your work)
```

### Branch Naming

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feature/` | New features | `feature/dark-mode` |
| `fix/` | Bug fixes | `fix/login-crash` |
| `hotfix/` | Urgent production fixes | `hotfix/security-patch` |
| `claude/` | AI-assisted development | `claude/refactor-auth` |

### Merge Policy

**CRITICAL: Always use traditional merges (not squash) to preserve commit history.**

### CRITICAL: Never Commit Directly to develop or main

**ALL work MUST go through a branch + PR workflow. There are NO exceptions.**

Before making any commit, check your branch:
```bash
git branch --show-current
```

If on `develop` or `main`:
1. **STOP** - do not commit
2. Create a branch: `git checkout -b fix/description`
3. Then commit your changes
4. Push and create a PR

Even "quick fixes" and "obvious bugs" must use branches. This ensures:
- PR review catches issues
- CI validates changes
- Audit trail exists
- Rollback is possible

**Incident Reference:** BACKLOG-154 documents a violation where a bug fix was committed directly to develop, bypassing review.

### Integration Branch Rules (MANDATORY)

**Incident Reference:** SPRINT-P Phase 1 — 4 PRs targeting develop directly caused 5+ hours of sequential CI waits due to `strict: true` branch protection cascade.

**ALL sprint work MUST use an integration branch. NEVER target develop directly with multiple sprint PRs.**

Integration branches (`int/*`) collect all sprint work before merging to develop.

**Pattern:**
1. PM creates `int/<sprint-name>` from develop at sprint start
2. All engineer PRs target the `int/*` branch (NOT develop)
3. The `int/*` branch has no `strict: true` — PRs merge fast
4. After all sprint work is done and tested, one PR from `int/*` to develop
5. One CI run, one merge to develop

**Before starting any new sprint:**
```bash
git branch -a | grep "int/"
```

**If integration branches exist with unmerged work:**

| Option | When to Use |
|--------|-------------|
| Base new sprint on the int/* branch | When existing work is related or foundational |
| Merge int/* to develop first | When existing work is complete and tested |
| Sync both branches regularly | When parallel work is truly needed |

**Never branch new sprint work from develop when develop is behind an active int/* branch.**

This prevents fixes from being lost (as happened with the onboarding fix in `int/ai-polish` when `int/cost-optimization` branched from stale develop).

### Parallel Agent Safety (MANDATORY)

**CRITICAL:** When running multiple engineer agents in parallel (background mode), each agent MUST use an isolated git worktree. Working in the same directory causes race conditions that can burn massive tokens.

**Incident Reference:** BACKLOG-132 (~18M tokens burned, ~500x overrun)

**Quick Reference:**
```bash
# Create isolated worktree for parallel task
# For sprint tasks: base from the integration branch
git worktree add ../Mad-task-XXX -b feature/TASK-XXX-description int/<sprint-name>
# For standalone work: base from develop
# git worktree add ../Mad-task-XXX -b feature/TASK-XXX-description develop

cd ../Mad-task-XXX

# Give the worktree its own hook runner (BACKLOG-2577). A worktree without
# .husky/_ runs NO pre-push hook and git reports that with silence and exit 0.
npm run hooks:doctor -- --seed

# Verify isolation
git worktree list
pwd  # Should show Mad-task-XXX, NOT main repo
```

`hooks:doctor` (no `--seed`) answers "which hook runs when I push, and is it
mine?" and exits non-zero when the answer is wrong. A hookless worktree loses
**local fast feedback, not correctness** — CI remains the gate — but fix it
anyway rather than pushing blind.

**Full documentation:** `.claude/docs/shared/git-branching.md` (Git Worktrees section)

### Bug Fix Workflow (MANDATORY)

**Before investigating any reported bug:**
```bash
# Check for existing fix branches that may address this issue
git branch -a | grep "fix/"
```

If an existing fix branch seems related:
1. Check its commits: `git log fix/<branch-name> --oneline -5`
2. Compare to develop: `git diff develop...fix/<branch-name> --stat`
3. If it contains the fix, **merge it** instead of starting over

**After creating a fix branch:**

A fix is NOT complete until it's merged. The workflow is:
1. Create branch → 2. Commit fix → 3. Push → 4. Create PR → 5. **Merge to develop**

Do NOT move on to other work until the fix is merged. Unmerged fix branches become orphaned and the same bug gets "fixed" multiple times.

**Cleanup:** After merging, delete the local fix branch:
```bash
git branch -d fix/<branch-name>
```

### Orphan PR Prevention (MANDATORY)

> **Incident Reference:** SPRINT-051/052 had 20+ PRs created but never merged, causing fixes to be "lost" and reimplemented multiple times.

**Full lifecycle reference:** `.claude/docs/shared/pr-lifecycle.md`

**The Rule:** A PR is NOT complete until MERGED. Creating a PR is step 3 of 4, not the final step.

```
1. CREATE   → Branch + commits pushed
2. OPEN     → PR created
3. APPROVE  → CI passes + review approved
4. MERGE    → PR merged ← COMPLETION HAPPENS HERE
```

**After every PR merge, verify:**
```bash
gh pr view <PR-NUMBER> --json state --jq '.state'
# Must show: MERGED (not OPEN, not CLOSED)
```

**Session-End Check (MANDATORY):**
```bash
# Before ending ANY session, check for orphaned PRs
gh pr list --state open --author @me

# If any approved PRs are open, MERGE THEM NOW
```

**Do NOT:**
- Mark tasks complete before verifying merge
- Move to next task before verifying merge
- End session with approved-but-unmerged PRs

## Starting New Work

### Step 1: Create Feature Branch

```bash
# Always start from develop
git checkout develop
git pull origin develop

# Create your feature branch
git checkout -b feature/your-feature-name
```

### Step 2: Make Changes

Follow these guidelines:
- Write TypeScript with strict mode compliance
- Add tests for new functionality
- Keep commits atomic and well-described
- Run checks before committing:

```bash
npm run type-check    # TypeScript compilation
npm run lint          # ESLint checks
npm test              # Run test suite
```

### Step 3: Commit Changes

```bash
git add .
git commit -m "feat: add feature description

Detailed explanation if needed.
"
```

### Commit Message Format

Use conventional commits:
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only
- `refactor:` - Code refactoring
- `test:` - Adding tests
- `chore:` - Maintenance tasks
- `ci:` - CI/CD changes

### Step 4: Sync with Base Branch (MANDATORY before PR)

```bash
git fetch origin
# For sprint tasks: merge the integration branch
git merge origin/int/<sprint-name>
# For standalone work: merge develop
# git merge origin/develop

# If conflicts exist, resolve them MANUALLY (see .claude/docs/shared/git-branching.md)
# NEVER use 'git checkout --theirs' blindly - it discards your branch's changes!

npm run type-check
npm test
```

### Step 5: Push and Create PR

```bash
git push -u origin feature/your-feature-name

# Create PR targeting develop
# For sprint tasks: target the integration branch
gh pr create --base int/<sprint-name> --title "feat: your feature" --body "Description..."

# For standalone work (no sprint): target develop
# gh pr create --base develop --title "feat: your feature" --body "Description..."
```

### Step 6: Wait for CI

Required checks:
- Test & Lint (macOS/Windows, Node 18/20)
- Security Audit
- Build Application

### Step 7: Merge

After CI passes, merge with traditional merge (not squash):

```bash
gh pr merge <PR-NUMBER> --merge
```

## UI Development

When making UI/CSS changes, match the existing reference implementation exactly. If the user says "make it look like X", study X pixel-by-pixel before writing code. Do not substitute icons, layouts, or spacing without asking.

## Code Standards

### TypeScript
- Strict mode enabled
- No `any` types without justification
- Proper error handling with typed errors

### React
- Functional components with hooks
- Proper dependency arrays in useEffect
- Memoization for expensive computations

### Electron
- Clear IPC boundaries (main/preload/renderer)
- No direct `window.api` calls in components - use service abstractions
- Encryption at all data layers

### Testing
- Jest + React Testing Library
- Target 40-80% coverage
- No flaky tests

## Architecture Boundaries

**Full reference:** `.claude/docs/shared/architecture-guardrails.md`

### Entry File Line Budgets

| File | Target | Trigger |
|------|--------|---------|
| `App.tsx` | **70** | >100 |
| `AppShell.tsx` | 150 | >200 |
| `AppRouter.tsx` | 250 | >300 |
| `useAppStateMachine.ts` | 300 | >400 |

*Target = ideal, Trigger = mandatory extraction*

### DO:
- Keep business logic in services/hooks
- Use typed interfaces for IPC communication
- Isolate platform-specific code
- Keep `App.tsx` purely compositional (aim for ~70 lines)

### DON'T:
- Add business logic to App.tsx or entry files
- Scatter `window.api`/`window.electron` calls in components
- Exceed entry file line budgets without extraction

## Development Data Directory (BACKLOG-2709)

**`npm run dev` has its own profile and its own database.** Unpackaged builds resolve
`userData` / `sessionData` / `logs` to `<appData>/keepr-dev`; the installed app keeps
`<appData>/keepr` and is never touched by a dev build.

Before this existed, `npm run dev`, every packaged QA build and the installed app all opened
`~/Library/Application Support/keepr/mad.db` — the real database. Dev builds on a feature branch
migrated it v55 → v62 on 11–12 Aug 2026, so the v2.28.0 install found nothing left to migrate and
wrote no pre-migration backup. **That upgrade path can never be observed on that machine again.**

| Consequence | Detail |
|---|---|
| Dev starts signed out | A dev profile has no session. First run shows login and an empty app — expected, not data loss. A blocking dialog says so on the first launch against a new dev directory. |
| Both can run at once | Dev and the installed app now take separate `SingletonLock`s. Previously, launching dev with the app open made dev quit. |
| Dev logs are separate | `keepr-dev/logs/main.log`. `app.setPath("logs", …)` alone is NOT enough — electron-log builds its macOS path from the app *name*, so `transports.file.resolvePathFn` is set explicitly in `electron/bootstrap/installAppDataPaths.ts`. |

**Precedence** (`electron/bootstrap/appDataPaths.ts`): `--user-data-dir` switch (keeps E2E profiles
hermetic) → `KEEPR_USER_DATA_DIR` → packaged (never moves) → `<appData>/keepr-dev`.

`KEEPR_USER_DATA_DIR` is an **environment variable only** — it cannot be set in `.env.local`,
because dotenv loads long after the override has already run. Use it to point a build at a seeded
fixture:

```bash
KEEPR_USER_DATA_DIR=/tmp/keepr-fixture npm run dev
```

**Never "fix" a dev build by pointing it back at `<appData>/keepr`.** That is the defect.

## Common Commands

```bash
# Development
npm run dev              # Start Electron in dev mode
npm run build            # Build for production

# Testing
npx jest path/to/file.test.ts   # PREFERRED for single suites - never touches node_modules
npm test                 # Full suite. Flips the shared native module for the duration
                         # of the run, then always restores it (see Native Module Errors)
npm run type-check       # TypeScript check
npm run lint             # ESLint check

# Native modules (REQUIRED after npm install or Node.js update)
npm rebuild better-sqlite3-multiple-ciphers
npx electron-rebuild
```

### Native Module Errors

If you see this error, rebuild native modules:
```
NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 133.
```

**Symptoms**: Database fails to initialize, app stuck on loading/onboarding screens in an infinite loop.

**Check which build is currently live** (a plain `require()` is NOT proof — `bindings` finds a
cwd-relative copy and falsely succeeds, so use `dlopen` on the absolute path):

```bash
node -e "try{process.dlopen({exports:{}},'/Users/daniel/Developer/Mad/node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node');console.log('NODE build -> dev WILL break')}catch(e){console.log('ELECTRON build -> dev OK')}"
```

#### Why this keeps happening: one binary, two incompatible ABIs

`better-sqlite3-multiple-ciphers` can only be built for **one** ABI at a time:

| Build | `npm run dev` | jest's 32 real-module suites |
|-------|---------------|------------------------------|
| **Electron** (resting state) | works | cannot load the binary |
| **Node** | broken | works |

Every git worktree symlinks `node_modules` at `/Users/daniel/Developer/Mad/node_modules`, so
**anything that rebuilds the module writes the SHARED tree** and affects the founder's running
dev app and every sibling worktree at once.

`npm test` flips to the Node ABI for the duration of the run and restores the Electron build
afterwards. Before BACKLOG-2372 the restore lived in npm's `posttest` hook, which npm **skips
when tests fail** — so a red or Ctrl-C'd run stranded the shared tree. That is why the breakage
correlated with test *failures*, not test *runs*. It now restores on every exit path, including
Ctrl-C. If a restore ever fails you get a loud banner and **exit code 75** — follow the command
it prints.

**Still true, and not protected:**
- **`npm install` / `npm rebuild` have the same hazard and no such protection.**
- While any `npm test` run is in progress the shared binary is Node-ABI, so starting
  `npm run dev` mid-run can still fail. BACKLOG-2374 (worktree-local native module) is the
  durable fix.
- `npm run test:watch` and `npm run test:coverage` deliberately do **not** flip the tree, so
  the 32 real-module suites fail under them. Use `npm test` for those suites.

**Agents: prefer `npx jest path/to/file.test.ts`** — it never touches `node_modules`.

**Fix (try in order)**:

1. Standard rebuild:
```bash
npm rebuild better-sqlite3-multiple-ciphers
npx electron-rebuild
```

2. If that doesn't work (common on Windows without Python), use prebuild-install:
```powershell
# Clear prebuild cache and download correct Electron binary
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\npm-cache\_prebuilds"
Remove-Item -Recurse -Force "node_modules\better-sqlite3-multiple-ciphers\build"
cd node_modules/better-sqlite3-multiple-ciphers
npx prebuild-install --runtime=electron --target=35.7.5 --arch=x64 --platform=win32
```
(Replace `35.7.5` with your Electron version from `npx electron --version`)

**When to rebuild**:
- After `npm install`
- After upgrading Node.js
- After pulling changes with dependency updates
- After switching branches with different dependencies

## Key Documentation

| Document | Location | Purpose |
|----------|----------|---------|
| **Docs Index** | `.claude/docs/INDEX.md` | Master index of all documentation |
| **PR SOP** | `.claude/docs/PR-SOP.md` | Complete PR checklist (all phases) |
| **Senior Engineer** | `.claude/docs/PR-SOP.md` + `senior-engineer-pr-lead` agent | Architecture standards, advanced reviews |
| **This Guide** | `CLAUDE.md` | Quick start, branching, workflow |

### Shared References (Canonical Sources)

| Topic | Location |
|-------|----------|
| **PR Lifecycle** | `.claude/docs/shared/pr-lifecycle.md` |
| Plan-First Protocol | `.claude/docs/shared/plan-first-protocol.md` |
| Metrics Templates | `.claude/docs/shared/metrics-templates.md` |
| Architecture Guardrails | `.claude/docs/shared/architecture-guardrails.md` |
| Git Branching | `.claude/docs/shared/git-branching.md` |
| Effect Safety Patterns | `.claude/docs/shared/effect-safety-patterns.md` |
| Native Module Fixes | `.claude/docs/shared/native-module-fixes.md` |
| CI Troubleshooting | `.claude/docs/shared/ci-troubleshooting.md` |

## Getting Help

- **PR preparation/review**: Follow `.claude/docs/PR-SOP.md`
- **Architecture questions**: Use the senior-engineer-pr-lead agent
- **Complex PR reviews**: Use the senior-engineer-pr-lead agent
- **Code exploration**: Use the Explore agent

## Quick Reference

| Task | Target Branch | Merge Type |
|------|---------------|------------|
| Sprint task (2+ PRs) | `int/<sprint-name>` | Traditional |
| Sprint final merge | `develop` (from `int/*`) | Traditional |
| Standalone feature | `develop` | Traditional |
| Standalone bug fix | `develop` | Traditional |
| Hotfix | `main` + `develop` | Traditional |
| Release | `main` (from develop) | Traditional |

**CRITICAL: All sprint work (2+ tasks) MUST use an integration branch. Never target develop directly with multiple PRs.**

### Investigation-First Sprints

For bug fix sprints with unclear root causes:

1. **Start with parallel investigation tasks** (read-only, no file modifications)
2. **Review findings before implementation** - PM checkpoint after Phase 1
3. **Defer tasks if investigation shows no bug exists** - Don't implement unnecessary fixes
4. **Update backlog status immediately** - Change to `deferred` with reason

**Reference:** SPRINT-061 saved ~17K tokens by deferring TASK-1406 after investigation found the "bug" was already fixed.

**Full documentation:** `.claude/skills/agentic-pm/modules/sprint-management.md` → "Investigation-First Pattern"
