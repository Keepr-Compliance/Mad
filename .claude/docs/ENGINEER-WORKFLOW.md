# Engineer Workflow Checklist

> **Source of Truth:** Task plans live in `pm_backlog_items.body` in Supabase, not in `.claude/plans/tasks/*.md` files. Progress notes, decisions, and Implementation Summary entries go in `pm_comments` (or an UPDATE to `pm_backlog_items.body`), not in on-disk task files. The `.claude/.current-task` file is the IPC contract for the metrics hook — leave it alone.

**MANDATORY**: Follow these steps for every task. Each agent step requires recording the Agent ID for metrics collection.

---

## Quick Reference: 6-Step Task Cycle (within 15-step handoff lifecycle)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: PLAN        → Plan Agent creates implementation plan               │
│                         📋 Record: Plan Agent ID                            │
│                                                                             │
│  STEP 2: SR REVIEW   → SR Engineer reviews and approves plan                │
│                         📋 Record: SR Engineer Agent ID                     │
│                                                                             │
│  STEP 3: USER REVIEW → User reviews and approves plan                       │
│                         ⏸️  GATE: Wait for user approval                    │
│                                                                             │
│  STEP 4: COMPACT     → Context reset before implementation                  │
│                         🔄 Fresh context for clean implementation           │
│                                                                             │
│  STEP 5: IMPLEMENT   → Engineer implements approved plan                    │
│                         📋 Record: Engineer Agent ID                        │
│                                                                             │
│  STEP 6: PM UPDATE   → PM updates status + records metrics                  │
│                         📋 See: PM Status Updates section below             │
└─────────────────────────────────────────────────────────────────────────────┘

**This 6-step cycle maps to Steps 5-14 of the 15-step agent-handoff lifecycle.**
**Full lifecycle:** `.claude/skills/agent-handoff/SKILL.md`
```

**CRITICAL:**
- Each agent invocation MUST record its Agent ID immediately
- NO implementation before Steps 1-3 complete
- User approval is a BLOCKING gate

---

## Agent ID Tracking Table (Per Task)

**Copy this into a `pm_comments` entry on the backlog item (or include it in your handoff message) and fill in as you progress. Do NOT write it to a `.claude/plans/tasks/*.md` file.**

| Step | Agent Type | Agent ID | Tokens | Status |
|------|------------|----------|--------|--------|
| 1. Plan | Plan Agent | ___________ | ___K | ☐ |
| 2. SR Review | SR Engineer Agent | ___________ | ___K | ☐ |
| 3. User Review | (No agent) | N/A | N/A | ☐ |
| 4. Compact | (Context reset) | N/A | N/A | ☐ |
| 5. Implement | Engineer Agent | ___________ | ___K | ☐ |

**After task completion, collect metrics:**
```bash
grep "<plan_agent_id>" .claude/metrics/tokens.csv
grep "<sr_engineer_agent_id>" .claude/metrics/tokens.csv
grep "<engineer_agent_id>" .claude/metrics/tokens.csv
```

---

## Pre-Work: Create Branch

**Before starting the 5-step cycle:**

```bash
# Always start from the integration branch (PM creates int/<sprint-name> at sprint start)
git checkout int/<sprint-name>
git pull origin int/<sprint-name>

# Create feature branch with task ID
git checkout -b feature/task-XXX-description
```

**IMPORTANT: All sprint PRs target the integration branch (`int/<sprint-name>`), NOT develop.**
The PM will create `int/<sprint-name>` from develop at sprint start. The task plan in `pm_backlog_items.body` will specify the PR target branch. If no integration branch is specified, ask the PM before creating a PR.

**Incident Reference:** SPRINT-P Phase 1 — targeting develop directly with multiple PRs caused 5+ hours of sequential CI waits due to `strict: true` cascade.

**Naming Convention:**
- `fix/task-XXX-...` for bug fixes
- `feature/task-XXX-...` for new features
- `claude/task-XXX-...` for AI-assisted work

---

## Step 1: PLAN (Read-Only Exploration)

**Purpose:** Create a detailed implementation plan before any code is written.

**Who:** Engineer agent — planning phase is read-only (no Edit/Write of production files).

**IMPORTANT:** Do NOT use `EnterPlanMode` — it requires interactive user approval and does not work inside subagent context. Instead, the engineer explores with read-only tools (Glob, Grep, Read) and writes the plan to the task file.

**Actions:**
1. Read the task plan from Supabase: `SELECT pm_get_item_by_legacy_id('TASK-XXX');` then read `body`
2. Explore relevant codebase files (read-only)
3. Identify all files to modify/create
4. Create step-by-step implementation plan
5. Document any risks or concerns
6. Write the plan back to Supabase — either UPDATE `pm_backlog_items.body` (for umbrella refactor) or `pm_add_comment('<backlog_item_uuid>', '<plan markdown>')` (for incremental). Do NOT create a `.claude/plans/tasks/*.md` file. Do NOT edit production files yet.

**Deliverable:** Implementation plan stored in Supabase (`pm_backlog_items.body` or `pm_comments`)

**IMMEDIATELY RECORD:**
```
Plan Agent ID: <agent_id from Task tool output>
```

**Exit Criteria:**
- [ ] Plan covers all acceptance criteria
- [ ] Files to modify are identified
- [ ] Risks are documented
- [ ] Plan Agent ID recorded

---

## Step 2: SR REVIEW (SR Engineer Agent)

**Purpose:** Technical validation of the plan before user review.

**Who:** SR Engineer Agent (invoke via Task tool with `subagent_type="senior-engineer-pr-lead"`)

**Actions:**
1. Review the implementation plan from Step 1
2. Validate architectural approach
3. Check for security concerns
4. Verify plan aligns with codebase patterns
5. Approve or request changes

**IMMEDIATELY RECORD:**
```
SR Engineer Agent ID: <agent_id from Task tool output>
```

**Exit Criteria:**
- [ ] Plan technically validated
- [ ] No architectural concerns
- [ ] SR Engineer Agent ID recorded
- [ ] SR approval documented

---

## Step 3: USER REVIEW (Blocking Gate)

**Purpose:** User approves the plan before any implementation begins.

**Who:** User (human)

**Actions:**
1. Present plan to user
2. Explain approach and any tradeoffs
3. Answer user questions
4. Get explicit approval

**⚠️ BLOCKING GATE:**
- Do NOT proceed to Step 4 without user approval
- If user requests changes, go back to Step 1

**Exit Criteria:**
- [ ] User has reviewed the plan
- [ ] User has explicitly approved
- [ ] Any user feedback incorporated

---

## Step 4: COMPACT (Context Reset)

**Purpose:** Reset context for clean implementation with fresh token budget.

**Who:** System (user triggers `/compact` or starts new session)

**Actions:**
1. User runs `/compact` command OR
2. User starts a new Claude session
3. Implementation begins with fresh context

**Why Compact?**
- Planning and review consume tokens
- Fresh context = more tokens for implementation
- Reduces confusion from planning exploration

**Exit Criteria:**
- [ ] Context compacted or new session started
- [ ] Ready for implementation

---

## Step 5: IMPLEMENT (Engineer Agent)

**Purpose:** Execute the approved plan.

**Who:** Engineer Agent (invoke via Task tool with `subagent_type="engineer"`)

**Actions:**
1. Read the approved plan
2. Implement exactly as specified
3. Run tests: `npm test`
4. Run type check: `npm run type-check`
5. Run lint: `npm run lint`
6. Create PR
7. Wait for CI
8. Request SR review for merge
9. Merge and verify

**IMMEDIATELY RECORD:**
```
Engineer Agent ID: <agent_id from Task tool output>
```

The agent_id is returned by the Task tool when the agent completes. Record it immediately — it is the key that links to `.claude/metrics/tokens.csv` for PM aggregation and sprint retrospectives.

**MANDATORY: Effort Reporting in Handoff**

When handing off to SR Engineer or PM, the engineer MUST include the `### Effort` section from the handoff template:

```markdown
### Effort
- **Agent ID:** `<agent_id>`
- **Total Tokens:** ~XK
- **Duration:** ~X min
- **Task Estimate:** ~XK (from task file)
```

Without this data, PM cannot label metrics entries, `sum_effort.py` cannot aggregate task totals, and the sprint rollup PR will fail the `pr-metrics-check` CI validation.

**Exit Criteria:**
- [ ] Code implemented per plan
- [ ] All tests pass
- [ ] PR created and merged
- [ ] Engineer Agent ID recorded
- [ ] `### Effort` section included in handoff message

**STOP if you encounter blockers** - ask PM before proceeding.

---

## PM Status Updates (At EVERY Transition)

**CRITICAL:** PM updates status at each workflow transition, not just at task completion. This prevents status drift and ensures the sprint plan always reflects reality.

**Who:** PM Agent or PM (human) — engineers do NOT update status files.

**Updated via Supabase** (source of truth):
- `pm_backlog_items` table — `status` column for each item
- `pm_sprints` table — sprint status

**Valid Statuses:** `pending`, `in_progress`, `testing`, `completed`, `deferred`

### When PM Updates Status

| Transition | Supabase pm_backlog_items | Trigger |
|-----------|--------------------------|---------|
| Engineer agent assigned (Step 5) | → `in_progress` | PM kicks off engineer |
| PR created + CI passes (Step 12) | → `testing` | SR notifies PM |
| PR merged (Step 12b) | → `completed` | SR confirms merge |
| Plan rejected (Step 8) | → `deferred` | SR rejects plan |

### PM Final Update (After Merge)

After each task's PR merges:

**PM Actions:**
1. Verify Supabase `pm_backlog_items.status` is `completed` (and `pm_tasks.status` if applicable)
2. Verify the In-Scope table inside `pm_sprints.body` shows the task as `Completed`
3. Record actual metrics vs estimates via `pm_record_task_tokens('<task_uuid>')`
4. Metrics are already in Supabase (`pm_token_metrics`) auto-captured by the SubagentStop hook. CSV at `.claude/metrics/tokens.csv` is append-only backup only.

**PM Metrics to Record:**

| Metric | Source | Destination |
|--------|--------|-------------|
| Plan Agent tokens | `SELECT * FROM pm_token_metrics WHERE agent_id = '<plan_agent_id>'` | Rollup row in `pm_backlog_items.actual_tokens` |
| SR Review tokens | `SELECT * FROM pm_token_metrics WHERE agent_id = '<sr_agent_id>'` | Rollup row in `pm_backlog_items.actual_tokens` |
| Engineer tokens | `SELECT * FROM pm_token_metrics WHERE agent_id = '<engineer_agent_id>'` | Rollup row in `pm_backlog_items.actual_tokens` |
| Total task tokens | Sum of above (or `pm_record_task_tokens`) | `pm_backlog_items.actual_tokens` |
| Variance | Estimated vs Actual | In-Scope table inside `pm_sprints.body` |

**Exit Criteria:**
- [ ] `pm_backlog_items.status` → `completed`
- [ ] `pm_tasks.status` → `completed` (if separate task row exists)
- [ ] Sprint body In-Scope table → `Completed`
- [ ] Metrics rolled up via `pm_record_task_tokens` and variance calculated

---

## Test Hygiene (MANDATORY — Before Every Commit)

**Reference:** BACKLOG-1356 — repeated CI failures in SPRINT-O from stale tests.

Engineers MUST complete these checks before committing or pushing. Do not rely on CI to catch test failures.

### Before Committing

1. **Run tests locally first:**
   ```bash
   npx jest --bail --no-coverage
   ```
   If any test fails, fix it before committing. Do not push broken tests.

2. **Find and update all affected test files:**
   When you change a function's behavior (return value, call count, parameters, error handling), find every test that references it:
   ```bash
   # Search for test files referencing the function/component you changed
   grep -r "functionName" --include="*.test.*" src/ electron/
   ```
   Update ALL matching test expectations to match the new behavior. Stale mocks and assertions are the #1 cause of CI failures.

3. **Check mock alignment:**
   If you changed a function signature, added a parameter, or changed a return type, verify that all mocks of that function match the new signature. Mismatched mocks cause false passes locally and failures in CI.

### Before Pushing

4. **Merge the base branch into your feature branch:**
   ```bash
   git fetch origin
   git merge origin/develop  # or origin/int/<sprint-name> if targeting an integration branch
   npx jest --bail --no-coverage
   ```
   Other PRs may have merged test fixes. Merging before pushing ensures your branch is tested against the latest state.

5. **Verify PR body includes Engineer Metrics:**
   The PR body MUST include the `## Engineer Metrics` section from `.github/PULL_REQUEST_TEMPLATE.md`. PRs missing this section will fail the CI `pr-metrics-check` validation.

### Why This Matters

Every CI failure costs 5-15 minutes of pipeline time and often requires a second engineer invocation to fix. Catching test failures locally eliminates this waste. During SPRINT-O, PRs averaged 2-5 CI cycles before going green — all preventable with local test runs.

---

## Implementation Details (Within Step 5)

The following details apply during Step 5 (IMPLEMENT):

### PR Creation

**Only create PR when:**
- [ ] Code implemented per approved plan
- [ ] All tests pass locally
- [ ] Type check passes
- [ ] Lint passes

**Create PR:**
```bash
git add .
git commit -m "type(scope): description

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

git push -u origin your-branch-name
gh pr create --base int/<sprint-name> --title "..." --body "..."
```

### CI and Debug Failures

1. **Wait for CI to complete:**
   ```bash
   gh pr checks <PR-NUMBER> --watch
   ```

2. **If CI fails - Debug and Fix:**
   ```bash
   gh run view <RUN-ID> --log-failed
   ```
   - Test failures → Run `npm test` locally, fix, push
   - Type errors → Run `npm run type-check`, fix, push
   - Lint errors → Run `npm run lint --fix`, commit, push

3. **Once ALL checks pass, request SR review for merge:**
   - Use the `senior-engineer-pr-lead` agent
   - This is a PR review, different from the plan review in Step 2

### Merge (SR Engineer Responsibility)

**CRITICAL: A PR is NOT complete until MERGED. The SR Engineer owns the merge — NOT the Engineer.**

After SR Engineer approves and user tests/approves:

```bash
# SR Engineer merges (not the Engineer)
gh pr merge <PR-NUMBER> --merge

# SR Engineer verifies merge state - MUST show "MERGED"
gh pr view <PR-NUMBER> --json state --jq '.state'
```

| Result | Meaning | Action |
|--------|---------|--------|
| `MERGED` | Success - SR notifies PM | Proceed to Step 6 |
| `OPEN` | Merge failed | SR Engineer investigates and retries |
| `CLOSED` | PR closed without merge | Work is LOST - escalate |

### When Merge is Blocked by Branch Protection

If `gh pr merge` fails with "the base branch policy prohibits the merge":

1. **Do NOT use `--admin`** — ever
2. Merge the target branch into your feature branch (usually the int branch, or develop for the final int→develop PR):
   ```bash
   git fetch origin  # fetch the target branch (int/<sprint-name> or develop)
   git merge origin/<target-branch> --no-edit  # int/<sprint-name> or develop
   git push origin <your-branch>
   ```
3. Wait for CI to pass on the updated branch
4. Try `gh pr merge <PR> --merge` again

**Why this happens:** Branch protection has `strict: true`, meaning your branch must include the latest target branch commits. When other PRs merge to develop while your CI is running, your branch falls behind.

**When merging multiple PRs sequentially:** Each merge moves develop forward. Before merging the next PR, always merge develop into it first.

### Session-End Check

Before ending any session:
```bash
gh pr list --state open --author @me
```

If any approved PRs are still open, merge them NOW.

---

## Parallel Task Execution

Sometimes PM will assign multiple tasks to run in parallel. This is only safe when SR Engineer has reviewed and approved parallel execution.

### Recommended: Git Worktree Pattern

**SPRINT-009 Lesson:** Git worktrees work well for parallel independent tasks. Each worktree is a separate working directory with its own branch, preventing conflicts.

**Setup (one-time):**
```bash
# From main repository
cd /path/to/Mad

# Create worktrees for parallel tasks
git worktree add ../Mad-TASK-601 feature/TASK-601-description
git worktree add ../Mad-TASK-602 feature/TASK-602-description
```

**Benefits:**
- Isolated working directories (no uncommitted file conflicts)
- Each worktree has its own branch
- Can run parallel Claude sessions, one per worktree
- Git handles tracking automatically

**Cleanup after merge:**
```bash
git worktree remove ../Mad-TASK-601
git worktree remove ../Mad-TASK-602
```

### When You're Assigned Parallel Tasks

**You will be told explicitly:**
```
Parallel Assignment: TASK-XXX and TASK-YYY
These tasks are approved for parallel execution.
Create separate branches for each.
Use worktrees for isolation (recommended).
```

**Rules for parallel work:**
1. Each task gets its own branch (from develop)
2. Use worktrees for isolation (recommended)
3. Do NOT modify files that aren't listed in your task
4. If you discover shared file needs, STOP and notify PM
5. Submit PRs independently - don't wait for the other task

### When Parallel Goes Wrong

**Warning signs:**
- You need to modify a file not in your task scope
- Git shows conflicts when you pull develop
- Another task's PR merged changes you depend on

**If this happens:**
1. STOP work immediately
2. Notify PM: "Parallel conflict detected"
3. Wait for PM/SR guidance on resolution

### Why Same-Session Parallel Can Fail

When two agents run in the **same Claude Code session**, they share:
- The same working directory
- The same uncommitted file state

**What happens:**
1. Agent A writes to `databaseService.ts` (uncommitted)
2. Agent B reads `databaseService.ts` - sees A's uncommitted changes
3. Agent B tries to edit - conflicts with A's version
4. Both agents re-read/re-write in a loop, burning tokens

**This is NOT a git branch problem** - branches only matter at commit/merge time.

**Safe parallel requires:**
- Separate working directories (different terminal sessions)
- OR truly isolated files (no overlap)
- OR sequential execution with commits between tasks

### Token Burn Early Warning

If a parallel task exceeds **2x estimated tokens** in first 10% of work:
- This may indicate agent conflict (shared file loop)
- Notify PM immediately
- Do not continue burning tokens hoping it resolves

## What NOT To Do

| Don't | Why |
|-------|-----|
| Skip branch creation | Makes tracking and rollback impossible |
| Forget to track metrics | PM needs data for estimation calibration |
| Create PR without metrics | SR Engineer will block it |
| Merge your own PR | Only SR Engineer merges |
| Start next task without PM | PM assigns based on priorities |
| Modify files outside task scope | Can cause parallel conflicts |
| Continue when tokens exceed 2x estimate | Early warning of problems |

---

## Checklist Template

Copy this into a `pm_comments` entry on the backlog item (or include it in your handoff message). Do NOT write it to a `.claude/plans/tasks/*.md` file.

```
## Task Checklist: TASK-XXX

### Pre-Work
- [ ] Created branch from sprint branch (or worktree for parallel work)
- [ ] Read task plan from `pm_backlog_items.body` (via `pm_get_item_by_legacy_id`)

### Step 1: PLAN
- [ ] Invoked Plan agent
- [ ] Plan Agent ID: _______________
- [ ] Plan covers all acceptance criteria
- [ ] Files to modify identified
- [ ] Plan written to Supabase (`pm_comments` or `pm_backlog_items.body`)

### Step 2: SR REVIEW
- [ ] Invoked SR Engineer agent to review plan
- [ ] SR Engineer Agent ID: _______________
- [ ] Plan technically validated
- [ ] SR approval documented

### Step 3: USER REVIEW (BLOCKING GATE)
- [ ] Plan presented to user
- [ ] User questions answered
- [ ] User explicitly approved plan
- [ ] Ready for implementation

### Step 4: COMPACT
- [ ] Context compacted (or new session started)
- [ ] Ready for clean implementation

### Step 5: IMPLEMENT
- [ ] Invoked Engineer agent
- [ ] Engineer Agent ID: _______________
- [ ] Code implemented per approved plan
- [ ] Tests pass (npm test)
- [ ] Type check passes (npm run type-check)
- [ ] Lint passes (npm run lint)
- [ ] PR created
- [ ] CI passes
- [ ] SR Engineer PR review requested
- [ ] PR merged and verified

### Step 6: PM UPDATE
- [ ] PM notified of completion
- [ ] `pm_sprints.body` In-Scope table updated (status → Completed, Actual Tokens filled)
- [ ] `pm_backlog_items.status` → `completed`, `pm_tasks.status` → `completed`
- [ ] Metrics rolled up via `pm_record_task_tokens`

### Agent ID Summary (for metrics collection)

| Step | Agent ID | Tokens |
|------|----------|--------|
| Plan | _________ | ___K |
| SR Review | _________ | ___K |
| Implement | _________ | ___K |
| **TOTAL** | - | ___K |

**Variance:** PM Est ~___K vs Actual ~___K (___% over/under)
```

---

## Enforcement Mechanisms

This workflow is **technically enforced** through multiple mechanisms:

### 1. Blocking Gates

| Gate | Enforced By | Cannot Proceed Without |
|------|-------------|------------------------|
| Step 1 → Step 2 | System | Plan Agent ID recorded |
| Step 2 → Step 3 | SR Engineer | SR approval documented |
| Step 3 → Step 4 | User | Explicit user approval |
| Step 5 → Step 6 | System | PR merged (state = MERGED) |

### 2. Agent ID Verification

All three Agent IDs (Plan, SR Review, Implement) must be recorded:

| Check | When Verified | Consequence if Missing |
|-------|---------------|------------------------|
| Plan Agent ID | Before Step 2 | SR Engineer blocks review |
| SR Engineer Agent ID | Before Step 3 | User gate blocked |
| Engineer Agent ID | Before Step 6 | PM rejects task completion |

### 3. CI Validation (Automated)

The `pr-metrics-check.yml` workflow validates PRs:

| Check | Validation | Failure Action |
|-------|------------|----------------|
| Agent ID Summary table | Must be present | PR blocked |
| All three Agent IDs | Must be filled (not blank) | PR blocked |
| Variance calculation | Must be present | PR blocked |

### 4. Workflow Violations

| Violation | Detection Method | Consequence |
|-----------|------------------|-------------|
| Skipped Step 1 (Plan) | Missing Plan Agent ID | PR rejected |
| Skipped Step 2 (SR Review) | Missing SR Agent ID | User gate blocked |
| Skipped Step 3 (User Review) | No user approval | Implementation blocked |
| Missing Agent IDs | CI/SR check | PR rejected |
| Incomplete metrics | PM review | Task not marked complete |

### 5. Violation Recovery

If you violate the workflow:

1. **Skipped Plan step:**
   - STOP implementation
   - Invoke Plan agent retroactively
   - Document as "DEVIATION: Plan created post-implementation"
   - Include retroactive Plan Agent ID

2. **Skipped SR Review:**
   - STOP and invoke SR Engineer for plan review
   - Document deviation

3. **Missing Agent IDs:**
   - Query Supabase: `SELECT agent_id, session_id, agent_type, recorded_at FROM pm_token_metrics ORDER BY recorded_at DESC LIMIT 20;`
   - (Fallback only) Check `.claude/metrics/tokens.csv` append-only backup
   - Document estimation method in a `pm_comment` on the backlog item

4. **CI Blocking PR:**
   - Update PR description with Agent ID Summary table
   - Push any additional commits
   - Wait for CI to re-run

---

## Questions?

- **Workflow issues:** Ask PM
- **Technical blockers:** Ask SR Engineer
- **Task clarification:** Ask PM before starting
- **Enforcement questions:** See `.claude/agents/engineer.md` for details
