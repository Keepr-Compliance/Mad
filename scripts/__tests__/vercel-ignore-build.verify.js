#!/usr/bin/env node
/**
 * VERIFICATION HARNESS for scripts/vercel-ignore-build.sh — BACKLOG-3916
 * =====================================================================
 * Runs in CI as a step of the Vercel Deploy Map workflow. A harness that never
 * executes is indistinguishable from one that passes, so it fails when zero
 * rows ran.
 *
 * Each row builds a tiny git repo in a temp dir, runs the REAL script with
 * `sh` (dash on ubuntu, as on Vercel) and asserts BOTH the exit code and the
 * log line. The script exits 1 for six different reasons; asserting the line
 * proves the row exercised the reason it is named for.
 *
 * Exit contract (Vercel's): 0 = SKIP the build, 1 = BUILD.
 */

const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "vercel-ignore-build.sh");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "verify",
  GIT_AUTHOR_EMAIL: "verify@example.invalid",
  GIT_COMMITTER_NAME: "verify",
  GIT_COMMITTER_EMAIL: "verify@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: os.tmpdir(),
};

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(repo, rel, content) {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commit(repo, rel, content, msg) {
  write(repo, rel, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "config", "commit.gpgsign", "false");
  commit(dir, "README.md", "root\n", "root");
  commit(dir, "broker-portal/page.tsx", "v1\n", "portal base");
  return dir;
}

// Merge tip, the BACKLOG-3916 shape: the feature commit (first parent) touches
// `featureFile`; the merged-in base branch (second parent) touches `baseFile`.
// HEAD~1 is the feature commit, so a first-parent diff shows only `baseFile`.
function mergeTip(dir, featureFile, baseFile) {
  initRepo(dir);
  git(dir, "checkout", "-q", "-b", "base");
  commit(dir, baseFile, "base side\n", "base side");
  git(dir, "checkout", "-q", "main");
  git(dir, "checkout", "-q", "-b", "feature");
  commit(dir, featureFile, "feature side\n", "feature side");
  git(dir, "merge", "-q", "--no-ff", "--no-edit", "base");
  return dir;
}

// Depth-1 clone of a merge tip: both parents are named in HEAD's object but
// absent from the clone, exactly as in a shallow CI checkout.
function shallowMergeTip(dir) {
  const src = mergeTip(dir + "-src", "broker-portal/page.tsx", "docs/notes.md");
  git(path.dirname(dir), "clone", "-q", "--depth", "1", "file://" + src, dir);
  return dir;
}

const ROWS = [
  // id, description, setup(dir) -> { repo, env? }, portal, ref, expected exit, expected log substring
  {
    id: "L1",
    name: "linear commit touching the portal",
    setup: (d) => (initRepo(d), commit(d, "broker-portal/page.tsx", "v2\n", "portal change"), d),
    ref: "feat-portal/x",
    exit: 1,
    log: "broker-portal affected between 'HEAD~1' and HEAD",
  },
  {
    id: "L2",
    name: "linear commit outside the portal",
    setup: (d) => (initRepo(d), commit(d, "docs/notes.md", "x\n", "docs change"), d),
    ref: "feat-portal/x",
    exit: 0,
    log: "no broker-portal-affecting change between 'HEAD~1' and HEAD; skipping build",
  },
  {
    id: "L3",
    name: "linear commit touching packages/",
    setup: (d) => (initRepo(d), commit(d, "packages/ui/a.ts", "x\n", "pkg change"), d),
    ref: "feat-portal/x",
    exit: 1,
    log: "broker-portal affected between 'HEAD~1' and HEAD",
  },
  {
    id: "L4",
    name: "linear commit touching the OTHER portal only",
    setup: (d) => (initRepo(d), commit(d, "admin-portal/page.tsx", "x\n", "admin change"), d),
    ref: "feat-portal/x",
    exit: 0,
    log: "skipping build",
  },
  {
    id: "M1",
    name: "merge tip, portal change on the feature side (HEAD~1 diff clean) — the bug",
    setup: (d) => mergeTip(d, "broker-portal/page.tsx", "docs/notes.md"),
    ref: "feat-portal/x",
    exit: 1,
    log: "broker-portal affected between merge parent",
  },
  {
    id: "M2",
    name: "merge tip, portal change on the merged-in side (HEAD~1 diff dirty)",
    setup: (d) => mergeTip(d, "docs/notes.md", "broker-portal/other.tsx"),
    ref: "feat-portal/x",
    exit: 1,
    log: "broker-portal affected between 'HEAD~1' and HEAD",
  },
  {
    id: "M3",
    name: "merge tip, no portal change on either side",
    setup: (d) => mergeTip(d, "docs/a.md", "docs/b.md"),
    ref: "feat-portal/x",
    exit: 0,
    log: "skipping build",
  },
  {
    id: "M4",
    name: "merge tip, feature side touches the other portal only",
    setup: (d) => mergeTip(d, "admin-portal/page.tsx", "docs/b.md"),
    ref: "feat-portal/x",
    exit: 0,
    log: "skipping build",
  },
  {
    id: "M5",
    name: "merge tip, feature side touches package-lock.json",
    setup: (d) => mergeTip(d, "package-lock.json", "docs/b.md"),
    ref: "feat-portal/x",
    exit: 1,
    log: "affected between merge parent",
  },
  {
    id: "P1",
    name: "PREVIOUS_SHA two commits back, linear, portal changed in between",
    setup: (d) => {
      initRepo(d);
      const prev = git(d, "rev-parse", "HEAD~1");
      commit(d, "broker-portal/page.tsx", "v2\n", "portal change");
      commit(d, "docs/notes.md", "x\n", "docs change");
      return { repo: d, env: { VERCEL_GIT_PREVIOUS_SHA: prev } };
    },
    ref: "feat-portal/x",
    exit: 1,
    log: "affected between '",
  },
  {
    id: "P2",
    name: "PREVIOUS_SHA = first parent of a merge tip whose portal change is on that parent's side",
    setup: (d) => {
      mergeTip(d, "broker-portal/page.tsx", "docs/notes.md");
      return { repo: d, env: { VERCEL_GIT_PREVIOUS_SHA: git(d, "rev-parse", "HEAD^1") } };
    },
    ref: "feat-portal/x",
    exit: 1,
    log: "affected between merge parent",
  },
  {
    id: "P3",
    name: "PREVIOUS_SHA not in the clone -> falls back to HEAD~1",
    setup: (d) => {
      initRepo(d);
      commit(d, "docs/notes.md", "x\n", "docs change");
      return { repo: d, env: { VERCEL_GIT_PREVIOUS_SHA: "0123456789abcdef0123456789abcdef01234567" } };
    },
    ref: "feat-portal/x",
    exit: 0,
    log: "between 'HEAD~1' and HEAD; skipping build",
  },
  {
    id: "S1",
    name: "shallow (depth 1) merge tip, parents absent",
    setup: (d) => shallowMergeTip(d),
    ref: "feat-portal/x",
    exit: 1,
    log: "no usable base commit",
  },
  {
    id: "S2",
    name: "shallow merge tip with a usable PREVIOUS_SHA (= HEAD's tree, so the BASE diff is empty)",
    setup: (d) => {
      shallowMergeTip(d);
      // HEAD itself is the only commit present; use it as PREVIOUS so BASE resolves
      // and the empty-diff fail-safe is what fires.
      return { repo: d, env: { VERCEL_GIT_PREVIOUS_SHA: git(d, "rev-parse", "HEAD") } };
    },
    ref: "feat-portal/x",
    exit: 1,
    log: "empty changed-file list",
  },
  {
    id: "S3",
    name: "merge tip whose second parent object is missing (BASE resolves, parent does not)",
    setup: (d) => {
      mergeTip(d, "docs/a.md", "docs/b.md");
      const p2 = git(d, "rev-parse", "HEAD^2");
      // Drop the second parent object from the store so only the raw parent line names it.
      const objPath = path.join(d, ".git", "objects", p2.slice(0, 2), p2.slice(2));
      fs.rmSync(objPath);
      return { repo: d };
    },
    ref: "feat-portal/x",
    exit: 1,
    log: "is not in the clone",
  },
  {
    id: "B1",
    name: "main always builds",
    setup: (d) => (initRepo(d), commit(d, "docs/notes.md", "x\n", "docs"), d),
    ref: "main",
    exit: 1,
    log: "branch 'main' always builds",
  },
  {
    id: "B2",
    name: "develop always builds",
    setup: (d) => (initRepo(d), commit(d, "docs/notes.md", "x\n", "docs"), d),
    ref: "develop",
    exit: 1,
    log: "branch 'develop' always builds",
  },
  {
    id: "A1",
    name: "admin-portal: merge tip, admin change on the feature side",
    portal: "admin-portal",
    setup: (d) => mergeTip(d, "admin-portal/page.tsx", "docs/b.md"),
    ref: "feat-portal/x",
    exit: 1,
    log: "admin-portal affected between merge parent",
  },
  {
    id: "A2",
    name: "admin-portal: merge tip, only broker changed",
    portal: "admin-portal",
    setup: (d) => mergeTip(d, "broker-portal/page.tsx", "docs/b.md"),
    ref: "feat-portal/x",
    exit: 0,
    log: "no admin-portal-affecting change",
  },
  {
    id: "E1",
    name: "unknown portal argument",
    portal: "nope-portal",
    setup: (d) => (initRepo(d), d),
    ref: "feat-portal/x",
    exit: 1,
    log: "unrecognised portal",
  },
];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ignore-build-verify-"));
let ran = 0;
let failed = 0;

try {
  for (const row of ROWS) {
    const dir = path.join(tmpRoot, row.id);
    let out = row.setup(dir);
    if (typeof out === "string") out = { repo: out };
    const env = { ...process.env, ...GIT_ENV, VERCEL_GIT_COMMIT_REF: row.ref, ...(out.env || {}) };
    if (!(out.env && "VERCEL_GIT_PREVIOUS_SHA" in out.env)) delete env.VERCEL_GIT_PREVIOUS_SHA;

    const r = spawnSync("sh", [SCRIPT, row.portal || "broker-portal"], {
      cwd: out.repo,
      encoding: "utf8",
      env,
    });
    ran += 1;
    const logOut = (r.stderr || "") + (r.stdout || "");
    const ok = r.status === row.exit && logOut.includes(row.log);
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${row.id}  ${row.name}: expected exit ${row.exit}, got ${r.status}`);
    console.log(`      ${logOut.trim()}`);
    if (!ok) console.log(`      expected log to contain: ${row.log}`);
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (ran === 0) {
  console.error("vercel-ignore-build.verify: 0 rows ran. A harness that runs nothing proves nothing.");
  process.exit(1);
}
console.log(`\nvercel-ignore-build.verify: ${ran} row(s) ran, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
