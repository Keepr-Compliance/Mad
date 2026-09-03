---
name: release
description: Release workflow — determine the true version, cut a release branch, PR to main, tag, sync the bump back to develop, and verify the auto-updater feed actually updated.
---

# Release Workflow

Use `/release` when cutting a public release from develop to main.

Merging to main publishes to the auto-updater feed, so every existing install receives it. Treat every step as outward-facing.

## Determine the version FIRST — do not read it off develop

**`develop/package.json` is not the current version and cannot be trusted.** The bump is made on the release branch and merged to main; it was historically never merged back, so develop lags by one or more releases. On 2026-08-31 main read `2.32.0` while develop still read `2.31.0`.

Take the highest of these three, then increment:

```bash
git show origin/main:package.json | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])'
gh release list --repo Keepr-Compliance/Mad --limit 5
gh release list --repo Keepr-Compliance/keepr-releases --limit 5   # what users actually receive
```

Ask the user which increment — patch, minor, major.

## Pre-flight

1. **Work from `origin/develop`, in its own worktree.** Never cut a release from a checkout that happens to be sitting on another branch; a stale tree has produced wrong measurements repeatedly in this repo.

2. **Check open PRs targeting develop** — for judgement, not as a gate:

   ```bash
   gh pr list --base develop --state open
   ```

   **Do NOT stop merely because the list is non-empty.** It is normally 25-30 PRs, mostly dependabot, some open for months, and every recent release shipped with them open. Read the list and ask one question: *is anything here meant to be IN this release?* If yes, merge it first. If it is dependency bumps and stale docs, proceed.

3. **CI must be settled on develop**, not merely started:

   ```bash
   gh run list --branch develop --limit 4 --json status,conclusion,name,headSha
   ```

   An `in_progress` run is not a pass. Wait for it and read the conclusion.

4. **Read main's protection before planning the merge:**

   ```bash
   gh api repos/Keepr-Compliance/Mad/branches/main/protection
   ```

   As of 2026-08-31: `strict: true`, a required PR review, and five required checks — Test & Lint on macOS and Windows, Build Application on macOS and Windows, and Security Audit. **A direct push to main is rejected.**

5. **Show the changelog** (`git log origin/main..origin/develop --oneline`) and get the user's sign-off on what is shipping.

6. **Check whether this release crosses a schema baseline.** If `BASELINE_VERSION` has risen since the live release, databases below it are refused with a dialog and a clean quit — every existing user must uninstall properly before installing, not install over the top. **Say so explicitly and get an answer before continuing.** Testers may need warning first.

## Cutting the release

7. **Branch from `origin/develop`** — never commit a version bump to a feature branch:

   ```bash
   git checkout -b chore/release-X.Y.Z origin/develop
   ```

8. **Bump `version` in `package.json`** and commit:

   ```bash
   git commit -m "chore(release): bump version to X.Y.Z [skip-metrics]"
   git push -u origin chore/release-X.Y.Z
   ```

9. **Open a PR to main.** This is the flow every recent release actually used (`chore/release-2.32.0` → PR #2430 → main); the direct-merge steps this skill used to describe cannot work under branch protection:

   ```bash
   gh pr create --base main --head chore/release-X.Y.Z --title "release: vX.Y.Z"
   ```

10. **Wait for all five required checks.** `strict: true` means the branch must also be current with main; if main moved, merge it in and let CI re-run.

11. **The user merges.** Never `--admin`, never a flag that bypasses a check.

12. **Tag on main after the merge:**

    ```bash
    git fetch origin && git tag vX.Y.Z origin/main && git push origin vX.Y.Z
    ```

## Close the loop — the step that used to be missing

13. **Merge the version bump back into develop**, or develop's version stays stale and the next release starts from a wrong number:

    ```bash
    git checkout -b chore/sync-version-X.Y.Z origin/develop
    git merge origin/main --no-edit
    gh pr create --base develop --title "chore: sync vX.Y.Z version bump back to develop"
    ```

## Verify the publish — the workflow going green is NOT the check

14. **Confirm the feed repo actually updated:**

    ```bash
    gh release list --repo Keepr-Compliance/keepr-releases --limit 3
    ```

    `vX.Y.Z` must appear and be `Latest`. The mirror runs on `PUBLIC_RELEASE_TOKEN`, a fine-grained PAT **with an expiry** — when it lapses, the main merge is green and the feed silently never updates. A green workflow is not evidence a user can receive the release; the feed repo is.

15. **Releases in `Keepr-Compliance/Mad` are drafts by design.** Do not read a draft there as a failure — `keepr-releases` is the one users see.

## Rules

- Never commit a version bump to a feature branch
- Always tag on main, never on develop
- Never `--admin`; if a check blocks, fix the check
- Wait for explicit user approval before the merge (step 11)

## Rollback

Only with explicit user approval:

```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
```

Reverting main itself needs a **revert PR, not a force-push** — main is protected and other work may already sit on top of the release commit.
