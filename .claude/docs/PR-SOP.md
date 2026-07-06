# Pull Request Standard Operating Procedure

This document outlines the standard procedure for creating, reviewing, and merging pull requests in Magic Audit. All agents and contributors should follow this SOP.

**LLM Note**: Claude and other AI agents can assist with all phases. Look for 🤖 markers for specific automation opportunities.

## Quick Reference

| PR Type | Target Branch | Merge Type | Required Checks |
|---------|---------------|------------|-----------------|
| Sprint Task | `int/<sprint-name>` | Traditional | Tests, Security |
| Sprint Final | `develop` (from `int/*`) | Traditional | Tests, Security |
| Standalone Feature | `develop` | Traditional | Tests, Security |
| Standalone Bug Fix | `develop` | Traditional | Tests, Security |
| Hotfix | `main` + `develop` | Traditional | Tests, Builds, Security |
| Release | `main` (from develop) | Traditional | All checks |

**CRITICAL: Always use traditional merges (not squash) to preserve commit history.**
**CRITICAL: All sprint PRs target `int/<sprint-name>`, NOT develop directly.**

---

## Phase 0: Target Branch Verification

Before creating a PR, verify you are targeting the correct branch:

| Your Branch Type | Target Branch |
|------------------|---------------|
| `feature/*` (sprint task) | `int/<sprint-name>` |
| `fix/*` (sprint task) | `int/<sprint-name>` |
| `claude/*` (sprint task) | `int/<sprint-name>` |
| `feature/*` (standalone) | `develop` |
| `fix/*` (standalone) | `develop` |
| `hotfix/*` | `main` AND `develop` |
| `develop` (release) | `main` |
| `int/*` (sprint complete) | `develop` |

**MANDATORY: All sprint PRs target the integration branch (`int/<sprint-name>`), NOT develop directly.**
Only the final integration PR (after all sprint work is merged and tested) targets develop.

**Incident Reference:** SPRINT-P Phase 1 — 4 PRs targeting develop directly caused 5+ hours of sequential CI waits due to `strict: true` branch protection cascade.

```bash
# Check your current branch
git branch --show-current

# Verify target branch is up to date
git fetch origin
git log --oneline HEAD..origin/int/<sprint-name>  # For sprint PRs
```

---

## Phase 1: Branch Preparation

### 1.1 Sync Branch
Ensure your branch is up-to-date with the target branch:

```bash
git fetch origin
git merge origin/develop  # or origin/main for hotfixes
```

Resolve any merge conflicts before proceeding.

### 1.2 Dependencies & Native Modules

**CRITICAL: Native Module Rebuild Required**

Native modules like `better-sqlite3-multiple-ciphers` must be compiled for Electron's bundled Node.js version (not your system Node.js). This is a common source of "infinite loop" bugs.

**Standard rebuild (try first):**
```bash
npm rebuild better-sqlite3-multiple-ciphers
npx electron-rebuild
```

**If standard rebuild doesn't work** (common on Windows without Python):
```powershell
# 1. Clear the prebuild cache (may have wrong version cached)
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\npm-cache\_prebuilds"

# 2. Delete the existing build
Remove-Item -Recurse -Force "node_modules\better-sqlite3-multiple-ciphers\build"

# 3. Download the correct Electron-specific prebuild (replace 35.7.5 with your Electron version)
cd node_modules/better-sqlite3-multiple-ciphers
npx prebuild-install --runtime=electron --target=35.7.5 --arch=x64 --platform=win32
```

Check your Electron version with: `npx electron --version`

**Common Error**: If you see `NODE_MODULE_VERSION` mismatch errors:
```
NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 133.
```
This means the native module was compiled for Node.js (127 = Node 22.x) but Electron needs a different version (133). Use the prebuild-install fix above.

### 1.3 Verify App Starts
**Before committing**, always verify the app actually runs:

```bash
npm run dev
```

Check for:
- [ ] No `NODE_MODULE_VERSION` errors in console
- [ ] Database initializes successfully
- [ ] App doesn't get stuck on loading/onboarding screens

---

## Phase 2: Code Cleanup

### 2.1 Remove Debug Code
Search for and remove:
- [ ] `console.log` statements (except structured logging)
- [ ] `console.warn` / `console.error` (unless intentional)
- [ ] Commented-out code blocks
- [ ] Unused imports
- [ ] Dead code / unreachable code
- [ ] TODO comments that should be resolved

```bash
# Find console statements
grep -rn "console\." src/ --include="*.ts" --include="*.tsx"
```

🤖 **LLM Assist**: Use ESLint autofix, codemods, or ask Claude to identify and remove debug code.

### 2.2 Style & Formatting
- [ ] Run Prettier/formatter
- [ ] Verify naming conventions (camelCase for variables, PascalCase for components)
- [ ] Check file structure alignment with project standards

```bash
npm run lint -- --fix
```

🤖 **LLM Assist**: Claude can propose consistent patterns and refactors for naming/structure.

### 2.3 Structured Error Logging
Use the appropriate logger for each process:

**Electron main process:** `LogService` (`electron/services/logService.ts`)
**Renderer process:** `logger` (`src/utils/logger.ts`)

- [ ] Use appropriate log levels: `debug`, `info`, `warn`, `error`
- [ ] Include context in log messages (function name, relevant IDs)
- [ ] No sensitive data in logs (tokens, passwords, PII)
- [ ] Use structured metadata for additional context

```typescript
// Electron main process
import logService from './logService';
logService.info('Processing transaction', 'TransactionService');

// Renderer process
import logger from '@/utils/logger';
logger.info('Sync started', { transactionId: '123' });
```

🤖 **LLM Assist**: Claude can generate consistent, standardized log statements using the LogService pattern.

### 2.4 React Effect Anti-Patterns

Check for these common patterns that cause infinite loops or lost navigation:

#### Callback Effects Must Use Ref Guards
Any `useEffect` that calls a prop callback (e.g., `onXChange`, `onComplete`, `onUpdate`) MUST track the last-reported value:

```typescript
// BAD - causes infinite loops if parent re-renders on callback
useEffect(() => {
  onValueChange?.(value);
}, [value, onValueChange]);

// GOOD - ref guard prevents duplicate calls
const lastValueRef = useRef<typeof value | null>(null);
useEffect(() => {
  if (onValueChange && lastValueRef.current !== value) {
    lastValueRef.current = value;
    onValueChange(value);
  }
}, [value, onValueChange]);
```

- [ ] All `useEffect` callbacks use ref guards

#### Empty State Must Navigate (Not Return Null)
Flow/wizard components that can have zero steps must actively navigate:

```typescript
// BAD - component returns null but user is stuck
if (steps.length === 0) return null;

// GOOD - actively navigates when nothing to show
useEffect(() => {
  if (steps.length === 0) app.goToStep("dashboard");
}, [steps.length, app]);
```

- [ ] Flow components navigate on empty state (not just return null)

#### Related Booleans Checked Together
When checking completion flags, ensure ALL semantically-related states are considered:

```typescript
// BAD - incomplete check
const needsEmailOnboarding = !hasCompletedEmailOnboarding;

// GOOD - checks both completion flag AND actual state
const needsEmailOnboarding = !hasCompletedEmailOnboarding && !hasEmailConnected;
```

- [ ] Related boolean flags are checked together

🤖 **LLM Assist**: Claude can audit useEffect patterns and identify missing ref guards or incomplete conditionals.

---

## Phase 3: Security & Documentation

### 3.1 Security Scan
- [ ] No hardcoded secrets, API keys, or tokens
- [ ] No sensitive data in error messages or logs
- [ ] Input validation on user inputs
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention in React components

```bash
# Check for potential secrets
grep -rn "password\|secret\|api_key\|token" src/ --include="*.ts" --include="*.tsx" | grep -v "type\|interface"
```

🤖 **LLM Assist**: Claude can spot security smells and recommend fixes. Also consider tools like gitleaks, truffleHog, or git-secrets.

### 3.2 Documentation Updates
If applicable, update:
- [ ] README.md sections affected by new features
- [ ] Code comments for complex logic
- [ ] Type definitions
- [ ] .env.example for new environment variables
- [ ] OpenAPI/Swagger JSON if endpoints were added

🤖 **LLM Assist**: Claude can draft README updates, code comments, and documentation for new features.

---

## Phase 4: Testing

### 4.1 Mock Data & Fixtures
- [ ] Test mocks match current API/schema
- [ ] Fixtures are up-to-date
- [ ] No hardcoded test data that could become stale

🤖 **LLM Assist**: Claude can generate fixture JSON, mock data, and update test fixtures to match new schemas.

### 4.2 Automated Tests
- [ ] Unit tests for new functions/utilities
- [ ] Integration tests for new features
- [ ] Component tests for UI changes
- [ ] Snapshot tests (if applicable)
- [ ] Target coverage: 40-80%

🤖 **LLM Assist**: Claude can generate test boilerplate, write full unit tests, and suggest edge cases to cover.

### 4.3 Test Suite Execution
Run the full test suite locally:

```bash
npm test
```

All tests must pass. No skipped tests without justification.

🤖 **LLM Assist**: If tests fail, Claude can analyze failures and suggest fixes.

---

## Phase 5: Static Analysis

### 5.1 Type Check
```bash
npm run type-check
```
- [ ] No TypeScript errors
- [ ] No `any` types without justification

### 5.2 Lint Check
```bash
npm run lint
```
- [ ] No lint errors (warnings acceptable with justification)

### 5.3 Performance Check
Review for:
- [ ] Unnecessary re-renders in React components
- [ ] Missing memoization for expensive computations
- [ ] O(n²) or worse algorithmic complexity
- [ ] Large bundle size additions
- [ ] Inefficient database queries
- [ ] Inefficient use of state or APIs

🤖 **LLM Assist**: Claude can spot performance issues and generate optimization suggestions without manual benchmarking.

---

## Phase 6: Final Automated Code Review

**This is a critical quality gate.** Run the entire branch through Claude to check for:

### 6.1 Code Quality Issues
- [ ] Anti-patterns and code smells
- [ ] Missing error checks / error handling
- [ ] Duplicate logic that should be abstracted
- [ ] Unnecessary complexity
- [ ] Missing null-checks / undefined handling
- [ ] Inconsistent naming conventions
- [ ] Code that needs refactoring
- [ ] **Optional props with silent failures** - verify all interface props are passed from parent components (see "Common Issues" section)

### 6.2 Architecture Compliance
- [ ] Entry file guardrails respected (App.tsx < 70 lines)
- [ ] Business logic not in entry files
- [ ] IPC boundaries respected (main/preload/renderer)
- [ ] Service abstractions used (no direct `window.api` in components)

### 6.3 Review Prompt Template

Use this prompt to request a code review:

```
Please review this branch for PR readiness. Check for:
1. Anti-patterns and code smells
2. Missing error handling
3. Duplicate logic
4. Unnecessary complexity
5. Missing null-checks
6. Inconsistent naming
7. Architecture boundary violations
8. Performance issues
9. Security concerns

Provide specific file:line references and suggested fixes.
```

🤖 **LLM Assist**: This phase replaces manual pre-review and significantly increases PR quality.

---

## Phase 7: PR Creation

### 7.1 Commit History
- [ ] Commits are atomic and focused
- [ ] Commit messages follow conventional format:
  - `feat:` - New feature
  - `fix:` - Bug fix
  - `docs:` - Documentation
  - `refactor:` - Code refactoring
  - `test:` - Adding tests
  - `chore:` - Maintenance

### 7.2 Create PR

```bash
git push -u origin your-branch-name

gh pr create --base int/<sprint-name> --title "type: description" --body "..."  # Use int branch for sprint PRs
```

🤖 **LLM Assist**: Claude can draft PR descriptions based on the changes made.

### 7.3 PR Description Template

```markdown
## Summary
- Bullet points describing what this PR does

## Changes
- List of specific changes made

## Test Plan
- [ ] How to test this change
- [ ] What was tested

## Screenshots (if UI changes)
[Add screenshots here]

## Checklist
- [ ] Tests pass locally
- [ ] Type check passes
- [ ] Lint check passes
- [ ] Documentation updated (if needed)
```

---

## Phase 7.5: MANDATORY Sync with Target Branch

**⚠️ NON-NEGOTIABLE: Always merge the target branch INTO your feature branch before final CI run.**

This step MUST be performed before pushing for final CI verification:

```bash
# 1. Fetch latest from target branch
git fetch origin

# 2. Merge target branch into your feature branch
git merge origin/develop  # or origin/main for hotfixes

# 3. If conflicts exist, resolve them NOW
# 4. Run tests locally to verify nothing broke
npm run type-check
npm test

# 5. Push (this triggers CI on the merged state)
git push
```

**Why this is mandatory:**
- Other PRs may have been merged since you started
- Merge conflicts caught BEFORE merge to develop, not after
- CI runs against the FINAL merged state
- Prevents broken `develop` branch from conflicting changes

**If conflicts exist:**
1. Resolve them in your feature branch
2. Test locally
3. Push the resolution
4. CI will run on the conflict-resolved code

**DO NOT skip this step even if:**
- Your PR was just created
- CI already passed once before
- You think develop hasn't changed

---

## Phase 8: CI Verification

**⚠️ CRITICAL: Never claim CI passed without explicit verification. False CI claims waste user time and erode trust.**

### 8.1 Wait for ALL Checks to Complete

Use `--watch` to block until all checks finish:

```bash
# REQUIRED: Wait for all checks to complete (blocks until done)
gh pr checks <PR-NUMBER> --watch
```

**DO NOT** use `gh pr checks` without `--watch` and assume checks passed - they may still be running.

### 8.2 Verify ALL Jobs Passed

After checks complete, verify EVERY job shows `pass`:

| Check | Required | Description |
|-------|----------|-------------|
| Test & Lint (macOS) | Yes | Unit tests + linting |
| Test & Lint (Windows) | Yes | Cross-platform verification |
| Security Audit | Yes | npm audit |
| Build Application | Yes | Vite + Electron build |
| Package Application | develop/main only | Creates DMG/NSIS installers |

```bash
# Verify all checks passed (should show all green checkmarks)
gh pr checks <PR-NUMBER>

# For develop/main PRs, also check the Package Application step explicitly
gh run list --branch <BRANCH-NAME> --limit 5
gh run view <RUN-ID>  # Check Package Application job status
```

### 8.3 Special Attention: Package Application

**The Package Application job only runs on `develop` and `main` branches.** This means:

1. **Feature branch PRs** - Package job doesn't run. CI may pass on feature branch but fail after merge.
2. **After merging to develop** - ALWAYS verify Package Application succeeded:
   ```bash
   # Check the develop branch CI after merge
   gh run list --branch develop --limit 3
   gh run view <LATEST-RUN-ID>
   ```

### 8.4 QA Routing Rule

**QA agents MUST verify CI is green before presenting test cases to the user.** If CI is failing on a PR:
1. Do NOT present QA test cases — the PR is not ready for user testing
2. Route back to the engineer agent to fix the failing tests
3. Only proceed with QA after all CI checks pass

This prevents wasted user testing time on code that will need to change.

### 8.5 LLM Guardrails (for Claude and AI agents)

When verifying CI status, you MUST:

1. **Run `gh pr checks --watch`** and wait for it to complete (don't interrupt)
2. **Include the actual command output** in your response to the user
3. **Check all jobs** - if any show `fail` or `pending`, CI has NOT passed
4. **After merge to develop/main**, verify Package Application job separately
5. **Never say "CI passed"** without showing evidence from `gh pr checks` or `gh run view`

**Example verification response:**
```
CI Status for PR #114:
✓ Test & Lint (macos-latest, 20.x)  pass
✓ Test & Lint (windows-latest, 20.x)  pass
✓ Build Application (macos-latest)  pass
✓ Build Application (windows-latest)  pass
✓ Security Audit  pass

All 5 checks passed. Ready to merge.
```

**If Package Application needs verification (after merge to develop):**
```bash
gh run list --branch develop --limit 1
# Then check that specific run
gh run view <RUN-ID>
```

---

## Phase 9: Merge

**CRITICAL: Creating a PR is step 3 of 4, not the final step. The task is NOT complete until the PR is MERGED.**

**Full lifecycle reference:** `.claude/docs/shared/pr-lifecycle.md`

### Pre-Merge Checklist
- [ ] All CI checks pass
- [ ] No merge conflicts (verified in Phase 7.5)
- [ ] PR approved (if reviews required)
- [ ] Target branch is correct

### 9.1 Merge Command

```bash
# ALWAYS use traditional merge (--merge), NEVER squash
# Do NOT auto-delete branches - deletion is a separate, manual step
gh pr merge <PR-NUMBER> --merge
```

**Branch Deletion:** See `.claude/docs/shared/git-branching.md` for deletion policy. Do NOT use `--delete-branch` unless explicitly requested.

### 9.2 Merge Verification (MANDATORY)

**After running the merge command, you MUST verify the merge succeeded.**

```bash
# Verify merge state - MUST show "MERGED"
gh pr view <PR-NUMBER> --json state --jq '.state'
```

| Result | Meaning | Action |
|--------|---------|--------|
| `MERGED` | Success - task can be marked complete | Proceed to Post-Merge |
| `OPEN` | Merge failed or didn't run | Investigate and retry |
| `CLOSED` | PR was closed without merge | Work is LOST - investigate |

**Do NOT mark the task as complete until you see `MERGED`.**

### --admin Flag (PROHIBITED)

NEVER use `--admin` to bypass branch protection. This includes:
- `gh pr merge --admin`
- Any workaround to skip required status checks

If merge is blocked, the fix is ALWAYS: merge base branch into feature branch, push, wait for CI.

**Incident Reference:** PRs #1411/#1412 were merged with `--admin` without explicit user approval.

### 9.3 Post-Merge
- [ ] Verify merge completed: `gh pr view <PR> --json state` shows `MERGED`
- [ ] Delete local branch: `git branch -d your-branch-name`
- [ ] Pull latest changes: `git checkout develop && git pull`
- [ ] Update Supabase: `pm_update_task_status('<task_uuid>', 'completed')` + `pm_update_item_status('<backlog_item_uuid>', 'completed')` (do NOT edit any `.claude/plans/tasks/*.md` file)
- [ ] Notify PM that task is complete (only AFTER merge verified)

### 9.5 Debugging Metrics Verification (MANDATORY)

Before merging, SR Engineer MUST verify debugging metrics are accurately captured.

**Goal:** Capture ALL debugging for estimation accuracy, block only on clear discrepancies.

**Step 1: Collect evidence**
```bash
# Count fix commits
FIX_COUNT=$(git log --oneline origin/develop..HEAD | grep -iE "fix" | wc -l)
echo "Fix commits: $FIX_COUNT"

# Check PR age
gh pr view --json createdAt --jq '.createdAt'
```

**Step 2: Tiered response based on evidence vs reported**

| Fix Commits | Debugging Reported | Response |
|-------------|-------------------|----------|
| 0 | 0 | PASS |
| 0 | >0 | PASS (honest about investigation time) |
| 1-2 | 0 | ASK engineer: "These fix commits took 0 debugging time?" |
| 1-2 | >0 | PASS |
| 3-5 | 0 | BLOCK - Require metrics update before merge |
| 3-5 | >0 | PASS (verify roughly proportional) |
| 6+ | any | INCIDENT REPORT required |

**Step 3: Timeline as signal (not blocker)**

PR open time does not equal work time. Engineers wait for CI, answers, dependencies.

**If PR >4h AND Debugging: 0, ASK:**
- "Was there waiting time (CI, blocked, waiting for answer)?"
- "Were there any unexpected issues that required debugging?"
- "Did investigation/troubleshooting happen that didn't result in fix commits?"

**Only block if:** fix commits present + Debugging: 0 (clear discrepancy)

**Why this matters:** Without accurate debugging metrics, PM estimates appear more accurate than they are. Even 10 minutes of debugging affects estimation calibration.

**Reference:** BACKLOG-126 (TASK-704 incident - 22h debugging reported as 0)

---

## Hotfix Procedure

For urgent production fixes:

```bash
# 1. Branch from main
git checkout main
git pull origin main
git checkout -b hotfix/description

# 2. Make fix and test

# 3. Create PR to main
gh pr create --base main --title "hotfix: description"

# 4. After merge to main, also merge to develop
git checkout develop
git pull origin develop
git merge origin/main
git push origin develop
```

---

## CI Failure Recovery

If CI fails after creating the PR:

1. **Check the failing job logs** on GitHub Actions
2. **Run the failing check locally** to reproduce
3. **Fix the issue**
4. **Re-run the checklist** starting from the earliest relevant phase:
   - Type error → Phase 5.1
   - Lint error → Phase 5.2
   - Test failure → Phase 4.3
   - Security issue → Phase 3.1
5. **Push the fix** and wait for CI to re-run

🤖 **LLM Assist**: Claude can analyze CI failure logs and suggest fixes.

---

## Review Checklist (for reviewers)

When reviewing PRs, verify:

- [ ] **Phase 0**: Correct target branch
- [ ] **Phase 1**: Branch is synced, no conflicts
- [ ] **Phase 2**: No debug code, proper formatting, uses LogService
- [ ] **Phase 3**: No security issues, docs updated
- [ ] **Phase 4**: Adequate test coverage
- [ ] **Phase 4a**: Test hygiene — behavioral changes have matching test updates (see below)
- [ ] **Phase 5**: Type check + lint pass
- [ ] **Phase 6**: Automated code review completed
- [ ] **Phase 7**: Clear PR description
- [ ] **Phase 7.5**: Target branch merged into feature branch (MANDATORY)
- [ ] **Phase 8**: CI passes (after Phase 7.5 sync)

### Phase 4a: Test Hygiene Verification (MANDATORY)

**Reference:** BACKLOG-1356 — SPRINT-O had repeated CI failures from stale tests.

SR Engineer MUST verify the following during code review:

- [ ] **All test files referencing changed functions/components have been updated.** Search for the changed function names across `*.test.*` files and verify expectations match the new behavior.
- [ ] **Behavioral changes have corresponding test updates.** If a function's return value, call count, parameters, or error handling changed, tests MUST reflect the new behavior.
- [ ] **Mock alignment.** If a function signature changed (new params, changed return type), all mocks of that function must match the updated signature.
- [ ] **No stale assertions.** Check that `expect()` calls match actual behavior — stale `.toHaveBeenCalledTimes()`, `.toEqual()`, or `.toHaveBeenCalledWith()` values are the most common CI failure cause.

**If test hygiene is not met:** Request changes. Do not approve PRs where behavioral changes lack matching test updates.

### Review Output Format

```
## PR Review Summary
**Branch**: source → target
**Merge Type**: Traditional (required)
**Status**: APPROVED / CHANGES REQUESTED / BLOCKED
**Risk Level**: LOW / MEDIUM / HIGH

## Checklist Results
[✓/✗/⚠️ for each phase]

## Issues Found
[List any blockers or recommendations]
```

---

## Common Issues & Fixes

### Native Module Mismatch
```bash
npm rebuild better-sqlite3-multiple-ciphers
npx electron-rebuild
```

### Merge Conflicts
```bash
git fetch origin
git merge origin/develop
# Resolve conflicts in editor
git add .
git commit
```

### CI Failures
1. Check the failing job logs on GitHub Actions
2. Run the failing check locally
3. Fix and push

### Optional Props with Silent Failures (Component Refactoring Bug)

**Pattern**: When extracting components during refactoring, optional props (`prop?: type`) can be defined in the interface but never passed from the parent. This causes **silent failures** - the UI renders, buttons appear clickable, but handlers do nothing.

**Example** (from commit `3b481ef` - EmailOnboardingScreen bug):
```tsx
// Interface defines optional props:
interface EmailOnboardingScreenProps {
  selectedPhoneType?: "iphone" | "android";  // Optional - no compile error if missing
  onPhoneTypeChange?: (type: "iphone" | "android") => void;  // Silent failure
  onBack?: () => void;  // Back button breaks silently
}

// Parent component never passes them:
<EmailOnboardingScreen
  userId={...}
  authProvider={...}
  onComplete={handleEmailOnboardingComplete}
  // selectedPhoneType - MISSING! No compile error
  // onPhoneTypeChange - MISSING! Buttons do nothing
  // onBack - MISSING! Back button appears but fails silently
/>
```

**Prevention Checklist** (add to Phase 6.1):
- [ ] When extracting/refactoring components, verify ALL props in the interface are passed from parent
- [ ] Pay special attention to optional props (`?`) - they won't cause compile errors when missing
- [ ] Test interactive elements (buttons, selects) actually trigger their handlers
- [ ] Check that state flows bidirectionally (parent → child AND child → parent)

**Detection**:
```bash
# Find optional props in component interfaces that might be missing
grep -rn "?: .*=>.*void" src/components --include="*.tsx"
```

---

## Session-End Checklist (MANDATORY)

**Before ending ANY working session, verify no orphaned PRs exist.**

> **Incident Reference:** SPRINT-051/052 had 20+ orphaned PRs that were created but never merged, causing fixes to be "lost" and reimplemented multiple times.

### Quick Verification

```bash
# Check for any open PRs you created
gh pr list --state open --author @me

# Check for any sprint-related open PRs
gh pr list --state open --search "TASK-"
```

### For Each Open PR Found

| PR State | Action Required |
|----------|-----------------|
| CI failing | Fix before ending session OR document blocker |
| Awaiting review | Note for next session (acceptable) |
| Approved but not merged | **MERGE NOW** - do not leave approved PRs unmerged |
| Has merge conflicts | Resolve before ending session |

### Session-End Checklist

Copy this to your notes:

```markdown
## Before Ending Session

- [ ] `gh pr list --state open --author @me` - reviewed all open PRs
- [ ] All approved PRs have been merged
- [ ] All merges verified with `gh pr view <PR> --json state`
- [ ] No PRs with failing CI left unattended (or blocker documented)
- [ ] Task files updated with merge confirmations
```

**Do NOT end a session with approved-but-unmerged PRs.**

---

## Questions?

- **Architecture decisions**: Consult senior-engineer-pr-lead agent
- **CI/CD issues**: Check `.github/workflows/ci.yml`
- **Branching strategy**: See `CLAUDE.md`
- **PR lifecycle**: See `.claude/docs/shared/pr-lifecycle.md`
