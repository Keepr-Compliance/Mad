# Engineer Assignment: TASK-XXX

> **Note:** This message is typically posted as a `pm_comments` entry on the backlog item (and/or as the agent prompt). The plan you need is stored in Supabase, not on disk.

> **NON-NEGOTIABLE: AGENT ID CAPTURE REQUIRED**
>
> You MUST record your Agent ID immediately when this task starts. This is mandatory.
> - Record your **Agent ID** from the Task tool output
> - Metrics are auto-captured via SubagentStop hook
>
> **Agent ID:** _______________

---

## Summary

You are assigned to **TASK-XXX: <Title>**.

## Task Plan Location

```
Supabase: pm_backlog_items.body where legacy_id = 'TASK-XXX'
         (lookup via pm_get_item_by_legacy_id('TASK-XXX'))
```

Read the full task plan (the `body` field) before starting. Do NOT look for a `.claude/plans/tasks/TASK-XXX.md` file — those paths are historical archive only.

## Quick Context

- **Goal**: <1 sentence>
- **Phase**: Phase <N>
- **Dependencies**: <none / TASK-YYY must complete first>
- **Conflicts with**: <none / TASK-ZZZ - do not run in parallel>

## Key Points

1. **Non-goals**: Review the non-goals section carefully. Do not expand scope.
2. **Integration**: Your work will be used by <TASK-AAA, TASK-BBB>.
3. **Testing**: <specific testing requirements>
4. **Branch**: Create `feat/<ID>-<slug>` from `<base branch>`.

## Workflow

1. Read the full task plan from `pm_backlog_items.body` (via `pm_get_item_by_legacy_id('TASK-XXX')`)
2. Record your Agent ID immediately
3. Create your feature branch
4. Implement according to acceptance criteria
5. Post your Implementation Summary as a `pm_comments` entry on the backlog item (do NOT edit any on-disk `.md` task file)
6. Run all CI checks locally
7. Open PR targeting `<branch>` with Agent ID noted
8. Have senior-engineer-pr-lead agent review the PR
9. **After SR approval, MERGE the PR** (`gh pr merge <PR> --merge`)
10. **Verify merge succeeded** (`gh pr view <PR> --json state` must show `MERGED`)

**CRITICAL:** Creating a PR is step 7 of 10, not the final step. Task is NOT complete until PR is MERGED.

**PR Lifecycle Reference:** `.claude/docs/shared/pr-lifecycle.md`

## Completion Reporting (REQUIRED)

**After PR is MERGED (not just approved)**, report:

```
## Task Completion Report: TASK-XXX

**Status:** Complete
**PR:** #<number>
**Merge Verified:** Yes (state: MERGED)
**Engineer Agent ID:** <your_agent_id>

### Merge Verification
```bash
gh pr view <PR-NUMBER> --json state --jq '.state'
# Output: MERGED
```

### Metrics (Auto-Captured)

Run: `grep "<your_agent_id>" .claude/metrics/tokens.csv`

| Metric | Value |
|--------|-------|
| Total Tokens | <from hook> |
| Duration | <from hook> seconds |
| API Calls | <from hook> |

### Variance Notes
(if significantly different from estimate of ~<X>K tokens)
<explanation>
```

**Do NOT report task complete until you have verified the merge state shows `MERGED`.**

Metrics are auto-captured via SubagentStop hook. The PM will lookup metrics using your Agent ID.

## Stop and Ask If

- You're unsure about acceptance criteria
- You discover work outside the defined scope
- You encounter blockers from dependencies
- You need to deviate from the implementation notes

## Communication

- Questions: Post in <channel/thread>
- Blockers: Escalate immediately
- Updates: <frequency/channel>

## Timeline

- **Start**: <date/time>
- **Integration checkpoint**: <date/time>
- **Phase deadline**: <date/time>

---

Good luck! Ping if you have questions.
