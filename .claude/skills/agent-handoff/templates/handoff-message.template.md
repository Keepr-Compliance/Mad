# Handoff Message Template

Use this template for ALL agent handoffs during sprint task execution.

> **Note:** This template's content is the body of the handoff message agents
> post to each other; it is also typically logged to Supabase via
> `pm_add_comment('<backlog_item_uuid>', '<handoff markdown>')`. Do NOT write
> handoffs to disk as `.md` files — Supabase is the source of truth.

---

## Handoff: [FROM_AGENT] → [TO_AGENT]

**Task:** TASK-XXXX (legacy_id) / backlog_item_id `<uuid>`
**Plan Source:** `pm_backlog_items.body` (look up via `pm_get_item_by_legacy_id('TASK-XXXX')`)
**Current Step:** X (of 15)
**Phase:** [A: Setup | B: Planning | C: Implementation | D: Merge & Cleanup]

### Status
[Choose one]
- [ ] Approved - Ready for next phase
- [ ] Rejected - Task cannot proceed as specified
- [ ] Changes Requested - Needs revision before approval
- [ ] Complete - Task finished, ready for closure
- [ ] Blocked - Waiting on external dependency

### Next Action
[Clear instruction for the receiving agent]

Example: "Review the implementation in branch `feature/TASK-1234-email-sync`.
Check that all acceptance criteria from the task file are met."

### Context
[Any relevant information the next agent needs]

- **Branch:** `feature/TASK-XXXX-description`
- **Worktree:** `../Mad-TASK-XXXX` (if applicable)
- **PR:** #XXX (if created)
- **Plan File:** `/path/to/plan.md` (if in planning phase)

### File Boundaries (Parallel Tasks Only)

If this task runs in parallel with other tasks, confirm file scope compliance:

- [ ] I only modified files listed in the "Files to modify" section of the task file
- [ ] I did NOT modify any files listed in "Files this task must NOT modify"
- [ ] If I needed a restricted file, I stopped and notified PM

If sequential execution (no parallel peers): "N/A -- sequential execution."

### Issues/Blockers

[Document any problems encountered during this phase]

If none: "None encountered."

If issues exist, use this format:
```
1. **[Issue Title]**
   - What happened: [description]
   - Resolution: [how it was fixed/worked around]
   - Time impact: [estimate]
```

### Effort

**MANDATORY for Engineer and SR Engineer handoffs.** This data feeds into PM metrics collection and sprint retrospectives.

- **Agent ID:** `<agent_id returned by Task tool>`
- **Total Tokens:** `<from TaskOutput or agent completion summary>`
- **Duration:** `<seconds or minutes>`
- **Task Estimate:** `~XK (from task file)`

The Agent ID is the key that links to `.claude/metrics/tokens.csv` for PM aggregation. Record it immediately when the Task tool returns.

### Files Modified
[List key files touched in this phase - helps next agent find context]

- `path/to/file1.ts` - [brief description of change]
- `path/to/file2.tsx` - [brief description of change]

### Supabase Updates Performed
- [ ] `pm_get_task_by_legacy_id('TASK-XXXX')` → UUID: ___
- [ ] `pm_update_task_status('<uuid>', '<status>')` → result: ___
- [ ] `pm_update_item_status('<uuid>', '<status>')` → result: ___
- [ ] `pm_record_task_tokens(...)` → result: ___ (Step 14 only)

---

## Example: Engineer → SR Engineer (Plan Review)

```markdown
## Handoff: ENGINEER → SR ENGINEER

**Task:** TASK-1775 / backlog_item_id `<uuid>`
**Plan Source:** `pm_backlog_items.body` (look up via `pm_get_item_by_legacy_id('TASK-1775')`)
**Current Step:** 6 (of 15)
**Phase:** B: Planning

### Status
- [x] Changes Requested - Needs revision before approval

### Next Action
Review the implementation plan for email attachment download service.
Plan logged via `pm_add_comment` on backlog item `<uuid>` (or read updated
`pm_backlog_items.body` if posted there).

Verify:
1. Architecture aligns with existing attachment patterns
2. Error handling for OAuth token refresh is specified
3. Storage deduplication approach is sound

### Context
- **Branch:** `feature/TASK-1775-email-attachment-download`
- **Worktree:** N/A (sequential execution)

### Issues/Blockers
1. **Gmail API rate limit concern**
   - What happened: Discovered 250 requests/second limit during exploration
   - Resolution: Added throttling recommendation to plan
   - Time impact: +15 min research

### Effort
- **Agent ID:** `a7f2c91`
- **Total Tokens:** ~45K
- **Duration:** ~3 min
- **Task Estimate:** ~30K

### Files Modified
- `.claude/plans/email-attachments-plan.md` - Created implementation plan
```
