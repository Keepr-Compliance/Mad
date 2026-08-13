---
name: sprint-wrapup
description: Wrap up a completed sprint — verify merges, clean branches, record backlog items, update statuses, and generate a summary.
---

# Sprint Wrap-Up Skill

Run this when all sprint work is done and deployed. It ensures nothing is left behind.

All PM data lives in **Supabase** (`pm_*` tables). Use the `mcp__supabase__execute_sql` tool for all reads and writes.

---

## Checklist

### 1. Verify All PRs Are Merged

```bash
# Check for any open PRs from this sprint
gh pr list --state open --search "SPRINT-XXX OR TASK-XXXX"
```

- Every PR must show state `MERGED`, not `OPEN` or `CLOSED`
- If any approved PRs are still open, merge them now
- Reference: `.claude/docs/shared/pr-lifecycle.md`

### 2. Clean Up Branches & Worktrees

```bash
# Delete merged local branches
git branch -d <branch-name>

# Check for worktrees
git worktree list
git worktree remove <path> --force
git worktree prune
```

- Delete all local branches that were merged during the sprint
- Remove any worktrees created for sprint tasks
- Do NOT delete branches without asking if unsure whether they're merged

### 3. Record New Backlog Items (Supabase)

Insert any new bugs, follow-ups, or tech debt discovered during the sprint into `pm_backlog_items`:

```sql
-- Get the next available item number
SELECT MAX(item_number) + 1 AS next_num FROM pm_backlog_items;

-- Insert each item
INSERT INTO pm_backlog_items (
  item_number, title, description, type, area, priority, status, est_tokens, start_date
) VALUES (
  <next_num>,
  '<title>',
  '<description>',
  '<type>',     -- 'bug' | 'feature' | 'chore' | 'improvement'
  '<area>',     -- 'admin-portal' | 'broker-portal' | 'electron' | 'infrastructure' | 'cross-portal'
  '<priority>', -- 'critical' | 'high' | 'medium' | 'low'
  'pending',
  <est_tokens>,
  CURRENT_DATE
);
```

Common sources of backlog items:
- Bugs found during testing but deferred
- Follow-up improvements mentioned by the user
- Tech debt introduced by time pressure
- Security/cleanup tasks (rotate secrets, delete old resources)
- Infrastructure improvements (CI, deployment, monitoring)

### 4. Update Sprint Status (Supabase)

Close the sprint in `pm_sprints`:

```sql
-- Mark sprint as completed
UPDATE pm_sprints
SET status = 'completed', end_date = CURRENT_DATE, updated_at = NOW()
WHERE name ILIKE '%SPRINT-XXX%';
```

### 5. Update Task Statuses (Supabase)

Mark all sprint tasks as completed in `pm_tasks`:

```sql
-- Complete all tasks in the sprint
UPDATE pm_tasks
SET status = 'completed', completed_at = NOW(), updated_at = NOW()
WHERE sprint_id = '<sprint-uuid>'
  AND status != 'completed';
```

Also update the parent backlog items:

```sql
-- Complete parent backlog items
UPDATE pm_backlog_items
SET status = 'completed', completed_at = NOW(), updated_at = NOW()
WHERE item_number IN (<backlog numbers for sprint tasks>);
```

### 6. Record Metrics (Supabase — Primary)

Verify all agents logged metrics and record task totals:

```sql
-- Check metrics for this sprint's tasks.
-- billable_tokens is the cost column. Do NOT report total_tokens as spend: it includes
-- cache_read_tokens and runs ~19x higher (measured 19.54x on 2026-08-11). Summing the
-- wrong column made every tracker variance wrong and forced 89 rows to be recomputed (PR #2282).
SELECT task_id, agent_type, billable_tokens, duration_ms, description
FROM pm_token_metrics
WHERE sprint_id = '<sprint-uuid>'
ORDER BY task_id, recorded_at;

-- Gap detection: find tasks with zero metric records
-- WARNING: This joins on legacy_id. If legacy_id is NULL, tasks silently show zero rows (false positive).
-- Fix: UPDATE pm_backlog_items SET legacy_id = 'TASK-' || item_number WHERE sprint_id = '<sprint-uuid>' AND legacy_id IS NULL;
-- Incident ref: SPRINT-T — NULL legacy_id made all metrics invisible.
SELECT t.legacy_id AS task_id, COUNT(m.id) AS metric_rows
FROM pm_tasks t
LEFT JOIN pm_token_metrics m ON m.task_id = t.legacy_id
WHERE t.sprint_id = '<sprint-uuid>' AND t.deleted_at IS NULL
GROUP BY t.legacy_id
HAVING COUNT(m.id) = 0;

-- Label any unlabeled rows (if .current-task was not set)
SELECT pm_label_agent_metrics('<agent_id>', 'TASK-XXXX', 'engineer', 'Implementation');

-- Record task totals (auto-sums from metric rows)
SELECT pm_record_task_tokens('<task_uuid>');
```

If failed Supabase pushes exist, check `~/.claude/metrics/failed-payloads.jsonl` and replay via `pm_log_agent_metrics` RPC.

### 7. Generate Sprint Summary

Add a retrospective to the sprint record. Store in the `body` field of `pm_sprints` or output to the user:

```markdown
## Retrospective

### Delivered
- [ list of features/fixes shipped ]

### Unplanned Work
- [ any work done outside original scope ]

### Issues Encountered
- [ problems hit, workarounds used ]

### Backlog Items Created
- BACKLOG-XXX: <title>
- BACKLOG-XXX: <title>

### Lessons Learned
- [ what to do differently next time ]
```

### 8. Ensure Clean State

```bash
# Switch back to develop
git checkout develop && git pull origin develop

# Verify no orphaned PRs
gh pr list --state open --author @me

# Verify deployments are current
# (broker portal)
cd broker-portal && vercel ls --prod 2>&1 | head -5
# (admin portal)
cd admin-portal && vercel ls --prod 2>&1 | head -5
```

---

## Supabase PM Tables Reference

| Table | Purpose |
|-------|---------|
| `pm_sprints` | Sprint records (name, goal, status, dates) |
| `pm_tasks` | Individual tasks within sprints |
| `pm_backlog_items` | Backlog items (bugs, features, chores) |
| `pm_token_metrics` | Agent token usage and cost tracking |
| `pm_comments` | Task/item comments |
| `pm_dependencies` | Task dependency graph |
| `pm_labels` / `pm_item_labels` | Label system |
| `pm_projects` | Project groupings |
| `pm_events` | Activity log |
| `pm_changelog` | Change history |

---

## When to Use This Skill

Use when:
- User says "wrap up", "close the sprint", "we're done with this sprint"
- All sprint tasks are implemented, reviewed, and deployed
- User wants to move on to new work

## Who Runs This

Typically invoked by the **PM agent** (`agentic-pm`), but can be run by the main session when wrapping up ad-hoc work that wasn't formally sprint-tracked.
