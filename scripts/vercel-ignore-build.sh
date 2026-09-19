#!/bin/sh
# Vercel "Ignored Build Step" guard for the portal projects (BACKLOG-2833).
#
# EXIT CODE CONTRACT — inverted from intuition, and it is Vercel's, not ours:
#
#     exit 0  ->  SKIP the build (Vercel cancels the deployment)
#     exit 1  ->  RUN the build
#
# Because a wrong "skip" means a genuine portal change silently never deploys,
# this guard MUST fail safe: it builds whenever it cannot PROVE the portal is
# unaffected. Every error path below exits 1. A missing script file makes the
# shell exit 127, which is also non-zero, so even that fails safe.
#
# Invoked from <portal>/vercel.json:
#     "ignoreCommand": "sh ../scripts/vercel-ignore-build.sh broker-portal"
#
# NOTE: this only decides whether a created deployment BUILDS. It does not stop
# the deployment from being created, and the free plan's 100/day cap counts
# creations. Reducing that count is what git.deploymentEnabled does; see the
# same file. Both matter, for different reasons.

set -u

log() { echo "vercel-ignore-build: $*" >&2; }

PORTAL="${1:-}"

# Guard the interpolation into the regex below, and catch a typo'd wiring.
case "$PORTAL" in
  broker-portal|admin-portal) ;;
  '')
    log "no portal argument given; building to be safe"
    exit 1
    ;;
  *)
    log "unrecognised portal '$PORTAL'; building to be safe"
    exit 1
    ;;
esac

# The deploy targets always build, whatever the diff says.
BRANCH="${VERCEL_GIT_COMMIT_REF:-}"
case "$BRANCH" in
  main|develop)
    log "branch '$BRANCH' always builds"
    exit 1
    ;;
esac

# Run from the repo root so pathspecs and `git diff` output agree.
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  log "not a git repository; building to be safe"
  exit 1
}
cd "$ROOT" || {
  log "cannot enter repo root '$ROOT'; building to be safe"
  exit 1
}

# Is this revision present in the (shallow) clone?
have_commit() {
  git rev-parse --verify --quiet "$1^{commit}" >/dev/null 2>&1
}

# Prefer the last successful deployment; fall back to the parent commit.
# VERCEL_GIT_PREVIOUS_SHA is only populated when an Ignored Build Step is
# configured, and it names the last SUCCESSFUL deployment — so when builds have
# been skipped it points further back, widening the diff. That errs toward
# building, which is the direction we want.
BASE=""
if [ -n "${VERCEL_GIT_PREVIOUS_SHA:-}" ] && have_commit "${VERCEL_GIT_PREVIOUS_SHA}"; then
  BASE="${VERCEL_GIT_PREVIOUS_SHA}"
elif have_commit "HEAD~1"; then
  BASE="HEAD~1"
fi

if [ -z "$BASE" ]; then
  log "no usable base commit (shallow clone, or first commit); building to be safe"
  exit 1
fi

# --no-renames matters. With rename detection on (git's default since 2.9) a moved
# file is reported as its DESTINATION path only. A file moved out of a watched
# directory -- say broker-portal/x.ts -> src/x.ts -- would then list only "src/x.ts",
# match nothing, and skip the build, even though the portal just lost a file.
# --no-renames reports the delete and the add separately, so the source path is
# still seen. No such move exists in this repo's history yet; the flag closes the
# class rather than a known instance.
CHANGED=$(git diff --name-only --no-renames "$BASE" HEAD --) || {
  log "git diff against '$BASE' failed; building to be safe"
  exit 1
}

if [ -z "$CHANGED" ]; then
  # No files differ. Could be a redeploy of the same tree, could be something
  # we have not thought of. Either way we cannot prove the portal is unaffected.
  log "empty changed-file list between '$BASE' and HEAD; building to be safe"
  exit 1
fi

# Paths whose contents can change this portal's build output:
#
#   <portal>/          the app itself
#   packages/          @keepr/design-system, @keepr/ui and @keepr/shared are npm
#                      workspaces consumed as raw TS via transpilePackages and
#                      imported directly by both portals (design-system: 49
#                      imports in broker, 77 in admin; ui: 33 and 8). The whole
#                      directory is watched rather than named subdirectories, so
#                      a new workspace package is covered the day it is added.
#   shared/            the "@shared/*" tsconfig alias -> ../shared/*
#   package.json,
#   package-lock.json  the install step is `cd .. && npm ci`, so the root
#                      manifest and lockfile determine what gets installed.
if printf '%s\n' "$CHANGED" | grep -qE "^(${PORTAL}/|packages/|shared/|package\.json\$|package-lock\.json\$)"; then
  log "$PORTAL affected between '$BASE' and HEAD; building"
  exit 1
fi

log "no $PORTAL-affecting change between '$BASE' and HEAD; skipping build"
exit 0
