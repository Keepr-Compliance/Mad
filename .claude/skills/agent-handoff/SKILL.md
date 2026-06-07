---
name: agent-handoff
description: Defines the 15-step sprint task workflow and handoff protocol between PM, Engineer, and SR Engineer agents.
---

# Agent Handoff Workflow

This skill defines how agents hand off work during sprint task execution. Read this before starting any sprint task work.

---

> **Source of Truth (read this first):** All sprint plans, task plans, progress logs, status transitions, decisions, and issue entries live in Supabase: `pm_sprints.body`, `pm_backlog_items.body`, `pm_comments`, `pm_token_metrics`. Do NOT create `.claude/plans/sprints/*.md` or `.claude/plans/tasks/*.md` files for new work. The `.claude/.current-task` file is the only on-disk PM artifact (it's an IPC contract the metrics hook reads). Existing `.md` files under `.claude/plans/` are historical/archive only. When this document references "the task file" or "the sprint file," read/write the corresponding Supabase `body` column instead.

---

## Quick Reference: Who Am I? What's Next?

### PM Agent Steps
| Step | Action | Status Update | Hand Off To |
|------|--------|---------------|-------------|
| 0 | Write `.current-task` with sprint context | — | - (before any agent work) |
| 1 | Verify task file exists with context | — | - (abort if missing) |
| 2-4 | Setup (worktree, branch, status) | Task + Item → `in_progress` | - |
| 5 | Task ready for planning | — | Engineer (read-only exploration) |
| 8 | Plan reviewed | Sprint notes: "Plan approved" | Engineer (implement) or User (if rejected) |
| 11 | Implementation reviewed | Task + Item → `testing` | SR Engineer (create PR) |
| 14 | After PR merged | Task + Item → `completed` | Record effort metrics |
| 15 | All tasks complete | Sprint → `Completed` | Close sprint |

**Status updates at every transition (Supabase only):**
1. Supabase RPC: `pm_update_task_status('<task_uuid>', '<status>')` — task-level status
2. Supabase RPC: `pm_update_item_status('<backlog_item_uuid>', '<status>')` — backlog item status
3. (Optional) Supabase RPC: `pm_add_comment('<backlog_item_uuid>', '<message>')` — log the rationale for the transition

**IMPORTANT:** Both status RPCs are required. `pm_update_task_status` updates the sprint task; `pm_update_item_status` updates the parent backlog item. Skipping either leaves the dashboard out of sync. Do NOT update `.claude/plans/sprints/*.md` or `.claude/plans/backlog/items/*.md` for new work — those files are historical archive only, and the CSV under `.claude/plans/backlog/data/` is read-only.

**Valid statuses (Supabase):** `pending`, `in_progress`, `testing`, `completed`, `deferred`

### Engineer Agent Steps
| Step | Action | Hand Off To |
|------|--------|-------------|
| 6 | Explore codebase (read-only), write plan | SR Engineer (plan review) |
| 9 | Implement, commit, push | SR Engineer (impl review) |
| 12 (CI fail) | Fix CI issues | SR Engineer (re-review) |

### SR Engineer Agent Steps
| Step | Action | Hand Off To |
|------|--------|-------------|
| 7 | Review plan | Engineer (changes) or PM (approved/rejected) |
| 10 | Review implementation | Engineer (changes) or PM (approved/rejected) |
| 12 | Create PR, review, wait CI (DO NOT MERGE) | User (testing gate) |
| 12a | **User tests and approves** | SR Engineer (merge) |
| 12b | Merge PR (only after user approval) | Step 13 |
| 13 | Delete worktree | PM (record metrics) |

---

## Full Workflow (15 Steps)

```
Sprint Task Lifecycle
=====================

PHASE A: SETUP (PM)
-------------------
0.  PM: Write .current-task with sprint context (BEFORE any agent work)
    - This is the FIRST thing PM does — before planning, before spawning any agent
    - **CRITICAL: sprint_id MUST be the sprint UUID (not the name)**
      The track-agent-tokens hook writes sprint_id directly to pm_token_metrics.
      Using the name (e.g., "SPRINT-T") instead of the UUID breaks sprint-level metrics queries.
    - echo '{"agent_type": "pm", "sprint_id": "<sprint-uuid>", "description": "Sprint setup"}' > .claude/.current-task
    - Update .current-task BEFORE EVERY agent invocation with the correct agent_type:
      * Before Engineer: {"task_id": "TASK-XXXX", "agent_type": "engineer", "sprint_id": "<sprint-uuid>"}
      * Before SR Engineer: {"task_id": "TASK-XXXX", "agent_type": "sr-engineer", "sprint_id": "<sprint-uuid>"}
      * Before QA: {"agent_type": "qa", "sprint_id": "<sprint-uuid>", "description": "Sprint QA"}
      * Sprint-level work (no task): omit task_id, include sprint_id + description
    - This ensures every subagent's token usage is captured with correct attribution

1a. PM: Create integration branch (if not already created for this sprint)
    - git checkout develop && git pull origin develop
    - git checkout -b int/<sprint-name>
    - git push -u origin int/<sprint-name>
    - All engineer PRs will target this branch, NOT develop
    - Incident ref: SPRINT-P Phase 1 (5+ hours lost to strict:true cascade)

1.  PM: Verify task plan exists with proper context
    - Look up the backlog item via `pm_get_item_by_legacy_id('TASK-XXXX')`
      (or `pm_get_task_by_legacy_id` for sprint task rows)
    - Read `pm_backlog_items.body` for that item — confirm it has
      requirements, acceptance criteria, dependencies
    - If missing or incomplete: STOP, notify user (do NOT fall back to
      reading a `.claude/plans/tasks/*.md` file — those are historical only)

2.  PM: Create worktree (if parallel tasks in phase)
    - git worktree add ../Mad-TASK-XXXX -b feature/TASK-XXXX int/<sprint-name>

3.  PM: Create branch for task
    - If worktree: already created in step 2
    - If sequential: git checkout -b feature/TASK-XXXX int/<sprint-name>

4.  PM: Update task status to "In Progress"
    - Update Supabase (BOTH RPCs required):
      `SELECT pm_update_task_status('<task_uuid>', 'in_progress');`
      `SELECT pm_update_item_status('<backlog_item_uuid>', 'in_progress');`
    - (Optional) Log the transition:
      `SELECT pm_add_comment('<backlog_item_uuid>', 'Status → in_progress: handing off to engineer');`
    - Valid statuses: pending, in_progress, testing, completed, deferred

5.  PM → ENGINEER: Handoff task for planning (read-only exploration)
    - Write `.claude/.current-task` with task context for metrics hook:
      `echo '{"task_id": "TASK-XXXX", "agent_type": "engineer", "sprint_id": "<sprint-uuid>"}' > .claude/.current-task`
    - Use handoff message template
    - Specify: Task ID (legacy_id), backlog item UUID, branch name.
      Engineer reads the plan from `pm_backlog_items.body` — do NOT
      reference a `.claude/plans/tasks/*.md` path for new work.
    - Instruct engineer: "Plan only — explore codebase, write plan, do NOT edit production files"

PHASE B: PLANNING
-----------------
6.  ENGINEER: Explore codebase and create implementation plan
    - Read the task plan from `pm_backlog_items.body` (or `pm_get_item_detail`)
      thoroughly
    - Use Glob, Grep, Read tools to explore relevant code (read-only)
    - Write the implementation plan back to Supabase via either:
        * `pm_add_comment('<backlog_item_uuid>', '<plan markdown>')` for an
          incremental plan log, OR
        * Update `pm_backlog_items.body` directly (UPDATE pm_backlog_items
          SET body = ... WHERE id = ...) for an umbrella refactor plan
    - Do NOT create a `.claude/plans/tasks/*.md` plan file on disk —
      Supabase is the source of truth
    - Do NOT edit production files — planning phase is read-only
    - Return plan → SR ENGINEER for review
    NOTE: Do NOT use EnterPlanMode — it requires interactive user approval
    and does not work inside subagent context. Instead, exercise discipline:
    read and plan only, save implementation for Step 9.

7.  SR ENGINEER: Review plan
    ├─ Request changes → Step 6 (back to Engineer)
    │   - Specify what needs to change
    │   - Use handoff message template
    ├─ Approve → Record approval in Supabase → Step 8
    │   - `pm_add_comment('<backlog_item_uuid>', '## Plan Approval\n<rationale>')`
    │   - Handoff to PM
    └─ Reject → Step 8 (with rejected status)
        - Document rejection reason via `pm_add_comment`
        - Handoff to PM

8.  PM: Update Supabase status + log decision
    ├─ If approved → ENGINEER: Start implementation (Step 9)
    │   - Status stays `in_progress` (plan approved, implementation starting)
    │   - Log decision: `pm_add_comment('<backlog_item_uuid>', 'Plan approved, implementing')`
    │   - Handoff with approval context
    └─ If rejected → Notify user, END
        - Update Supabase (BOTH RPCs required):
          `SELECT pm_update_task_status('<task_uuid>', 'deferred');`
          `SELECT pm_update_item_status('<backlog_item_uuid>', 'deferred');`
        - Document reason: `pm_add_comment('<backlog_item_uuid>', 'Deferred: <reason>')`

PHASE C: IMPLEMENTATION
-----------------------
9.  ENGINEER: Implement task, commit changes, push branch
    - Follow the approved plan
    - Make atomic commits
    - Run full test suite BEFORE pushing: `npx jest --bail --no-coverage`
      If any tests fail, fix them before creating the PR.
      Search for ALL test files referencing changed functions:
      `grep -r "functionName" --include="*.test.*" src/ electron/`
      and update stale expectations to match new behavior.
    - Push branch to remote
    - When creating PR, include `## Engineer Metrics` section in body
      (use template from `.github/PULL_REQUEST_TEMPLATE.md`)
    - Engineer MUST include `### Effort` section in handoff message
      with agent_id and token count. The agent_id is returned by
      the Task tool when the agent completes.
    - → SR ENGINEER: Handoff for implementation review

10. SR ENGINEER: Review implementation
    ├─ Request changes → Step 9 (back to Engineer)
    │   - List specific changes needed
    │   - Use handoff message template
    ├─ Approve → Step 11
    │   - Confirm implementation matches plan
    │   - SR Engineer MUST include own `### Effort` section in handoff
    │   - Handoff to PM
    └─ Reject → Step 11 (notify PM with rejected status)
        - Document rejection reason

11. PM: Update status
    - Update Supabase (BOTH RPCs required):
      `SELECT pm_update_task_status('<task_uuid>', 'testing');`
      `SELECT pm_update_item_status('<backlog_item_uuid>', 'testing');`
    - (Optional) Log: `pm_add_comment('<backlog_item_uuid>', 'Implementation approved → testing')`
    - → SR ENGINEER: Create PR (Step 12)

PHASE D: PR, TEST & MERGE
--------------------------
12. SR ENGINEER: Create PR + Review (DO NOT MERGE)
    - PR targets int/<sprint-name> branch (NOT develop)
    - gh pr create --base int/<sprint-name>  # All sprint PRs target the int branch
    - Review code quality, security, architecture
    - Wait for CI
    ├─ CI passes → Step 12a
    ├─ CI fails → ENGINEER: Fix issues → Step 9
        - Identify failing tests/checks
        - Handoff to Engineer with details

    *** MANDATORY: NEVER merge without explicit user approval ***

12a. USER TESTING GATE (MANDATORY)
    - Notify user: PR is ready for testing
    - Provide: PR URL, branch name, what to test
    - User tests on the branch (git checkout <branch> && npm run dev)
    - WAIT for user confirmation before proceeding
    ├─ User approves → Step 12b
    ├─ User finds issues → ENGINEER: Fix issues → Step 9
    └─ User requests changes → ENGINEER: Make changes → Step 9

12b. SR ENGINEER: Merge PR (only after user approval)
    - gh pr merge <PR> --merge
    - **CRITICAL:** If merge is blocked by branch protection, merge the target branch
      into the PR branch and wait for CI. Do NOT use `--admin`. Only the user can
      authorize `--admin`, and only with explicit words like "use --admin".
    - Verify merge succeeded
    - SR Engineer MUST include own `### Effort` section in handoff to PM
    - If fix agents were spawned for CI failures, include those agent_ids too
    - → Step 13

13. SR ENGINEER: Delete worktree
    - git worktree remove ../Mad-TASK-XXXX
    - Clear `.claude/.current-task`: `echo '{}' > .claude/.current-task`
    - → PM: Task merged notification

14. PM: Record effort metrics + mark Completed
    - Update Supabase (BOTH RPCs required):
      `SELECT pm_update_task_status('<task_uuid>', 'completed');`
      `SELECT pm_update_item_status('<backlog_item_uuid>', 'completed');`
    - Reconcile metrics (verify all agents logged to Supabase):
      ```sql
      SELECT agent_id, agent_type, total_tokens, task_id
      FROM pm_token_metrics WHERE task_id = 'TASK-XXXX' ORDER BY recorded_at;
      ```
    - If any agents are unlabeled, label them:
      `SELECT pm_label_agent_metrics('<agent_id>', 'TASK-XXXX', 'engineer', 'Implementation');`
    - Record task totals (auto-sums from metric rows):
      `SELECT pm_record_task_tokens('<task_uuid>');`
    - Collect issues from handoff messages and log them as
      `pm_comments` (tag with `issue` keyword) on the relevant backlog item

15. PM: When ALL sprint tasks complete → Close sprint
    - Verify all tasks are complete
    - Aggregate all task metrics from Supabase:
      ```sql
      SELECT task_id, SUM(total_tokens) AS total, SUM(billable_tokens) AS billable
      FROM pm_token_metrics WHERE sprint_id = '<sprint-uuid>'
      GROUP BY task_id ORDER BY task_id;
      ```
    - Populate `pm_sprints.body` with the sprint retrospective
      (UPDATE pm_sprints SET body = '<markdown>' WHERE id = '<sprint-uuid>'):
      - Estimation accuracy table (est vs actual per task)
      - Issues summary (aggregated from `pm_comments` across the sprint's items)
      - What went well / didn't / lessons learned
    - Create sprint rollup PR (sprint/* → develop) with
      `## Engineer Metrics` section populated from aggregated data
      (this passes the CI pr-metrics-check)
    - Include Agent ID, Total Tokens, Duration, Variance in PR body
    - Update sprint status: `pm_update_sprint_status('<sprint-uuid>', 'completed')`
    - Create final integration PR: int/<sprint-name> → develop
    - Wait for CI on the int→develop PR
    - Merge the integration branch to develop (one merge, one CI run)
    - This avoids the strict:true cascade that occurs when merging N PRs to develop directly
```

---

## Handoff Message Template

Every handoff MUST use this format:

```markdown
## Handoff: [FROM_AGENT] → [TO_AGENT]

**Task:** TASK-XXXX
**Current Step:** X
**Status:** [approved/rejected/changes-requested/complete]
**Next Action:** [what the receiving agent should do]
**Context:** [any relevant info - branch, PR, blockers]
**Issues/Blockers:** [problems encountered, workarounds used, or "None"]
```

See `templates/handoff-message.template.md` for the full template.

---

## Decision Trees

### At Step 7 (Plan Review)
```
Is the plan complete and correct?
├─ Yes, fully approved
│   → Write approval to plan file
│   → Handoff to PM (Step 8, approved)
├─ Mostly good, minor changes needed
│   → List specific changes
│   → Handoff to Engineer (Step 6)
└─ Fundamentally flawed or out of scope
    → Document rejection reason
    → Handoff to PM (Step 8, rejected)
```

### At Step 10 (Implementation Review)
```
Does implementation match the approved plan?
├─ Yes, all requirements met
│   → Handoff to PM (Step 11, approved)
├─ Partially complete, changes needed
│   → List specific changes
│   → Handoff to Engineer (Step 9)
└─ Does not meet requirements
    → Document rejection reason
    → Handoff to PM (Step 11, rejected)
```

### At Step 12 (PR + CI)
```
Did CI pass?
├─ Yes, all checks green
│   → Notify user: PR ready for testing
│   → DO NOT MERGE — wait for user approval (Step 12a)
└─ No, checks failed
    → Identify failing checks
    → Handoff to Engineer (Step 9)
    → Include failure details
```

### At Step 12a (User Testing Gate)
```
*** MANDATORY — NEVER skip this step ***

Has the user explicitly approved the merge?
├─ Yes, user says "merge it" / "looks good" / "approved"
│   → SR Engineer merges PR (Step 12b)
│   → Proceed to Step 13
├─ User found issues
│   → Handoff to Engineer (Step 9)
│   → Include user's feedback
└─ User hasn't responded yet
    → WAIT — do not proceed
    → Never auto-merge on timeout
```

---

## Issue Documentation

**MANDATORY:** Before every handoff, document any issues encountered.

Reference: `.claude/skills/issue-log/SKILL.md`

If nothing went wrong, explicitly state in handoff:
```
**Issues/Blockers:** None
```

---

## Supabase RPC Quick Reference

All status updates should use Supabase RPCs via the `mcp__supabase__execute_sql` tool.
**BOTH RPCs are required at every status transition:**

```sql
-- Update BOTH task and item status (Steps 4, 8, 11, 14)
SELECT pm_update_task_status('<task_uuid>', 'in_progress');
SELECT pm_update_item_status('<backlog_item_uuid>', 'in_progress');

-- Look up task by legacy ID to get both UUIDs
SELECT pm_get_task_by_legacy_id('TASK-XXXX');
-- Returns: task UUID + backlog_item_id (use both for subsequent calls)

-- Look up item by legacy ID to get UUID
SELECT pm_get_item_by_legacy_id('BACKLOG-746');

-- Query metrics (alternative to CSV, Step 14)
SELECT * FROM pm_token_metrics WHERE task_id = 'TASK-1234';
```

---

## Mandatory Supabase Updates

At each step below, the responsible agent MUST run these SQL commands via `mcp__supabase__execute_sql`.

### Step 1: Resolve Task UUID
```sql
SELECT pm_get_task_by_legacy_id('TASK-XXXX');
-- Returns: {"id": "<uuid>", "status": "pending", "backlog_item_id": "<uuid>", "sprint_id": "<uuid>"}
-- Save the task UUID and backlog_item_id for all subsequent calls
```

### Step 4: PM marks task In Progress
```sql
SELECT pm_update_task_status('<task_uuid>', 'in_progress');
SELECT pm_update_item_status('<backlog_item_uuid>', 'in_progress');
```

### Step 5: PM handoff comment
```sql
SELECT pm_add_comment('<backlog_item_uuid>', 'Handed off to Engineer for planning');
```

### Step 8 (Approved): PM updates status
```sql
SELECT pm_add_comment('<backlog_item_uuid>', 'Plan approved, starting implementation');
```

### Step 8 (Rejected): PM defers task
```sql
SELECT pm_update_task_status('<task_uuid>', 'deferred');
SELECT pm_update_item_status('<backlog_item_uuid>', 'deferred');
```

### Step 11: PM marks Testing (PR created)
```sql
SELECT pm_update_task_status('<task_uuid>', 'testing');
SELECT pm_update_item_status('<backlog_item_uuid>', 'testing');
```

### Step 14: PM marks Completed + Records Tokens
```sql
SELECT pm_update_task_status('<task_uuid>', 'completed');
SELECT pm_record_task_tokens(
  '<task_uuid>',
  <total_actual_tokens>,
  '<engineer_agent_id>',
  'engineer',
  <input_tokens>, <output_tokens>, <cache_read>, <cache_create>,
  <duration_ms>, <api_calls>, '<session_id>'
);
```

### Step 15: PM closes sprint (if all tasks done)
```sql
SELECT pm_update_sprint_status('<sprint_uuid>', 'completed');
```

---

## Related Skills

- `.claude/skills/agentic-pm/SKILL.md` - PM responsibilities
- `.claude/skills/issue-log/SKILL.md` - Issue documentation
- `.claude/skills/log-metrics/SKILL.md` - Metrics scripts (Step 14)
- `.claude/docs/shared/git-branching.md` - Git workflow
- `.claude/docs/shared/pr-lifecycle.md` - PR requirements
