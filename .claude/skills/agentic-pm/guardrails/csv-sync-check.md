# CSV Sync Check Guardrail

> **DEPRECATED:** This guardrail applied to the pre-Supabase backlog/sprint workflow. Source of truth is now `pm_sprints`, `pm_backlog_items`, `pm_comments`, `pm_token_metrics` in Supabase. The CSV under `.claude/plans/backlog/data/backlog.csv` is read-only archive and is no longer kept in sync. Do NOT run `sync_csv.py` against current data. Keep this file for historical context only. See `.claude/skills/agentic-pm/SKILL.md` for the current workflow.

**(Historical) MANDATORY: Run this check before ANY sprint action (create, close, status report).**

## When to Run

- Before creating a new sprint
- Before closing a sprint
- Before reporting sprint status
- When user asks "where are we with..."

## Check Procedure

```bash
# 1. Find all backlog markdown files
find .claude/plans/backlog/items -name "BACKLOG-*.md" | wc -l

# 2. Count rows in CSV (minus header)
tail -n +2 .claude/plans/backlog/data/backlog.csv | wc -l

# 3. If counts don't match, CSV is out of sync
```

## Auto-Fix Script

If out of sync, run:
```bash
python .claude/plans/backlog/scripts/sync_csv.py
```

## Failure Response

If this check fails:
1. **STOP** - Do not proceed with sprint action
2. **FIX** - Add missing items to CSV
3. **VERIFY** - Re-run check
4. **PROCEED** - Only after check passes

## What Gets Checked

| Check | Pass Condition |
|-------|----------------|
| Item count | CSV rows == markdown files |
| Sprint items | All sprint items in CSV have sprint column set |
| Completed items | Completed items have completed_at date |
| Status values | All status values are valid |

## Valid Status Values

- Pending
- In Progress
- Implemented
- Testing
- Completed
- Blocked
- Deferred
- Obsolete
