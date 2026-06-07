# Token Cap Workflow

**Purpose:** Prevent runaway agents from burning excessive tokens undetected.

**Reference:** BACKLOG-133

---

## Overview

Every task has an implicit or explicit token cap = 4x the upper token estimate.

- If PM estimates 10K tokens, soft cap = 40K
- If PM estimates 20K-30K tokens, soft cap = 120K (4x upper)

This is a **soft cap**: engineers report and wait, they don't crash.

---

## For Engineers

### Tracking Your Token Usage

1. Note the estimated tokens from `pm_backlog_items.est_tokens` (or the task plan body)
2. Monitor your token usage via SubagentStop hook data in Supabase `pm_token_metrics` (primary) or `.claude/metrics/tokens.csv` (append-only backup); also `/log-metrics --summary` works
3. Be aware of token-heavy operations:
   - Long file reads (~2-5K tokens each)
   - Verbose command output
   - Multiple Edit tool retries

### When You Reach 50% of Cap (Early Warning)

At 50% of your token cap (2x estimate):
- Note it in your progress update
- Assess: Are you on track to complete within 4x?
- If concerned, report status to PM proactively

### When You Reach 4x Estimated Tokens (Hard Stop)

1. **STOP** current work immediately
2. **REPORT** status to PM using the format in `engineer.md`
3. **WAIT** for PM decision before continuing

**Do NOT:**
- Try to "finish quickly" to avoid the report
- Continue hoping you're almost done
- Rationalize that "this is a special case"

---

## For PM (Handling Reports)

When you receive a TOKEN CAP REACHED report:

### 1. Assess the Situation

Ask yourself:
- Is progress reasonable for tokens consumed?
- Is the root cause fixable (e.g., retry loops, verbose output)?
- Is the task inherently more complex than estimated?
- Should the task continue or be restructured?

### 2. Decision Options

| Decision | When to Use | Response to Engineer |
|----------|-------------|---------------------|
| **Extend cap** | Good progress, near completion | "Continue with additional XK budget" |
| **Abort** | Something is fundamentally wrong | "Stop work, we need to investigate" |
| **Split** | Task is larger than expected | "Create TASK-XXX-b for remaining work" |
| **Reassign** | Approach isn't working | "Different approach needed, will create new task" |

### 3. Record the Incident

- Add a `pm_comment` on the backlog item with decision and rationale (do NOT edit a `.claude/plans/tasks/*.md` file)
- Consider updating estimates for similar future tasks (UPDATE `pm_backlog_items.est_tokens` going forward)
- If pattern repeats, investigate root cause (tooling, estimation, scope)

---

## Why 4x?

| Multiplier | Problem |
|------------|---------|
| 2x | Too sensitive - complex tasks naturally vary 50-100% |
| 3x | Catches some issues but misses gradual overruns |
| **4x** | Catches genuine runaway loops while allowing variance |
| 5x+ | Too late - significant waste already occurred |

**Historical context:** SPRINT-014 had incidents with 500x+ overruns. A 4x cap would have caught these within the first 5-10% of actual consumption.

---

## Exceptions

The 4x cap does NOT apply to:

| Exception | Reason |
|-----------|--------|
| SR Engineer reviews | Different workflow, variable by PR size |
| PM explicitly specifies different cap | PM has context for exceptions |
| Task file notes "high variance expected" | PM pre-approved higher variance |

---

## Common Overconsumption Causes

| Cause | Prevention |
|-------|------------|
| Edit tool retry loops | Stop after 2 failures, report |
| CI debugging cycles | Don't poll CI, hand off to SR |
| Large file reads | Use `--silent`, limit output |
| Verbose command output | Pipe to `tail -20`, use `--quiet` |
| Scope expansion | Stop and report, don't absorb |

---

## Token Cap Report Format

See `engineer.md` for the exact format to use when reporting.

The report should include:
1. Task ID and estimates
2. Current progress (what's done, what's remaining)
3. Reason for overconsumption
4. Options for PM to choose from
