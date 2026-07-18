---
name: preflight
description: Flight-check before starting ANY new project, sprint, or feature branch — sweeps open PRs, unmerged branches, Supabase in-flight items, and migration parity so new work never branches from stale develop or collides with in-flight work.
---

# Preflight — In-Flight Work Check

Run BEFORE creating any sprint, integration branch, or feature branch. Produces a **Flight-Check Report**; no branch may be created until the report's final "Branching from" line is filled in with evidence.

**Why this exists (incident refs):**
- `int/ai-polish` onboarding fix lost when another sprint branched from stale develop
- BACKLOG-1878 — `int/supabase-security-perf`: items all "completed", migrations live in prod, branch **never merged** → silent schema drift
- BACKLOG-1879 — `int/android-companion`: 5 real fixes sat unmerged since March
- PR #1782 — item completed, PR orphaned open for a month
- SPRINT-166 — PM subagent ran a rev-list comparison **backwards** and framed a base-branch decision on the false result

**Core principle:** git is the source of truth for merge state; Supabase is the source of truth for intent. Cross-check both, trust neither alone. Status columns can lie (1878 proved it).

---

## Check 1: Open PRs — ALL authors, not just yours

```bash
git fetch origin
gh pr list --state open
```

For each open PR:
- Green and only waiting for approval? → **merge-first candidate** (surface to user: "approve this before we branch?")
- Does it touch files/areas the new work will touch? → note overlap

## Check 2: Unmerged branches with recent activity + worktrees

```bash
# Newest-first remote branches (scan top ~30 for anything recent)
git for-each-ref refs/remotes/origin --sort=-committerdate --format='%(committerdate:short) %(refname:short)' | head -30

# Not merged into develop
git branch -r --no-merged origin/develop

# Integration branches specifically (any int/* = investigate before branching)
git branch -a | grep "int/" || true

# Local in-flight work
git worktree list
```

Any unmerged branch with commits newer than ~2 sprints, and every `int/*` branch, must get a verdict below.

## Check 3: Supabase cross-check — run it in the branch→items direction

```sql
-- In-flight items with recorded branches/PRs (branch_name/pr_url populated since 2026-07)
SELECT legacy_id, title, status, branch_name, pr_url
FROM pm_backlog_items
WHERE status IN ('in_progress','testing') AND deleted_at IS NULL
ORDER BY updated_at DESC;
```

Then — critically — for every unmerged branch from Check 2, look up its items **regardless of status**:

```sql
SELECT legacy_id, title, status FROM pm_backlog_items WHERE branch_name = '<branch>';
```

An item marked `completed`/`testing` whose branch is NOT an ancestor of develop = the 1878 failure mode. Verify merge state with git, never the status column:

```bash
git merge-base --is-ancestor origin/<branch> origin/develop && echo MERGED || echo NOT-MERGED
```

## Check 4: Migration parity — repo vs live database

```sql
-- Live migrations (via Supabase MCP execute_sql)
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 20;
```

```bash
ls supabase/migrations/ | tail -20
```

Migrations applied to the live DB but missing from `supabase/migrations/` on develop (or vice versa) = **schema drift**. STOP: log a backlog item before proceeding (incident: BACKLOG-1878 — drift trips parity tests with no visible cause).

## Check 5: File-overlap classification

For each live branch that survived Checks 1–3:

```bash
git diff --stat origin/develop...origin/<branch> | tail -5
```

Compare touched files against the areas the new work will modify.

## Verdicts

| Verdict | When | Action |
|---|---|---|
| **Merge-first** | Green PR waiting for approval AND overlaps new work | Ask user to approve merge BEFORE branching |
| **Base-on** | Foundational/related unmerged work the new project builds on | Branch from it instead of develop (note in report) |
| **Parallel-safe** | Disjoint files, independently active | Proceed; note it exists |
| **Ask-user** | Ambiguous state or ownership | STOP and ask — never guess |

## Flight-Check Report (required output)

```markdown
## Flight-Check Report — YYYY-MM-DD

**Open PRs (all authors):** <n> — <#PR: verdict, ...>
**Unmerged branches w/ recent activity:** <branch: verdict, ...>
**Supabase in-flight cross-check:** <items checked; any status/git mismatches>
**Migration parity:** OK | DRIFT → BACKLOG-####
**Worktrees:** <list or "none">

**Branching from:** <ref>
**Because:** <reason>
**Evidence:** `git rev-list --count origin/develop..origin/<ref>` = N ahead, `git rev-list --count origin/<ref>..origin/develop` = M behind
```

Post the report via `pm_add_comment` on the sprint's primary backlog item (or include in `pm_sprints.body`).

**Git-evidence rule:** any "X is behind/ahead of Y" claim MUST quote `git rev-list --count` in BOTH directions after `git fetch origin`. Main sessions MUST re-run this check before relaying a subagent's git conclusion (SPRINT-166 incident: the comparison was backwards).

## Who runs this

- **PM agent** — mandatory Step 0.5 of `.claude/skills/agent-handoff/SKILL.md`, before creating `int/<sprint-name>` or choosing a base branch
- **Main session** — before any standalone feature/fix branch of non-trivial scope
