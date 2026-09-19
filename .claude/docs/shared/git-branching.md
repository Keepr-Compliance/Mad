# Git Branching Strategy

**Status:** Canonical reference for branching and merge policies
**Last Updated:** 2026-09-13

---

## Branch Structure

Magic Audit follows a GitFlow-inspired branching strategy:

```
main (production)
  │
  └── PR (traditional merge)
        │
develop (integration/staging)
  │
  └── PR (traditional merge)
        │
feature/*, fix/*, claude/* (feature branches)
```

---

## Branch Types

| Branch | Purpose | Branch From | Merge To | Protected |
|--------|---------|-------------|----------|-----------|
| `main` | Production-ready code | - | - | Yes |
| `develop` | Integration branch for next release | - | `main` | Yes |
| `feature/*` | New features | `develop` | `develop` | No |
| `fix/*` | Bug fixes | `develop` | `develop` | No |
| `hotfix/*` | Urgent production fixes | `main` | `main` AND `develop` | No |
| `claude/*` | AI-assisted development | `develop` | `develop` | No |
| `int/*` | Integration branches (multi-feature) | `develop` | `develop` | No |
| `int-portal/*` | Integration branch for a sprint that changes portal code (see Branch Naming) | `develop` | `develop` | No |
| `project/*` | Multi-sprint project branches | `develop` | `develop` | No |
| `hotfix-portal/*` | Hotfix that changes portal code (see Branch Naming) | same as `hotfix/*` | `main` AND `develop` | No |
| `<type>-portal/*` | Opt in to a Vercel portal preview | `develop` | `develop` | No |

---

## Branch Naming

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feature/` | New features | `feature/dark-mode` |
| `fix/` | Bug fixes | `fix/login-crash` |
| `hotfix/` | Urgent production fixes | `hotfix/security-patch` |
| `claude/` | AI-assisted development | `claude/refactor-auth` |
| `int/` | Integration branches | `int/ai-polish` |
| `int-portal/` | Integration branch for a sprint that changes portal code; creates portal deployments | `int-portal/contacts-ui` |
| `hotfix-portal/` | Hotfix that changes portal code; creates portal deployments | `hotfix-portal/login-redirect` |
| `project/` | Multi-sprint projects | `project/ai-integration` |
| `refactor/` | Code refactoring | `refactor/docs-consolidation` |
| `<type>-portal/` | Opt in to a Vercel portal preview (a modifier on the type, not a new type) | `fix-portal/broker-login` |

For sprint tasks, include the task ID:
- `fix/task-510-database-cleanup`
- `feature/task-512-export-feature`

---

### Portal preview deployments (BACKLOG-2833)

The two web apps (`broker-portal/`, `admin-portal/`) deploy to Vercel. Portal previews are
**off by default**, because the free plan caps deployments **created** — and a deployment
that the Ignored Build Step cancels still counts against that cap.

**To get a preview, add `-portal` to the type segment of your branch name:** `fix-portal/…`,
`docs-portal/…`, `chore-portal/…`, `feat-portal/…`. The type keeps its meaning; `-portal` is
a modifier on it, not a new type. (`portal/…` also works, as a spare spelling.) Integration and
hotfix branches use the same key: `int-portal/…` and `hotfix-portal/…`.

| Branch | Previews? |
|---|---|
| `main`, `develop` | yes |
| `dependabot/*` | yes — dependency bumps are real portal changes |
| `release/*` | yes |
| `int/*`, `hotfix/*` | **no** (BACKLOG-3205). The `Portal Branch Name` check fails when one of these carries portal changes — see *Does this sprint or hotfix touch a portal?* below |
| `fix-portal/…`, `docs-portal/…`, any `<type>-portal/…` | **yes — this is the opt-in** |
| `int-portal/…`, `hotfix-portal/…` | **yes** — the opt-in for integration and hotfix branches. Measured for `int-portal/` on 2026-09-13 (BACKLOG-3205); `hotfix-portal/` matches the same `*-portal/**` key and was not pushed separately |
| everything else (`fix/`, `feat/`, `chore/`, `docs/`, …) | no |

**If your preview never appears, check the branch name first.** A branch the config denies
gets no deployment *and no error* — Vercel posts no commit status at all for it. The symptom
is silence, which reads like a broken feature rather than a naming miss. `fix-portals/`,
`portal-fix/` and `fix_portal/` all miss: the modifier must end the type segment and be
followed by `/`.

**The limits.** From Vercel's published limits page, <https://vercel.com/docs/limits> → "API
rate limits", Free tier, every one scoped to the **account** (not the project):

| Limit | Value | Window |
|---|---|---|
| Deployments per day (Free) | 100 | 86400s |
| Deployments per hour (Free) | 100 | 3600s |
| Deployments per five minutes (Free) | 60 | 300s |

These are **rolling windows, not calendar days.** There is no midnight reset — a refusal was
observed at 18:41 UTC while that calendar day's count was only 68 — so a burst can still be
costing you the next morning.

Both portals sit under one account, so every push to a **deploying** branch costs **2**.
That puts the day's ceiling at roughly **50 pushes to deploying branches**. Pushes to any
other branch cost nothing.

**Editing `broker-portal/vercel.json` or `admin-portal/vercel.json`?** The `"**": false`
entry in `git.deploymentEnabled` must stay the **last** key. This is an observed rule and
the mechanism is *not* established: with that key written first, branches an allow key
matches were denied on both portals; written last, they deployed. JSON cannot carry a
comment saying so, so `scripts/ci/check-vercel-deploy-map.mjs` (workflow **Vercel Deploy
Map**) asserts it and fails the build if the order changes. Without that check a reordering
would silently deny every branch — `main` and `develop` included — with no red anywhere.
The same guard requires `"*-portal/**": true` and rejects `"int/**": true` or
`"hotfix/**": true` (BACKLOG-3205).

**Already on a non-portal branch and need a preview now?**

```bash
vercel deploy --cwd broker-portal     # or admin-portal
```

One deployment from the same account budget. Needs a one-time `vercel link` per portal
directory, and it uploads your **working tree** — so the preview can include uncommitted
changes and corresponds to no commit. It also produces no PR comment.

A `<type>-portal/…` PR still needs the Engineer Metrics section and a BACKLOG id like any
other branch; `[skip-metrics]` in the PR title is the escape for a quick hand-pushed fix.

### Does this sprint or hotfix touch a portal?

Answer this **before creating the branch** (BACKLOG-3205). Portal code means any path under
`broker-portal/`, `admin-portal/`, `packages/design-system/` or `packages/ui/`.

| Answer | Integration branch | Hotfix branch |
|---|---|---|
| yes | `int-portal/<sprint-name>` | `hotfix-portal/<name>` |
| no | `int/<sprint-name>` | `hotfix/<name>` |

Plain `int/` and `hotfix/` branches get no Vercel deployment for the portal they change. The
`-portal` names create one.
`packages/shared/` and the root `package.json` / `package-lock.json` are not portal code for
this question: the desktop type-check compiles against `@keepr/shared`, and dependency bumps
touch the root manifests.

**The check.** Workflow **Portal Branch Name** (`scripts/ci/check-portal-branch-name.mjs`) runs
on pushes to, and pull requests into, `int/`, `hotfix/`, `int-portal/` and `hotfix-portal/`
branches. It fails when a plain `int/` or `hotfix/` branch's own changes touch portal code. A
develop sync does not count: only changes that are on neither `develop` nor `main` do.

**When it fails,** create the opt-in branch from the plain one and move its open PRs to it:

```bash
git push origin origin/int/<name>:refs/heads/int-portal/<name>
gh pr edit <number> --base int-portal/<name>     # each open PR into int/<name>
```

**When the deployment builds.** A created deployment still runs the Ignored Build Step
(`scripts/vercel-ignore-build.sh`), which builds only when the push changes that portal's paths.
On a branch's first deployment it compares against the previous commit (`HEAD~1`). Measured on
2026-09-13 (BACKLOG-3205):

| What you push to the `-portal` branch | Result |
|---|---|
| the same commit the plain branch already has | no deployment at all |
| an empty commit | a deployment per portal, each skipped as "Not affected" — no build |
| a commit whose only change is outside the portal paths | a deployment, cancelled by the Ignored Build Step |

Not measured as a build, but traced from the build logs and the Ignored Build Step: a `-portal`
branch builds when a push's **newest commit** changes portal code, and a PR merge commit counts.
Until the branch has had one successful build, the step compares against `HEAD~1`, so a
multi-commit push whose last commit is desktop-only is cancelled. After that it compares against
the last successful build's commit, so any portal change since then builds. So **move the branch
before the first portal PR merges**: that merge commit then changes portal code, and it builds.
If portal work is already merged, the next push whose newest commit changes portal code builds;
for a preview sooner, use `vercel deploy` (above).

**The old red stays on that commit.** Moving a branch or a PR to the `-portal` name runs the check
again and it passes, but the earlier failed run remains in that commit's check rollup until a new
commit is pushed.

**Do not delete the plain branch.** The Message Hygiene gate treats a commit reachable from
another `origin` branch as already published (`scripts/ci/check-message-hygiene.mjs`).
Deleting `int/<name>` puts every one of its commits back into range on the
`int-portal/<name> -> develop` PR.

---

## Merge Policy

**CRITICAL: Always use traditional merges (not squash) to preserve commit history.**

```bash
# CORRECT - traditional merge
gh pr merge <PR-NUMBER> --merge

# WRONG - squash loses commit history
gh pr merge <PR-NUMBER> --squash  # DO NOT USE
```

---

## Branch Deletion Policy

**Do NOT auto-delete branches.** Branch deletion is a separate, manual step.

| Branch Type | When to Delete | How |
|-------------|----------------|-----|
| `feature/*`, `fix/*` | After merge confirmed AND no dependent work | Manual: `git branch -d branch-name` |
| `int/*`, `int-portal/*` | NEVER auto-delete | May be needed for reference |
| `hotfix/*`, `hotfix-portal/*` | After merged to BOTH main and develop | Manual |
| `project/*` | After project milestone complete | Manual, with team confirmation |

**PR merge command (no auto-delete):**
```bash
gh pr merge <PR-NUMBER> --merge
# NOT: gh pr merge <PR-NUMBER> --merge --delete-branch
```

---

## Workflow Examples

### Starting New Feature

```bash
git checkout develop
git pull origin develop
git checkout -b feature/my-feature
# ... make changes ...
git push -u origin feature/my-feature
gh pr create --base develop --title "feat: my feature"
```

### Bug Fix

```bash
git checkout develop
git pull origin develop
git checkout -b fix/bug-description
# ... fix bug ...
git push -u origin fix/bug-description
gh pr create --base develop --title "fix: bug description"
```

### Hotfix (Production Emergency)

```bash
# 1. Branch from main
git checkout main
git pull origin main
git checkout -b hotfix/critical-fix

# 2. Make fix and test
# ...

# 3. Create PR to main
git push -u origin hotfix/critical-fix
gh pr create --base main --title "hotfix: critical fix"

# 4. After merge to main, also merge to develop
git checkout develop
git pull origin develop
git merge origin/main
git push origin develop
```

### Release (develop to main)

```bash
git checkout develop
git pull origin develop
# Create PR from develop to main
gh pr create --base main --head develop --title "release: v1.2.3"
# After merge, main triggers production packaging
```

---

## Integration Branch Rules (MANDATORY)

**Incident Reference:** SPRINT-P Phase 1 — 4 PRs targeting develop directly caused 5+ hours of sequential CI waits due to `strict: true` branch protection cascade.

**ALL sprint work MUST use an integration branch. NEVER target develop directly with multiple sprint PRs.**

Integration branches (`int/*`) collect all sprint work before merging to develop.

`int-portal/<sprint-name>` is an integration branch too, and every rule in this section applies
to it. Pick the name with *Does this sprint or hotfix touch a portal?* under Branch Naming.

### Sprint Integration Branch Workflow

```bash
# 1. PM creates integration branch at sprint start
git checkout develop
git pull origin develop
git checkout -b int/<sprint-name>
git push -u origin int/<sprint-name>

# 2. Engineers create feature branches from the int branch
git checkout int/<sprint-name>
git checkout -b feature/task-XXX-description

# 3. All sprint PRs target the int branch
gh pr create --base int/<sprint-name> --title "fix: description"

# 4. After all sprint work is merged to int and tested:
#    One final PR from int/<sprint-name> → develop
gh pr create --base develop --head int/<sprint-name> --title "sprint: SPRINT-XXX complete"

# 5. One CI run, one merge to develop
gh pr merge <PR> --merge
```

### Why This Is Mandatory

| Approach | N PRs | CI Wait Time | Total Merge Time |
|----------|-------|-------------|------------------|
| Direct to develop (strict:true) | 4 | 4 x 15-30 min (sequential) | 1-2+ hours |
| Integration branch | 4 + 1 | 1 x 15-30 min (final only) | 15-30 min |

With `strict: true` on develop, each merge invalidates all other open PRs because they no longer include the latest commit. This forces sequential CI runs. Integration branches bypass this entirely.

### When to Check for Existing Integration Branches

**Before starting any new sprint:**
```bash
git branch -a | grep -E '(^|[ /])int(-portal)?/'
```

**If integration branches exist with unmerged work:**

| Situation | Action |
|-----------|--------|
| Existing work is related/foundational | Base new sprint on the `int/*` branch |
| Existing work is complete and tested | Merge `int/*` to develop first |
| Parallel work truly needed | Sync both branches regularly |

**Never branch new sprint work from develop when develop is behind an active `int/*` branch.**

### Single-Task Exception

For truly standalone work (a single PR with no sprint context), targeting develop directly is acceptable. But any sprint with 2+ tasks MUST use an integration branch.

---

## Project Branches (Multi-Sprint Work)

For related work spanning multiple sprints:

```bash
# Create project branch
git checkout develop
git checkout -b project/ai-integration

# Sprint work branches off project branch
git checkout project/ai-integration
git checkout -b feature/ai-sprint-1-task-xxx

# Merge sprint work to project branch first
# Then merge project branch to develop when milestone complete
```

---

## Branch Protection Rules

Both `main` and `develop` have protection rules:
- Required status checks must pass
- Force pushes are blocked
- Branch deletion is blocked

---

## Pre-PR Sync (Mandatory)

Before creating a PR, always sync with target branch:

```bash
git fetch origin
git merge origin/develop  # or origin/main for hotfixes

# If conflicts exist, resolve them NOW (see Merge Conflict Resolution below)
# Run tests locally
npm run type-check
npm test

# Then push
git push
```

---

## Merge Conflict Resolution (CRITICAL)

> **Incident Reference:** SPRINT-054 Phase 0 - Multiple fixes from PR #573 were lost when `git checkout --theirs` was used to resolve conflicts, discarding all changes from the feature branch.

### Never Use `--theirs` or `--ours` Blindly

When resolving merge conflicts, **DO NOT** blindly accept one side:

```bash
# DANGEROUS - loses all your branch's changes to this file
git checkout --theirs path/to/file.tsx

# DANGEROUS - loses all incoming changes from develop
git checkout --ours path/to/file.tsx
```

### When `--theirs`/`--ours` IS Acceptable

| Situation | Acceptable? | Example |
|-----------|-------------|---------|
| File was only changed on one branch | Yes | Config file updated on develop, not touched in feature |
| Your changes are obsolete/replaced | Yes | Develop has a complete rewrite of a component you lightly modified |
| You're intentionally discarding your work | Yes | Abandoning an approach that didn't work |

### Proper Conflict Resolution Process

1. **Examine the conflict markers** - understand what both sides changed:
   ```
   <<<<<<< HEAD (your branch)
   // Your changes
   =======
   // Incoming changes from develop
   >>>>>>> origin/develop
   ```

2. **Merge manually** - keep changes from BOTH sides where appropriate

3. **Test after resolution**:
   ```bash
   npm run type-check
   npm test
   npm run dev  # Manual smoke test
   ```

4. **Review the diff before committing**:
   ```bash
   git diff --cached  # See what you're about to commit
   ```

### Common Merge Conflict Scenarios

| Scenario | Resolution Approach |
|----------|---------------------|
| Both sides added imports | Keep all imports (remove duplicates) |
| Both sides modified same function | Manually integrate both changes |
| Develop refactored, you added feature | Apply your feature to the refactored code |
| Both sides added to same list/array | Include items from both sides |

### Post-Merge Verification Checklist

After resolving conflicts, verify no fixes were lost:

- [ ] All features from your branch still work
- [ ] All features from develop still work
- [ ] Run full test suite
- [ ] Manual smoke test of affected functionality
- [ ] Review git log to confirm your commits are present

---

## Bug Fix Workflow Reminder

**Before investigating any reported bug:**
```bash
# Check for existing fix branches
git branch -a | grep "fix/"
```

If an existing fix branch seems related:
1. Check its commits: `git log fix/<branch-name> --oneline -5`
2. Compare to develop: `git diff develop...fix/<branch-name> --stat`
3. If it contains the fix, **merge it** instead of starting over

**After creating a fix branch:** A fix is NOT complete until merged. Don't move on until the PR is merged.

---

## Strict Branch Protection (`strict: true`)

The `develop` branch requires `strict: true` in branch protection. This means:

1. All required CI checks must pass (Test & Lint macOS/Windows, Security Audit)
2. The PR branch must include the latest commits from the target branch

### The Sequential PR Problem

When merging multiple PRs to the same target:

```
PR-A merges → develop moves to commit X
PR-B was based on commit X-1 → now out of date → merge blocked
Fix: merge develop into PR-B → push → CI runs → merge
PR-B merges → develop moves to commit Y
PR-C now out of date → repeat
```

### Recovery Steps

When `gh pr merge` fails with "base branch policy prohibits the merge":

```bash
git fetch origin develop
git merge origin/develop --no-edit
git push origin <branch>
# Wait for CI to pass
gh pr merge <PR> --merge
```

NEVER use `--admin` to bypass this. The strict check exists to ensure code is tested against the latest target branch state.

---

## Git Worktrees (Parallel Sprint Execution)

> **MANDATORY for Parallel/Subagent Execution:** If you were spawned to run alongside other agents or are executing parallel sprint tasks, you MUST use isolated git worktrees (or be spawned with `isolation: "worktree"` on the Agent tool). This is NON-NEGOTIABLE.
>
> **Incident Reference:** BACKLOG-132 - ~18M tokens burned (~500x overrun) when two parallel agents worked in the same directory without worktree isolation.

When executing sprint tasks in parallel, use git worktrees to maintain multiple branches simultaneously.

### Creating Worktrees for Sprint Tasks

The `git worktree add` command with `-b` creates BOTH the branch AND the worktree directory in one step.

**Syntax:** `git worktree add <path> -b <new-branch> <base-branch>`

```bash
# Feature work (base from develop)
git worktree add ../Mad-task-701 -b feature/TASK-701-html-email develop

# Bug fix (base from develop)
git worktree add ../Mad-task-804 -b fix/TASK-804-flaky-test develop

# Documentation/refactor (base from develop)
git worktree add ../Mad-task-616 -b refactor/TASK-616-console-cleanup develop

# Hotfix (base from main - production emergency)
git worktree add ../Mad-hotfix-001 -b hotfix/critical-security-patch main
```

**Then, in the new worktree, seed its hook runner (MANDATORY — BACKLOG-2577):**

```bash
cd ../Mad-task-701
npm run hooks:doctor -- --seed
```

### Why the seed step is not optional

`core.hooksPath` is shared by every worktree, and husky resolves the user hook
relative to it. A worktree with no `.husky/_` directory runs **no pre-push hook
at all**, and git reports that with **silence and exit 0** — there is no warning,
and a push that checked nothing looks exactly like a push that passed.

`.husky/_` is deliberately **untracked**, so `git worktree add` cannot bring it
along: hook infrastructure requires branch-independence, and tracking is
definitionally branch-dependence (a checkout of a branch without the files would
delete the directory and disable hooks repo-wide). The one-time seed is the
price of that safety.

Run `npm run hooks:doctor` (without `--seed`) at any time to see which hook a
push from this worktree will actually execute, whether it is this worktree's own,
and its md5. It exits non-zero when the answer is wrong.

**Bounding the risk:** an unseeded worktree loses **local fast feedback, not
correctness**. CI remains the gate, so nothing bad merges because of a missed
seed. Fix it anyway rather than pushing blind.

### Verification Steps (MANDATORY)

**Always verify worktree creation before proceeding:**

```bash
# Step 1: Verify worktree exists
git worktree list
# Expected output for each worktree:
# /Users/you/Mad-task-701  abc1234 [feature/TASK-701-html-email]

# Step 2: Verify directory is accessible
ls /Users/you/Mad-task-701
# Should show: package.json, src/, electron/, etc.

# Step 3: Verify correct branch
git -C /Users/you/Mad-task-701 branch --show-current
# Should show: feature/TASK-701-html-email
```

### Common Failure Modes and Solutions

| Error Message | Cause | Solution |
|---------------|-------|----------|
| `fatal: 'feature/TASK-XXX' already exists` | Branch name already in use | Delete: `git branch -D feature/TASK-XXX` then retry |
| `fatal: '/path/to/Mad-task-XXX' already exists` | Directory exists | Remove: `rm -rf /path/to/Mad-task-XXX` then retry |
| `fatal: not a git repository` | Running from wrong directory | Use `-C` flag: `git -C /path/to/Mad worktree add ...` |
| `Preparing worktree (new branch)` then hangs | Network issue fetching | Add `--no-track` flag, push later |
| Worktree not in `git worktree list` | Creation failed silently | Check command output, fix error, retry |

### Example Workflow: Worktree from Creation to PR

```bash
# === SETUP (from main repo) ===
cd /Users/daniel/Documents/Mad
git fetch origin
git pull origin develop

# === CREATE WORKTREE ===
git worktree add ../Mad-task-801 -b feature/TASK-801-sms-fixtures develop

# === VERIFY ===
git worktree list
ls ../Mad-task-801/package.json  # Should exist

# === WORK IN WORKTREE (always use absolute paths or -C) ===
git -C /Users/daniel/Documents/Mad-task-801 status
# ... make changes ...
git -C /Users/daniel/Documents/Mad-task-801 add -A
git -C /Users/daniel/Documents/Mad-task-801 commit -m "feat: add SMS fixtures"
git -C /Users/daniel/Documents/Mad-task-801 push -u origin feature/TASK-801-sms-fixtures

# === CREATE PR ===
gh pr create --repo 5hdaniel/Mad --head feature/TASK-801-sms-fixtures --base develop

# === CLEANUP (after PR merged) ===
git worktree remove ../Mad-task-801 --force
```

**CRITICAL:** Always use `git -C /absolute/path` or `--prefix` for npm. Never rely on `cd` to maintain context in automated workflows.

### Worktree Naming Convention

| Pattern | Example |
|---------|---------|
| `Mad-task-<NNN>` | `Mad-task-701`, `Mad-task-800` |
| Based on task ID | Matches the TASK-XXX being implemented |

### Worktree Cleanup (MANDATORY)

**Important:** Git worktrees are NOT automatically cleaned up when PRs merge. They must be explicitly removed after sprint completion.

**After sprint completion:**
```bash
# List all worktrees
git worktree list

# Remove each completed worktree
git worktree remove Mad-task-701 --force
git worktree remove Mad-task-702 --force
git worktree remove Mad-task-800 --force

# Verify cleanup
git worktree list
```

**Bulk cleanup script:**
```bash
# Remove all Mad-task-* worktrees at once
for wt in Mad-task-*; do
  if [ -d "$wt" ]; then
    git worktree remove "$wt" --force
    echo "Removed worktree: $wt"
  fi
done
```

### When to Clean Up Worktrees

| Trigger | Action |
|---------|--------|
| All sprint PRs merged | Remove all sprint worktrees |
| Sprint cancelled/abandoned | Remove associated worktrees |
| Task moved to different sprint | Remove old worktree if branch changed |

### Worktree Cleanup Responsibility

| Role | Responsibility |
|------|----------------|
| PM | Verify worktree cleanup in sprint completion checklist |
| Engineer | Clean up worktrees after their tasks merge |
| SR Engineer | Verify no orphaned worktrees during PR review |
