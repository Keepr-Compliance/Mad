#!/usr/bin/env node
/**
 * Verification harness for scripts/test-with-restore.js (BACKLOG-2372).
 *
 *   node scripts/__tests__/test-with-restore.verify.js
 *
 * Exits 0 only if every case passes.
 *
 * ## Why this is a standalone script and not a jest suite
 *
 * jest.config.js restricts the CI `testMatch` to `src/**` and `electron/**`, so
 * a suite under `scripts/` would never run in CI. Broadening `testMatch` would
 * drag `scripts/qa/harness/__tests__/**` (which has its own jest.qa.config.js)
 * into the unit run -- a worse trade. The `.verify.js` extension also matches
 * neither `testMatch` branch (both need a `.test.`/`.spec.` infix), so this file
 * cannot be dragged into a local `npm test` either.
 *
 * ## How it works
 *
 * A fixture mirrors the repo layout and gets a COPY of the real wrapper, so the
 * production script is exercised unmodified with no test-only hooks in it:
 *
 *   <fixture>/scripts/test-with-restore.js                  <- real code, copied
 *   <fixture>/scripts/rebuild-native.js                     <- stub "restore"
 *   <fixture>/node_modules/better-sqlite3-multiple-ciphers/ <- real npm package
 *                          .../build/Release/better_sqlite3.node  <- sentinel
 *   <fixture>/node_modules/jest/bin/jest.js                 <- stub "jest"
 *
 * `__dirname/..` inside the copied wrapper resolves to the fixture root, and
 * `require.resolve('jest/package.json')` finds the fixture's stub. The FLIP is
 * driven by a REAL `npm rebuild`, which really does execute the fixture
 * package's `install` script -- so npm's lifecycle, `npm_execpath`, and arg
 * forwarding are all genuinely exercised. Only the *native compile* is faked.
 *
 * The two ABI states are REAL native binaries copied out of the repo's own
 * node_modules -- an actual Electron-ABI build and an actual Node-ABI build.
 * That matters: the wrapper now verifies its restore with `process.dlopen`, so
 * a fixture using placeholder text would let cases pass for the wrong reason.
 *
 * NOTHING here writes to the repo's node_modules -- those two binaries are only
 * read. The real shared binary is hashed before and after the whole run and
 * asserted byte-identical (V14).
 *
 * ## Preconditions (BACKLOG-2372 reviews, R5 + S1)
 *
 * An end-state assertion alone cannot tell "restored correctly" apart from
 * "nothing happened" -- that shape produced FOUR false greens on this ticket.
 * So every case asserts a precondition:
 *
 *   - Cases where jest runs: the stub jest records, at startup, the ABI it
 *     actually observed; we assert it saw the Node build. This is a HANDSHAKE,
 *     never a timer sample -- sampling at a fixed delay races process startup.
 *   - Cases interrupted during the flip: jest legitimately never starts, so
 *     they assert the opposite (flip started, jest never spawned) PLUS the
 *     wrapper's own guard message. "jest wrote no marker" alone is NOT enough:
 *     a spawned-then-instantly-killed jest also writes no marker.
 *   - Every case claiming "the tree was restored" also asserts the restore
 *     actually RAN. Without that, a case whose flip was killed before it wrote
 *     anything passes against a wrapper that never restores at all -- which is
 *     exactly how V11 used to pass.
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
// FX_WRAPPER lets a negative-control run point the harness at a deliberately
// broken copy of the wrapper, to prove these cases can actually FAIL. A suite
// that has never failed is not evidence. See the PR body for the control matrix.
const REAL_WRAPPER = process.env.FX_WRAPPER || path.join(REPO_ROOT, "scripts", "test-with-restore.js");

const NM = path.join(REPO_ROOT, "node_modules");
// A genuine Electron-ABI build: system Node refuses it with NODE_MODULE_VERSION.
const ELECTRON_SRC = path.join(NM, "better-sqlite3-multiple-ciphers", "build", "Release", "better_sqlite3.node");
// A genuine Node-ABI build: system Node loads it. Any Node-ABI `.node` will do;
// it only ever stands in for "the binary is currently the Node build".
const NODE_ABI_SRC = path.join(NM, "fsevents", "fsevents.node");

const CI_ARGS = ["--silent", "--maxWorkers=2", "--workerIdleMemoryLimit=512MB", "--forceExit"];

// mkdtempSync: atomic, mode 0700, unpredictable suffix. A PREDICTABLE path in a
// world-writable dir that we then write executable JS into and RUN is
// CodeQL js/insecure-temporary-file (8 high alerts on the first revision).
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2372-verify-"));
const MARKERS = path.join(FIXTURE, "markers");
const SENTINEL = path.join(
  FIXTURE,
  "node_modules",
  "better-sqlite3-multiple-ciphers",
  "build",
  "Release",
  "better_sqlite3.node",
);

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const marker = (n) => path.join(MARKERS, n);
const hasMarker = (n) => fs.existsSync(marker(n));
const readMarker = (n) => (hasMarker(n) ? fs.readFileSync(marker(n), "utf8") : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ELECTRON_SHA;
let NODE_SHA;

async function waitForMarker(name, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasMarker(name)) return true;
    await sleep(20);
  }
  return false;
}

// --------------------------------------------------------------------------
// Fixture construction
// --------------------------------------------------------------------------

function buildFixture() {
  const nm = path.join(FIXTURE, "node_modules");
  const pkgDir = path.join(nm, "better-sqlite3-multiple-ciphers");
  fs.mkdirSync(path.join(pkgDir, "build", "Release"), { recursive: true });
  fs.mkdirSync(path.join(nm, "jest", "bin"), { recursive: true });
  fs.mkdirSync(path.join(FIXTURE, "scripts"), { recursive: true });
  fs.mkdirSync(MARKERS, { recursive: true });

  fs.writeFileSync(
    path.join(FIXTURE, "package.json"),
    JSON.stringify(
      { name: "fx-2372", version: "1.0.0", private: true, scripts: { test: "node scripts/test-with-restore.js" } },
      null,
      2,
    ),
  );

  // The real wrapper, copied verbatim.
  fs.copyFileSync(REAL_WRAPPER, path.join(FIXTURE, "scripts", "test-with-restore.js"));

  // Stub restore (stands in for scripts/rebuild-native.js).
  //   ok   -> copies the real Electron binary back
  //   fail -> exits 1
  //   lie  -> exits 0 WITHOUT restoring, which is what rebuild-native.js does
  //           when the module dir is absent (`not found, skipping` -> success)
  fs.writeFileSync(
    path.join(FIXTURE, "scripts", "rebuild-native.js"),
    `const fs=require('fs'),p=require('path');
const M=process.env.FX_MARKERS, S=process.env.FX_SENTINEL, E=process.env.FX_ELECTRON_SRC;
fs.writeFileSync(p.join(M,'restore-started.txt'),'1');
const mode=process.env.FX_RESTORE_MODE||'ok';
if(mode==='fail'){process.exit(1);}
if(mode==='lie'){fs.writeFileSync(p.join(M,'restore-done.txt'),'lied');process.exit(0);}
const wait=Number(process.env.FX_RESTORE_SLEEP_MS||0);
const end=Date.now()+wait; while(Date.now()<end){}       // block; ignore signals
fs.copyFileSync(E,S);
fs.writeFileSync(p.join(M,'restore-done.txt'),'1');
`,
  );

  // Real npm package whose `install` script performs the "flip".
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(
      { name: "better-sqlite3-multiple-ciphers", version: "1.0.0", scripts: { install: "node ./flip.js" } },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(pkgDir, "flip.js"),
    `const fs=require('fs'),p=require('path');
const M=process.env.FX_MARKERS, S=process.env.FX_SENTINEL, N=process.env.FX_NODE_ABI_SRC;
fs.writeFileSync(p.join(M,'flip-started.txt'),'1');
const wait=Number(process.env.FX_FLIP_SLEEP_MS||0);
const end=Date.now()+wait; while(Date.now()<end){}
fs.copyFileSync(N,S);
fs.writeFileSync(p.join(M,'flip-done.txt'),'1');
`,
  );
  fs.copyFileSync(ELECTRON_SRC, SENTINEL);

  ELECTRON_SHA = sha(ELECTRON_SRC);
  NODE_SHA = sha(NODE_ABI_SRC);

  // Stub jest. Records the ABI it observes at startup -> the handshake.
  fs.writeFileSync(path.join(nm, "jest", "package.json"), JSON.stringify({ name: "jest", version: "29.0.0" }));
  fs.writeFileSync(
    path.join(nm, "jest", "bin", "jest.js"),
    `const fs=require('fs'),p=require('path'),c=require('crypto');
const M=process.env.FX_MARKERS, S=process.env.FX_SENTINEL;
fs.writeFileSync(p.join(M,'jest-argv.json'), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(p.join(M,'jest-observed.txt'),
  c.createHash('sha256').update(fs.readFileSync(S)).digest('hex'));   // handshake
const mode=process.env.FX_JEST_MODE||'exit0';
if(mode==='exit0'){process.exit(0);}
if(mode==='exit1'){process.exit(1);}
setTimeout(()=>{fs.writeFileSync(p.join(M,'jest-completed.txt'),'1');process.exit(0);},
  Number(process.env.FX_JEST_SLEEP_MS||4000));
`,
  );
}

function resetMarkers() {
  fs.rmSync(MARKERS, { recursive: true, force: true });
  fs.mkdirSync(MARKERS, { recursive: true });
  fs.copyFileSync(ELECTRON_SRC, SENTINEL);
}

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {'direct'|'npm'} o.via  'direct' leaves npm_execpath unset (exercises
 *   the shell fallback branch); 'npm' runs a real `npm test --` (exercises the
 *   npm_execpath branch and end-to-end arg forwarding).
 */
function launch({ via = "direct", args = [], env = {} }) {
  const childEnv = {
    ...process.env,
    FX_MARKERS: MARKERS,
    FX_SENTINEL: SENTINEL,
    FX_ELECTRON_SRC: ELECTRON_SRC,
    FX_NODE_ABI_SRC: NODE_ABI_SRC,
    ...env,
  };
  delete childEnv.npm_execpath;
  delete childEnv.npm_lifecycle_event;

  const child =
    via === "npm"
      ? spawn("npm", ["test", "--", ...args], {
          cwd: FIXTURE,
          env: childEnv,
          detached: true, // own process group, so we can signal the group
          stdio: ["ignore", "pipe", "pipe"],
          shell: true,
        })
      : spawn(process.execPath, [path.join(FIXTURE, "scripts", "test-with-restore.js"), ...args], {
          cwd: FIXTURE,
          env: childEnv,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const done = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  return { child, done };
}

/** Signal a process group, tolerating a group that has already exited. */
function killGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false; // already gone
    throw err;
  }
}

// --------------------------------------------------------------------------
// Cases
// --------------------------------------------------------------------------

const results = [];

function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}\n        ${detail}`);
}

/** Mid-run handshake precondition: jest must have observed the Node build. */
const midRunFlipObserved = () => readMarker("jest-observed.txt") === NODE_SHA;
/** The claim "the tree was restored" requires the restore to have RUN. */
const restoreRan = () => hasMarker("restore-started.txt");
const treeIsElectron = () => sha(SENTINEL) === ELECTRON_SHA;
const jestSpawned = () => hasMarker("jest-observed.txt");

/**
 * Run one case in isolation. A throwing case must be recorded as a FAIL rather
 * than aborting the run -- an early exit truncates results and hides later
 * cases (it can only ever under-report, but that is still a bad signal).
 */
async function runCase(id, name, fn) {
  try {
    resetMarkers();
    await fn(id, name);
  } catch (err) {
    record(id, name, false, `threw: ${err && err.message}`);
  }
}

async function run() {
  buildFixture();

  await runCase("V1", "passing run restores", async (id, name) => {
    const { done } = launch({ env: { FX_JEST_MODE: "exit0" } });
    const r = await done;
    record(id, name, midRunFlipObserved() && restoreRan() && treeIsElectron() && r.code === 0,
      `exit=${r.code} flipObserved=${midRunFlipObserved()} restoreRan=${restoreRan()} electron=${treeIsElectron()}`);
  });

  await runCase("V2", "FAILING run restores, exit 1 propagates", async (id, name) => {
    const { done } = launch({ env: { FX_JEST_MODE: "exit1" } });
    const r = await done;
    record(id, name, midRunFlipObserved() && restoreRan() && treeIsElectron() && r.code === 1,
      `exit=${r.code} restoreRan=${restoreRan()} electron=${treeIsElectron()}`);
  });

  await runCase("V3", "group SIGINT restores, dies by signal", async (id, name) => {
    const { child, done } = launch({ env: { FX_JEST_MODE: "sleep" } });
    await waitForMarker("jest-observed.txt");
    killGroup(child.pid, "SIGINT");
    const r = await done;
    record(id, name,
      midRunFlipObserved() && restoreRan() && treeIsElectron() && r.signal === "SIGINT" && !hasMarker("jest-completed.txt"),
      `signal=${r.signal} restoreRan=${restoreRan()} electron=${treeIsElectron()} orphan=${hasMarker("jest-completed.txt")}`);
  });

  await runCase("V4", "group SIGHUP restores", async (id, name) => {
    const { child, done } = launch({ env: { FX_JEST_MODE: "sleep" } });
    await waitForMarker("jest-observed.txt");
    killGroup(child.pid, "SIGHUP");
    const r = await done;
    record(id, name, midRunFlipObserved() && restoreRan() && treeIsElectron() && r.signal === "SIGHUP",
      `signal=${r.signal} restoreRan=${restoreRan()} electron=${treeIsElectron()}`);
  });

  await runCase("V5", "pid-only SIGTERM forwards to jest (no orphan)", async (id, name) => {
    const { child, done } = launch({ env: { FX_JEST_MODE: "sleep", FX_JEST_SLEEP_MS: "4000" } });
    await waitForMarker("jest-observed.txt");
    process.kill(child.pid, "SIGTERM"); // pid only, NOT the group
    const r = await done;
    await sleep(1500); // give an orphaned jest time to finish if it survived
    const orphaned = hasMarker("jest-completed.txt");
    record(id, name,
      midRunFlipObserved() && restoreRan() && treeIsElectron() && !orphaned && r.signal === "SIGTERM",
      `signal=${r.signal} orphanCompleted=${orphaned} electron=${treeIsElectron()}`);
  });

  await runCase("V6", "restore failure screams, exit 75", async (id, name) => {
    const { done } = launch({ env: { FX_JEST_MODE: "exit0", FX_RESTORE_MODE: "fail" } });
    const r = await done;
    const banner = r.stderr.includes("NATIVE MODULE RESTORE FAILED");
    record(id, name, midRunFlipObserved() && r.code === 75 && banner && sha(SENTINEL) === NODE_SHA,
      `exit=${r.code} banner=${banner}`);
  });

  await runCase("V7", "restore failure never masks a test failure", async (id, name) => {
    const { done } = launch({ env: { FX_JEST_MODE: "exit1", FX_RESTORE_MODE: "fail" } });
    const r = await done;
    const banner = r.stderr.includes("NATIVE MODULE RESTORE FAILED");
    record(id, name, midRunFlipObserved() && r.code === 1 && banner, `exit=${r.code} banner=${banner}`);
  });

  await runCase("V8", "signal path: failed restore screams, exit 75 not 130", async (id, name) => {
    const { child, done } = launch({ env: { FX_JEST_MODE: "sleep", FX_RESTORE_MODE: "fail" } });
    await waitForMarker("jest-observed.txt");
    killGroup(child.pid, "SIGINT");
    const r = await done;
    const banner = r.stderr.includes("NATIVE MODULE RESTORE FAILED");
    record(id, name, midRunFlipObserved() && banner && r.code === 75 && r.signal === null,
      `exit=${r.code} signal=${r.signal} banner=${banner}`);
  });

  await runCase("V9", "npm test -- <CI args> forwarded verbatim", async (id, name) => {
    const { done } = launch({ via: "npm", args: CI_ARGS, env: { FX_JEST_MODE: "exit0" } });
    const r = await done;
    const argv = JSON.parse(readMarker("jest-argv.json") ?? "null");
    record(id, name,
      midRunFlipObserved() && restoreRan() && treeIsElectron() && r.code === 0 &&
        JSON.stringify(argv) === JSON.stringify(CI_ARGS),
      `exit=${r.code} argv=${JSON.stringify(argv)}`);
  });

  // No mid-run precondition: the flip legitimately never completes, so jest must
  // NEVER be spawned. Assert the wrapper's OWN guard message -- "jest wrote no
  // marker" is also produced by a jest spawned and killed within milliseconds,
  // which is the very defect (R1) this case exists to catch.
  await runCase("V10", "interrupt during flip: deferred guard fires, jest never spawned", async (id, name) => {
    const { child, done } = launch({ env: { FX_JEST_MODE: "exit0", FX_FLIP_SLEEP_MS: "2500" } });
    await waitForMarker("flip-started.txt");
    process.kill(child.pid, "SIGTERM"); // pid only: the flip itself completes
    const r = await done;
    const guardFired = r.stderr.includes("during rebuild; not running jest");
    record(id, name,
      hasMarker("flip-started.txt") && guardFired && !jestSpawned() && restoreRan() && treeIsElectron(),
      `guardFired=${guardFired} jestSpawned=${jestSpawned()} restoreRan=${restoreRan()} electron=${treeIsElectron()} signal=${r.signal}`);
  });

  // S1: this case's GROUP signal kills the flip before it writes, so the
  // sentinel reads Electron whether or not a restore happened. `restoreRan()`
  // is what makes the claim in this case's own name true -- without it, it
  // passed against a wrapper that never restores at all.
  await runCase("V11", "group signal during flip (status=null) refuses to run jest", async (id, name) => {
    const { child, done } = launch({ env: { FX_JEST_MODE: "exit0", FX_FLIP_SLEEP_MS: "2500" } });
    await waitForMarker("flip-started.txt");
    killGroup(child.pid, "SIGINT");
    const r = await done;
    const refused = r.stderr.includes("Refusing to run jest against an unknown ABI");
    record(id, name,
      hasMarker("flip-started.txt") && refused && !jestSpawned() && restoreRan() && treeIsElectron(),
      `refused=${refused} jestSpawned=${jestSpawned()} restoreRan=${restoreRan()} electron=${treeIsElectron()} code=${r.code}`);
  });

  // The only case that distinguishes `detached: true` on the restore child.
  await runCase("V12", "second Ctrl-C during slow restore still restores (detached)", async (id, name) => {
    const { child, done } = launch({ env: { FX_JEST_MODE: "sleep", FX_RESTORE_SLEEP_MS: "2000" } });
    await waitForMarker("jest-observed.txt");
    killGroup(child.pid, "SIGINT");
    await waitForMarker("restore-started.txt");
    killGroup(child.pid, "SIGINT"); // the frustrated second Ctrl-C
    const r = await done;
    record(id, name, midRunFlipObserved() && treeIsElectron() && hasMarker("restore-done.txt"),
      `restoreCompleted=${hasMarker("restore-done.txt")} electron=${treeIsElectron()} signal=${r.signal}`);
  });

  // S3: rebuild-native.js returns SUCCESS when the module dir is absent, so an
  // exit code alone cannot evidence a restore. The wrapper must dlopen the
  // binary and notice the tree is still the Node build.
  await runCase("V13", "restore that LIES (exit 0, no restore) is caught by dlopen", async (id, name) => {
    const { done } = launch({ env: { FX_JEST_MODE: "exit0", FX_RESTORE_MODE: "lie" } });
    const r = await done;
    const banner = r.stderr.includes("NATIVE MODULE RESTORE FAILED");
    const saidSo = r.stderr.includes("still not the Electron build");
    record(id, name, midRunFlipObserved() && r.code === 75 && banner && saidSo && sha(SENTINEL) === NODE_SHA,
      `exit=${r.code} banner=${banner} diagnosedCorrectly=${saidSo} treeStillNode=${sha(SENTINEL) === NODE_SHA}`);
  });

  fs.rmSync(FIXTURE, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log(`FAILED: ${failed.map((f) => f.id).join(", ")}`);
    process.exitCode = 1;
  }
}

// The acceptance criterion (V14) is asserted around the whole run: sha256 AND
// mtime of the REAL shared binary must be unchanged, because nothing here may
// write to it. Fail loudly rather than reporting "absent" and carrying on --
// that is the same false-green shape as everything else on this ticket.
for (const [label, src] of [["Electron-ABI", ELECTRON_SRC], ["Node-ABI", NODE_ABI_SRC]]) {
  if (!fs.existsSync(src)) {
    console.error(`FATAL: need a real ${label} binary at ${src}`);
    console.error("");
    console.error("This tree has no node_modules, so the dlopen-based cases cannot be");
    console.error("meaningful. Run the harness from a tree that already has its own");
    console.error("node_modules -- the main checkout, or a scratch copy of the repo.");
    console.error("");
    console.error("Do NOT symlink node_modules into a worktree to satisfy this check.");
    console.error("That is the exact configuration this script exists to protect: any");
    console.error("later `npm test`/`install`/`rebuild` in that tree follows the symlink");
    console.error("and rewrites the SHARED native binary, breaking a running `npm run dev`");
    console.error("and every sibling worktree at once. If you have no other option, treat");
    console.error("the symlink as live-armed and never run npm in that tree again.");
    process.exit(1);
  }
}
const mtime0 = fs.statSync(ELECTRON_SRC).mtimeMs;
const sha0 = sha(ELECTRON_SRC);
console.log(`real shared binary BEFORE: sha256=${sha0} mtimeMs=${mtime0}\n`);

process.on("exit", () => {
  const mtime1 = fs.statSync(ELECTRON_SRC).mtimeMs;
  const sha1 = sha(ELECTRON_SRC);
  const same = sha1 === sha0 && mtime1 === mtime0;
  console.log(`\nreal shared binary AFTER : sha256=${sha1} mtimeMs=${mtime1}`);
  console.log(same ? "V14 PASS  shared binary byte-identical and untouched" : "V14 FAIL  SHARED BINARY CHANGED");
  if (!same) process.exitCode = 1;
});

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
