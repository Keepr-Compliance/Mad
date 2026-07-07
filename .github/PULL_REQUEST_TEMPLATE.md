## Summary
<!-- Brief description of what this PR does -->

## Changes
<!-- List specific changes made -->

## Task Reference
<!-- Always pair TASK and BACKLOG numbers — every PR must be traceable to a pm_backlog_items row -->
- **Task ID**: TASK-XXX
- **Backlog Item**: BACKLOG-XXX
- **Sprint**:
- **Branch**:

---

## Engineer Pre-PR Checklist

**REQUIRED: Complete ALL items before requesting review**

### 1. Branch & Setup
- [ ] Created branch from the **Branch From** base in the task plan (default `int/<sprint-name>` for sprint tasks; `develop` for standalone work)
- [ ] Branch follows naming: `fix/task-XXX-*` or `feature/task-XXX-*`

### 2. Implementation
- [ ] All acceptance criteria met
- [ ] Tests pass locally: `npm test`
- [ ] Type check passes: `npm run type-check`
- [ ] Lint passes: `npm run lint`

### 3. Supabase Updated (source of truth)
- [ ] Implementation Summary posted via `pm_add_comment` on the backlog item
- [ ] Deviations/issues documented via `pm_add_comment` (if any)
- [ ] `branch_name` + `pr_url` recorded on the backlog item:
      `UPDATE pm_backlog_items SET branch_name = '<branch>', pr_url = '<url>' WHERE id = '<uuid>';`

### 4. Metrics Linkage
- [ ] Agent ID recorded below (numeric metrics are auto-captured to `pm_token_metrics` — do NOT paste token counts here)

---

## Engineer Metrics: TASK-XXX

### Agent ID

**Record this when the Task tool returns — it is the linkage key for `pm_token_metrics`:**
```
Engineer Agent ID: <paste your agent_id here>
```

> Numeric metrics (tokens, duration, API calls, variance) are auto-captured by the
> SubagentStop hook into Supabase `pm_token_metrics` after the agent finishes.
> PM rolls them up via `pm_record_task_tokens('<task_uuid>')` at Step 14 (BACKLOG-1873).

**Implementation Notes:**
<!-- Summary of approach, key decisions -->

---

## Test Plan
<!-- How to verify this change works -->
- [ ]

---

## SR Engineer Review Section

**DO NOT EDIT BELOW - For SR Engineer only**

### SR Engineer Checklist

**BLOCKING - Verify before reviewing code:**
- [ ] Engineer Agent ID is present (not placeholder)
- [ ] TASK-/BACKLOG- cross-reference present
- [ ] Implementation Summary posted in `pm_comments` on the backlog item
- [ ] `branch_name` + `pr_url` recorded on the backlog item

**Code Review:**
- [ ] CI passes
- [ ] Code quality acceptable
- [ ] Architecture compliance verified
- [ ] No security concerns

**Merge Gate:**
- [ ] User has explicitly approved the merge (testing gate — agent-handoff Step 12a). NEVER merge without it.

### SR Engineer Agent ID

```
SR Engineer Agent ID: <paste your agent_id here>
```

**Review Notes:**
<!-- Architecture concerns, security review, approval rationale -->

---

**After user approval and merge, PM records metrics via `pm_record_task_tokens` and marks the item complete in Supabase.**

---

## Automated Validation

This PR will be automatically validated by CI for:
- Presence of the Engineer Metrics section
- Presence of an Agent ID (pm_token_metrics linkage key)
- A TASK-#### or BACKLOG-#### cross-reference

PRs missing these elements will fail the PR Metrics Validation check.
Numeric metrics are NOT validated in the PR body — they live in Supabase (BACKLOG-1873).
