# Metrics Tracking Guide

**Status:** DEPRECATED - See `.claude/docs/shared/metrics-templates.md` for current format
**Last Updated:** 2026-01-03

---

> **DEPRECATION NOTICE (2026-01-03 / updated 2026-06-07)**
>
> This document uses the legacy turn-based metrics format which has been replaced by auto-captured metrics via SubagentStop hook → Supabase `pm_token_metrics`.
>
> Additionally, all references in this doc to writing metrics to "the task file", "INDEX.md", or `.claude/plans/...` paths are obsolete. Source of truth is now Supabase (`pm_sprints.body`, `pm_backlog_items.body`, `pm_comments`, `pm_token_metrics`). The CSV at `.claude/metrics/tokens.csv` is append-only backup only.
>
> **For current metrics format, see:** `.claude/docs/shared/metrics-templates.md`
>
> **Key changes:**
> - Turns (manual count) → API Calls (auto-captured)
> - Tokens (estimate: Turns × 4K) → Total Tokens (auto-captured)
> - Time (self-reported) → Duration (auto-captured, seconds)
> - Task file metrics sections → `pm_comments` on the backlog item
> - INDEX.md aggregate tables → `pm_sprints.body` In-Scope table + `pm_backlog_items.actual_tokens`
>
> This document is preserved for historical reference only.

---

## Overview (LEGACY)

This guide defines the LEGACY metrics tracked across the Magic Audit development workflow. For current metrics, see `metrics-templates.md`.

Metrics enable:

- Estimation calibration (improving future estimates)
- Workflow efficiency analysis (identifying bottlenecks)
- Resource planning (capacity and effort prediction)
- Trend analysis (improvement over time)

---

## 1. Engineer Metrics (Per Task) - LEGACY

Engineers record these metrics for each task in their PR description.

> **DEPRECATED:** Engineers now only need to record their Agent ID. Metrics are auto-captured.

### Required Fields

| Metric | Description | How to Measure |
|--------|-------------|----------------|
| **Turns** | Number of user messages/prompts | Count each message in session |
| **Tokens** | Estimated token usage | Turns x 4K (adjust for long file reads: +2-5K each) |
| **Active Time** | LLM computation/response time | Time spent in active work |
| **Wall-Clock Time** | Total elapsed time | Task start to PR creation |

### Phase Breakdown

| Phase | What to Count | Includes |
|-------|---------------|----------|
| **Planning (Plan)** | Plan agent invocations | Plan creation, revisions, approval |
| **Implementation (Impl)** | Actual coding | File modifications, testing, exploration |
| **Debugging (Debug)** | CI failures, bug fixes | Test fixes, lint fixes, type errors |

### Estimation Variance

Calculate variance as:
```
Variance % = ((Actual - Estimated) / Estimated) * 100
```

**Acceptable variance ranges:**
| Variance | Classification |
|----------|---------------|
| -20% to +20% | Good estimate |
| +20% to +50% | Slightly underestimated |
| -50% to -20% | Overestimated |
| > +50% | Significantly underestimated |
| < -50% | Significantly overestimated |

### PR Description Format

```markdown
## Engineer Metrics: TASK-XXX

**Task Start:** YYYY-MM-DD HH:MM
**Task End:** YYYY-MM-DD HH:MM
**Wall-Clock Time:** X min

| Phase | Turns | Tokens | Active Time |
|-------|-------|--------|-------------|
| Planning (Plan) | X | ~XK | X min |
| Implementation (Impl) | X | ~XK | X min |
| Debugging (Debug) | X | ~XK | X min |
| **Engineer Total** | X | ~XK | X min |

**Estimated vs Actual:**
- Est Turns: X-Y -> Actual: X (variance: X%)
- Est Wall-Clock: X-Y min -> Actual: X min (variance: X%)

**Planning Notes:** [Plan revisions, key decisions]
**Implementation Notes:** [Approach summary, deviations from plan]
```

---

## 2. Sprint Metrics (Aggregate)

PM aggregates these metrics across all tasks in a sprint.

### Task Completion Metrics

| Metric | Description | Formula |
|--------|-------------|---------|
| **Task Completion Rate** | Planned vs completed | (Completed / Planned) * 100 |
| **Total Turns** | Sum of all engineer turns | Sum(task.turns) |
| **Total Tokens** | Sum of all token usage | Sum(task.tokens) |
| **Total Active Time** | Sum of active work time | Sum(task.activeTime) |

### Quality Metrics

| Metric | Description | Formula |
|--------|-------------|---------|
| **CI Failure Rate** | Failures per PR | (CI Failures / Total PRs) * 100 |
| **Rework Count** | PRs requiring changes | Count of revision requests |
| **Merge Conflict Rate** | PRs with conflicts | (PRs with conflicts / Total PRs) * 100 |

### Time Metrics

| Metric | Description | Measurement |
|--------|-------------|-------------|
| **Time to PR** | Branch creation to PR | Avg time per task |
| **Time to Merge** | PR creation to merge | Avg time per PR |
| **Phase Duration** | Phase start to complete | Per-phase tracking |

### Estimation Accuracy

| Metric | Description | Formula |
|--------|-------------|---------|
| **Estimation Accuracy** | Overall accuracy | 100 - Abs(Avg Variance) |
| **Category Accuracy** | Per-category accuracy | Grouped by task type |
| **Variance Trend** | Improvement over sprints | Compare across sprints |

### Sprint Metrics Table Format

```markdown
## Sprint Metrics Summary

### Completion

| Metric | Value |
|--------|-------|
| Tasks Planned | X |
| Tasks Completed | X |
| Completion Rate | X% |
| Total PRs Merged | X |

### Effort

| Metric | Estimated | Actual | Variance |
|--------|-----------|--------|----------|
| Total Turns | X | X | X% |
| Total Tokens | ~XK | ~XK | X% |
| Total Time | X hours | X hours | X% |

### Quality

| Metric | Count | Rate |
|--------|-------|------|
| CI Failures | X | X per PR |
| Rework Requests | X | X% |
| Merge Conflicts | X | X% |

### Time

| Metric | Avg | Min | Max |
|--------|-----|-----|-----|
| Time to PR | X min | X | X |
| Time to Merge | X min | X | X |
```

---

## 3. Growth Metrics (Trend Over Sprints)

PM tracks these metrics across multiple sprints to identify improvement trends.

### Estimation Improvement

| Metric | Description | Goal |
|--------|-------------|------|
| **Estimation Accuracy Trend** | Accuracy over last 3 sprints | Increasing |
| **Category Calibration** | Per-category multiplier stability | Stable/decreasing variance |
| **Outlier Frequency** | Tasks with >50% variance | Decreasing |

### Efficiency Improvement

| Metric | Description | Goal |
|--------|-------------|------|
| **Avg Turns per Task** | By category over time | Decreasing or stable |
| **Debug-to-Impl Ratio** | Debug turns / Impl turns | Decreasing |
| **Time to First PR** | Trend over sprints | Decreasing |

### Quality Improvement

| Metric | Description | Goal |
|--------|-------------|------|
| **CI Stability Trend** | Failure rate over time | Decreasing |
| **Rework Rate Trend** | Revision requests over time | Decreasing |
| **First-Pass Merge Rate** | PRs merged without rework | Increasing |

### Growth Metrics Dashboard Format

```markdown
## Growth Metrics (Last 3 Sprints)

### Estimation Accuracy Trend

| Sprint | Overall Accuracy | Best Category | Worst Category |
|--------|------------------|---------------|----------------|
| SPRINT-007 | X% | refactor (X%) | ipc (X%) |
| SPRINT-008 | X% | test (X%) | schema (X%) |
| SPRINT-009 | X% | cleanup (X%) | service (X%) |

**Trend:** Improving / Stable / Declining

### Category Multipliers Over Time

| Category | SPRINT-007 | SPRINT-008 | SPRINT-009 | Recommended |
|----------|------------|------------|------------|-------------|
| refactor | 0.5x | 0.4x | 0.3x | 0.3x |
| security | 1.0x | 1.0x | 1.0x | 1.0x |
| test | 1.2x | 1.0x | 1.0x | 1.0x |
| schema | 1.5x | 1.3x | 1.3x | 1.3x |

### Quality Trends

| Metric | SPRINT-007 | SPRINT-008 | SPRINT-009 | Trend |
|--------|------------|------------|------------|-------|
| CI Failure Rate | X% | X% | X% | Down |
| Rework Rate | X% | X% | X% | Down |
| First-Pass Merge | X% | X% | X% | Up |
```

---

## 4. Estimation Multipliers

Based on historical data, apply these multipliers when estimating tasks.

### Current Calibrated Multipliers (SPRINT-009)

| Category | Turn Multiplier | Wall-Clock Multiplier | Notes |
|----------|-----------------|----------------------|-------|
| **refactor** | 0.3x | 3x | Well-structured extractions |
| **security** | 1.0x | 3x | Audits require careful review |
| **test** | 1.0x | 3x | Test writing is predictable |
| **schema** | 1.3x | 3x | High variance, add buffer |
| **config** | 0.5x | 3x | Usually overestimated |
| **service** | 1.0x | 3x | TBD - need data |
| **ipc** | 1.5x | 3x | Suspected underestimate |
| **ui** | 1.0x | 3x | TBD - need data |
| **cleanup** | 0.5x | 3x | Simple file operations |

### How to Apply Multipliers

1. PM creates initial estimate based on task complexity
2. Apply category multiplier to get adjusted estimate
3. Example: 10-14 turns for refactor task
   - Apply 0.3x -> Expect 3-4 actual turns
   - Apply 3x wall-clock -> Expect 15-20 min real time

### Updating Multipliers

After each sprint, calculate new multipliers:

```
New Multiplier = Avg Actual Turns / Avg Estimated Turns
```

**Smoothing:** Weight new data at 30%, historical at 70%:
```
Updated = (0.3 * New) + (0.7 * Current)
```

---

## 5. Phase Retro Metrics Requirements

### What PM Must Record (Per Phase)

After each phase completes, PM produces a phase retro report with:

| Section | Metrics Included |
|---------|------------------|
| **Completion** | Tasks completed, blocked, partial |
| **Effort** | Total turns, tokens, time per task |
| **Quality** | CI failures, rework, conflicts |
| **Variance** | Estimated vs actual by task |

### What SR Engineer Contributes

SR Engineer adds to phase retro:

| Contribution | Description |
|--------------|-------------|
| **Quality Issues** | Code quality problems observed |
| **Architecture Concerns** | Boundary violations, pattern breaks |
| **Patterns to Reinforce** | Good practices to continue |
| **Patterns to Avoid** | Anti-patterns observed |

### What Engineers Record (In Task File)

Before handoff to SR, engineers update task file with:

| Field | Description |
|-------|-------------|
| **Actual Turns** | Total turns for task |
| **Tokens Est** | Estimated token usage |
| **Active Time** | LLM active work time |
| **Deviations** | Any changes from plan |
| **Issues** | Blockers or challenges |

---

## 6. Metrics Collection Points

### When to Record Metrics

| Event | Who Records | Where |
|-------|-------------|-------|
| Task Start | Engineer | Task file (start time) |
| Plan Complete | Engineer | Task file (plan metrics) |
| PR Created | Engineer | PR description |
| PR Merged | SR Engineer | PR description (SR metrics) |
| Phase Complete | PM | Phase retro report |
| Sprint Complete | PM | Sprint summary |

### Metrics Flow

```
Engineer Task File    ->    PR Description    ->    Phase Retro
     ^                           ^                       ^
     |                           |                       |
  Start time              Engineer Metrics         Aggregated
  Est vs Actual              SR Metrics            Sprint-level
```

---

## 7. Metrics Storage Locations

| Metrics Type | Location | Format |
|--------------|----------|--------|
| Task Metrics | PR description | Markdown table |
| Task Summary | `.claude/plans/tasks/TASK-XXX.md` | Implementation Summary section |
| Sprint Index | `.claude/plans/backlog/INDEX.md` | Estimation Accuracy table |
| Phase Retro | `.claude/plans/sprints/archive/SPRINT-XXX/phase-retros/` | Phase retro report |
| Sprint Metrics | `.claude/plans/sprints/archive/SPRINT-XXX/metrics/` | Aggregate metrics |
| Sprint Summary | `.claude/plans/sprints/archive/SPRINT-XXX/summary.md` | Final summary |

---

## 8. Validation Rules

### CI Enforcement

PRs missing these sections are blocked:
- Engineer Metrics section
- Planning (Plan) row with actual numbers
- Estimated vs Actual comparison

### SR Engineer Verification

SR Engineer rejects:
- Placeholder values ("X" instead of numbers)
- Missing Planning Notes
- Incomplete Implementation Summary

### PM Verification (Phase Retro)

Phase retro must include:
- All task metrics collected
- Variance analysis by category
- Quality issues documented
- Improvement proposals if issues found

---

## 9. Quick Reference

### Token Estimation Guidelines

| Activity | Token Estimate |
|----------|----------------|
| Standard turn | ~4K |
| Long file read (>300 lines) | +2-5K |
| Complex plan generation | ~6-8K |
| Code review with context | ~5-8K |

### Wall-Clock Overhead

| Activity | Time Impact |
|----------|-------------|
| API response latency | 30-90s per turn |
| File exploration | 5-15 min |
| Test execution | 5-10 min |
| Git operations | 3-5 min |

### Healthy Metrics Targets

| Metric | Target | Warning Threshold |
|--------|--------|-------------------|
| Estimation Accuracy | >80% | <60% |
| CI Failure Rate | <20% | >40% |
| Rework Rate | <15% | >30% |
| Debug-to-Impl Ratio | <0.3 | >0.5 |

---

## Related Documentation

| Document | Location |
|----------|----------|
| Metrics Templates | `.claude/docs/shared/metrics-templates.md` |
| Engineer Workflow | `.claude/docs/ENGINEER-WORKFLOW.md` |
| Phase Retro Skill | `.claude/skills/agentic-pm/skills/phase-retro-guardrail-tuner/` |
| Sprint Summary Template | `.claude/skills/agentic-pm/templates/sprint-summary.template.md` |
