<!-- Release PR body template — BACKLOG-3133.

     Copy this file, fill in the marked places, and pass the copy to
     `gh pr create --body-file`. Do NOT hand-write a release PR body: the four
     sections below are what `Validate PR Metrics` checks, and the last of them
     is an exact-string test.

     The three most recent release PRs before this template existed (#2496,
     #2492, #2455) each failed Check 4, because a hand-written body has no
     reason to contain a sentence nobody remembers. That is what a template is
     for. -->

## Summary

Release **vX.Y.Z** — `develop` → `main`. Previous release A.B.C.

<!-- One line on why this version number: patch, minor or major, and what makes
     it that. -->

## What ships

<!-- The BACKLOG-#### items in this release, grouped by surface. At least one
     real BACKLOG-#### or TASK-#### number must appear somewhere in this body
     (Check 3). -->

## Pre-flight

| Check | Result |
|---|---|
| Version | main and the live feed read A.B.C → **X.Y.Z** |
| Schema baseline | `BASELINE_VERSION` — unchanged / RISEN (a rise forces every existing user to uninstall; say so and warn testers) |
| develop CI | all required checks green on `<sha>` |
| Open PRs to develop | <count>, none belonging in this release |
| Bump | `package.json` and `package-lock.json` (root and `packages[""]`) |

## After merge

1. Tag `vX.Y.Z` on main
2. Merge the version bump back into develop, or the next release starts from a stale number
3. Verify `Keepr-Compliance/keepr-releases` actually updated — the workflow going green is not the check

---

## Public Repository Notice

<!-- LOCKED SECTION. `Validate PR Metrics` Check 4 fails if the sentence below is
     missing or altered by even one word. It is byte-identical to the one in
     .github/PULL_REQUEST_TEMPLATE.md. Do not reword it. Add notes underneath. -->

This repository is public. Do not describe vulnerabilities, addresses, credentials, endpoints, or network layout here. Link the backlog item.

<!-- The lines below are NOT part of the locked sentence. Edit them freely. -->

**Record ids.** A UUID on a line that names its PM table — `pm_comments`,
`pm_backlog_items`, `pm_tasks`, `pm_sprints`, `pm_events`, `pm_token_metrics` —
passes with no waiver. Any other UUID takes `pii-allow-uuid: <why>` on the same
line, and replacing it beats waiving it.

---

## Engineer Metrics

| Metric | Value |
|---|---|
| Total Tokens | auto-captured |
| Duration | auto-captured |
| API Calls | auto-captured |

**Agent ID:** `<the session id of the agent that cut this release>`   (pm_token_metrics linkage key)

A release PR aggregates many agents' work, so the Agent ID above attributes the
agent that cut the release, not the authors of what ships. Numeric metrics are
auto-captured into Supabase `pm_token_metrics` by the SubagentStop hook and are
not validated here (BACKLOG-1873). The sections this body must carry are fixed
by BACKLOG-3133.
