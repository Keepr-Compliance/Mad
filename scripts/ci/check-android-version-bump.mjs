#!/usr/bin/env node
/**
 * check-android-version-bump — BACKLOG-2956 standing rule
 *
 * Fails when `android-companion/` gains a shipping change without a bump to
 * `expo.android.versionCode`.
 *
 * ## Why this gate exists
 *
 * `expo.version` sat at `"1.0.0"` across 54 commits and `expo.android.versionCode`
 * was never set at all — Expo silently defaults it to 1, so EVERY companion build
 * ever produced identified itself as version 1. That is how a five-month-old debug
 * APK ended up on a field tester's phone with no way to tell it apart from a build
 * made that morning (BACKLOG-2955). Setting the numbers once fixes today. This
 * check is what stops it recurring in six months when nobody remembers.
 *
 * The rule is deliberately about `versionCode`, not `version` — see WHY BOTH ARE
 * NOT GATED below.
 *
 * ## What counts as a "shipping change"
 *
 * Everything under `android-companion/` EXCEPT the non-shipping paths listed in
 * `NON_SHIPPING`: markdown, tests, and lint/type/test configuration. Those cannot
 * change the artifact a user installs, so demanding a bump for them would be noise.
 *
 * Two consequences of that rule, both chosen on purpose:
 *
 *   - `scripts/` IS shipping-relevant. The build scripts decide how the artifact is
 *     assembled and signed; a change there can absolutely change what users get.
 *   - A COMMENT-ONLY edit to shipping source still requires a bump. Detecting
 *     "comments only" means parsing every changed file, and the failure mode of
 *     getting it wrong is a silent "no bump needed" — precisely the defect this
 *     gate exists to prevent. The cost of complying is incrementing one integer,
 *     which is cheaper than any mechanism for arguing about it.
 *
 * There is deliberately NO override flag. An escape hatch that is easy to reach
 * becomes a habit, and this repo has already seen `--no-verify` used to get past a
 * hook (BACKLOG-2837). If the rule proves wrong for some path, the fix is to add
 * that path to `NON_SHIPPING` — a visible, reviewable code change.
 *
 * ## WHY BOTH ARE NOT GATED
 *
 * `versionCode` is the machine identifier: a monotonic integer that Android, Play
 * and every updater compare to decide what is newer. Requiring it to move on every
 * shipping change is exactly right — two different artifacts must never share one.
 *
 * `expo.version` is human-facing semver. Forcing it to change on every commit would
 * have produced 54 meaningless patch bumps and destroyed the only signal it carries.
 * So it is not required to move. What IS enforced is that it cannot drift
 * incoherently:
 *
 *   - `app.json` `expo.version` must equal `android-companion/package.json` version.
 *   - If `expo.version` changes, `versionCode` must change too (a new user-visible
 *     version is always a new artifact).
 *
 * The original complaint — "1.0.0 for 54 commits" — is answered by versionCode
 * moving every time, because that is what makes two builds distinguishable. The
 * version name never could.
 *
 * ## Diff range
 *
 * Mirrors `check-changes` in ci.yml. On a pull request the range is
 * `origin/<base>...HEAD` (three-dot: merge base), so the question asked is "does
 * this BRANCH bump the number", not "does every commit". That matters — a branch
 * legitimately bumps once and then adds several commits.
 *
 * On a push to a feature branch the same merge-base range against `origin/develop`
 * is used, for the same reason. `HEAD~1..HEAD` would be per-commit and would fail a
 * branch that had already bumped in an earlier commit.
 *
 * On `develop`/`main` itself the check is skipped: the PR that introduced the
 * change was already gated, and re-gating a merge commit only produces noise.
 *
 * @module scripts/ci/check-android-version-bump
 */

import { execFileSync } from "node:child_process";

const APP_JSON = "android-companion/app.json";
const PKG_JSON = "android-companion/package.json";
const PREFIX = "android-companion/";

/**
 * Paths under android-companion/ that cannot affect the installed artifact.
 * A change confined to these requires no versionCode bump.
 */
const NON_SHIPPING = [
  /\.md$/i,
  /(^|\/)__tests__\//,
  /(^|\/)__mocks__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /(^|\/)jest\.config\.[cm]?js$/,
  /(^|\/)jest\.setup\.[cm]?[jt]s$/,
  /(^|\/)eslint\.config\.[cm]?js$/,
  /(^|\/)tsconfig\.json$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)\.npmrc$/,
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/** Resolve the base commit to diff against, or null when the check should skip. */
function resolveBase() {
  const baseRef = process.env.GATE_BASE_REF?.trim();
  if (baseRef) {
    const resolved =
      gitOrNull(["merge-base", `origin/${baseRef}`, "HEAD"]) ??
      gitOrNull(["merge-base", baseRef, "HEAD"]);
    if (!resolved) {
      console.error(
        `Could not resolve a merge base against "${baseRef}". ` +
          `The workflow must fetch the base branch before running this check.`
      );
      process.exit(1);
    }
    return resolved;
  }

  const branch = gitOrNull(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "develop" || branch === "main") return null;

  return (
    gitOrNull(["merge-base", "origin/develop", "HEAD"]) ??
    gitOrNull(["merge-base", "develop", "HEAD"])
  );
}

/** Read a JSON file as it existed at `rev`, or null if absent there. */
function readJsonAt(rev, path) {
  const raw = gitOrNull(["show", `${rev}:${path}`]);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Could not parse ${path} at ${rev}: ${err.message}`);
    process.exit(1);
  }
}

const base = resolveBase();
if (base === null) {
  console.log(
    "android version-bump check skipped: on develop/main, where the originating PR was already gated."
  );
  process.exit(0);
}

const changed = git(["diff", "--name-only", `${base}`, "HEAD"])
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((f) => f.startsWith(PREFIX));

if (changed.length === 0) {
  console.log("android version-bump check passed: no android-companion/ changes.");
  process.exit(0);
}

const shipping = changed.filter((f) => {
  const rel = f.slice(PREFIX.length);
  return !NON_SHIPPING.some((re) => re.test(rel));
});

if (shipping.length === 0) {
  console.log(
    `android version-bump check passed: ${changed.length} android-companion/ file(s) changed, ` +
      `all non-shipping (docs/tests/config).`
  );
  process.exit(0);
}

const headApp = readJsonAt("HEAD", APP_JSON);
const headPkg = readJsonAt("HEAD", PKG_JSON);
const baseApp = readJsonAt(base, APP_JSON);

const failures = [];

const headCode = headApp?.expo?.android?.versionCode;
const headVersion = headApp?.expo?.version;

// Rule 0 — versionCode must EXIST. Its absence is the original defect: Expo
// silently defaults it to 1, so every build claims to be version 1.
if (typeof headCode !== "number" || !Number.isInteger(headCode)) {
  failures.push(
    `${APP_JSON} has no integer expo.android.versionCode.\n` +
      `    Expo defaults it to 1 when unset, which makes every build indistinguishable.\n` +
      `    Fix:  set "versionCode" under "android" in ${APP_JSON}`
  );
} else if (baseApp !== null) {
  // Rule 1 — it must have INCREASED relative to the base.
  const baseCode = baseApp?.expo?.android?.versionCode;
  const baseCodeNum = typeof baseCode === "number" ? baseCode : 1; // Expo's silent default
  if (headCode <= baseCodeNum) {
    failures.push(
      `android-companion/ has shipping changes but expo.android.versionCode was not bumped.\n` +
        `    base: ${baseCodeNum}   head: ${headCode}   (must be strictly greater)\n` +
        `    Shipping files changed (${shipping.length}):\n` +
        shipping
          .slice(0, 10)
          .map((f) => `      ${f}`)
          .join("\n") +
        (shipping.length > 10 ? `\n      ... and ${shipping.length - 10} more` : "") +
        `\n    Fix:  set "versionCode": ${baseCodeNum + 1} in ${APP_JSON}\n` +
        `    Why:  two different builds must never share a versionCode — it is the only\n` +
        `          thing that lets support, telemetry and Android itself tell them apart.`
    );
  }
}

// Rule 2 — app.json and package.json versions must agree.
if (headVersion !== undefined && headPkg?.version !== undefined) {
  if (headVersion !== headPkg.version) {
    failures.push(
      `Version mismatch: ${APP_JSON} expo.version is "${headVersion}" but ` +
        `${PKG_JSON} version is "${headPkg.version}".\n` +
        `    These must agree — they are the same product's version number.`
    );
  }
}

// Rule 3 — a changed user-visible version is always a new artifact.
if (baseApp !== null) {
  const baseVersion = baseApp?.expo?.version;
  if (
    baseVersion !== undefined &&
    headVersion !== undefined &&
    baseVersion !== headVersion
  ) {
    const baseCodeNum =
      typeof baseApp?.expo?.android?.versionCode === "number"
        ? baseApp.expo.android.versionCode
        : 1;
    if (headCode === baseCodeNum) {
      failures.push(
        `expo.version changed ("${baseVersion}" -> "${headVersion}") but ` +
          `expo.android.versionCode did not (${headCode}).\n` +
          `    A new user-visible version is always a new artifact.`
      );
    }
  }
}

if (failures.length > 0) {
  console.error("\nandroid version-bump check FAILED (BACKLOG-2956):\n");
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log("android version-bump check passed:");
console.log(`  - base: ${base.slice(0, 9)}`);
console.log(`  - shipping files changed: ${shipping.length}`);
console.log(`  - versionCode: ${headCode}`);
console.log(`  - version: ${headVersion} (matches package.json)`);
