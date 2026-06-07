---
name: issue-log
description: Mandatory issue documentation skill. ALL agents must document problems, blockers, and workarounds before handoffs or task completion.
---

# Issue Documentation Skill

**This skill is MANDATORY for all agents.** Document issues before ANY handoff or task completion.

---

## Why This Matters

Undocumented issues lead to:
- Repeated debugging of the same problems
- Lost knowledge when context resets
- Inaccurate time estimates for similar tasks
- Recurring patterns that could be prevented

---

## When to Use This Skill

Document issues when:
- Something doesn't work as expected
- You try an approach and abandon it
- You find a bug or unexpected behavior
- You spend significant time debugging (>10 min on one problem)
- You discover a workaround for a limitation
- External dependencies cause delays
- Before ANY handoff to another agent
- Before marking a task complete

---

## Issue Entry Format

```markdown
### Issue #[N]: [Brief descriptive title]

- **When:** Step X / Phase Y of workflow
- **What happened:** [Clear description of the problem]
- **Root cause:** [If known, otherwise "Unknown - needs investigation"]
- **Resolution:** [How it was fixed OR workaround used OR "Unresolved"]
- **Time spent:** [Estimate in minutes/hours]
- **Prevention:** [How to avoid in future, if applicable]
- **Severity:** [Low | Medium | High | Critical]
```

---

## Where to Document Issues

### 1. In Handoff Messages (Always)
Every handoff message has an `**Issues/Blockers:**` field.

If no issues: `**Issues/Blockers:** None`

If issues exist: Brief summary with reference to full log.

### 2. In Supabase comments (Per-Task)
Append a `pm_comments` entry tagged `issue` on the relevant backlog item:

```sql
SELECT pm_add_comment(
  '<backlog_item_uuid>',
  E'## Issues Log\n\n### Issue #1: <title>\n- **When:** ...\n- **What happened:** ...\n...'
);
```

Do NOT append to a `.claude/plans/tasks/TASK-XXXX-*.md` file — Supabase is the source of truth and those paths are historical archive only.

### 3. In Sprint Retrospective (SR Engineer consolidates)
When closing a sprint, SR Engineer aggregates all task issues from `pm_comments`
across the sprint's items and rolls them into the `## Issues Summary` section
inside `pm_sprints.body` (UPDATE pm_sprints SET body = ...).

### 4. Escalate to Backlog (PM responsibility)
If an issue is systemic or recurring, PM creates a backlog item via `pm_create_item`.

---

## Issue Severity Guide

| Severity | Definition | Example |
|----------|------------|---------|
| **Low** | Minor inconvenience, no workaround needed | Slow API response |
| **Medium** | Required workaround, some time lost | Had to use alternative approach |
| **High** | Significant delay, blocked for >1 hour | Dependency failure, unclear requirements |
| **Critical** | Task cannot complete, escalation needed | API down, fundamental design flaw |

---

## Examples

### Example 1: Test Failure Issue
```markdown
### Issue #1: ContactRow test expecting wrong aria-label

- **When:** Step 9 / Phase C (Implementation)
- **What happened:** Test expected "Import Jane" but component uses "Add Jane"
- **Root cause:** Component was updated but test wasn't
- **Resolution:** Updated test expectation to match component behavior
- **Time spent:** 15 minutes
- **Prevention:** Run related tests before committing component changes
- **Severity:** Low
```

### Example 2: Workaround Issue
```markdown
### Issue #2: SQLite foreign key constraint preventing delete

- **When:** Step 9 / Phase C (Implementation)
- **What happened:** Deleting contact failed due to FK constraint with messages table
- **Root cause:** Messages table references contacts, no ON DELETE CASCADE
- **Resolution:** Workaround: Delete related messages first, then contact
- **Time spent:** 45 minutes
- **Prevention:** Add migration to set ON DELETE CASCADE (BACKLOG-XXX created)
- **Severity:** Medium
```

### Example 3: Unresolved Issue
```markdown
### Issue #3: Intermittent CI timeout on Windows

- **When:** Step 12 / Phase D (Merge)
- **What happened:** Windows CI runner timed out 2 of 5 runs
- **Root cause:** Unknown - possibly runner resource contention
- **Resolution:** Unresolved - re-ran CI until it passed
- **Time spent:** 20 minutes waiting
- **Prevention:** Consider adding retry logic or investigating Windows runner config
- **Severity:** Medium
```

---

## No Issues? Say So Explicitly

If nothing went wrong, you MUST still acknowledge it:

```markdown
**Issues/Blockers:** None encountered.
```

or as a `pm_comment` on the backlog item:

```sql
SELECT pm_add_comment('<backlog_item_uuid>', '## Issues Log\n\nNo issues encountered during this task.');
```

This confirms issues were considered, not forgotten.

---

## Template File

See `templates/issue-entry.template.md` for copy-paste template.

---

## Related

- `.claude/skills/agent-handoff/SKILL.md` - Workflow requiring issue docs
- `.claude/skills/agentic-pm/SKILL.md` - PM escalation of recurring issues
