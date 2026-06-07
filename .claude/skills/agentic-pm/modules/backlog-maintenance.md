# Backlog Maintenance Module

This module covers backlog cleanup, task archiving, and housekeeping procedures.

---

## Backlog Maintenance (MANDATORY)

**CRITICAL: Supabase is the source of truth for backlog data. It MUST be updated in real-time via RPCs.**

> **Note:** Legacy CSV files at `.claude/plans/backlog/data/` are preserved as a read-only archive. Do NOT update CSVs for new changes — use Supabase RPCs.

### Data Source

Use the Supabase MCP tool (`mcp__supabase__execute_sql`) to run RPCs:

```sql
-- List items with filters
SELECT pm_list_items(p_status := 'pending', p_priority := 'high');

-- Get item by legacy ID
SELECT pm_get_item_by_legacy_id('BACKLOG-460');

-- Get item detail
SELECT pm_get_item_detail('<uuid>');
```

### Status Values (Supabase underscore format)

| Status | Meaning | When to Use |
|--------|---------|-------------|
| `pending` | Not started | Default for new items |
| `in_progress` | Active development | Engineer has started |
| `implemented` | Code done, needs testing | Code merged but not QA verified |
| `testing` | In QA/verification | QA session in progress |
| `completed` | Fully done and verified | QA passed, sprint closed |
| `blocked` | Cannot proceed | Has unresolved dependency |
| `deferred` | Intentionally postponed | Not doing this sprint |
| `obsolete` | No longer relevant | Superseded by other work |

### When to Update (via Supabase RPCs)

| Event | Supabase RPC |
|-------|--------------|
| New backlog item created | `pm_create_item(p_title, p_type, p_priority)` |
| Item assigned to sprint | `pm_assign_to_sprint(p_item_id, p_sprint_id)` |
| Engineer starts work | `pm_update_item_status('<uuid>', 'in_progress')` |
| PR merged | `pm_update_item_status('<uuid>', 'implemented')` |
| QA passed | `pm_update_item_status('<uuid>', 'completed')` |
| Sprint closed | Verify all items have correct status via `pm_list_items` |

### Example Operations

**New item created:**
```sql
SELECT pm_create_item(
  p_title := 'New Feature',
  p_type := 'feature',
  p_priority := 'high'
);
```

**Item assigned to sprint:**
```sql
SELECT pm_assign_to_sprint(
  p_item_id := '<item-uuid>',
  p_sprint_id := '<sprint-uuid>'
);
```

**Status update (implementation complete):**
```sql
SELECT pm_update_item_status('<item-uuid>', 'implemented');
```

**Fully complete:**
```sql
SELECT pm_update_item_status('<item-uuid>', 'completed');
```

### Common Mistakes to Avoid

1. **Creating backlog items without using Supabase RPCs** - They won't be in the source of truth
2. **Using non-standard status values** - Database constraints enforce valid values
3. **Not assigning to sprint** - Can't track sprint velocity
4. **Marking as `completed` before QA** - Use `implemented` instead
5. **Updating only the CSV** - CSV is archived; Supabase is the source of truth

---

## Task Archiving (Historical)

> **Note:** Since the migration to Supabase, task plans live in `pm_backlog_items.body` and are never moved to an archive directory — sprint association (`sprint_id`) and `completed_at` timestamp already mark them as historical. The legacy procedure below is preserved for context only; do NOT create or move `.claude/plans/tasks/*.md` files for new work.

### (Legacy) When to Archive

Archive tasks when:
- A sprint is fully completed and merged
- All tasks in the sprint have status "Completed"
- The sprint retrospective (if any) is complete

### (Legacy) Archive Structure

```
.claude/plans/tasks/
  archive/
    SPRINT-001/
      TASK-101-*.md
      TASK-102-*.md
      ...
    SPRINT-002/
      ...
  TASK-600-*.md  (current sprint - active)
  TASK-601-*.md
  ...
```

### (Legacy) Archive Procedure

1. **Identify completed sprints** — query Supabase: `SELECT id, name, status FROM pm_sprints WHERE status = 'completed';`
2. (Legacy) **Create archive folder**
   ```bash
   mkdir -p .claude/plans/tasks/archive/SPRINT-XXX
   ```
3. (Legacy) **Move completed task files** (only if `.md` files exist on disk from before the Supabase migration)
4. **Update INDEX.md** — historical; new work updates `pm_sprints.body` instead

### Task Number Ranges by Sprint (Historical)

| Sprint | Task Range | Status |
|--------|------------|--------|
| SPRINT-001 | TASK-101 - TASK-116 | Archived |
| SPRINT-002 | TASK-201 - TASK-2XX | Archived |
| SPRINT-003 | TASK-301 - TASK-324 | Archived |
| SPRINT-004 | TASK-401 - TASK-414 | Archived |
| SPRINT-005 | TASK-501 - TASK-512 | Archived |
| SPRINT-006 | - | - |
| SPRINT-007 | - | - |
| SPRINT-008 | TASK-513 - TASK-521 | Archived |
| SPRINT-009 | TASK-600 - TASK-617 | Active |

---

## Backlog Cleanup

### Stale Item Detection

Items are considered stale if:
- No activity for 30+ days
- Blocked with no resolution path
- Superseded by other work

### Cleanup Actions

1. **Review stale items** - Determine if still relevant
2. **Update or close** - Refresh requirements or mark as won't-do
3. **Re-prioritize** - Move to appropriate sprint or backlog

---

## TODO Extraction

When reviewing code, extract inline TODOs to backlog:

```bash
# Find TODOs in codebase
grep -rn "TODO\|FIXME\|HACK" src/ electron/ --include="*.ts" --include="*.tsx"
```

For each significant TODO:
1. Create backlog item with reference to source location
2. Link to original TODO in code
3. Prioritize based on impact

---

## Integration with Sprint Lifecycle

| Sprint Phase | Maintenance Action |
|--------------|-------------------|
| Sprint Start | Clear old archive if >3 sprints old |
| Sprint End | Archive completed tasks |
| Retrospective | Update estimation accuracy data |

---

## Sprint Status Verification (MANDATORY)

**Problem:** Sprint status in Supabase can lag GitHub PR state if `pm_update_item_status` / `pm_update_task_status` were not called after a merge. This leads to incorrect status reports.

**Rule:** Before reporting sprint status, ALWAYS cross-check Supabase `pm_backlog_items.status` and `pm_tasks.status` against actual merged GitHub PRs. If Supabase is stale, update it via the RPCs (do NOT edit any `.md` file).

### Verification Procedure

```bash
# 1. Get task IDs from sprint file (e.g., TASK-700 to TASK-706)

# 2. Check actual PR status for those tasks
gh pr list --state all --limit 20 | grep -E "(700|701|702|703|704|705|706)"

# 3. If PRs are merged but pm_backlog_items.status shows "pending", run pm_update_item_status to fix
```

### When to Verify

| Situation | Action |
|-----------|--------|
| User asks "where are we with sprint X?" | Verify against PRs first |
| Sprint file shows "Planning" or "Active" | Check if PRs are merged |
| Generating retrospective | Confirm all status matches PRs |

### Why This Matters

SPRINT-010 was fully merged on 2025-12-29 but sprint file still showed "Planning" on 2026-01-01. This led to incorrect status reports because the file was trusted without verification.

**Trust, but verify.** The source of truth for code state is GitHub; the source of truth for sprint/task status is Supabase. Reconcile both.

---

## Sprint Completion Checklist (After Last PR Merges)

**MANDATORY**: Execute this checklist immediately after the final sprint PR merges.

**Why this exists:** Historically (pre-Supabase), sprint markdown files went stale when not updated after merges. Now the same risk applies to Supabase rows if RPCs are not called.

### 1. Verify All PRs Merged

```bash
# List all PRs for sprint tasks
gh pr list --state all | grep -E "(TASK-XXX|TASK-YYY|...)"
# All should show "MERGED"

# Or check by branch pattern
gh pr list --state merged --search "head:fix/task-" --limit 20
```

### 2. Update Sprint Record in Supabase

```sql
-- Mark sprint complete and populate retrospective
UPDATE pm_sprints
SET status = 'completed',
    body = '<final retrospective markdown>'
WHERE id = '<sprint-uuid>';
-- (or: SELECT pm_update_sprint_status('<sprint-uuid>', 'completed'); then UPDATE body separately)
```

The retrospective markdown lives in `pm_sprints.body` — do NOT create a `.claude/plans/sprints/*.md` file.

### 3. Mark Each Backlog Item / Task Complete

```sql
-- For each item in the sprint
SELECT pm_update_item_status('<backlog_item_uuid>', 'completed');
SELECT pm_update_task_status('<task_uuid>', 'completed');
SELECT pm_add_comment('<backlog_item_uuid>', 'Sprint <name> closed: completed');
```

### 4. Aggregate Metrics & Log Issues

- Run `pm_record_task_tokens(...)` for each task to capture actuals
- Pull issue entries from `pm_comments` (tagged `issue`) and roll them into the sprint body retrospective

### 5. Commit Code-Only Changes (No Plan-File Updates Needed)

```bash
git status
# Should show no changes under .claude/plans/sprints/ or .claude/plans/tasks/ for new work
git push   # Only if there are unrelated code changes to push
```

### Quick Reference

| Step | Where | Action |
|------|-------|--------|
| 1 | GitHub | Verify all sprint PRs merged |
| 2 | `pm_sprints` (Supabase) | Status → `completed`, `body` ← retrospective |
| 3 | `pm_backlog_items` + `pm_tasks` (Supabase) | Status → `completed` for each |
| 4 | `pm_token_metrics` + `pm_comments` (Supabase) | Roll up tokens, gather issues |
| 5 | git | Push any unrelated code changes (no plan-file edits) |

**Reference:** BACKLOG-124, BACKLOG-1722
