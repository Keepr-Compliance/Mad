# Keepr - Claude Development Guide

This guide is for all Claude agents working on Keepr. Follow these standards for all development work.

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

# Verify isolation
git worktree list
pwd  # Should show Mad-task-XXX, NOT main repo
```

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

## Common Commands

```bash
# Development
npm run dev              # Start Electron in dev mode
npm run build            # Build for production

# Testing
npm test                 # Run all tests
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
