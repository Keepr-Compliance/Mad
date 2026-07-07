# Plan-First Protocol

**Status:** MANDATORY for all agents (Engineer, SR Engineer, PM)
**Last Updated:** 2024-12-24

---

## Overview

> **Scope note (2026-07):** For **Engineer sprint tasks**, the authoritative planning phase is `.claude/skills/agent-handoff/SKILL.md` Steps 6–8: the Engineer explores read-only, writes the plan to Supabase (`pm_add_comment` / `pm_backlog_items.body`), and **SR Engineer plan approval (Step 7) is the gate**. For that flow, the Plan agent below is an optional drafting aid and Step 4 self-approval does NOT apply. This protocol as written remains in force for PM and SR Engineer activities and for standalone (non-sprint) work.

Before ANY implementation, review, or planning activity, you MUST invoke the Plan agent to create a strategic plan. This is non-negotiable.

**Why this exists:**
- Prevents scope creep and missed requirements
- Creates auditable decision trail
- Enables accurate metrics tracking
- Reduces rework from poor planning

---

## Protocol Steps

### Step 1: Invoke Plan Agent

Use the Task tool with `subagent_type="Plan"` and provide context appropriate to your role:

```markdown
## Planning Request: [Type]

**Role**: [Engineer | SR Engineer | PM]
**Task**: [TASK-XXX or activity description]

### Context
- **Objective**: [What needs to be accomplished]
- **Constraints**: [Limitations, guardrails, dependencies]
- **Scope**: [Files, services, or areas affected]

### Expected Plan Output
1. **Action Sequence**: Ordered steps with dependencies
2. **Risk Areas**: Potential issues to watch for
3. **Quality Gates**: What must be verified
4. **Estimated Complexity**: Low/Medium/High with rationale
```

### Step 2: Review the Plan

After receiving the plan, review it from your role's perspective:

**All Roles Check:**
- [ ] Are all requirements addressed?
- [ ] Is the sequence logical (dependencies respected)?
- [ ] Are there any missing steps?
- [ ] Is the complexity estimate reasonable?

**If issues found**, re-invoke Plan agent with:
```markdown
## Planning Revision Request

**Original Plan Issues:**
1. [Issue 1]
2. [Issue 2]

**Requested Changes:**
- [Change 1]
- [Change 2]

Please revise the plan addressing these concerns.
```

### Step 3: Record Agent ID

**REQUIRED**: Record the Plan agent's activity:

```markdown
## Plan Agent

**Plan Agent ID:** [agent_id from Task tool output]
**Planning Complete:** [timestamp]

Metrics will be auto-captured via SubagentStop hook.
```

### Step 4: Approve and Execute

Once satisfied with the plan:
1. Document the approved plan in your output
2. Use the plan as your execution guide
3. Reference plan steps as you complete them

**BLOCKING**: Do NOT start execution until you have an approved plan.

---

## Role-Specific Extensions

### Engineers

Include in planning request:
- Task plan source: `pm_backlog_items.body` for legacy_id `TASK-XXX` (look up via `pm_get_item_by_legacy_id`) and acceptance criteria
- Architecture boundaries (entry file guardrails)
- Testing requirements

**Fixture Size Check:**
- [ ] Does task involve fixture creation?
- [ ] If yes, how many items will the fixture contain?
- [ ] If >50 items, plan to use generator approach

Reference: `.claude/docs/shared/large-fixture-generation.md`

### SR Engineers

Include in planning request:
- PR/branch being reviewed
- Services affected and layers involved
- Security and performance considerations

### PM

Include in planning request:
- Backlog items being considered
- Merge target and risk tolerance
- Dependencies across tasks

### Sprint Completion (After Final Merge)

PM MUST execute the Sprint Completion Checklist (`.claude/skills/agentic-pm/modules/backlog-maintenance.md`) immediately after the final sprint PR merges:
- Update sprint status in Supabase (`pm_update_sprint_status('<sprint-uuid>', 'completed')`) and populate `pm_sprints.body` with the retrospective
- Mark backlog items + tasks complete (`pm_update_item_status` / `pm_update_task_status`)
- Roll up actuals via `pm_record_task_tokens`

**Failure to complete this checklist results in stale Supabase data and broken dashboard metrics.**

---

## Workflow Violations

| Violation | Detection | Consequence |
|-----------|-----------|-------------|
| Skipping Plan-First Protocol | CI check + SR Review | PR blocked until plan complete |
| Missing Agent ID | SR Engineer review | PR rejected |

**If you realize you skipped planning:**
1. STOP immediately
2. Invoke Plan agent (even retroactively)
3. Document as deviation: "DEVIATION: Plan created post-implementation"

---

## References

- Engineer implementation: `.claude/agents/engineer.md`
- SR Engineer reviews: `.claude/agents/senior-engineer-pr-lead.md`
- PM planning: `.claude/skills/agentic-pm/SKILL.md`
