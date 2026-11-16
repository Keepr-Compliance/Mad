#!/usr/bin/env node
// BACKLOG-4245: refusals that run in the build jobs, before anything is signed.
//
//   --local                 ref + channel + package.json version. No network, no
//                           secrets. Runs on every build, main included: main
//                           refuses any version that is not X.Y.Z.
//   --remote                beta/ and rehearsal/ refs only: the target feed by id,
//                           its Latest, and (real feed) the beta floor.
//   --app-update FILE...    a packaged app's app-update.yml reads the real feed
//                           and has no channel key.
//
// Env: GITHUB_REF, CHANNEL; --remote also REAL_FEED_REPO, REAL_FEED_ID,
// SCRATCH_FEED_REPO, HAS_SCRATCH_TOKEN, GH_TOKEN (read-only use).
import { readFileSync } from "node:fs";
import {
  appUpdateConfigErrors,
  latestPreflightErrors,
  localPreflight,
  targetIdErrors,
} from "./feed-lib.mjs";
import { fail, ghRunner, readLatest, repoId } from "./feed-gh.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

function packageVersion() {
  const file = opt("--package", "package.json");
  return JSON.parse(readFileSync(file, "utf8")).version;
}

function local() {
  const ref = process.env.GITHUB_REF ?? "";
  const channel = process.env.CHANNEL ?? "";
  const version = packageVersion();
  const result = localPreflight({ ref, channel, version });
  if (result.errors.length) fail(result.errors);
  console.log(`preflight: ref ${ref}, channel ${channel || "website (default)"}, version ${version}: OK`);
  return { ...result, version };
}

function remote() {
  const { role, kind, version } = local();
  if (!role) fail([`--remote has nothing to check on ${process.env.GITHUB_REF}`]);
  const realFeedId = process.env.REAL_FEED_ID ?? "";
  const errors = [];
  let target;
  if (role === "rehearsal") {
    target = process.env.SCRATCH_FEED_REPO ?? "";
    if (process.env.HAS_SCRATCH_TOKEN !== "true") {
      errors.push("the SCRATCH_FEED_TOKEN repository secret is not set: create it before a rehearsal");
    }
  } else {
    target = process.env.REAL_FEED_REPO ?? "";
  }
  if (!realFeedId) errors.push("REAL_FEED_ID is not set");
  if (!target) {
    errors.push(role === "rehearsal"
      ? "SCRATCH_FEED_REPO is not set: create the repository variable before a rehearsal"
      : "REAL_FEED_REPO is not set");
  }
  if (errors.length) fail(errors);

  const gh = ghRunner();
  const id = repoId(gh, target);
  const idErrors = targetIdErrors({ role, targetRepo: target, targetId: id, realFeedId });
  if (idErrors.length) fail(idErrors);
  const latest = readLatest(gh, target);
  const latestErrors = latestPreflightErrors({ role, kind, version, latest });
  if (latestErrors.length) fail(latestErrors);
  console.log(`preflight: ${role} feed ${target}, ${kind} ${version}, Latest ${latest ? latest.tag_name : "none"}: OK`);
}

function appUpdate() {
  const files = args.slice(args.indexOf("--app-update") + 1).filter((a) => !a.startsWith("--"));
  const [owner, repo] = String(process.env.REAL_FEED_REPO ?? "").split("/");
  if (!owner || !repo) fail(["REAL_FEED_REPO is not set"]);
  if (files.length === 0) fail(["--app-update needs at least one file"]);
  const errors = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      errors.push(`${file}: not found`);
      continue;
    }
    errors.push(...appUpdateConfigErrors(text, { owner, repo }, file));
  }
  if (errors.length) fail(errors);
  console.log(`app-update.yml: ${files.length} file(s) read ${owner}/${repo} with no channel key: OK`);
}

try {
  if (args.includes("--local")) local();
  else if (args.includes("--remote")) remote();
  else if (args.includes("--app-update")) appUpdate();
  else fail(["usage: feed-preflight.mjs --local | --remote | --app-update FILE..."]);
} catch (e) {
  fail([e.message]);
}
