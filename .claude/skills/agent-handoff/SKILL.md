---
name: agent-handoff
description: Defines the 15-step sprint task workflow and handoff protocol between PM, Engineer, and SR Engineer agents.
---

# Agent Handoff Workflow

This skill defines how agents hand off work during sprint task execution. Read this before starting any sprint task work.

---

> **Source of Truth (read this first):** All sprint plans, task plans, progress logs, status transitions, decisions, and issue entries live in Supabase: `pm_sprints.body`, `pm_backlog_items.body`, `pm_comments`, `pm_token_metrics`. Do NOT create `.claude/plans/sprints/*.md` or `.claude/plans/tasks/*.md` files for new work. The `.claude/.current-task` file is the only on-disk PM artifact. It is no longer how an agent is identified: since BACKLOG-1693 (PR #2280) the metrics hooks bind identity per agent at spawn via a sidecar keyed on `agent_id`, and `.current-task` is the **fourth** fallback in the resolution order — consulted only when no sibling subagent is running and its mtime falls inside that run's window. Writing it is still supported and still correct for single-agent sessions; it is simply not load-bearing. `.claude/hooks/README.md` is the authority on attribution — read it before writing PM tooling that depends on how metrics are labelled. Existing `.md` files under `.claude/plans/` are historical/archive only. When this document references "the task file" or "the sprint file," read/write the corresponding Supabase `body` column instead.

---

## Quick Reference: Who Am I? What's Next?

### PM Agent Steps
| Step | Action | Status Update | Hand Off To |
|------|--------|---------------|-------------|
| 0 | Name `BACKLOG-nnnn` in every agent brief (this is what attributes tokens); `.current-task` optional | — | - (before any agent work) |
| 1 | Verify backlog item exists with plan in `pm_backlog_items.body` (via `pm_get_item_by_legacy_id`) | — | - (abort if missing) |
| 2-4 | Setup (worktree, branch, status) | Task + Item → `in_progress` | - |
| 5 | Task ready for planning | — | Engineer (read-only exploration) |
| 8 | Plan reviewed | Sprint notes: "Plan approved" | Engineer (implement) or User (if rejected) |
| 11 | Implementation reviewed | Task + Item → `testing` | SR Engineer (create PR) |
| 14 | After PR merged | Task + Item → `completed` | Record effort metrics |
| 15 | All tasks complete | Sprint → `Completed` | Close sprint |

**Status updates at every transition (Supabase only):**
1. Supabase RPC: `pm_update_task_status('<task_uuid>', '<status>')` — task-level status
2. Supabase RPC: `pm_update_item_status('<backlog_item_uuid>', '<status>')` — backlog item status
3. (Optional) Supabase RPC: `pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := '<message>')` — log the rationale for the transition

**IMPORTANT:** Both status RPCs are required. `pm_update_task_status` updates the sprint task; `pm_update_item_status` updates the parent backlog item. Skipping either leaves the dashboard out of sync. Do NOT update `.claude/plans/sprints/*.md` or `.claude/plans/backlog/items/*.md` for new work — those files are historical archive only, and the CSV under `.claude/plans/backlog/data/` is read-only.

**Valid statuses (Supabase):** `pending`, `in_progress`, `testing`, `completed`, `deferred`

### Engineer Agent Steps
| Step | Action | Hand Off To |
|------|--------|-------------|
| 6 | Explore codebase (read-only), write plan | SR Engineer (plan review) |
| 9 | Implement, commit, push, create PR (base `int/<sprint-name>`) | SR Engineer (impl review) |
| 12 (CI fail) | Fix CI issues | SR Engineer (re-review) |

### SR Engineer Agent Steps
| Step | Action | Hand Off To |
|------|--------|-------------|
| 7 | Review plan | Engineer (changes) or PM (approved/rejected) |
| 10 | Review implementation | Engineer (changes) or PM (approved/rejected) |
| 12 | Review Engineer's PR, wait CI (DO NOT MERGE) | User (testing gate) |
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
0.  PM: Put BACKLOG-nnnn in every agent brief (attribution happens at spawn)
    - **This, not .current-task, is what attributes an agent's tokens.** Since
      BACKLOG-1693 the register-agent hook writes a per-agent sidecar keyed on
      agent_id when the agent is spawned, and the SubagentStop hook reads it back
      by that same agent_id. Naming the item in the brief is sufficient.
    - Writing .current-task is OPTIONAL and is the 4th fallback in the resolution
      order — used only when no sibling subagent is running and its mtime falls
      inside that run's window. With parallel agents it is ignored by design.
      Do NOT rely on it to distinguish concurrent agents; that is the failure it
      caused (five consecutive agents recorded against one item, measured
      2026-08-11). See `.claude/hooks/README.md` for the full order.
    - If you do write it, sprint_id MUST be the sprint UUID (not the name).
      The hook writes sprint_id straight to pm_token_metrics; a name like
      "SPRINT-T" breaks sprint-level metrics queries.
    - echo '{"agent_type": "pm", "sprint_id": "<sprint-uuid>", "description": "Sprint setup"}' > .claude/.current-task

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
    - Alternative: spawn the Engineer with `isolation: "worktree"` on the
      Agent tool — the harness creates/cleans the worktree structurally;
      the engineer then creates its branch from the Branch From base inside it

3.  PM: Create branch for task
    - If worktree: already created in step 2
    - If sequential: git checkout -b feature/TASK-XXXX int/<sprint-name>

4.  PM: Update task status to "In Progress"
    - Update Supabase (BOTH RPCs required):
      `SELECT pm_update_task_status('<task_uuid>', 'in_progress');`
      `SELECT pm_update_item_status('<backlog_item_uuid>', 'in_progress');`
    - (Optional) Log the transition:
      `SELECT pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := 'Status → in_progress: handing off to engineer');`
    - Valid statuses: pending, in_progress, testing, completed, deferred

5.  PM → ENGINEER: Handoff task for planning (read-only exploration)
    - Include the `BACKLOG-nnnn` id in the engineer's brief — that is what binds
      the metrics row to this item (BACKLOG-1693). Optionally also write
      `.claude/.current-task` (legacy fallback, ignored when agents run in parallel):
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
        * `pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := '<plan markdown>')` for an
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
    │   - `pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := '## Plan Approval\n<rationale>')`
    │   - Handoff to PM
    └─ Reject → Step 8 (with rejected status)
        - Document rejection reason via `pm_add_comment`
        - Handoff to PM

8.  PM: Update Supabase status + log decision
    ├─ If approved → ENGINEER: Start implementation (Step 9)
    │   - Status stays `in_progress` (plan approved, implementation starting)
    │   - Log decision: `pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := 'Plan approved, implementing')`
    │   - Handoff with approval context
    └─ If rejected → Notify user, END
        - Update Supabase (BOTH RPCs required):
          `SELECT pm_update_task_status('<task_uuid>', 'deferred');`
          `SELECT pm_update_item_status('<backlog_item_uuid>', 'deferred');`
        - Document reason: `pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := 'Deferred: <reason>')`

PHASE C: IMPLEMENTATION
-----------------------
9.  ENGINEER: Implement task, commit changes, push branch, create PR
    - Follow the approved plan
    - Make atomic commits
    - Run full test suite BEFORE pushing: `npx jest --bail --no-coverage`
      If any tests fail, fix them before creating the PR.
      Search for ALL test files referencing changed functions:
      `grep -r "functionName" --include="*.test.*" src/ electron/`
      and update stale expectations to match new behavior.
    - Push branch to remote
    - Create the PR: `gh pr create --base <Branch Into from the task plan>`
      (read Branch From / Branch Into from `pm_backlog_items.body` — set by
      SR Technical Review; default: `int/<sprint-name>` for sprint tasks)
    - Include `## Engineer Metrics` section in PR body
      (use template from `.github/PULL_REQUEST_TEMPLATE.md`)
    - Record the PR on the backlog item:
      `UPDATE pm_backlog_items SET branch_name = '<branch>', pr_url = '<url>' WHERE id = '<backlog_item_uuid>';`
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
    - (Optional) Log: `pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := 'Implementation approved → testing')`
    - → SR ENGINEER: Review PR + CI (Step 12)

PHASE D: PR, TEST & MERGE
--------------------------
12. SR ENGINEER: Review PR (DO NOT MERGE)
    - PR was created by the Engineer at Step 9, targeting the Branch Into
      from the task plan (default int/<sprint-name> — NOT develop)
    - If the Engineer did not open a PR: gh pr create --base <Branch Into>
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
      SELECT agent_id, agent_type, billable_tokens, task_id
      FROM pm_token_metrics WHERE task_id = 'TASK-XXXX' ORDER BY recorded_at;
      ```
      **Use `billable_tokens`, never `total_tokens`.** `total_tokens` includes
      `cache_read_tokens` and runs ~19x higher (measured 19.54x across the live
      table on 2026-08-11); summing it for cost or variance is simply wrong.
      `billable_tokens` is `GENERATED ALWAYS AS (input + output + cache_creation)`
      — cache reads are excluded on purpose. See "A note on `total_tokens`" below.
    - If any agents are unlabeled, label them:
      `SELECT pm_label_agent_metrics('<agent_id>', 'TASK-XXXX', 'engineer', 'Implementation');`
      Label the rows the hooks already wrote — do NOT insert agent rows by hand.
    - Record task totals (auto-sums the metric rows above):
      `SELECT pm_record_task_tokens('<task_uuid>');`
      Pass NO agent arguments. The function takes 11 but uses only the first
      two; the agent ones are accepted and silently ignored. See the Step 14
      entry under "SQL Reference" for why, and what to use instead.
    - Collect issues from handoff messages and log them as
      `pm_comments` (tag with `issue` keyword) on the relevant backlog item

15. PM: When ALL sprint tasks complete → Close sprint
    - Verify all tasks are complete
    - Aggregate all task metrics from Supabase:
      ```sql
      SELECT task_id, SUM(billable_tokens) AS billable
      FROM pm_token_metrics WHERE sprint_id = '<sprint-uuid>'
      GROUP BY task_id ORDER BY task_id;
      ```
      `SUM(total_tokens)` was removed from this query, not renamed. It double-counts
      cache reads (~19x), and every sprint figure derived from it is wrong.
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
**Controls run:** [which line you reverted, and what went red — see below]
**Measured at:** [SHA, for any claim about another branch]
**Issues/Blockers:** [problems encountered, workarounds used, or "None"]
```

See `templates/handoff-message.template.md` for the full template.

---

## Situational Awareness (MANDATORY)

An agent knows its task. It does not know what changed around it. These steps close that gap; none takes more than a minute.

### 0. Before dispatching ANY item — check it is not already built

```bash
gh pr list --state all --search "BACKLOG-XXXX" --json number,state,title,baseRefName
```

Then grep for the thing it would add. If a migration, check the version list. If a column, check whether anything reads it.

**Two instances in one day, 2026-08-04:**
- **BACKLOG-2364** was dispatched to an engineer. Migration **v56** had shipped it weeks earlier, verbatim, in PRs #2167 and #2161. The engineer correctly refused and wrote no code. Writing the assigned migration would have added duplicate columns to two tables.
- **PR #1782** (2026-06-08, still open) turned out to duplicate work later redone under BACKLOG-2352. Its backlog item had been deleted, so nothing connected the two.

The founder, on the second: *"i guess we did the work twice... it is what it is it's an example why we need to figure out how to better track our work."*

**The check costs seconds. Skipping it costs an agent run and burns the founder's trust in the backlog.** A `status` of `pending` is not evidence the work is undone — statuses drift, items get deleted, and PRs mention several task ids at once (three items showed "2 PRs" that were the same migration PR naming all of them).

### 1. Before any claim about another branch — check what is moving

**Agents register themselves automatically.** The `PostToolUse:Agent` hook writes `pm_agent_activity` at launch; the `PostToolUse:Edit|Write` hook refreshes it on every edit and **detects** which files are actually being touched (`git diff --name-only`, not a declared list — a declared list goes stale the moment scope changes). You do not have to remember to do anything.

**You DO have to look.** Before editing a shared file, or claiming anything about another branch:

```sql
-- who else is working, and on what
SELECT agent_id, legacy_id, branch_name, status, note, minutes_since_heartbeat
FROM pm_agents_active;

-- am I about to collide with someone?
SELECT * FROM pm_agent_file_collisions;
```

`pm_agent_file_collisions` lists any file two live agents are both editing. On 2026-08-04 two agents rewrote `contactPickerList.ts` unaware of each other; it took **three review cycles** to surface. This query surfaces it on the first edit.

**Stamp the SHA into the claim.** "No conflict with #2204" is unverifiable an hour later; "no conflict with #2204 at `13a4e32b`" is a one-line recheck. Four merge-order conclusions were reached that night and two were wrong — one measured against a branch force-pushed twenty minutes later.

```bash
gh pr list --base int/<sprint-name> --json number,headRefOid,title
```

**The registry is non-blocking and therefore fails silently.** `pm_agent_bypassed` reconciles it against `pm_token_metrics` — any agent that ran but never registered appears there. A steady trickle means the hook is broken; a spike means agents are working outside the harness. **Check it when the registry looks suspiciously empty**, rather than concluding nobody is working.

### 2. Controls are part of the handoff, not a detail

**Revert one line of your fix and confirm a test goes red.** Report which control and what failed. See `CLAUDE.md` → *Break it and watch it go red*. An unstated control is an unrun control, and three PRs that night had controls which proved nothing until a reviewer re-ran them.

### 3. Namespace anything in a shared location

The session scratchpad is **shared across all agents**, not per-agent. Two collisions on 2026-08-04, both on the obvious name `pr-body.md`: one agent deleted a sibling's file, another had its own overwritten and published a sibling's text onto its PR.

**Prefix scratchpad files with the item or agent id** (`pr-body-2459.md`). Never delete a scratchpad file you did not create.

### 4. Verify `pwd` after any `cd` into a path you did not create

A `cd` into a worktree a sibling has removed silently lands in the main repo — where a `git checkout` then moves the founder's working tree. Happened 2026-08-04; caught and restored.

### Plan review is not optional

Step 7 exists because an engineer who plans in the open gets corrected before writing code. On 2026-08-04 the one item that received a plan review had a dead-code target caught before implementation — *"otherwise it would have shipped a no-op behind a green test."* An item where the step was skipped was built on a root cause that turned out to be false, and the founder made a product decision on it.

**Skipping Steps 6-8 is the single most expensive shortcut in this workflow.**

---

## The Human-Facing Summary (MANDATORY)

**Every agent's final message ends with this block and nothing after it.** It is the only part a person reads. Everything else you wrote — checklists, review sections, issue entries, file lists, control evidence — goes to `pm_comments` on the backlog item, in full, **first**.

This is an instantiation of `~/.claude/CLAUDE.md` → *Output style*, not a second ruleset. Shape adapted from the "i-have-adhd" skill (github.com/ayghri/i-have-adhd, MIT).

Five slots. One sentence each. Never four, never six:

```
SUMMARY
1. Changed: <what the app now does differently, in the founder's words — not file names>
2. State: <branch / PR #, CI green|red|not run>
3. Control: <what you reverted and what went red> | <"none run — reason">
4. Issues: <one line> | <"none">
5. Decision needed: <one concrete ask> | <"nothing needed">
```

**Rules:**

- **Slot 5 is never omitted.** "Nothing needed" is an answer; silence is not. The founder should never have to ask *"what is the question here?"*
- **Slot 1 names the behaviour, not the change set.** "Rejected deals no longer auto-link contacts" — not "refactored contactManualLink.ts".
- **Slot 3 stays in the human summary on purpose.** An unstated control is an unrun control; burying it in Supabase makes the omission invisible at the moment a merge is decided. State the control here, put the evidence in `pm_comments`.
- A slot needing a second sentence means the second sentence belongs in `pm_comments`. Cite it, do not inline it.
- No preamble above the block. No recap below it.

**This shortens what you write, never what you do.** `CLAUDE.md` → *Break it and watch it go red* is unchanged, and the Supabase record gets **larger** under this rule, not smaller.

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

> **Change-request loops (Steps 7→6 and 10→9):** resume the SAME engineer
> agent via SendMessage (use the agentId from its spawn result) instead of
> spawning a fresh one — the engineer keeps full task context, avoiding a
> costly re-read of the task plan and codebase.

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
│   → Post the full review to pm_comments
│   → Notify user with the SUMMARY block ONLY (see The Human-Facing Summary)
│     Slot 5 reads: "Decision needed: test <one named screen/action>, then merge or report."
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
SELECT pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := 'Handed off to Engineer for planning');
```

### Step 8 (Approved): PM updates status
```sql
SELECT pm_add_comment(p_item_id := '<backlog_item_uuid>', p_body := 'Plan approved, starting implementation');
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
-- Note: <task_uuid> here is pm_tasks.id (the sprint task row),
-- NOT pm_backlog_items.id. Resolve via pm_get_task_by_legacy_id('TASK-XXXX').

-- Use this form. It sums the metric rows the hooks already wrote and
-- writes pm_tasks.actual_tokens + the parent item's actual_tokens/variance.
SELECT pm_record_task_tokens('<task_uuid>');

-- Second form, only to override the sum with a hand-set total:
SELECT pm_record_task_tokens('<task_uuid>', <total_actual_tokens>);
```

**`pm_record_task_tokens` records the task TOTAL. It does not write agent rows.**

The function still declares 11 parameters, but only the first two do anything.
`p_agent_id`, `p_agent_type`, `p_input_tokens`, `p_output_tokens`, `p_cache_read`,
`p_cache_create`, `p_duration_ms`, `p_api_calls` and `p_session_id` are **accepted and
ignored** — passing them is silently discarded, and the returned payload always reads
`agent_metrics_written: false`. **Do not add them back.** They were kept only so the
admin portal keeps compiling.

PR #2282 removed the synthetic agent-metric row this function used to insert, because
`pm_token_metrics.billable_tokens` is a `GENERATED ALWAYS` column
(`input + output + cache_creation`) — every row the function wrote re-entered the sum it
had just computed, inflating the very total it was recording.

Agent-level rows come from the hooks, not from this call:

| Want | Use |
|---|---|
| Per-agent token rows | Nothing — the `SubagentStop` hook writes them. Since BACKLOG-1693 identity is bound per agent at spawn, so put `BACKLOG-nnnn` in the agent's brief and attribution follows. See `.claude/hooks/README.md`. |
| An unlabelled row attached to a task | `SELECT pm_label_agent_metrics('<agent_id>', 'TASK-XXXX', 'engineer', 'Implementation');` — works from an MCP session |
| The task/item rollup | `SELECT pm_record_task_tokens('<task_uuid>');` |

`pm_log_agent_metrics` is the RPC the hook itself calls. It is guarded by an
`internal_roles` check with a service-role bypass, so it works for the hook and **fails
from an MCP session** with "Access denied: internal role required". A PM should not be
calling it by hand.

**`pm_record_task_tokens` raises when there is nothing to sum.** If no metric rows exist
for the task or its parent item it errors rather than returning — that means the hooks
did not record, so fix attribution instead of passing a number to silence it. When rows
exist for the item but none are keyed to this task, it deliberately leaves
`pm_tasks.actual_tokens` alone (an item may have several tasks) and rolls up the item only.

### A note on `total_tokens` — never sum it for cost

**Effort, cost and variance come from `billable_tokens`. `total_tokens` is not a smaller
mistake, it is a ~19x one.**

| Column | Contents | Use for cost? |
|---|---|---|
| `billable_tokens` | `GENERATED ALWAYS AS (input + output + cache_creation)` | **Yes** |
| `total_tokens` | the above **plus `cache_read_tokens`** | **No** |

Cache reads dominate an agent's transcript and are excluded from `billable_tokens` on
purpose. Measured across the whole live table on 2026-08-11
(`SELECT SUM(total_tokens), SUM(billable_tokens) FROM pm_token_metrics`):
15,967,627,947 vs 817,061,720 — **19.54x**.

This is not hypothetical. Summing `total_tokens` is what made every `variance` in the
tracker wrong; 89 item rows had to be recomputed from `SUM(billable_tokens)`, and it is
the reason PR #2282 changed `pm_record_task_tokens`. `pm_record_task_tokens` already sums
the right column — this note is for the hand-written reconciliation queries in Steps 14
and 15, where the choice is yours.

Do not "simplify" these queries back to `total_tokens`, and do not add it alongside
`billable_tokens` in a query whose output is a cost or variance figure — offering both is
how the wrong one gets copied into a sprint retrospective. It is fine in a full component
breakdown that already lists `cache_read_tokens` separately (see
`.claude/skills/log-metrics/SKILL.md`), where it is plainly the sum of the parts and is
labelled diagnostic-only.

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
