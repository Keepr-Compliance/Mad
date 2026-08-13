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
| Item assigned to sprint | `pm_assign_to_sprint(p_item_ids uuid[], p_sprint_id uuid)` |
| Engineer starts work | `pm_update_item_status('<uuid>', 'in_progress')` |
| PR merged | `pm_update_item_status('<uuid>', 'implemented')` |
| QA passed | `pm_update_item_status('<uuid>', 'completed')` |
| Sprint closed | Verify all items have correct status via `pm_list_items` |

> **When the new item came out of work on another item, link it in the same step.** Insert a
> `pm_task_links` row with `link_type = 'introduced_by'` (source = the new item, target = the
> originator). Prose in the body is not a link. Full rules, SQL and worked examples:
> `.claude/skills/backlog-management/SKILL.md` → "Linking a New Item (MANDATORY)".

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
  p_item_ids := ARRAY['<item-uuid>']::uuid[],
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

### Epic Size — 30 children is a REVIEW TRIGGER, not a hard cap

**An epic nobody can hold has stopped organizing anything.** But some epics are legitimately flat, so this is a prompt to look, not an automatic split.

| Children | Action |
|----------|--------|
| ≤ 30 | Fine |
| > 30 | **Stop and ask: is this a build, or a list?** Split if it is a build. Record the exemption if it is a list. |

**Split by the thing being built, not by priority.** Priority changes weekly and re-sorts nothing; a phase boundary (schema → crosswalk → matching → UI → tests) survives, and each half can be summarized in a sentence.

**Legitimately flat epics — do NOT split these:**

- **Inventories.** BACKLOG-2021 (SOC 2 Trust Services Criteria) has 55 children because there are 55 controls. The list *is* the deliverable; splitting it by "phase" would invent a structure the framework does not have.
- **Time-boxes.** BACKLOG-2183 (`v2.25.0 post-release testing bugs`) has 31 unrelated bugs whose only shared property is when they were found. There is no axis to split on.

**The distinguishing question: does the epic describe ONE thing being built, or N things being tracked?** A build over 30 is a planning failure. A list over 30 is just a list — record why it is exempt on the epic, so the next reviewer does not re-open it.

Seven epics exceed 30 today; two of them are the exemptions above.

**Why this is not cosmetic.** Epic 2468 reached **121 children**. The cost is that *"what is built?"* stops having an answer that fits on a screen — and on 13 Aug 2026 it was answered **wrongly**, from status fields nobody could audit, because no agent or human could hold the set. It also hides the real signal: 54 pending items in one bucket look like a backlog, while the same 54 grouped into phases show plainly that one phase has not started.

**When an epic passes 30 because the work changed shape** — an investigation found a missing model rather than a broken function — see `sprint-management.md` → *"When the investigation finds a MISSING MODEL, re-cut the plan that day."* Splitting is not enough there; the shape is wrong, not just the size.

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

### A QA gate is not finished until it writes back (MANDATORY)

The procedure above reconciles status against **merged PRs**. It does not cover the other thing that changes an item's truth: **the founder testing it and saying it works.**

**Rule: a QA gate is not complete until every item it covered has its status set to what the gate found.** Not a summary comment on the epic — the item itself. Write it at the time the result is taken, not afterwards.

**Record the non-passes too.** "Verified", "still broken" and **"not verifiable"** are three different outcomes and all three are real. Gate 4's check 19 could not be verified at all: the linker has no instrumentation, so its convergence claim cannot be confirmed in the field at any scale. Marking that as a pass would have been a vacuous green; marking it as a failure would have been false.

**Why this is MANDATORY.** Gate 4 ran 41 checks on the founder's machine and confirmed 37 fixes holding. The result was written as **one comment on epic 2468 and not one child status changed.** Weeks later the board reported **29 items as unverified when he had personally verified 21 of them** — and he caught it, not the process. A stale `testing` is indistinguishable from a real one, so the under-report is invisible; and because *some* items had been advanced and others had not, the column looked maintained.

**Check for the shape:** if an item carries a `FOUNDER TEST — PASS` comment above an unchanged status field, the write-back was skipped.

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
SELECT pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := 'Sprint <name> closed: completed');
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
