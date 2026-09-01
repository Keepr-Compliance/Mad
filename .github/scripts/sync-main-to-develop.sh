#!/usr/bin/env bash
#
# Open the "sync main back into develop" PR. (BACKLOG-3041)
#
# ## Why this exists
#
# The release cuts chore/release-X.Y.Z, bumps the version, and PRs it INTO
# main. That commit is born on the main side and reaches develop only if a
# human deliberately syncs it back. For 2.32.0 and 2.33.0 nobody did, develop
# sat two releases behind, and the drift produced a hand-resolved version
# conflict (d5472e3d6 "chore(release): merge main and resolve the version to
# 2.33.0"). Each unsynced bump makes the next release's conflict worse.
#
# ## Why head IS main, and not a cut sync branch
#
# Load-bearing, not a simplification. A PR opened by GitHub Actions with the
# default GITHUB_TOKEN does NOT trigger `pull_request` workflows -- so a sync
# PR on a freshly cut branch would sit forever with zero checks, which is a
# WORSE failure than the manual process because it looks done.
#
# With head = main, the PR's head SHA *is* main's tip, and ci.yml already runs
# on `push: branches: [main]` against that exact SHA. Measured on
# 61e0d4df8912f43d16db30ed56311687da8bf408, workflow run 33367949832
# (event=push, branch=main) produced:
#     Test & Lint (macos-latest, 20.x)     success
#     Test & Lint (windows-latest, 20.x)   success
#     Security Audit                       success
# which is exactly develop's required-status-check set. So the required checks
# are on the SHA whether or not `pull_request` workflows ever fire.
#
# Consequence, accepted: develop is protected with strict:true. If develop
# advances after this PR opens, "Update branch" would mean pushing to main and
# is blocked. Recovery is the manual cut-branch sync (the pre-BACKLOG-3041
# process, e.g. PR #2456). That failure is VISIBLE on the PR, not silent.
#
# ## Why ahead_by is the authority, not the path filter
#
# The workflow's `paths: [package.json]` filter is an optimization for the
# common case. It is not a guarantee: GitHub skips path-filter evaluation for
# pushes of more than 1,000 commits and when diff generation times out, and a
# hotfix merged straight to main moves main ahead without touching the version
# at all. main being ahead of develop is the actual defect, so `ahead_by` is
# what this script gates on. Version numbers are reported, never gated on.
#
# ## Environment
#
#   REPO           owner/name                       (required)
#   HEAD_BRANCH    branch to sync FROM   (default: main)
#   BASE_BRANCH    branch to sync INTO   (default: develop)
#   GH_TOKEN       token for gh                     (required)
#
# HEAD_BRANCH/BASE_BRANCH are parameterised so this exact file can be exercised
# against throwaway probe branches without touching main or develop. The
# defaults are the production pair.

set -euo pipefail

REPO="${REPO:?REPO must be set (owner/name)}"
HEAD_BRANCH="${HEAD_BRANCH:-main}"
BASE_BRANCH="${BASE_BRANCH:-develop}"

say() { echo "[sync-pr] $*"; }

# Read a branch's package.json version through the API rather than the checkout:
# the workflow checks out one branch, and this needs both. Never fatal -- the
# version is cosmetic here (see "Why ahead_by is the authority" above), so a
# missing or unparseable package.json degrades to "unknown" instead of blocking
# a sync that ahead_by says is genuinely needed.
branch_version() {
  local ref="$1" content
  content=$(gh api "repos/${REPO}/contents/package.json?ref=${ref}" --jq '.content' 2>/dev/null || true)
  if [ -z "$content" ]; then
    echo "unknown"
    return 0
  fi
  echo "$content" | tr -d '\n' | base64 --decode 2>/dev/null | jq -r '.version // "unknown"' 2>/dev/null || echo "unknown"
}

say "repo=${REPO}  head=${HEAD_BRANCH}  base=${BASE_BRANCH}"

# --- Is there anything to sync? ----------------------------------------------
# ahead_by = commits reachable from HEAD_BRANCH but not from BASE_BRANCH.
compare=$(gh api "repos/${REPO}/compare/${BASE_BRANCH}...${HEAD_BRANCH}" --jq '{ahead: .ahead_by, behind: .behind_by}')
ahead=$(echo "$compare" | jq -r '.ahead')
behind=$(echo "$compare" | jq -r '.behind')

head_version=$(branch_version "$HEAD_BRANCH")
base_version=$(branch_version "$BASE_BRANCH")

say "${HEAD_BRANCH} is ${ahead} commit(s) ahead of ${BASE_BRANCH}, ${behind} behind"
say "version: ${HEAD_BRANCH}=${head_version}  ${BASE_BRANCH}=${base_version}"

if [ "$ahead" -eq 0 ]; then
  say "Nothing to sync -- ${BASE_BRANCH} already contains every commit on ${HEAD_BRANCH}."
  exit 0
fi

# --- Idempotency -------------------------------------------------------------
# The path that will actually be exercised repeatedly: every push to main while
# a sync PR is still open re-enters here. Because head IS main, an already-open
# PR picks the new commits up on its own -- there is nothing to do and nothing
# to create.
existing=$(gh pr list --repo "$REPO" --base "$BASE_BRANCH" --head "$HEAD_BRANCH" --state open --json number,url --jq '.[0] // empty')
if [ -n "$existing" ]; then
  existing_num=$(echo "$existing" | jq -r '.number')
  existing_url=$(echo "$existing" | jq -r '.url')
  say "A sync PR is already open: #${existing_num} ${existing_url}"
  say "It tracks ${HEAD_BRANCH} directly, so it already includes these commits. Not opening a second one."
  exit 0
fi

# --- Open it -----------------------------------------------------------------
# [skip-metrics] belongs in the TITLE. pr-metrics-check.yml reads the PR title,
# and a version sync has no engineer and no honest Agent ID to cite. The release
# bump commits already carry the flag in their COMMIT MESSAGE, which that gate
# never reads -- right convention, wrong place (BACKLOG-3041).
#
# Do NOT "fix" this by adding a branch-prefix exemption to pr-metrics-check.yml.
# That gate's exemptions are deliberately narrow: its Check 2 is a substring
# match with no existence test, so the cheapest way to satisfy it is to invent
# an Agent ID -- PR #2295 cited one with zero rows in pm_token_metrics. A
# [skip-metrics] title is visible on the PR; a branch-prefix exemption is not.
TITLE="chore: sync the v${head_version} version bump from ${HEAD_BRANCH} back into ${BASE_BRANCH} [skip-metrics]"

BODY=$(cat <<EOF
Automated back-merge opened by \`.github/workflows/sync-main-to-develop.yml\` (BACKLOG-3041).

\`${HEAD_BRANCH}\` is **${ahead} commit(s) ahead** of \`${BASE_BRANCH}\`.

| branch | package.json version |
|---|---|
| \`${HEAD_BRANCH}\` | ${head_version} |
| \`${BASE_BRANCH}\` | ${base_version} |

The release bumps the version on a branch that merges **into \`${HEAD_BRANCH}\`**, so the
bump commit is born on the \`${HEAD_BRANCH}\` side and only reaches \`${BASE_BRANCH}\` if it is
merged back. When that does not happen the drift compounds and the next
release hits a version conflict — which is what produced the hand-resolved
\`d5472e3d6\` for 2.33.0.

\`[skip-metrics]\` is in the title because a version sync has no engineer and no
honest Agent ID to cite. See BACKLOG-3041.

**Merge with a traditional merge (not squash)**, per CLAUDE.md.

> Head is \`${HEAD_BRANCH}\` itself, so this PR updates automatically on every
> further push to \`${HEAD_BRANCH}\` — no second PR is opened.
EOF
)

say "Opening PR: ${TITLE}"

create_err=$(mktemp)
if ! gh pr create \
      --repo "$REPO" \
      --base "$BASE_BRANCH" \
      --head "$HEAD_BRANCH" \
      --title "$TITLE" \
      --body "$BODY" >/dev/null 2>"$create_err"; then
  err=$(cat "$create_err")
  rm -f "$create_err"
  echo "$err" >&2

  # The known trap, named explicitly so the Actions log answers the question
  # instead of raising it. Repo setting measured 2026-09-01:
  #   gh api repos/Keepr-Compliance/Mad/actions/permissions/workflow
  #   -> {"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
  # With that false, GITHUB_TOKEN cannot open a PR at all.
  if echo "$err" | grep -qi "not permitted to create or approve pull requests"; then
    cat >&2 <<'REMEDY'

[sync-pr] BLOCKED: GitHub Actions is not permitted to create pull requests in
[sync-pr] this repository, so the back-merge PR was NOT opened.
[sync-pr]
[sync-pr] This job is deliberately RED rather than quietly green: a silent
[sync-pr] skip here recreates exactly the defect BACKLOG-3041 fixes.
[sync-pr]
[sync-pr] Pick ONE remedy (repo admin required):
[sync-pr]
[sync-pr]   A. Let Actions open PRs (no new credential, nothing to expire):
[sync-pr]      gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow \
[sync-pr]        -F can_approve_pull_request_reviews=true \
[sync-pr]        -f default_workflow_permissions=read
[sync-pr]      Approval is not a review-bypass here: main and develop both
[sync-pr]      require 0 approving reviews, so this grants PR creation only.
[sync-pr]
[sync-pr]   B. Add a SYNC_PR_TOKEN repo secret (a PAT with pull-requests:write
[sync-pr]      on this repo). The workflow prefers it when present. Costs an
[sync-pr]      expiring credential to maintain.
[sync-pr]
[sync-pr] Until then, open the PR by hand:
[sync-pr]   gh pr create --base BASE --head HEAD \
[sync-pr]     --title "chore: sync the version bump back into develop [skip-metrics]"
REMEDY
    exit 1
  fi

  # Lost a race against a concurrent run (or a human) -- the desired end state
  # exists, so this is not a failure.
  if echo "$err" | grep -qi "already exists"; then
    say "A PR for ${HEAD_BRANCH} -> ${BASE_BRANCH} already exists (created concurrently). Nothing to do."
    exit 0
  fi

  say "FAILED to open the sync PR. See the error above."
  exit 1
fi
rm -f "$create_err"

# --- Read the PR back and ASSERT its fields ----------------------------------
# `gh pr create` exiting 0 is not evidence the PR says what it must. The title
# flag is the whole reason pr-metrics-check.yml lets this PR through, so it is
# asserted, not assumed.
pr_json=$(gh pr list --repo "$REPO" --base "$BASE_BRANCH" --head "$HEAD_BRANCH" --state open --json number --jq '.[0].number')
if [ -z "$pr_json" ]; then
  say "FAILED: gh pr create reported success but no open PR ${HEAD_BRANCH} -> ${BASE_BRANCH} can be found."
  exit 1
fi

read -r got_num got_base got_head got_title <<EOF
$(gh pr view "$pr_json" --repo "$REPO" --json number,baseRefName,headRefName,title \
    --jq '[.number, .baseRefName, .headRefName, .title] | @tsv')
EOF

say "read back: #${got_num} ${got_head} -> ${got_base}"
say "read back: title = ${got_title}"

fail=0
[ "$got_base" = "$BASE_BRANCH" ] || { say "ASSERT FAILED: base is '${got_base}', expected '${BASE_BRANCH}'"; fail=1; }
[ "$got_head" = "$HEAD_BRANCH" ] || { say "ASSERT FAILED: head is '${got_head}', expected '${HEAD_BRANCH}'"; fail=1; }
case "$got_title" in
  *"[skip-metrics]"*) ;;
  *) say "ASSERT FAILED: title does not carry [skip-metrics]; pr-metrics-check.yml will block this PR"; fail=1 ;;
esac
[ "$fail" -eq 0 ] || exit 1

say "PR #${got_num} opened and verified."
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Back-merge sync PR opened"
    echo ""
    echo "- PR: #${got_num}"
    echo "- \`${got_head}\` -> \`${got_base}\` (${ahead} commit(s))"
    echo "- version: \`${HEAD_BRANCH}\`=${head_version}, \`${BASE_BRANCH}\`=${base_version}"
    echo "- title carries \`[skip-metrics]\`: verified by read-back"
  } >> "$GITHUB_STEP_SUMMARY"
fi
