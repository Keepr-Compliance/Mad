#!/usr/bin/env node
// BACKLOG-4245: release.yml's stable, beta and rehearsal publish paths stay as
// reviewed. Fails when:
//  - create-release's text differs from its reviewed text (pinned by hash),
//    apart from its last, report-only step;
//  - the stable mirror passes --prerelease, --latest or --draft;
//  - the rehearsal's stable commands differ from the stable mirror's;
//  - a build job's local preflight step is missing, conditional, or runs after
//    a step that reads a secret;
//  - a token secret appears outside the job that owns it, or the beta token
//    appears in a job without the feed-beta Environment;
//  - an expression mixes a secret with && or || (it falls through to the
//    second value when the first is empty);
//  - publish-beta and rehearse-feed differ in anything but step env;
//  - either job's `if:` differs from its reviewed text;
//  - the copied integrity step drifts from create-release's.
//
// Dependency-free (runs with no npm install): reads the workflow by indentation.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const wfIndex = args.indexOf("--workflow");
const WORKFLOW = wfIndex >= 0 ? args[wfIndex + 1] : path.join(ROOT, ".github/workflows/release.yml");

/** sha256 of create-release from its key line to the end of its integrity step, as reviewed. */
export const CREATE_RELEASE_SHA256 = "9502567ac43116273fd833bb8308003038c6ddd9df70b8fb84837ac23d003842";
const LATEST_STEP_MARKER = "\n\n      # BACKLOG-4245: report only.";
const LATEST_STEP_NAME = "Check which release is Latest (report only, BACKLOG-4245)";

const PUBLISH_BETA_IF =
  "always() && inputs.channel == 'beta' && startsWith(github.ref, 'refs/heads/beta/') && " +
  "needs.release-macos.result == 'success' && needs.release-windows.result == 'success'";
const REHEARSE_IF =
  "always() && startsWith(github.ref, 'refs/heads/rehearsal/') && " +
  "(inputs.channel == 'website' || inputs.channel == 'beta') && " +
  "needs.release-macos.result == 'success' && needs.release-windows.result == 'success'";
const LOCAL_STEP_NAME = "Refuse a version or channel this ref cannot release (BACKLOG-4245)";
const SCRATCH_PRESENCE = "${{ secrets.SCRATCH_FEED_TOKEN != '' }}";

const errors = [];
const err = (m) => errors.push(m);

const text = readFileSync(WORKFLOW, "utf8").replace(/\r\n/g, "\n");
const lines = text.split("\n");

function jobRange(name) {
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[^ #\n]/.test(lines[i]) || /^[^ #\n]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [start, end];
}
function jobText(name) {
  const r = jobRange(name);
  return r ? lines.slice(r[0], r[1]).join("\n") + "\n" : null;
}
function stepsOf(job) {
  const out = [];
  let cur = null;
  for (const line of job.split("\n")) {
    if (/^ {6}- /.test(line)) {
      cur = [line];
      out.push(cur);
    } else if (cur && (line === "" || /^ {8}/.test(line))) {
      cur.push(line);
    } else if (cur && /^ {6}#/.test(line)) {
      cur.push(line);
    } else {
      cur = null;
    }
  }
  return out.map((s) => s.join("\n").replace(/\n+$/, "") + "\n");
}
const stepName = (step) => (/^ {6}- name: (.+)$/m.exec(step) || [])[1] ?? "";
function withoutEnv(step) {
  const out = [];
  let inEnv = false;
  for (const line of step.split("\n")) {
    if (/^ {8}env:\s*$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (inEnv && /^ {10}/.test(line)) continue;
    inEnv = false;
    out.push(line);
  }
  return out.join("\n");
}
/** Comment lines between steps belong to the next step; drop them for comparisons. */
const stripComments = (step) => step.split("\n").filter((l) => !/^ {6}#/.test(l)).join("\n").replace(/\s+$/, "");
function jobIf(job) {
  const ls = job.split("\n");
  const i = ls.findIndex((l) => /^ {4}if:/.test(l));
  if (i < 0) return null;
  const inline = ls[i].replace(/^ {4}if:\s*/, "");
  if (inline && inline !== ">-") return inline.trim();
  const parts = [];
  for (let j = i + 1; j < ls.length && /^ {6}\S/.test(ls[j]); j++) parts.push(ls[j].trim());
  return parts.join(" ");
}
const secretsIn = (t) => [...String(t).matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
const expressions = (t) => [...String(t).matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[0]);

// ── create-release: reviewed text + one appended report-only step ──────────
const createRelease = jobText("create-release");
if (!createRelease) {
  err("create-release job not found");
} else {
  const cut = createRelease.indexOf(LATEST_STEP_MARKER);
  if (cut < 0) {
    err("create-release: the report-only Latest step is missing");
  } else {
    const reviewed = createRelease.slice(0, cut + 1);
    const hash = createHash("sha256").update(reviewed).digest("hex");
    if (hash !== CREATE_RELEASE_SHA256) {
      err(`create-release differs from its reviewed text (sha256 ${hash}); a change to it needs review and a new pin`);
    }
    const steps = stepsOf(createRelease);
    const last = steps[steps.length - 1] ?? "";
    if (stepName(last) !== LATEST_STEP_NAME) err(`create-release: the last step must be "${LATEST_STEP_NAME}"`);
    if (!/^ {8}continue-on-error: true$/m.test(last)) err("create-release: the Latest step must be continue-on-error: true");
    if (!/--report-only/.test(last)) err("create-release: the Latest step must pass --report-only");
    if (secretsIn(last).length) err("create-release: the Latest step must read no secret");
  }

  const mirror = stepsOf(createRelease).find((s) => stepName(s) === "Mirror to public releases repo");
  if (!mirror) {
    err("create-release: the mirror step is missing");
  } else {
    for (const f of ["--prerelease", "--latest", "--draft"]) {
      if (mirror.includes(f)) err(`create-release: the stable mirror passes ${f}`);
    }
    checkParity(mirror);
  }
}

function shellWords(line) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) words.push(m[1] !== undefined ? m[1] : m[2]);
  return words;
}
function commandWords(step, startRe, endRe) {
  const ls = step.split("\n");
  const i = ls.findIndex((l) => startRe.test(l));
  if (i < 0) return null;
  const words = [];
  for (let j = i; j < ls.length; j++) {
    let l = ls[j].trim();
    if (endRe && endRe.test(l)) break;
    const more = l.endsWith("\\");
    l = l.replace(/\s*\\$/, "").replace(/^if\s+/, "");
    words.push(...shellWords(l));
    if (!more) break;
  }
  return words
    .map((w) => w.replace(/\$\{VERSION\}/g, "<TAG>").replace(/\$\{PUBLIC_REPO\}/g, "<FEED>"))
    .slice(1); // drop "gh"
}
function checkParity(mirror) {
  const create = commandWords(mirror, /^\s*if gh release create /, /^2>/);
  const upload = commandWords(mirror, /^\s*gh release upload /, null);
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/release/publish-feed.mjs"), "--phase", "stage", "--kind", "stable", "--version", "0.0.0"], {
    encoding: "utf8",
    env: { ...process.env, FEED_ROLE: "rehearsal", FEED_REPO: "placeholder/feed" },
  });
  if (r.status !== 0) {
    err(`publish-feed.mjs --kind stable dry run failed: ${r.stderr.trim()}`);
    return;
  }
  const plan = JSON.parse(r.stdout);
  if (JSON.stringify(create) !== JSON.stringify(plan.create)) {
    err(`rehearsal stable create differs from the mirror's:\n  mirror:    ${JSON.stringify(create)}\n  rehearsal: ${JSON.stringify(plan.create)}`);
  }
  if (JSON.stringify(upload) !== JSON.stringify(plan.upload)) {
    err(`rehearsal stable upload differs from the mirror's:\n  mirror:    ${JSON.stringify(upload)}\n  rehearsal: ${JSON.stringify(plan.upload)}`);
  }
}

// ── build jobs: the local preflight runs first and unconditionally ─────────
for (const job of ["release-macos", "release-windows"]) {
  const t = jobText(job);
  if (!t) {
    err(`${job} job not found`);
    continue;
  }
  const steps = stepsOf(t);
  const i = steps.findIndex((s) => stepName(s) === LOCAL_STEP_NAME);
  if (i < 0) {
    err(`${job}: the step "${LOCAL_STEP_NAME}" is missing`);
    continue;
  }
  if (/^ {8}if:/m.test(steps[i])) err(`${job}: the local preflight step must not have an if:`);
  if (!/feed-preflight\.mjs --local/.test(steps[i])) err(`${job}: the local preflight step must run feed-preflight.mjs --local`);
  if (secretsIn(steps[i]).length) err(`${job}: the local preflight step must read no secret`);
  const firstSecret = steps.findIndex((s) => secretsIn(s).length > 0);
  if (firstSecret >= 0 && firstSecret < i) err(`${job}: the local preflight step must run before "${stepName(steps[firstSecret])}" reads a secret`);
}

// ── secrets: each token in its own job ─────────────────────────────────────
const jobNames = lines.filter((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l) && jobRange(l.trim().slice(0, -1))).map((l) => l.trim().slice(0, -1));
const jobsStart = lines.indexOf("jobs:");
for (const name of jobNames) {
  const r = jobRange(name);
  if (!r || r[0] < jobsStart) continue;
  const t = jobText(name);
  const used = secretsIn(t);
  const hasEnv = /^ {4}environment: feed-beta\s*$/m.test(t);
  if (hasEnv && name !== "publish-beta") err(`${name}: only publish-beta may use the feed-beta Environment`);
  if (used.includes("FEED_BETA_TOKEN") && !hasEnv) err(`${name}: reads FEED_BETA_TOKEN without environment: feed-beta`);
  if (used.includes("PUBLIC_RELEASE_TOKEN") && name !== "create-release") err(`${name}: reads PUBLIC_RELEASE_TOKEN (create-release only)`);
  if (name !== "rehearse-feed") {
    const bare = t.split(SCRATCH_PRESENCE).join("");
    if (secretsIn(bare).includes("SCRATCH_FEED_TOKEN")) err(`${name}: reads SCRATCH_FEED_TOKEN (rehearse-feed only, or the presence test ${SCRATCH_PRESENCE})`);
  }
  if (name === "publish-beta") {
    if (!hasEnv) err("publish-beta: must declare environment: feed-beta");
    for (const s of used) if (s !== "FEED_BETA_TOKEN") err(`publish-beta: reads ${s}`);
  }
  if (name === "rehearse-feed") for (const s of used) if (s !== "SCRATCH_FEED_TOKEN") err(`rehearse-feed: reads ${s}`);
}

for (const e of expressions(text)) {
  if (/secrets\./.test(e) && /&&|\|\|/.test(e)) err(`an expression mixes a secret with && or ||: ${e}`);
}

// ── publish-beta and rehearse-feed: same steps, reviewed if: ───────────────
const beta = jobText("publish-beta");
const rehearse = jobText("rehearse-feed");
if (!beta) err("publish-beta job not found");
if (!rehearse) err("rehearse-feed job not found");
if (beta && rehearse) {
  const a = stepsOf(beta).map((s) => stripComments(withoutEnv(s)));
  const b = stepsOf(rehearse).map((s) => stripComments(withoutEnv(s)));
  if (a.length === 0) err("publish-beta has no steps");
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    const i = a.findIndex((s, k) => s !== b[k]);
    err(`publish-beta and rehearse-feed steps differ (first at step ${i + 1}: "${stepName(a[i] ?? b[i] ?? "")}")`);
  }
  if (jobIf(beta) !== PUBLISH_BETA_IF) err(`publish-beta if: differs from the reviewed text: ${jobIf(beta)}`);
  if (jobIf(rehearse) !== REHEARSE_IF) err(`rehearse-feed if: differs from the reviewed text: ${jobIf(rehearse)}`);
  for (const [n, t] of [["publish-beta", beta], ["rehearse-feed", rehearse]]) {
    if (/store/.test(jobIf(t) ?? "")) err(`${n}: if: admits store`);
    if (!/^ {4}needs: \[release-macos, release-windows\]$/m.test(t)) err(`${n}: needs both build jobs`);
  }

  // The integrity copy: create-release's step with FEED_REPO and no private legs.
  const original = createRelease && stepsOf(createRelease).find((s) => stepName(s) === "Verify release asset integrity");
  const run = (s) => (s ? s.slice(s.indexOf("        run: |\n")) : "");
  if (original) {
    const expected = run(original)
      .replace('          PRIVATE_REPO="${GITHUB_REPOSITORY}"\n', "")
      .replace('          PUBLIC_REPO="Keepr-Compliance/keepr-releases"\n', '          PUBLIC_REPO="${FEED_REPO}"\n')
      .replace('          verify_repo "${PRIVATE_REPO}" "${GITHUB_TOKEN}" "private"\n', "")
      .replace('          strict_verify_repo "${PRIVATE_REPO}" "${GITHUB_TOKEN}" "private" "false"\n', "");
    const copy = stepsOf(beta).find((s) => stepName(s) === "Verify release asset integrity");
    if (stripComments(run(copy)) !== stripComments(expected)) err("publish-beta: the integrity step differs from create-release's (apart from FEED_REPO and the private legs)");
  }
}

if (!/^ {8}options: \[website, store, beta\]$/m.test(text)) err("workflow_dispatch channel options must be [website, store, beta]");

if (errors.length) {
  for (const e of errors) console.error(`::error::check-release-feed-flags: ${e}`);
  process.exit(1);
}
console.log(`check-release-feed-flags: OK — ${path.relative(ROOT, WORKFLOW) || WORKFLOW}`);
