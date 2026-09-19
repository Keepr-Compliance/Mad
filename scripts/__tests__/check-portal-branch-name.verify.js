#!/usr/bin/env node
/**
 * VERIFICATION HARNESS for scripts/ci/check-portal-branch-name.mjs — BACKLOG-3205
 * ============================================================================
 * Runs in CI as the "Verify the check itself" step of the Portal Branch Name
 * workflow. It fails when zero cases ran.
 *
 * It builds a throwaway git history under os.tmpdir(): a bare "origin" and a
 * clone. It does not use this repository's own branches, which get renamed and
 * merged, and which a fork does not have. Each fixture copies the SHAPE of a case
 * measured on real branches during planning (recorded on the backlog item); no
 * file content is real.
 *
 * History (origin):
 *   main     m0
 *   develop  m0 - d1(desktop) - d2(portal)        develop is one portal file ahead of main
 *
 * Cases (exit code expected)
 *   H1   push int/a: own portal commit, then an own desktop commit on top   1
 *   H1b  push int/g: own commit under packages/ui/                          1
 *   H1c  push int/h: own commit under packages/shared/                      0
 *   H2   push int/b: forked at d1, own desktop commit, merged develop
 *        (the merge brings d2's portal file)                                0
 *   H3   push int/c: forked at d1, own desktop commit, develop moved on      0
 *   H4   push hotfix/d: cut from develop, own desktop commit               0
 *   H4b  push hotfix/k: cut from main while main is one portal commit
 *        ahead of develop; own desktop commit (separate origin)          0
 *   H5   push hotfix/e: cut from main, own portal commit                   1
 *   H6   push int/f: cut from develop, own desktop commit                  0
 *   H7   PR feature/f7 -> int/p7: base gained a portal commit after the
 *        head forked; the head has only a desktop commit                    0
 *   H8   PR feature/f8 -> int/p7: own portal commit                         1
 *   H9   PR develop -> int/c (trunk sync)                                   0
 *   H10a push int-portal/a at H1's commit                                   0
 *   H10b push hotfix-portal/e at H5's commit                                0
 *   H10c push intake/x at H1's commit                                       0
 *   H10d push int/x/y at H1's commit                                        1
 *   H10e PR feature/f8 -> int-portal/p7                                     0
 *   H11  push int/a, origin has no main                                     2
 *   H12  push int/a, origin main has unrelated history                      2
 *   H13  PR with a base commit that exists nowhere                          2
 *   H13b PR whose base has unrelated history                                2
 *
 * Mutations each case exists to kill (re-run at implementation):
 *   push range HEAD~1..HEAD         H1 (misses), H2 (false red)
 *   push range two-dot vs develop   H3
 *   trunk inferred from prefix      H4 (hotfix -> main)
 *   main-only trunk                 H4, H6
 *   develop-only trunk              H4b (main's merge-base computed, result unused)
 *   PR range two-dot                H7
 *   trunk-sync exemption removed    H9
 *   prefix match without the slash  H10a, H10c
 *   exit 0 on findings              H1, H5, H8
 *   git error read as no changes    H11, H12 (push), H13, H13b (PR)
 *   portal dirs only                H1b
 *   all of packages/                H1c
 */

const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const CHECK = path.join(REPO_ROOT, "scripts", "ci", "check-portal-branch-name.mjs");

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "verify",
  GIT_AUTHOR_EMAIL: "verify@example.invalid",
  GIT_COMMITTER_NAME: "verify",
  GIT_COMMITTER_EMAIL: "verify@example.invalid",
};
// No signing and no hooks inside the throwaway repos.
const GIT_FLAGS = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main"];

function git(cwd, ...args) {
  return execFileSync("git", [...GIT_FLAGS, ...args], { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(cwd, file, message) {
  const abs = path.join(cwd, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, `${message}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-branch-verify-"));
const results = [];

function build() {
  const work = path.join(tmp, "build");
  fs.mkdirSync(work);
  git(work, "init", "-q");
  commitFile(work, "README.md", "m0 readme");
  for (const f of ["broker-portal/page.txt", "admin-portal/page.txt", "packages/ui/x.txt", "packages/design-system/y.txt", "packages/shared/s.txt", "src/app.txt"]) {
    commitFile(work, f, `m0 ${f}`);
  }
  const m0 = git(work, "rev-parse", "HEAD");

  git(work, "checkout", "-q", "-b", "develop");
  const d1 = commitFile(work, "src/app.txt", "d1 desktop");

  // int/c and int/b fork at d1, before develop gains its portal commit.
  git(work, "checkout", "-q", "-b", "int/c", d1);
  commitFile(work, "src/c.txt", "c own desktop");
  git(work, "checkout", "-q", "-b", "int/b", d1);
  commitFile(work, "src/b.txt", "b own desktop");

  git(work, "checkout", "-q", "develop");
  commitFile(work, "broker-portal/page.txt", "d2 portal");

  git(work, "checkout", "-q", "int/b");
  git(work, "merge", "-q", "--no-ff", "-m", "merge develop into int/b", "develop");

  git(work, "checkout", "-q", "-b", "int/a", "develop");
  commitFile(work, "broker-portal/a.txt", "a own portal");
  commitFile(work, "src/a.txt", "a own desktop on top");

  git(work, "checkout", "-q", "-b", "int/g", "develop");
  commitFile(work, "packages/ui/g.txt", "g own ui");
  git(work, "checkout", "-q", "-b", "int/h", "develop");
  commitFile(work, "packages/shared/h.txt", "h own shared");
  git(work, "checkout", "-q", "-b", "hotfix/d", "develop");
  commitFile(work, "src/d.txt", "d own desktop");
  git(work, "checkout", "-q", "-b", "hotfix/e", m0);
  commitFile(work, "admin-portal/e.txt", "e own portal");
  git(work, "checkout", "-q", "-b", "int/f", "develop");
  commitFile(work, "src/f.txt", "f own desktop");

  git(work, "checkout", "-q", "-b", "int/p7", "develop");
  git(work, "checkout", "-q", "-b", "feature/f7", "int/p7");
  const f7 = commitFile(work, "src/f7.txt", "f7 own desktop");
  git(work, "checkout", "-q", "-b", "feature/f8", "int/p7");
  const f8 = commitFile(work, "admin-portal/f8.txt", "f8 own portal");
  git(work, "checkout", "-q", "int/p7");
  const p7 = commitFile(work, "broker-portal/p7.txt", "p7 base gains a portal commit");

  git(work, "checkout", "-q", "--orphan", "unrelated");
  git(work, "rm", "-rq", "--cached", ".");
  for (const entry of fs.readdirSync(work)) if (entry !== ".git") fs.rmSync(path.join(work, entry), { recursive: true, force: true });
  const unrelated = commitFile(work, "other.txt", "unrelated root");
  git(work, "checkout", "-q", "develop");

  const origin = path.join(tmp, "origin.git");
  git(tmp, "clone", "-q", "--bare", work, origin);
  // Keep the unrelated root reachable in origin only through its own branch.
  const clone = path.join(tmp, "clone");
  git(tmp, "clone", "-q", origin, clone);

  // H11: an origin with no main.
  const originNoMain = path.join(tmp, "origin-nomain.git");
  git(tmp, "clone", "-q", "--bare", work, originNoMain);
  git(originNoMain, "branch", "-D", "main");
  const cloneNoMain = path.join(tmp, "clone-nomain");
  git(tmp, "clone", "-q", "--branch", "develop", originNoMain, cloneNoMain);

  // H12: an origin whose main is unrelated history.
  const originUnrelated = path.join(tmp, "origin-unrelated.git");
  git(tmp, "clone", "-q", "--bare", work, originUnrelated);
  git(originUnrelated, "update-ref", "refs/heads/main", unrelated);
  const cloneUnrelated = path.join(tmp, "clone-unrelated");
  git(tmp, "clone", "-q", "--branch", "develop", originUnrelated, cloneUnrelated);

  return { clone, cloneNoMain, cloneUnrelated, f7, f8, p7, unrelated };
}

// H4b: its own origin, so its merge-bases do not move the other cases'.
// main = m0 - h1(portal); develop = m0 - d1(desktop); hotfix/k = h1 - k1(desktop).
function buildMainAhead() {
  const work = path.join(tmp, "build-main-ahead");
  fs.mkdirSync(work);
  git(work, "init", "-q");
  commitFile(work, "README.md", "m0 readme");
  commitFile(work, "broker-portal/page.txt", "m0 portal");
  commitFile(work, "src/app.txt", "m0 desktop");
  git(work, "checkout", "-q", "-b", "develop");
  commitFile(work, "src/app.txt", "d1 desktop");
  git(work, "checkout", "-q", "main");
  commitFile(work, "broker-portal/h.txt", "h1 hotfix portal, on main, not yet on develop");
  git(work, "checkout", "-q", "-b", "hotfix/k");
  commitFile(work, "src/k.txt", "k own desktop");
  git(work, "checkout", "-q", "develop");
  const origin = path.join(tmp, "origin-main-ahead.git");
  git(tmp, "clone", "-q", "--bare", work, origin);
  const clone = path.join(tmp, "clone-main-ahead");
  git(tmp, "clone", "-q", "--branch", "develop", origin, clone);
  return clone;
}

function runCheck(cwd, env, detachAt) {
  if (detachAt) git(cwd, "checkout", "-q", "--detach", detachAt);
  const r = spawnSync(process.execPath, [CHECK], {
    cwd,
    encoding: "utf8",
    env: { ...GIT_ENV, EVENT_NAME: "", REF_NAME: "", PR_BASE_REF: "", PR_HEAD_REF: "", PR_BASE_SHA: "", PR_HEAD_SHA: "", ...env },
  });
  return { code: r.status, all: (r.stdout || "") + (r.stderr || "") };
}

function expectCase(id, name, got, expected, mustContain) {
  let ok = got.code === expected;
  let detail = `expected exit ${expected}, got ${got.code}`;
  if (ok && mustContain && !got.all.includes(mustContain)) {
    ok = false;
    detail += `; output lacks "${mustContain}"`;
  }
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}: ${detail}`);
  if (!ok) console.log(got.all.split("\n").map((l) => `      ${l}`).join("\n"));
}

try {
  const fx = build();
  const c = fx.clone;
  const sha = (ref) => git(c, "rev-parse", `origin/${ref}`);
  const push = (branch, at) => runCheck(c, { EVENT_NAME: "push", REF_NAME: branch }, at);
  const pr = (baseRef, headRef, baseSha, headSha, cwd = c) =>
    runCheck(cwd, { EVENT_NAME: "pull_request", PR_BASE_REF: baseRef, PR_HEAD_REF: headRef, PR_BASE_SHA: baseSha, PR_HEAD_SHA: headSha });

  expectCase("H1", "push int/a, own portal then desktop on top", push("int/a", sha("int/a")), 1, "int-portal/a");
  expectCase("H1b", "push int/g, own packages/ui change", push("int/g", sha("int/g")), 1, "packages/ui/g.txt");
  expectCase("H1c", "push int/h, own packages/shared change", push("int/h", sha("int/h")), 0);
  expectCase("H2", "push int/b, develop merge brings a portal file", push("int/b", sha("int/b")), 0);
  expectCase("H3", "push int/c, develop moved on with a portal commit", push("int/c", sha("int/c")), 0);
  expectCase("H4", "push hotfix/d, cut from develop, desktop only", push("hotfix/d", sha("hotfix/d")), 0);
  const mainAhead = buildMainAhead();
  const k = git(mainAhead, "rev-parse", "origin/hotfix/k");
  expectCase("H4b", "push hotfix/k, cut from main while main leads develop by a portal commit", runCheck(mainAhead, { EVENT_NAME: "push", REF_NAME: "hotfix/k" }, k), 0);
  expectCase("H5", "push hotfix/e, cut from main, own portal", push("hotfix/e", sha("hotfix/e")), 1, "hotfix-portal/e");
  expectCase("H6", "push int/f, cut from develop, desktop only", push("int/f", sha("int/f")), 0);
  expectCase("H7", "PR f7 -> int/p7, base gained a portal commit", pr("int/p7", "feature/f7", fx.p7, fx.f7), 0);
  expectCase("H8", "PR f8 -> int/p7, own portal commit", pr("int/p7", "feature/f8", fx.p7, fx.f8), 1, "int-portal/p7");
  expectCase("H9", "PR develop -> int/c, trunk sync", pr("int/c", "develop", sha("int/c"), sha("develop")), 0);
  expectCase("H10a", "push int-portal/a at int/a", push("int-portal/a", sha("int/a")), 0);
  expectCase("H10b", "push hotfix-portal/e at hotfix/e", push("hotfix-portal/e", sha("hotfix/e")), 0);
  expectCase("H10c", "push intake/x at int/a", push("intake/x", sha("int/a")), 0);
  expectCase("H10d", "push int/x/y at int/a", push("int/x/y", sha("int/a")), 1, "int-portal/x/y");
  expectCase("H10e", "PR f8 -> int-portal/p7", pr("int-portal/p7", "feature/f8", fx.p7, fx.f8), 0);

  const aNoMain = git(fx.cloneNoMain, "rev-parse", "origin/int/a");
  expectCase("H11", "push int/a, origin has no main", runCheck(fx.cloneNoMain, { EVENT_NAME: "push", REF_NAME: "int/a" }, aNoMain), 2);
  const aUnrel = git(fx.cloneUnrelated, "rev-parse", "origin/int/a");
  expectCase("H12", "push int/a, origin main unrelated", runCheck(fx.cloneUnrelated, { EVENT_NAME: "push", REF_NAME: "int/a" }, aUnrel), 2);
  expectCase("H13", "PR with a base commit that exists nowhere", pr("int/p7", "feature/f8", "0123456789abcdef0123456789abcdef01234567", fx.f8), 2);
  expectCase("H13b", "PR whose base has unrelated history", pr("int/p7", "feature/f8", fx.unrelated, fx.f8), 2);
} catch (err) {
  console.error(`check-portal-branch-name.verify: fixture build failed: ${err.message}`);
  results.push({ id: "BUILD", ok: false });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
if (results.length === 0) {
  console.error("check-portal-branch-name.verify: 0 cases ran. A harness that runs nothing proves nothing.");
  process.exit(1);
}
console.log(`\ncheck-portal-branch-name.verify: ${results.length} case(s) ran, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
