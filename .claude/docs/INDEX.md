# Documentation Index

**Last Updated:** 2026-02-19

This is the master index for all Claude agent documentation in Magic Audit.

---

## Quick Navigation

| Need To... | Go To |
|------------|-------|
| Implement a task | [Engineer Workflow](#engineer-workflow) |
| Review a PR | [SR Engineer](#sr-engineer) |
| Plan a sprint | [PM / Agentic PM](#pm--agentic-pm) |
| Create a PR | [PR-SOP](#process-documents) |
| Fix native module issues | [Native Module Fixes](#shared-reference-documents) |
| Understand architecture rules | [Architecture Guardrails](#shared-reference-documents) |

---

## Agent Types & Configuration

These agents are **built-in Task tool types** (invoked via `subagent_type`), not markdown files on disk. Their behavior is configured by the docs listed below.

| Agent (`subagent_type`) | Config Docs | When to Use |
|-------------------------|-------------|-------------|
| **`engineer`** | `.claude/docs/ENGINEER-WORKFLOW.md` + `.claude/skills/agent-handoff/SKILL.md` | Task implementation, branch creation, PR submission |
| **`senior-engineer-pr-lead`** | `.claude/docs/PR-SOP.md` + `.claude/skills/agent-handoff/SKILL.md` | PR review, architecture decisions, merge approval |
| **`agentic-pm`** | `.claude/skills/agentic-pm/SKILL.md` + `.claude/skills/agent-handoff/SKILL.md` | Sprint planning, backlog management, task assignment |

---

## Process Documents

| Document | Location | Purpose |
|----------|----------|---------|
| **PR-SOP** | `.claude/docs/PR-SOP.md` | Complete 9-phase PR checklist |
| **Engineer Workflow** | `.claude/docs/ENGINEER-WORKFLOW.md` | 6-step task implementation checklist (within the 15-step handoff lifecycle) |
| **LLM Integration Testing** | `.claude/docs/LLM-INTEGRATION-TESTING.md` | AI feature testing checklist |

---

## Shared Reference Documents

These are the **canonical sources** for content that was previously duplicated across multiple files. Always reference these instead of duplicating content.

| Document | Location | Content |
|----------|----------|---------|
| **PR Lifecycle** | `.claude/docs/shared/pr-lifecycle.md` | PR completion rules, orphan prevention |
| **Plan-First Protocol** | `.claude/docs/shared/plan-first-protocol.md` | Mandatory planning steps for all agents |
| **Metrics Templates** | `.claude/docs/shared/metrics-templates.md` | Engineer, SR, and PM metrics formats |
| **Architecture Guardrails** | `.claude/docs/shared/architecture-guardrails.md` | Entry file budgets, state machine patterns |
| **State Machine Architecture** | `.claude/docs/shared/state-machine-architecture.md` | App state machine states, transitions, usage |
| **Effect Safety Patterns** | `.claude/docs/shared/effect-safety-patterns.md` | React effect patterns to prevent bugs |
| **Git Branching** | `.claude/docs/shared/git-branching.md` | Branching strategy, merge policy |
| **Native Module Fixes** | `.claude/docs/shared/native-module-fixes.md` | SQLite rebuild troubleshooting |
| **IPC Handler Patterns** | `.claude/docs/shared/ipc-handler-patterns.md` | Electron IPC listener ownership, cleanup |

---

## PM Skill & Modules

The PM skill uses progressive disclosure - load only what you need.

| Module | Location | Purpose |
|--------|----------|---------|
| **Skill Definition** | `.claude/skills/agentic-pm/SKILL.md` | Main PM skill configuration |
| **Backlog Prioritization** | `.claude/skills/agentic-pm/modules/backlog-prioritization.md` | MoSCoW, RICE frameworks |
| **Sprint Selection** | `.claude/skills/agentic-pm/modules/sprint-selection.md` | Phase planning |
| **Task Plan Authoring** | `.claude/skills/agentic-pm/modules/task-file-authoring.md` | Authoring task plans in `pm_backlog_items.body` |
| **Dependency Graph** | `.claude/skills/agentic-pm/modules/dependency-graph.md` | Task dependencies |
| **Testing & Quality** | `.claude/skills/agentic-pm/modules/testing-quality-planning.md` | Test planning |

**Templates:** `.claude/skills/agentic-pm/templates/`

---

## Project Artifacts

| Artifact | Location | Naming Pattern |
|----------|----------|----------------|
| **Sprint plans (source of truth)** | `pm_sprints.body` (Supabase) | Markdown in `body` column |
| **Task plans (source of truth)** | `pm_backlog_items.body` (Supabase) | Markdown in `body` column |
| **Progress / decisions / issues (source of truth)** | `pm_comments` (Supabase) | One row per comment, linked to backlog item |
| **Metrics (source of truth)** | `pm_token_metrics` (Supabase) | Auto-captured by SubagentStop hook |
| `.claude/.current-task` | repo root | IPC contract for the metrics hook (the only on-disk PM artifact for new work) |
| Sprint plans (legacy archive) | `.claude/plans/sprints/` | `SPRINT-NNN-slug.md` — historical only |
| Task files (legacy archive) | `.claude/plans/tasks/` | `TASK-NNN-slug.md` — historical only |
| Archived tasks (legacy archive) | `.claude/plans/tasks/archive/` | `TASK-NNN-slug.md` |
| Backlog CSV (legacy archive) | `.claude/plans/backlog/data/backlog.csv` | Read-only |
| Backlog detail files (legacy archive) | `.claude/plans/backlog/items/` | `BACKLOG-NNN.md` |

**Note:** Supabase is the single source of truth. Do NOT author new `.md` plan/task files. Existing files under `.claude/plans/` are historical archive only.

---

## Main Project Guide

| Document | Location | Purpose |
|----------|----------|---------|
| **CLAUDE.md** | `CLAUDE.md` (project root) | Main development guide, agent workflow, code standards |

---

## Document Maintenance

When updating documentation:

1. **Shared content** → Update in `.claude/docs/shared/`, not in individual files
2. **Process changes** → Update the relevant process doc AND notify agents
3. **New shared patterns** → Create in `.claude/docs/shared/` and reference from agents
4. **Deprecating content** → Add deprecation notice, then remove after one sprint

---

## Version History

| Date | Change | Author |
|------|--------|--------|
| 2024-12-24 | Created shared docs structure, consolidated duplicates | Claude |
| 2026-01-04 | Added state machine architecture documentation (BACKLOG-142 complete) | Claude |
| 2026-01-24 | Added PR lifecycle documentation, orphan PR prevention rules (SPRINT-051/052 incident) | Claude |
| 2026-02-02 | Added IPC handler patterns documentation (SPRINT-068, SR recommendation) | Claude |
