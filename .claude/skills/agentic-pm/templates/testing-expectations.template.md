# Testing Expectations: TASK-XXX

<!--
  Use the content of this template inside `pm_backlog_items.body` for the task
  (as a "Testing Expectations" section), NOT as a standalone disk file. For
  sprint-level testing strategy, embed `testing-quality-plan.template.md`
  content inside `pm_sprints.body` instead.
-->

> **Template scope**: Use this template within individual task plans (`pm_backlog_items.body`).
> For sprint-level testing strategy, use `testing-quality-plan.template.md` content inside `pm_sprints.body`.

## Overview

This document specifies testing requirements for TASK-XXX.

**PRs without required tests WILL BE REJECTED.**

---

## Unit Tests

- **Required**: Yes / No

### New tests to write:

| Logic/Function | Test File | Description |
|----------------|-----------|-------------|
| <function/module> | `<path/to/test.test.ts>` | <what to test> |

### Existing tests to update:

| Behavior | Test File | Reason |
|----------|-----------|--------|
| <behavior> | `<path/to/test.test.ts>` | <why update needed> |

---

## Coverage

- **Coverage impact**: <must not decrease / target X% / not enforced>

### If not enforced, reason:

<explanation>

---

## Integration / Feature Tests

- **Required**: Yes / No

### Scenarios:

| Scenario | Description | Expected Outcome |
|----------|-------------|------------------|
| <scenario 1> | <description> | <expected result> |
| <scenario 2> | <description> | <expected result> |

---

## CI Requirements

This task's PR MUST pass:

- [ ] Unit tests (`npm test`)
- [ ] Integration tests (`npm run test:integration`) — if applicable
- [ ] Coverage checks — <threshold or "no regression">
- [ ] Type checking (`npm run type-check`)
- [ ] Lint / format checks (`npm run lint`)

---

## Test Ownership

- **Primary owner**: <engineer assigned to task>
- **Reviewer**: <who reviews the tests>

---

## Notes

<Any additional context about testing for this task>
