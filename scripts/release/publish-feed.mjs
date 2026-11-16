#!/usr/bin/env node
// BACKLOG-4245: publish a beta (real feed or rehearsal) or a stable (rehearsal
// only) and assert the result. The real stable publish stays in release.yml's
// create-release job; this script only reads it (--phase check-latest).
//
// Without --execute it calls nothing and prints what it would run.
//
// Phases, in job order:
//   target        token present; feed by id; rehearsal token cannot push to the
//                 real feed; real feed: the Environment requires a reviewer
//   stage         beta: draft prerelease (or resume / repair), then A1, A3, A4
//                 stable: create (or upload on "already exists"), then A3
//   (release.yml's integrity step runs here)
//   finish        beta: make it public as a prerelease, never Latest, then A1', A2
//                 stable: Latest rule (check-latest), enforced
//   check-latest  stable: Latest is a stable at least as new as this tag
//                 (--report-only: warn, always exit 0)
//
// Env: FEED_ROLE (real|rehearsal), FEED_REPO, REAL_FEED_REPO, REAL_FEED_ID,
// GH_TOKEN (the feed token), ENVIRONMENT_NAME + REPO_TOKEN + GITHUB_REPOSITORY
// (real role only).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ASSET_GLOBS,
  RELEASE_NOTES,
  assetSetErrors,
  betaLatestErrors,
  decideBetaFinish,
  decideBetaStage,
  expectedAssetNames,
  flagErrors,
  parseVersion,
  stableLatestErrors,
  targetIdErrors,
  updateFileErrors,
  BETA_RE,
  STABLE_RE,
} from "./feed-lib.mjs";
import { fail, ghJson, ghOk, ghRunner, listReleases, readLatest, repoId } from "./feed-gh.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);

const phase = opt("--phase", "");
const kind = opt("--kind", "");
const version = opt("--version", "");
const root = opt("--root", ".");
const execute = flag("--execute");
const reportOnly = flag("--report-only");
const retries = Number(opt("--retries", "3"));
const retryDelayMs = Number(opt("--retry-delay-ms", "10000"));

const role = process.env.FEED_ROLE ?? "";
const feed = process.env.FEED_REPO ?? "";
const tag = `v${version}`;

// --report-only check-latest never fails the job it runs in.
const warnOnly = reportOnly && phase === "check-latest";
function die(errors) {
  if (!warnOnly) fail(errors);
  for (const e of errors) console.log(`::warning::Latest check for ${tag}: ${e}`);
  process.exit(0);
}

function stableCreateArgv(t, f, files) {
  return ["release", "create", t, "--repo", f, "--title", `Keepr ${t}`, "--notes", RELEASE_NOTES, ...files];
}
function uploadArgv(t, f, files) {
  return ["release", "upload", t, "--repo", f, "--clobber", ...files];
}
function betaCreateArgv(t, f, files) {
  return ["release", "create", t, "--repo", f, "--draft", "--prerelease", "--title", `Keepr ${t}`, "--notes", RELEASE_NOTES, ...files];
}
const BETA_PUBLISH = (t, f) => ["release", "edit", t, "--repo", f, "--draft=false", "--prerelease", "--latest=false"];
const BETA_REASSERT = (t, f) => ["release", "edit", t, "--repo", f, "--prerelease", "--latest=false"];

function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Each glob is "<dir>/*.<ext>"; every one must match at least one file. */
function expandGlobs() {
  const files = [];
  const errors = [];
  for (const glob of ASSET_GLOBS) {
    const dir = path.posix.dirname(glob);
    const ext = path.posix.basename(glob).replace(/^\*/, "");
    let names = [];
    try {
      names = readdirSync(path.join(root, dir)).filter((n) => n.endsWith(ext)).sort();
    } catch {
      names = [];
    }
    if (names.length === 0) errors.push(`no file matches ${glob}`);
    files.push(...names.map((n) => path.join(root, dir, n)));
  }
  if (errors.length) die(errors);
  return files;
}

function requireBasics(needKind) {
  const errors = [];
  if (!["real", "rehearsal"].includes(role)) errors.push(`FEED_ROLE must be real or rehearsal (got "${role}")`);
  if (!feed) {
    errors.push(role === "rehearsal"
      ? "FEED_REPO is empty: the SCRATCH_FEED_REPO repository variable is not set"
      : "FEED_REPO is empty");
  }
  if (needKind) {
    if (!["beta", "stable"].includes(kind)) errors.push(`--kind must be beta or stable (got "${kind}")`);
    if (kind === "beta" && !BETA_RE.test(version)) errors.push(`--version ${version} is not X.Y.Z-beta.N`);
    if (kind === "stable" && !STABLE_RE.test(version)) errors.push(`--version ${version} is not X.Y.Z`);
    if (kind === "stable" && role === "real" && phase !== "check-latest") {
      errors.push("the real stable publish is the create-release job; this script only checks it");
    }
  }
  if (errors.length) die(errors);
}

function viewRelease(gh) {
  return ghJson(gh, ["release", "view", tag, "--repo", feed, "--json", "isDraft,isPrerelease,assets"], `reading ${tag}`);
}

function checkAssets(gh, view, label) {
  const names = (view.assets ?? []).map((a) => a.name);
  return assetSetErrors(names, expectedAssetNames(version), `${label} assets of ${tag}`);
}

function readLatestWithRetry(gh, accept) {
  let latest = null;
  let errors = [];
  for (let i = 0; i < Math.max(1, retries); i++) {
    if (i > 0) sleep(retryDelayMs);
    latest = readLatest(gh, feed);
    errors = accept(latest);
    if (errors.length === 0) break;
  }
  return { latest, errors };
}

/** A2: Latest must not move, so every one of `retries` reads must be clean. */
function readLatestEveryTime(gh, accept) {
  let latest = null;
  for (let i = 0; i < Math.max(1, retries); i++) {
    if (i > 0) sleep(retryDelayMs);
    latest = readLatest(gh, feed);
    const errors = accept(latest);
    if (errors.length) return { latest, errors: errors.map((e) => `read ${i + 1}: ${e}`) };
  }
  return { latest, errors: [] };
}

// ── phases ────────────────────────────────────────────────────────────────

function phaseTarget(gh) {
  requireBasics(false);
  const errors = [];
  if (!process.env.GH_TOKEN) {
    errors.push(role === "real"
      ? `the feed token is empty: the token secret of the ${process.env.ENVIRONMENT_NAME || "beta"} Environment is not set (GitHub creates a missing Environment empty, with no reviewer)`
      : "the feed token is empty: the SCRATCH_FEED_TOKEN repository secret is not set");
  }
  const realFeedId = process.env.REAL_FEED_ID ?? "";
  const realFeed = process.env.REAL_FEED_REPO ?? "";
  if (!realFeedId) errors.push("REAL_FEED_ID is not set");
  if (!realFeed) errors.push("REAL_FEED_REPO is not set");
  if (role === "real" && !process.env.ENVIRONMENT_NAME) errors.push("ENVIRONMENT_NAME is not set");
  if (errors.length) die(errors);

  if (!execute) {
    console.log(`dry run: would check ${feed} (${role}) by id${role === "rehearsal" ? `, and that the token cannot push to ${realFeed}` : `, and the ${process.env.ENVIRONMENT_NAME} Environment's reviewers`}`);
    return;
  }
  const id = repoId(gh, feed);
  const idErrors = targetIdErrors({ role, targetRepo: feed, targetId: id, realFeedId });
  if (idErrors.length) die(idErrors);

  if (role === "rehearsal") {
    const real = ghJson(gh, ["api", `repos/${realFeed}`], `reading ${realFeed} with the rehearsal token`);
    if (real?.permissions?.push !== false) {
      die([`the rehearsal token must not be able to push to ${realFeed} (permissions.push is ${real?.permissions?.push})`]);
    }
  } else {
    const repo = process.env.GITHUB_REPOSITORY ?? "";
    const envName = process.env.ENVIRONMENT_NAME;
    const r = gh(["api", `repos/${repo}/environments/${encodeURIComponent(envName)}`], { token: process.env.REPO_TOKEN ?? "" });
    if (r.status !== 0) die([`could not read the ${envName} Environment: ${r.stderr.trim()}`]);
    const env = JSON.parse(r.stdout);
    const reviewers = (env.protection_rules ?? [])
      .filter((p) => p.type === "required_reviewers")
      .flatMap((p) => p.reviewers ?? []);
    const envErrors = [];
    if (reviewers.length === 0) envErrors.push(`the ${envName} Environment has no required reviewer`);
    if (!env.deployment_branch_policy) envErrors.push(`the ${envName} Environment admits every branch`);
    if (envErrors.length) die(envErrors);
  }
  console.log(`target: ${feed} (${role}) checked: OK`);
}

function phaseStage(gh) {
  requireBasics(true);
  if (!execute) {
    const files = ASSET_GLOBS;
    const plan = kind === "stable"
      ? { create: stableCreateArgv("<TAG>", "<FEED>", files), upload: uploadArgv("<TAG>", "<FEED>", files) }
      : { create: betaCreateArgv("<TAG>", "<FEED>", files), resume: uploadArgv("<TAG>", "<FEED>", files), repair: BETA_REASSERT("<TAG>", "<FEED>") };
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  phaseTarget(gh); // every write phase re-checks token and target itself
  const files = expandGlobs();
  const localErrors = assetSetErrors(files.map((f) => path.basename(f)), expectedAssetNames(version), "built files");
  if (localErrors.length) die(localErrors);

  if (kind === "stable") {
    const r = gh(stableCreateArgv(tag, feed, files));
    if (r.status === 0) {
      console.log("Release created successfully.");
    } else if (/already exists/i.test(r.stderr)) {
      console.log("Release already exists — uploading/updating assets instead.");
      ghOk(gh, uploadArgv(tag, feed, files), `uploading to ${tag}`);
    } else {
      die([`gh release create failed with an unexpected error: ${r.stderr.trim()}`]);
    }
    const errors = checkAssets(gh, viewRelease(gh), "published");
    if (errors.length) die(errors);
    console.log(`stage: stable ${tag} on ${feed}: 12 assets: OK`);
    return;
  }

  const decision = decideBetaStage(listReleases(gh, feed), tag);
  if (decision.refuse) die([decision.refuse]);
  console.log(`stage: ${tag} on ${feed}: ${decision.action}`);
  if (decision.action === "create") {
    ghOk(gh, betaCreateArgv(tag, feed, files), `creating the draft ${tag}`);
  } else if (decision.action === "resume") {
    ghOk(gh, uploadArgv(tag, feed, files), `uploading to the draft ${tag}`);
  } else {
    ghOk(gh, BETA_REASSERT(tag, feed), `re-asserting the prerelease flags of ${tag}`);
    const reasserted = flagErrors(viewRelease(gh), decision.expect, "after re-asserting flags");
    if (reasserted.length) die(reasserted);
    ghOk(gh, uploadArgv(tag, feed, files), `uploading to ${tag}`);
  }

  const view = viewRelease(gh);
  const errors = [...flagErrors(view, decision.expect, "A1"), ...checkAssets(gh, view, "A3")];
  if (errors.length) die(errors);

  const dir = mkdtempSync(path.join(os.tmpdir(), "feed-a4-"));
  try {
    ghOk(gh, ["release", "download", tag, "--repo", feed, "-p", "latest-mac.yml", "-p", "latest.yml", "-D", dir], `downloading the update files of ${tag}`);
    const names = expectedAssetNames(version);
    const ymlErrors = [];
    for (const file of ["latest-mac.yml", "latest.yml"]) {
      let text = "";
      try {
        text = readFileSync(path.join(dir, file), "utf8");
      } catch {
        ymlErrors.push(`A4: ${file} was not downloaded`);
        continue;
      }
      ymlErrors.push(...updateFileErrors(text, version, names, `A4 ${file}`));
    }
    if (ymlErrors.length) die(ymlErrors);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`stage: ${tag} is a ${view.isDraft ? "draft " : ""}prerelease with its 12 assets: OK`);
}

function phaseFinishBeta(gh) {
  phaseTarget(gh); // every write phase re-checks token and target itself
  const decision = decideBetaFinish(listReleases(gh, feed), tag);
  if (decision.refuse) die([decision.refuse]);
  const previous = readLatest(gh, feed);
  if (!previous) die(["the feed has no Latest before publishing the beta"]);
  ghOk(gh, BETA_PUBLISH(tag, feed), `publishing ${tag} as a prerelease`);
  const flags = flagErrors(viewRelease(gh), { isDraft: false, isPrerelease: true }, "A1'");
  if (flags.length) die(flags);
  const { latest, errors } = readLatestEveryTime(gh, (l) => betaLatestErrors({ latest: l, tag, previousTag: previous.tag_name }));
  if (errors.length) die(errors.map((e) => `A2: ${e}`));
  console.log(`finish: ${tag} is a public prerelease; Latest is still ${latest.tag_name}: OK`);
}

function phaseCheckLatest(gh) {
  let result;
  try {
    result = readLatestWithRetry(gh, (l) => stableLatestErrors({ latest: l, tag }));
  } catch (e) {
    result = { latest: null, errors: [e.message] };
  }
  if (result.errors.length === 0) {
    console.log(`Latest is ${result.latest.tag_name} for ${tag}: OK`);
    return;
  }
  if (reportOnly) {
    for (const e of result.errors) console.log(`::warning::Latest check for ${tag}: ${e}`);
    return;
  }
  die(result.errors);
}

try {
  if (!["target", "stage", "finish", "check-latest"].includes(phase)) {
    die(["usage: publish-feed.mjs --phase target|stage|finish|check-latest [--kind beta|stable --version V] [--execute]"]);
  }
  if (version && !parseVersion(version)) die([`--version ${version} is not a version`]);
  if (phase === "target") {
    phaseTarget(execute ? ghRunner() : null);
  } else if (phase === "stage") {
    phaseStage(execute ? ghRunner() : null);
  } else {
    requireBasics(true);
    if (!execute) {
      console.log(phase === "finish" && kind === "beta"
        ? JSON.stringify({ publish: BETA_PUBLISH("<TAG>", "<FEED>") }, null, 2)
        : `dry run: would read the Latest release of ${feed}`);
    } else if (phase === "finish" && kind === "beta") {
      phaseFinishBeta(ghRunner());
    } else {
      phaseCheckLatest(ghRunner());
    }
  }
} catch (e) {
  if (reportOnly && phase === "check-latest") {
    console.log(`::warning::Latest check could not run: ${e.message}`);
    process.exit(0);
  }
  die([e.message]);
}
