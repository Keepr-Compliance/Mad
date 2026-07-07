# Sprint Management Module

This module covers sprint lifecycle operations: creating sprints, monitoring execution, closing sprints, and moving tasks between sprints.

---

## Sprint RPCs (Supabase)

Sprint operations should use Supabase RPCs as the primary data source. Use the Supabase MCP tool (`mcp__supabase__execute_sql`) to run these:

```sql
-- Create sprint
SELECT pm_create_sprint(p_name := 'SPRINT-140', p_goal := 'Sprint goal');

-- List all sprints
SELECT pm_list_sprints();

-- Get sprint detail (items, status)
SELECT pm_get_sprint_detail('<sprint-uuid>');

-- Assign item to sprint (first arg is an ARRAY — uuid[])
SELECT pm_assign_to_sprint(p_item_ids := ARRAY['<item-uuid>']::uuid[], p_sprint_id := '<sprint-uuid>');

-- Update item status within sprint
SELECT pm_update_item_status('<item-uuid>', 'in_progress');
```

> **Note:** Sprint plans live in `pm_sprints.body` (markdown stored in the `body` column). Do NOT create or update `.claude/plans/sprints/SPRINT-XXX.md` files for new work — those are historical archive only.

---

## Token Monitoring (MANDATORY - HOTFIX BACKLOG-136)

**CRITICAL: This section is non-negotiable. Failure to follow this workflow results in meaningless estimates.**

### The Problem

Engineers self-report token usage (~8K) but actual consumption is 100x+ higher (~800K-1.1M).

**Why this matters:**
- Token caps cannot be enforced without visibility
- Estimates are meaningless without real consumption data
- Budget forecasting impossible

### Required Workflow: After EVERY Engineer Agent Completes

1. **Get the agent task_id** (shown when spawning with Task tool)
   ```
   Agent spawned with task_id: a82dc40
   ```

2. **Check actual tokens via TaskOutput**
   ```
   TaskOutput(task_id="a82dc40", block=false)
   ```
   Look for: `"X new tokens"` in the output or `"Y new tools used, Z new tokens"`

3. **Compare to estimate**
   ```
   Task estimate: 10K tokens
   Actual: 595084 tokens
   Ratio: 59x (INCIDENT)
   ```

4. **Flag if actual > 4x estimate**
   - Log actuals via `pm_add_comment` on the backlog item and/or `pm_record_task_tokens`
   - Note in the In-Scope table inside `pm_sprints.body`
   - Investigate root cause

5. **Log a comment on the backlog item** with the actuals
   ```sql
   SELECT pm_add_comment(
     p_item_id := '<backlog_item_uuid>',
     p_body := E'### Engineer Metrics (ACTUAL)\n\n| Phase | Self-Reported | Actual (Monitored) |\n|-------|---------------|-------------------|\n| Implementation | ~8K | ~800K |\n| **Ratio** | - | **100x** |'
   );
   ```
   Do NOT append to a `.claude/plans/tasks/TASK-XXX.md` file. The
   `pm_token_metrics` rows are auto-captured by the SubagentStop hook;
   the comment is just for narrative context.

### Token Monitoring Checklist

Before marking any engineer task complete:
- [ ] Retrieved agent task_id
- [ ] Checked TaskOutput for actual tokens
- [ ] Compared to estimate
- [ ] Flagged if >4x overrun
- [ ] Logged actuals as a `pm_comment` on the backlog item (or via `pm_record_task_tokens`)

### Why Engineers Can't Self-Report Accurately

Engineers see only:
- Text they generate (~1-5K tokens)
- File content they read (counts against context)

Engineers DON'T see:
- Tool call overhead (~100+ tokens per call)
- Context window accumulation
- Failed edit retries (each retry = full context)
- npm/bash verbose output (often 10-50K per command)
- File re-reads (same file read 3x = 3x tokens)

**Rule of thumb:** Actual consumption = 50-100x visible work.

---

## Estimate Integrity Rules (MANDATORY)

**CRITICAL: Estimates are historical data. Never modify them after sprint creation.**

These rules apply to estimates stored in `pm_backlog_items.est_tokens` and to the In-Scope table rendered inside `pm_sprints.body`.

### Why Estimates Must Stay Fixed

Estimates capture planning assumptions at sprint start. Changing them retroactively:
- Destroys ability to measure estimation accuracy
- Makes variance analysis meaningless
- Prevents learning from over/under-estimates

### Rules

1. **Never modify original estimates** in `pm_backlog_items.est_tokens` or in the In-Scope table inside `pm_sprints.body`
   - Total Estimated tokens stays fixed
   - SR Review Overhead stays fixed
   - Grand Total stays fixed

2. **Actual Tokens = Actuals Only**
   - `pm_backlog_items.actual_tokens` (and the Actual Tokens column in the sprint body) stay NULL/"-" until the task is complete AND tokens are recorded via `pm_record_task_tokens`
   - Never put estimates in this column

3. **Mid-Sprint Additions**
   - Insert a new row in the In-Scope table inside `pm_sprints.body` with a `*(added mid-sprint)*` note
   - Add a footnote in the body: `*Note: TASK-XXXX added mid-sprint (+~XK est.)*`
   - Do NOT modify original totals
   - Also create the backlog item in Supabase (`pm_create_item` + `pm_assign_to_sprint`)

### Example: Adding Task Mid-Sprint

Within the markdown stored in `pm_sprints.body`:

**WRONG:**
```markdown
**Total Estimated:** ~165K tokens  <!-- Changed from 150K -->
```

**RIGHT:**
```markdown
| TASK-1780 | New Feature | ~15K | HIGH | 3 | *(added mid-sprint)*

**Total Estimated (implementation):** ~150K tokens  <!-- Unchanged -->

*Note: TASK-1780 added mid-sprint (+~15K est.)*
```

### Progress Tracking (in `pm_sprints.body` In-Scope table)

| Column | Contains | When Filled |
|--------|----------|-------------|
| Status | mirror of `pm_backlog_items.status` | Real-time (re-render body when status changes) |
| Actual Tokens | rollup from `pm_token_metrics` | After task complete |
| Duration | Actual time if tracked | After task complete |
| PR | PR number(s) | When PR created |

**NEVER put estimates in the Actual Tokens column.**

---

## Creating a Sprint

### Prerequisites

1. Sprint plan reviewed by SR Engineer (sprint plan = markdown stored in `pm_sprints.body`)
2. All task plans authored in `pm_backlog_items.body` (one per backlog item assigned to the sprint)
3. Dependency graph validated
4. Token caps set (4x upper estimate)

### Sprint Creation Checklist

- [ ] Sprint created in Supabase: `SELECT pm_create_sprint(p_name := 'SPRINT-XXX', p_goal := 'Sprint goal');`
- [ ] **Integration branch created:** `git checkout -b int/<sprint-name> develop && git push -u origin int/<sprint-name>`
- [ ] Sprint plan populated in Supabase: `UPDATE pm_sprints SET body = '<sprint plan markdown>' WHERE id = '<sprint-uuid>';`
- [ ] All task plans populated in Supabase: `UPDATE pm_backlog_items SET body = '<task plan markdown>' WHERE id = '<item-uuid>';` (one per task)
- [ ] **All task plan bodies specify PR target:** `int/<sprint-name>` (NOT develop)
- [ ] Items assigned to sprint in Supabase: `SELECT pm_assign_to_sprint(p_item_ids := ARRAY['<uuid>']::uuid[], p_sprint_id := '<uuid>');`
- [ ] **All task items have `legacy_id` set:** `UPDATE pm_backlog_items SET legacy_id = 'TASK-' || item_number WHERE sprint_id = '<sprint-uuid>' AND legacy_id IS NULL;`
  - The admin portal's token breakdown UI joins `pm_token_metrics.task_id` against `pm_backlog_items.legacy_id`
  - Without this, effort metrics won't show on the task detail page
  - **Incident ref:** SPRINT-T — all 8 tasks had NULL legacy_id, metrics invisible in admin portal
- [ ] Worktrees ready for parallel tasks (BACKLOG-132)

**Do NOT create `.claude/plans/sprints/SPRINT-XXX.md` or `.claude/plans/tasks/TASK-XXX.md` files for new work** — those paths are historical archive only.

**Incident Reference:** SPRINT-P Phase 1 — targeting develop directly with 4 PRs caused 5+ hours of sequential CI waits due to `strict: true` cascade. Integration branches are now mandatory for all sprints.

---

## Executing a Sprint

### Starting Tasks

1. Check dependency graph - only start tasks with no pending dependencies
2. For parallel tasks, create isolated worktrees
3. Spawn engineer agents with proper context
4. **Record agent task_id for token monitoring**

### Monitoring Progress

Every time you check on running agents:
1. TaskOutput with `block=false` to check status
2. If complete, check actual tokens
3. Log actuals via `pm_record_task_tokens` and/or a `pm_comment` on the backlog item
4. Flag overruns immediately

### Handling Overruns

If actual tokens > 4x estimate:

1. **Do NOT let the engineer continue unsupervised**
2. Check what's consuming tokens:
   - Edit retries? → Agent is struggling with edits
   - npm commands? → Unnecessary verbose output
   - File re-reads? → Context management issue
3. Document via `pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := 'Token overrun: <details>')` on the affected backlog item
4. Adjust future estimates for similar tasks

---

## Closing a Sprint

### Sprint Closure Checklist

> **Incident Reference:** SPRINT-051/052 had 20+ orphaned PRs that were created but never merged, causing massive confusion.

**Full lifecycle reference:** `.claude/docs/shared/pr-lifecycle.md`

#### PR Verification (MANDATORY - Do First)

Before ANY other closure activity:

```bash
# Check for orphaned PRs
gh pr list --state open --search "TASK-"
gh pr list --state open --search "SPRINT-"
```

**A sprint CANNOT be closed if:**
- Any sprint-related PR is still open
- Any task has a PR in `OPEN` state (not `MERGED`)
- Any approved PR is waiting for merge

**For each open PR found:**
| PR State | Action |
|----------|--------|
| CI failing | Fix before closing sprint |
| Awaiting review | Complete review and merge |
| Approved but not merged | Merge immediately |
| Has conflicts | Resolve and merge |

**Verify all PRs are merged:**
```bash
# For each task's PR, verify state is MERGED
gh pr view <PR-NUMBER> --json state --jq '.state'
# Must show: MERGED (not OPEN, not CLOSED)
```

#### Metrics Collection (Before Closure)

For each task in the sprint:

1. **Label agent metrics** — Collect agent_ids from all handoff messages:
   ```bash
   python .claude/skills/log-metrics/log_metrics.py \
     --label --agent-id <ID> -t engineer -i TASK-XXXX -d "implementation"
   python .claude/skills/log-metrics/log_metrics.py \
     --label --agent-id <ID> -t sr-engineer -i TASK-XXXX -d "PR review"
   ```

2. **Aggregate per-task totals:**
   ```bash
   python .claude/skills/log-metrics/sum_effort.py --task TASK-XXXX --pretty
   ```

3. **Record actuals in Supabase:**
   - `SELECT pm_record_task_tokens('<task_uuid>');` — rolls up `pm_token_metrics` into `pm_backlog_items.actual_tokens`
   - Optionally `pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := '## Actual Effort\n...')` for narrative context
   - Update the In-Scope table inside `pm_sprints.body` with the Actual Tokens column

4. **Build estimation accuracy table** (rendered inside `pm_sprints.body`):
   | Task | Est Tokens | Actual Tokens | Variance |
   |------|-----------|---------------|----------|
   | TASK-XXXX | ~30K | ~45K | +50% |

#### Sprint Rollup PR Creation

The sprint rollup PR (sprint/* → develop) **must include `## Engineer Metrics`** to pass `pr-metrics-check.yml`.

**Template for PR body:**
```markdown
## Engineer Metrics: SPRINT-XXX

### Agent ID
Sprint aggregate across N engineer + N SR agents

### Metrics (Auto-Captured)
| Metric | Value |
|--------|-------|
| **Total Tokens** | ~XXXK |
| Duration | X minutes |
| API Calls | N PRs |

**Variance:** Est ~XK vs Actual ~XK (X% over/under)
```

#### Retrospective Generation

Populate the `## Sprint Retrospective` section inside `pm_sprints.body` (UPDATE pm_sprints SET body = ... WHERE id = ...) with:

1. **Estimation accuracy table** — est vs actual per task, with variance %
2. **Issues summary** — aggregated from `pm_comments` (filter `tag = 'issue'` or similar) across the sprint's items, and from task handoff messages
3. **What went well / didn't / lessons learned** — derived from the sprint

#### Sprint Body Required Sections (in `pm_sprints.body`)

The In-Scope table must include an `Actual Tokens` column:
```
| ID | Title | Task | Phase | Est Tokens | Actual Tokens | Status |
```

The body must have a `## Sprint Retrospective` section (populated at close):
```markdown
## Sprint Retrospective

### Estimation Accuracy
| Task | Est Tokens | Actual Tokens | Variance | Notes |
|------|-----------|---------------|----------|-------|

### Issues Encountered
| # | Task | Issue | Severity | Resolution | Time Impact |
|---|------|-------|----------|------------|-------------|

### What Went Well
- [bullet points]

### What Didn't Go Well
- [bullet points]

### Lessons for Future Sprints
- [bullet points]
```

#### Full Closure Checklist

- [ ] **PR Audit complete** - `gh pr list --state open` shows no sprint PRs
- [ ] **All PRs verified MERGED** - Not just approved, actually merged
- [ ] **All item statuses updated in Supabase** - `pm_update_item_status('<uuid>', 'completed')` for each item
- [ ] **All task statuses updated in Supabase** - `pm_update_task_status('<task_uuid>', 'completed')` for each sprint task
- [ ] **All agent metrics labeled** - Every agent_id from handoffs labeled via `pm_label_agent_metrics` (CSV at `.claude/metrics/tokens.csv` is append-only backup only)
- [ ] **Per-task actuals recorded** - `pm_record_task_tokens('<task_uuid>')` run for each task
- [ ] **Sprint retrospective populated in `pm_sprints.body`** - Estimation accuracy, issues (from `pm_comments`), lessons
- [ ] **Sprint status set** - `pm_update_sprint_status('<sprint_uuid>', 'completed')`
- [ ] Worktrees cleaned up
- [ ] **Sprint rollup PR created** with `## Engineer Metrics` section

### Retrospective Data Points

Capture for each task:
- Estimated tokens vs Actual tokens (monitored, not self-reported)
- Root cause of variance (if >50%)
- Lessons for future estimates

---

## Tracking Unplanned Work (MANDATORY)

**CRITICAL: Unplanned work must be documented AS IT HAPPENS, not reconstructed during sprint reviews.**

### Why Track Unplanned Work?

1. **Estimation Accuracy**: Unplanned work reveals gaps in initial scoping
2. **Future Prediction**: Patterns in unplanned work improve future estimates
3. **Sprint Velocity**: True velocity = planned + unplanned work
4. **Root Cause Analysis**: Tracking sources of unplanned work enables process improvements

### What Counts as Unplanned Work?

| Category | Example | Track As |
|----------|---------|----------|
| **Discovered Bug** | State machine wasn't wired into main.tsx | New TASK with `(unplanned)` tag |
| **Integration Gap** | Login button not connected to state machine | New TASK with `(unplanned)` tag |
| **Validation Discovery** | Returning users see onboarding again | New TASK with `(unplanned)` tag |
| **Review Finding** | SR Engineer finds type assertion issue | New TASK referencing review |
| **Scope Expansion** | Feature needs additional edge case handling | UPDATE existing `pm_backlog_items.body`, add a note to the In-Scope table in `pm_sprints.body` |
| **Dependency Discovery** | Task X requires Task Y to be done first | Add TASK Y as `(unplanned)` |

### Required Workflow: When Unplanned Work Arises

1. **Create the backlog item in Supabase immediately**
   ```sql
   SELECT pm_create_item(
     p_title := '<title> (unplanned)',
     p_type := 'bug', -- or feature, etc.
     p_priority := 'high'
   );
   -- Then UPDATE pm_backlog_items SET body = '<task plan markdown>' WHERE id = '<new-uuid>';
   ```
   The body should include the standard task-plan sections plus:
   ```markdown
   ## Source
   - **Discovered During:** TASK-YYY / Platform Validation / SR Engineer Review
   - **Root Cause:** <Why this wasn't in the original plan>
   - **Discovery Date:** YYYY-MM-DD
   ```

2. **Assign to the sprint and update the Unplanned Work Log inside `pm_sprints.body`**
   ```sql
   SELECT pm_assign_to_sprint(p_item_ids := ARRAY['<new-item-uuid>']::uuid[], p_sprint_id := '<sprint-uuid>');
   ```
   Then re-render the `## Unplanned Work Log` table inside the sprint body
   (UPDATE pm_sprints SET body = ... WHERE id = ...) to include the new row:
   ```markdown
   ## Unplanned Work Log

   | Task | Source | Root Cause | Added Date |
   |------|--------|------------|------------|
   | TASK-XXX | TASK-YYY validation | Integration not wired | 2026-01-04 |
   ```

3. **Log a comment on the related item** explaining the discovery:
   ```sql
   SELECT pm_add_comment(p_item_id := '<related-item-uuid>', p_body := 'Unplanned work created: TASK-XXX (<reason>)');
   ```

4. **Track Metrics Separately**
   Unplanned tasks should be tracked separately for estimation analysis (via `pm_token_metrics` filtered by `unplanned` flag in comments or sprint body table):
   - Planned tasks: used for estimation accuracy
   - Unplanned tasks: used for "discovery buffer" calculation

### Sprint Body Unplanned Work Section (in `pm_sprints.body`)

Every sprint body MUST include this section (add during sprint if missing):

```markdown
## Unplanned Work Log

| Task | Source | Root Cause | Added Date | Impact |
|------|--------|------------|------------|--------|
| - | - | - | - | - |

### Unplanned Work Summary

| Metric | Value |
|--------|-------|
| Unplanned tasks | 0 |
| Unplanned PRs | 0 |
| Unplanned lines changed | 0 |
| Root causes | - |
```

### Discovery Buffer Calculation

After each sprint, calculate the discovery buffer:

```
Discovery Buffer = Unplanned Work / Planned Work

Example:
- Planned: 6 tasks, ~150K tokens
- Unplanned: 4 tasks, ~50K tokens
- Discovery Buffer: 4/6 = 67% or 50K/150K = 33%

Future Sprint Adjustment:
- If discovery buffer > 30%, reduce planned scope by 20%
- If discovery buffer > 50%, reduce planned scope by 30%
```

---

## Investigation-First Pattern (for Bug Fix Sprints)

**Source:** SPRINT-061 - Saved ~17K tokens by avoiding unnecessary TASK-1406 implementation.

### When to Use

Use investigation-first for sprints where:
- Root cause is unclear
- Multiple possible causes exist
- "Bugs" may already be fixed or not exist

### Structure

```
Phase 1: Investigation (Parallel)
  - TASK-X00: Investigate issue A
  - TASK-X01: Investigate issue B
  - TASK-X02: Investigate issue C

Phase 2: Implementation (Based on Findings)
  - TASK-X03: Fix for A (if investigation confirms bug)
  - TASK-X04: Fix for B (if investigation confirms bug)
  - etc.
```

### Key Rules

1. **Investigation tasks are read-only** - No file modifications, safe to parallelize
2. **Define implementation tasks tentatively** - Mark as "pending investigation"
3. **Defer if no bug found** - Don't implement fixes for non-existent bugs
4. **Update backlog immediately** - Change status to `deferred` with reason

### Investigation Tooling (MCP)

Investigation agents have MCP access — use it instead of guessing at a cause you can look up:

- **Sentry** — production error/crash triage: `mcp__sentry__search_issues`, `mcp__sentry__get_issue_details`, `mcp__sentry__search_events` (org `keeprcompliancecom`). Pull the real stack trace/events before proposing a fix.
- **Supabase** — inspect real data/schema: `mcp__supabase__execute_sql`; check `mcp__supabase__get_advisors` for security/perf lints.
- **Vercel** — broker-portal deploy/runtime issues: `mcp__vercel__get_deployment_build_logs`, `mcp__vercel__get_runtime_logs`.

### PM Checkpoint After Investigation Phase

Before starting implementation phase:
1. Review all investigation findings (read `pm_comments` posted by investigation engineers)
2. For each planned implementation task, decide:
   - **PROCEED**: Bug confirmed, fix needed
   - **MODIFY**: Different fix needed — UPDATE `pm_backlog_items.body` for the task with the revised plan
   - **SKIP**: No bug found — `pm_update_item_status('<uuid>', 'deferred')` and `pm_add_comment(p_item_id := '<uuid>', p_body := 'Deferred: investigation showed no bug')`
3. Update the sprint body (`pm_sprints.body`) with the decisions
4. Notify user of any scope changes

---

## Moving Tasks Between Sprints

### When to Move a Task

- Sprint scope too large
- Unexpected blockers
- Priority shift
- Dependency issues

### How to Move

1. Update sprint assignment in Supabase: `SELECT pm_assign_to_sprint(p_item_ids := ARRAY['<uuid>']::uuid[], p_sprint_id := '<new-sprint-uuid>');`
2. Update the In-Scope tables inside both sprint bodies (`pm_sprints.body`) — remove the row from the old sprint, add it to the new one
3. Log the move and reason: `SELECT pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := 'Moved from SPRINT-X to SPRINT-Y: <reason>');`
