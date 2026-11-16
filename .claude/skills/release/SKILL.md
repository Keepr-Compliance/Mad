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
gh release list --repo Keepr-Compliance/keepr-releases --limit 5 --exclude-pre-releases   # what users actually receive
```

Betas are prereleases on the feed (see *Cutting a beta*) and never count here: the next stable is numbered from the stables only.

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

9. **Open a PR to main.** This is the flow every recent release actually used (`chore/release-2.32.0` → PR #2430 → main); the direct-merge steps this skill used to describe cannot work under branch protection.

   **Build the body from the template — do not hand-write it.** `Validate PR Metrics` runs on release PRs (no skip pattern matches `chore/release-*`), and its fourth check is an exact-string test for the Public Repository Notice. The three release PRs before this template existed (#2496, #2492, #2455) each carried that sentence zero times.

   ```bash
   cp .claude/skills/release/release-pr-body.md /tmp/release-pr-body.md
   # fill in Summary / What ships / Pre-flight / After merge / Agent ID.
   # Leave the Public Repository Notice sentence byte-identical.

   # Scan it before it is published — the body is world-readable the moment the PR opens.
   node scripts/ci/check-message-hygiene.mjs --text-file /tmp/release-pr-body.md --label "release PR body"

   gh pr create --base main --head chore/release-X.Y.Z --title "release: vX.Y.Z" \
     --body-file /tmp/release-pr-body.md
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
    gh release list --repo Keepr-Compliance/keepr-releases --limit 3 --exclude-pre-releases
    gh api repos/Keepr-Compliance/keepr-releases/releases/latest --jq '.tag_name + " prerelease=" + (.prerelease|tostring)'
    ```

    `vX.Y.Z` must appear and be `Latest` (for an old-line hotfix, e.g. 2.48.1 after 2.49.0, Latest stays on the newer stable). The workflow's last step, *Check which release is Latest (report only)*, checks the same rule and only warns: read its output. The mirror runs on `PUBLIC_RELEASE_TOKEN`, a fine-grained PAT **with an expiry** — when it lapses, the main merge is green and the feed silently never updates. A green workflow is not evidence a user can receive the release; the feed repo is.

15. **Releases in `Keepr-Compliance/Mad` are drafts by design.** Do not read a draft there as a failure — `keepr-releases` is the one users see.

## Cutting a beta

A beta is a prerelease on the update feed. Only installs with **Get beta updates** switched on receive it (an account must be eligible *and* have the switch on; each account is separate). Everyone else keeps receiving `Latest`, which a beta never becomes.

**The workflow refuses, before signing:** a version that is not `X.Y.Z` on `main`; `channel=beta` anywhere but a `beta/` or `rehearsal/` branch; a beta branch not named `beta/<version>`; a beta version that is not newer than the feed's Latest; any beta to the feed while Latest is below v2.49.0.

1. **Branch from the released stable tag, not from develop:**

   ```bash
   git fetch origin --tags
   git checkout -b beta/2.49.1-beta.1 v2.49.0      # branch name = beta/<version>
   ```

   The version is the **next patch of the released tag** plus `-beta.N` (`v2.49.0` gives `2.49.1-beta.1`, then `-beta.2`), so the stable `2.49.1` that later ships the same fixes supersedes it for every beta install. Feature-preview betas from develop are a separate case and are not covered here.

2. **Cherry-pick the fixes, then bump `package.json` to `X.Y.Z-beta.N`** and push the branch. **No beta may carry a local schema migration whose version is not already merged to develop.** A beta branch is never merged anywhere.

3. **Dispatch (founder's go):**

   ```bash
   gh workflow run release.yml --ref beta/X.Y.Z-beta.N -f channel=beta
   ```

   Both platforms build exactly as for a website release. The `Publish Beta` job then waits on the `feed-beta` Environment.

4. **Only the founder approves, in the browser.** Agents never approve or reject a deployment, and never call the `pending_deployments` API. For the **first** beta, he rejects once, the run must end with nothing new on the feed, and then a second dispatch is approved.

5. **Verify:**

   ```bash
   gh release view vX.Y.Z-beta.N --repo Keepr-Compliance/keepr-releases --json isDraft,isPrerelease   # false, true
   gh api repos/Keepr-Compliance/keepr-releases/releases/latest --jq .tag_name                         # unchanged stable
   ```

**Withdraw a bad beta (founder's go):**

```bash
gh release edit vX.Y.Z-beta.N --repo Keepr-Compliance/keepr-releases --draft=true --notes "WITHDRAWN-4245: <reason>"
```

It leaves the feed; installs that already took it stay on it (never downgraded). A re-run refuses to publish a withdrawn beta; ship the fix as `beta.N+1`, or ship the stable `X.Y.Z`.

**Never mirror a beta by hand.** If a stable is ever mirrored by hand, use no `--prerelease`, `--latest` or `--draft` flag, exactly as the workflow does.

### Rehearsing the publish path

`rehearsal/*` branches publish to the scratch feed named by the `SCRATCH_FEED_REPO` variable, never to the update feed. Versions are `90.x` and are cut from the branch under test. Each dispatch needs the founder's go. Run artifacts from these branches are kept 1 day; delete them after each step's checks. **Never install a rehearsal build anywhere.**

## Rules

- Never commit a version bump to a feature branch
- Never put a prerelease version on main (the workflow refuses it)
- Always tag on main, never on develop
- Never `--admin`; if a check blocks, fix the check
- Wait for explicit user approval before the merge (step 11)

## Rollback

Only with explicit user approval:

```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
```

Reverting main itself needs a **revert PR, not a force-push** — main is protected and other work may already sit on top of the release commit.
