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
 * into the unit run -- a worse trade. See the PR body for the coverage gap.
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
 * NOTHING here touches the repo's own node_modules. The real shared binary is
 * hashed before and after the whole run and asserted byte-identical (V8).
 *
 * ## Preconditions (BACKLOG-2372 review, R5)
 *
 * An end-state assertion alone cannot tell "restored correctly" apart from
 * "nothing happened" -- both this harness and the reviewer's produced a FALSE
 * GREEN that way. So every case asserts a precondition:
 *
 *   - Cases where jest runs: the stub jest records, at startup, the ABI it
 *     actually observed; we assert it saw NODE-ABI. This is a HANDSHAKE, never
 *     a timer sample -- sampling at a fixed delay races process startup and
 *     yields flaky INVALIDs that then get "fixed" by loosening the check.
 *   - Cases where the run is interrupted during the flip: jest legitimately
 *     never starts, so those cases assert the opposite -- flip started, jest
 *     never spawned. Blanket-applying the mid-run precondition would make them
 *     unscoreable.
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
const REAL_SHARED_BINARY = path.join(
  REPO_ROOT,
  "node_modules",
  "better-sqlite3-multiple-ciphers",
  "build",
  "Release",
  "better_sqlite3.node",
);

const ELECTRON = "ELECTRON-ABI\n";
const NODE_ABI = "NODE-ABI\n";
const CI_ARGS = ["--silent", "--maxWorkers=2", "--workerIdleMemoryLimit=512MB", "--forceExit"];

const FIXTURE = path.join(os.tmpdir(), `keepr-2372-verify-${process.pid}`);
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
  fs.rmSync(FIXTURE, { recursive: true, force: true });

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
  fs.writeFileSync(
    path.join(FIXTURE, "scripts", "rebuild-native.js"),
    `const fs=require('fs'),p=require('path');
const M=process.env.FX_MARKERS, S=process.env.FX_SENTINEL;
fs.writeFileSync(p.join(M,'restore-started.txt'),'1');
if(process.env.FX_RESTORE_MODE==='fail'){process.exit(1);}
const wait=Number(process.env.FX_RESTORE_SLEEP_MS||0);
const end=Date.now()+wait; while(Date.now()<end){}       // block; ignore signals
fs.writeFileSync(S,${JSON.stringify(ELECTRON)});
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
const M=process.env.FX_MARKERS, S=process.env.FX_SENTINEL;
fs.writeFileSync(p.join(M,'flip-started.txt'),'1');
const wait=Number(process.env.FX_FLIP_SLEEP_MS||0);
const end=Date.now()+wait; while(Date.now()<end){}
fs.writeFileSync(S,${JSON.stringify(NODE_ABI)});
fs.writeFileSync(p.join(M,'flip-done.txt'),'1');
`,
  );
  fs.writeFileSync(SENTINEL, ELECTRON);

  // Stub jest. Records the ABI it observes at startup -> the handshake.
  fs.writeFileSync(path.join(nm, "jest", "package.json"), JSON.stringify({ name: "jest", version: "29.0.0" }));
  fs.writeFileSync(
    path.join(nm, "jest", "bin", "jest.js"),
    `const fs=require('fs'),p=require('path');
const M=process.env.FX_MARKERS, S=process.env.FX_SENTINEL;
fs.writeFileSync(p.join(M,'jest-argv.json'), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(p.join(M,'jest-observed.txt'), fs.readFileSync(S,'utf8'));  // handshake
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
  fs.writeFileSync(SENTINEL, ELECTRON);
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

// --------------------------------------------------------------------------
// Cases
// --------------------------------------------------------------------------

const results = [];

function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}\n        ${detail}`);
}

/** Mid-run handshake precondition: jest must have observed the Node ABI. */
function midRunFlipObserved() {
  const observed = readMarker("jest-observed.txt");
  return observed === NODE_ABI;
}

async function run() {
  buildFixture();
  const baselineSha = sha(SENTINEL);

  // ---- V1: passing run ---------------------------------------------------
  {
    resetMarkers();
    const { done } = launch({ env: { FX_JEST_MODE: "exit0" } });
    const r = await done;
    const ok = midRunFlipObserved() && sha(SENTINEL) === baselineSha && r.code === 0;
    record("V1", "passing run restores", ok, `exit=${r.code} observed=${JSON.stringify(readMarker("jest-observed.txt"))} shaMatch=${sha(SENTINEL) === baselineSha}`);
  }

  // ---- V2: failing run (the actual bug) ----------------------------------
  {
    resetMarkers();
    const { done } = launch({ env: { FX_JEST_MODE: "exit1" } });
    const r = await done;
    const ok = midRunFlipObserved() && sha(SENTINEL) === baselineSha && r.code === 1;
    record("V2", "FAILING run restores, exit 1 propagates", ok, `exit=${r.code} shaMatch=${sha(SENTINEL) === baselineSha}`);
  }

  // ---- V3: group SIGINT mid-run ------------------------------------------
  {
    resetMarkers();
    const { child, done } = launch({ env: { FX_JEST_MODE: "sleep" } });
    await waitForMarker("jest-observed.txt");
    process.kill(-child.pid, "SIGINT");
    const r = await done;
    const ok =
      midRunFlipObserved() && sha(SENTINEL) === baselineSha && r.signal === "SIGINT" && !hasMarker("jest-completed.txt");
    record("V3", "group SIGINT restores, dies by signal", ok, `signal=${r.signal} code=${r.code} shaMatch=${sha(SENTINEL) === baselineSha} orphan=${hasMarker("jest-completed.txt")}`);
  }

  // ---- V4: group SIGHUP mid-run ------------------------------------------
  {
    resetMarkers();
    const { child, done } = launch({ env: { FX_JEST_MODE: "sleep" } });
    await waitForMarker("jest-observed.txt");
    process.kill(-child.pid, "SIGHUP");
    const r = await done;
    const ok = midRunFlipObserved() && sha(SENTINEL) === baselineSha && r.signal === "SIGHUP";
    record("V4", "group SIGHUP restores", ok, `signal=${r.signal} shaMatch=${sha(SENTINEL) === baselineSha}`);
  }

  // ---- V5: signal to the WRAPPER PID ONLY -> must not orphan jest (R2) ----
  {
    resetMarkers();
    const { child, done } = launch({ env: { FX_JEST_MODE: "sleep", FX_JEST_SLEEP_MS: "4000" } });
    await waitForMarker("jest-observed.txt");
    process.kill(child.pid, "SIGTERM"); // pid only, NOT the group
    const r = await done;
    await sleep(1500); // give an orphaned jest time to finish if it survived
    const orphaned = hasMarker("jest-completed.txt");
    const ok = midRunFlipObserved() && sha(SENTINEL) === baselineSha && !orphaned && r.signal === "SIGTERM";
    record("V5", "pid-only SIGTERM forwards to jest (no orphan)", ok, `signal=${r.signal} orphanCompleted=${orphaned} shaMatch=${sha(SENTINEL) === baselineSha}`);
  }

  // ---- V6: restore fails, jest PASSED -> exit 75 + banner ----------------
  {
    resetMarkers();
    const { done } = launch({ env: { FX_JEST_MODE: "exit0", FX_RESTORE_MODE: "fail" } });
    const r = await done;
    const banner = r.stderr.includes("NATIVE MODULE RESTORE FAILED");
    const ok = midRunFlipObserved() && r.code === 75 && banner && fs.readFileSync(SENTINEL, "utf8") === NODE_ABI;
    record("V6", "restore failure screams, exit 75", ok, `exit=${r.code} banner=${banner}`);
  }

  // ---- V7: restore fails, jest FAILED -> jest's code wins -----------------
  {
    resetMarkers();
    const { done } = launch({ env: { FX_JEST_MODE: "exit1", FX_RESTORE_MODE: "fail" } });
    const r = await done;
    const banner = r.stderr.includes("NATIVE MODULE RESTORE FAILED");
    const ok = midRunFlipObserved() && r.code === 1 && banner;
    record("V7", "restore failure never masks a test failure", ok, `exit=${r.code} banner=${banner}`);
  }

  // ---- V8: restore fails on the SIGNAL path -> banner + 75, not clean 130 -
  {
    resetMarkers();
    const { child, done } = launch({ env: { FX_JEST_MODE: "sleep", FX_RESTORE_MODE: "fail" } });
    await waitForMarker("jest-observed.txt");
    process.kill(-child.pid, "SIGINT");
    const r = await done;
    const banner = r.stderr.includes("NATIVE MODULE RESTORE FAILED");
    const ok = midRunFlipObserved() && banner && r.code === 75 && r.signal === null;
    record("V8", "signal path: failed restore screams, exit 75 not 130", ok, `exit=${r.code} signal=${r.signal} banner=${banner}`);
  }

  // ---- V9: arg passthrough through a REAL `npm test -- ...` --------------
  {
    resetMarkers();
    const { done } = launch({ via: "npm", args: CI_ARGS, env: { FX_JEST_MODE: "exit0" } });
    const r = await done;
    const argv = JSON.parse(readMarker("jest-argv.json") ?? "null");
    const ok =
      midRunFlipObserved() && r.code === 0 && JSON.stringify(argv) === JSON.stringify(CI_ARGS) && sha(SENTINEL) === baselineSha;
    record("V9", "npm test -- <CI args> forwarded verbatim", ok, `exit=${r.code} argv=${JSON.stringify(argv)}`);
  }

  // ---- V10: pid-only signal DURING the flip (R1 deferred check) -----------
  // No mid-run precondition here: the flip legitimately never completes, so
  // jest must NEVER be spawned. Asserting NODE-ABI would make this unscoreable.
  {
    resetMarkers();
    const { child, done } = launch({ env: { FX_JEST_MODE: "exit0", FX_FLIP_SLEEP_MS: "2500" } });
    await waitForMarker("flip-started.txt");
    process.kill(child.pid, "SIGTERM"); // pid only: the flip itself completes
    const r = await done;
    const jestRan = hasMarker("jest-observed.txt");
    // Assert on the wrapper's OWN guard message, not merely on jest's absence.
    // "jest never wrote its marker" is NOT the same as "jest was never spawned":
    // a spawned-then-immediately-killed jest also leaves no marker, so the weaker
    // assertion silently passes the very defect this case exists to catch.
    const guardFired = r.stderr.includes("during rebuild; not running jest");
    const ok = hasMarker("flip-started.txt") && guardFired && !jestRan && sha(SENTINEL) === baselineSha;
    record("V10", "interrupt during flip: deferred guard fires, jest never spawned", ok, `guardFired=${guardFired} jestSpawned=${jestRan} signal=${r.signal} code=${r.code} shaMatch=${sha(SENTINEL) === baselineSha}`);
  }

  // ---- V11: GROUP signal during the flip -> flip status===null path -------
  {
    resetMarkers();
    const { child, done } = launch({ env: { FX_JEST_MODE: "exit0", FX_FLIP_SLEEP_MS: "2500" } });
    await waitForMarker("flip-started.txt");
    process.kill(-child.pid, "SIGINT");
    const r = await done;
    const jestRan = hasMarker("jest-observed.txt");
    // Same reasoning as V10: assert the wrapper reported the null-status flip
    // failure, which is the `status !== 0` (not `> 0`) path.
    const refused = r.stderr.includes("Refusing to run jest against an unknown ABI");
    const ok = hasMarker("flip-started.txt") && refused && !jestRan && sha(SENTINEL) === baselineSha;
    record("V11", "group signal during flip (status=null) refuses to run jest", ok, `refused=${refused} jestSpawned=${jestRan} signal=${r.signal} code=${r.code} shaMatch=${sha(SENTINEL) === baselineSha}`);
  }

  // ---- V12: SECOND signal during a slow restore --------------------------
  // The only case that distinguishes `detached: true` on the restore child.
  {
    resetMarkers();
    const { child, done } = launch({ env: { FX_JEST_MODE: "sleep", FX_RESTORE_SLEEP_MS: "2000" } });
    await waitForMarker("jest-observed.txt");
    process.kill(-child.pid, "SIGINT");
    await waitForMarker("restore-started.txt");
    process.kill(-child.pid, "SIGINT"); // the frustrated second Ctrl-C
    const r = await done;
    const ok = midRunFlipObserved() && sha(SENTINEL) === baselineSha && hasMarker("restore-done.txt");
    record("V12", "second Ctrl-C during slow restore still restores (detached)", ok, `restoreCompleted=${hasMarker("restore-done.txt")} shaMatch=${sha(SENTINEL) === baselineSha} signal=${r.signal}`);
  }

  fs.rmSync(FIXTURE, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log(`FAILED: ${failed.map((f) => f.id).join(", ")}`);
    process.exit(1);
  }
}

// V13 (the acceptance criterion) is asserted by the caller around this whole
// run: sha256 AND mtime of the REAL shared binary must be unchanged, because
// nothing here may touch it. Printed here for the record.
if (fs.existsSync(REAL_SHARED_BINARY)) {
  const st = fs.statSync(REAL_SHARED_BINARY);
  console.log(`real shared binary: sha256=${sha(REAL_SHARED_BINARY)} mtime=${st.mtimeMs}\n`);
} else {
  console.log("real shared binary: absent (worktree without node_modules)\n");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
