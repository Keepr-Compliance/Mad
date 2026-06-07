# Integration Guide

## How this skill fits into Magic Audit's development workflow

### Workflow Position

```
User Request
    │
    ▼
┌─────────────────────────────┐
│     agentic-pm skill        │  ← Creates sprint plans, manages Supabase backlog
│  (this skill)               │
└─────────────────────────────┘
    │
    ▼
Engineer (subagent) executes task in isolated worktree
    │
    ▼
┌─────────────────────────────┐
│  senior-engineer-pr-lead    │  ← Reviews PR per PR-SOP, merges after user approval
│  agent                      │
└─────────────────────────────┘
    │
    ▼
PR merged to integration branch (int/<sprint-name>)
    │  (or directly to develop for hotfixes)
    ▼
┌─────────────────────────────┐
│ phase-retro-guardrail-tuner │  ← Retrospective, improves process
│ (sub-skill)                 │
└─────────────────────────────┘
    │
    ▼
Next sprint benefits from improvements
```

## Data & Artifact Locations

### Primary Data Store: Supabase

All backlog items, tasks, sprints, and metrics live in Supabase. The legacy CSV (`.claude/plans/backlog/backlog.csv`) is archived/read-only.

| Data | Supabase Table | Access |
|------|----------------|--------|
| Backlog items | `pm_backlog_items` | `pm_update_item_status` RPC |
| Tasks | `pm_tasks` | `pm_update_task_status` RPC |
| Sprints | `pm_sprints` | `pm_close_sprint` RPC |
| Events/audit log | `pm_events` | `pm_log_event` RPC |
| Agent metrics | `pm_agent_metrics` | `pm_log_agent_metrics` RPC |

### Local Artifacts

| Artifact | Location | Notes |
|----------|----------|-------|
| `.claude/.current-task` | repo root | IPC contract for the SubagentStop metrics hook. The ONLY on-disk PM artifact for new work. |

**Note:** Sprint plans live in `pm_sprints.body`, task details in `pm_backlog_items.body`, and decision/risk/issue logs in `pm_comments`. Engineers read task details via MCP. Legacy on-disk files (`.claude/plans/sprints/*.md`, `.claude/plans/tasks/*.md`, `.claude/plans/decision-log.md`, `.claude/plans/risk-register.md`) are historical archive only — do NOT create new ones.

## Related Documentation

| Document | Location | Purpose |
|----------|----------|---------|
| PR-SOP | `.claude/docs/PR-SOP.md` | Full PR checklist (10 phases) |
| Engineer Workflow | `.claude/docs/ENGINEER-WORKFLOW.md` | 6-step task implementation cycle |
| Agent Handoff | `.claude/skills/agent-handoff/SKILL.md` | 15-step lifecycle (authoritative) |
| Project Guide | `CLAUDE.md` | Branching, conventions, quick reference |

## Handoff Points

### PM → Engineer

When issuing a task:
1. Task plan written to `pm_backlog_items.body` in Supabase (no `.claude/plans/tasks/*.md` file)
2. Integration branch created (`int/<sprint-name>`) if sprint has 2+ tasks
3. Status updated to `in_progress` in Supabase via `pm_update_item_status` + `pm_update_task_status`
4. Engineer invoked with task context (legacy_id + backlog_item_id) via handoff template

### Engineer → SR Engineer

When PR is ready:
1. Engineer pushes code, creates PR targeting `int/<sprint-name>`
   - Exception: hotfixes and standalone fixes target `develop` directly
2. SR Engineer reviews using PR-SOP
3. SR Engineer owns the merge (after user testing/approval)

### SR Engineer → PM (via retro)

After phase completion:
1. PM runs `phase-retro-guardrail-tuner` skill
2. Patterns identified from engineer summaries, PR notes
3. Guardrail patches proposed
4. Templates/modules updated for next phase

## Branch Strategy

### Sprint Work (2+ tasks) — Integration Branch Required

```
develop
  │
  └── int/<sprint-name>          ← PM creates at sprint start
        │
        ├── feature/TASK-XXX-a   ← Engineer PRs target int/* branch
        ├── feature/TASK-XXX-b
        └── fix/TASK-XXX-c
              │
              └── After all tasks done: one PR from int/* → develop
```

### Standalone Work (single fix/feature) — Target develop

```
develop
  │
  └── fix/description   ← PR targets develop directly
```

### Branch Naming

| Prefix | Example | Use Case |
|--------|---------|----------|
| `feature/` | `feature/backlog-101-types` | New features |
| `fix/` | `fix/backlog-102-login-crash` | Bug fixes |
| `hotfix/` | `hotfix/security-patch` | Urgent production fixes (target main + develop) |
| `claude/` | `claude/103-refactor-auth` | AI-assisted development |
| `int/` | `int/sprint-name` | Integration branches for sprints |

### Merge Policy

**CRITICAL**: Always traditional merge, never squash. SR Engineer merges — not the Engineer.

## CI Pipeline Integration

### Required Checks

All task PRs must pass:
- [ ] Test & Lint (macOS + Windows, Node 18 + 20)
- [ ] Security Audit
- [ ] Build Application

### Native Module Handling

**Known issue**: `better-sqlite3-multiple-ciphers` requires rebuild after:
- `npm install`
- Node.js version change
- Electron version change

```bash
npm rebuild better-sqlite3-multiple-ciphers
npx electron-rebuild
```

## LLM-Specific Considerations

### Capacity Planning

When planning for agentic engineers (LLM instances):
- Estimate complexity in tokens (using category multipliers from metrics-templates.md)
- Budget ~200K-500K tokens per phase
- Include 20% buffer for exploration

### Context Management

- Tasks sharing contracts should be sequential
- Avoid parallel tasks that modify shared types
- Use integration branches to collect parallel work safely

### Parallel Agent Safety

Each parallel engineer agent MUST use an isolated git worktree:
```bash
git worktree add ../Mad-task-XXX -b feature/TASK-XXX-description int/<sprint-name>
```

### Checkpoints

Insert human review checkpoints:
- After complex tasks (>100K tokens estimated)
- Before integration merges
- When architectural decisions arise
