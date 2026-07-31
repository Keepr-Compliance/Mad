#!/usr/bin/env node
/**
 * Run jest, then ALWAYS restore the Electron build of the native SQLite module.
 * (BACKLOG-2372)
 *
 * ## The bug this fixes
 *
 * `better-sqlite3-multiple-ciphers` can only be compiled for ONE ABI at a time:
 *   - Electron ABI  -> `npm run dev` works; jest cannot load the real module.
 *   - Node ABI      -> jest can load it; `npm run dev` is broken.
 *
 * 31 suites (`grep -rl '"node_modules",' --include="*.test.ts" electron/ src/`)
 * deliberately bypass the jest moduleNameMapper stub by `require()`-ing the
 * package via an absolute path, so they need the REAL binary at the Node ABI.
 *
 * The old design was `pretest` (-> Node ABI) + `posttest` (-> Electron ABI).
 * npm does NOT run `posttest` when `test` exits non-zero, so a FAILING or
 * INTERRUPTED run stranded the binary at the Node ABI. Every git worktree
 * symlinks `node_modules` at the main repo, so that strands the SHARED tree and
 * breaks the founder's running dev app plus every sibling worktree at once.
 *
 * npm's pre/post hooks are separate processes with no shared lifecycle: a post
 * hook CANNOT be made to run on failure or on a signal. So both transitions are
 * folded into this single process, where the restore is attached to the very
 * process that performed the mutation.
 *
 * ## Design notes (each one is load-bearing; see BACKLOG-2372 review)
 *
 * 1. Signal handlers are registered BEFORE the flip. Registering a handler
 *    overrides Node's default terminate-on-signal, which is what keeps us alive
 *    long enough to restore. Flipping first would leave a window where Ctrl-C
 *    strands the tree -- the exact bug.
 *
 * 2. The post-flip "was I interrupted?" check runs inside `setImmediate`, NOT
 *    synchronously. `spawnSync` blocks the event loop, so Node defers the signal
 *    callback; a synchronous check always reads `null` and would spawn jest
 *    anyway. A guard that never fires is worse than no guard.
 *
 * 3. A signal is FORWARDED to the jest child and the child's `exit` drives the
 *    restore. Restoring directly from the handler orphans jest, which then runs
 *    its native suites against a binary yanked out from under it.
 *
 * 4. The restore child is spawned `detached: true`. A terminal Ctrl-C signals
 *    the whole foreground process group; without its own group a SECOND Ctrl-C
 *    during a slow restore kills the restore mid-flight and strands the tree.
 *
 * 5. `npm` is invoked as `node <npm_execpath>`, never as the bare `npm` binary.
 *    On Windows `npm` is a `.cmd`, and since Node 18.20.1/20.12.1 spawning a
 *    `.cmd` without `shell: true` throws EINVAL -- that would fail half the CI
 *    matrix. npm exports `npm_execpath` to run-scripts.
 *
 * 6. Flip/restore failure is tested with `status !== 0`, never `status > 0`.
 *    On a group signal the child is killed too and `status` is `null`.
 */

const { spawn, spawnSync } = require("child_process");
const path = require("path");

const MODULE_NAME = "better-sqlite3-multiple-ciphers";
const REPO_ROOT = path.join(__dirname, "..");
const NATIVE_BINARY = path.join(
  REPO_ROOT,
  "node_modules",
  MODULE_NAME,
  "build",
  "Release",
  "better_sqlite3.node",
);
const RESTORE_SCRIPT = path.join(__dirname, "rebuild-native.js");
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** sysexits.h EX_TEMPFAIL -- "tests passed but the tree is broken". */
const EX_TEMPFAIL = 75;

let interrupted = null; // signal name, if one arrived
let jest = null; // the jest ChildProcess
let restoreAttempted = false;
let restoreFailed = false;
let finished = false;

/**
 * Spawn npm portably. Bare `npm` is a `.cmd` on Windows and cannot be spawned
 * without a shell (Node >=18.20.1 throws EINVAL), so prefer the JS entrypoint
 * npm exports to its own run-scripts.
 */
function runNpm(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return spawnSync(process.execPath, [npmExecPath, ...args], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }
  // Invoked directly (not via an npm run-script). `shell: true` makes the
  // `.cmd` shim spawnable on Windows.
  return spawnSync("npm", args, { cwd: REPO_ROOT, stdio: "inherit", shell: true });
}

/** Flip the shared binary to the Node ABI so the 31 real-module suites can run. */
function flipToNodeAbi() {
  console.log(`[test-with-restore] Rebuilding ${MODULE_NAME} for Node (jest)...`);
  return runNpm(["rebuild", MODULE_NAME]);
}

/**
 * Restore the Electron build. Idempotent -- safe to call from the child-exit
 * path, from `uncaughtException`, and from `process.on('exit')`.
 */
function restoreOnce() {
  if (restoreAttempted) return;
  restoreAttempted = true;

  console.log("[test-with-restore] Restoring Electron build of native modules...");
  const result = spawnSync(process.execPath, [RESTORE_SCRIPT], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    // Own process group: a second Ctrl-C must not kill the restore itself.
    detached: true,
  });

  if (result.status !== 0) {
    restoreFailed = true;
    printRestoreFailureBanner(result);
  }
}

function printRestoreFailureBanner(result) {
  const why =
    result.error?.message ??
    (result.signal ? `killed by ${result.signal}` : `exit status ${result.status}`);

  process.stderr.write(
    [
      "",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "!! NATIVE MODULE RESTORE FAILED -- THE SHARED TREE IS LEFT BROKEN",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "",
      `Reason: ${why}`,
      "",
      `The binary at:  ${NATIVE_BINARY}`,
      "is still built for Node, NOT for Electron. `npm run dev` will fail with",
      "NODE_MODULE_VERSION until it is rebuilt. Every git worktree that symlinks",
      "node_modules at the main repo is affected too.",
      "",
      "Check which build is currently live:",
      "",
      `  node -e "try{process.dlopen({exports:{}},'${NATIVE_BINARY}');console.log('NODE build -> dev WILL break')}catch(e){console.log('ELECTRON build -> dev OK')}"`,
      "",
      "Repair it (needs network on a prebuild cache miss):",
      "",
      `  node ${RESTORE_SCRIPT}`,
      "",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "",
    ].join("\n"),
  );
}

/** Re-raise `sig` with the default action so the shell sees a true 128+n. */
function reraise(sig) {
  for (const s of SIGNALS) process.removeAllListeners(s);
  process.kill(process.pid, sig);
}

/**
 * Single exit path: restore, then decide the status code.
 *
 * A broken tree outranks exit-code fidelity: if the restore failed we exit 75
 * rather than re-raising a signal, so the failure cannot look like a clean 130.
 * jest's own failure code still wins when jest failed -- 75 must never mask a
 * real test failure.
 */
function finish(code, signal) {
  if (finished) return;
  finished = true;

  restoreOnce();

  if (restoreFailed) {
    process.exit(typeof code === "number" && code !== 0 ? code : EX_TEMPFAIL);
  }

  const killedBy = signal || interrupted;
  if (killedBy) {
    reraise(killedBy);
    return;
  }

  process.exit(typeof code === "number" ? code : EX_TEMPFAIL);
}

// --- 1. Handlers FIRST, before any mutation. ---------------------------------
for (const sig of SIGNALS) {
  process.on(sig, () => {
    interrupted = sig;
    // Forward to jest and let its `exit` drive the restore; restoring here
    // would orphan jest against a binary that is about to change under it.
    if (jest && jest.exitCode === null && !jest.killed) {
      try {
        jest.kill(sig);
      } catch {
        /* already gone; the exit handler will run */
      }
    }
  });
}

process.on("uncaughtException", (err) => {
  console.error("[test-with-restore] Unexpected error:", err);
  finish(1, null);
});

// Last-resort net. `restoreOnce()` is idempotent, so this is a no-op whenever
// the normal path already ran.
process.on("exit", () => {
  restoreOnce();
});

// --- 2. Flip to the Node ABI. ------------------------------------------------
const flip = flipToNodeAbi();

// `status !== 0` (not `> 0`): a group signal kills this child too, giving null.
if (flip.status !== 0) {
  const why =
    flip.error?.message ??
    (flip.signal ? `killed by ${flip.signal}` : `exit status ${flip.status}`);
  console.error(`[test-with-restore] Rebuild for Node failed: ${why}`);
  console.error("[test-with-restore] Refusing to run jest against an unknown ABI.");
  finish(1, null);
}

// --- 3. Deferred interrupt check, then spawn jest. ---------------------------
// MUST be deferred: `spawnSync` above blocked the event loop, so a signal
// delivered during the flip has not run its callback yet. A synchronous check
// here would always read `null`.
setImmediate(() => {
  if (interrupted) {
    console.error(`[test-with-restore] Interrupted (${interrupted}) during rebuild; not running jest.`);
    finish(null, interrupted);
    return;
  }

  let jestBin;
  try {
    // `require.resolve('jest/bin/jest.js')` is blocked by the package's
    // "exports" map, so resolve the manifest and join from its directory.
    jestBin = path.join(path.dirname(require.resolve("jest/package.json")), "bin/jest.js");
  } catch {
    console.error("[test-with-restore] Could not resolve jest. Is node_modules installed?");
    finish(1, null);
    return;
  }

  // Spawn via process.execPath, never the node_modules/.bin shim (a .cmd on
  // Windows). All args after `--` arrive here verbatim and are forwarded as-is.
  jest = spawn(process.execPath, [jestBin, ...process.argv.slice(2)], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  jest.on("error", (err) => {
    console.error("[test-with-restore] Failed to start jest:", err.message);
    finish(1, null);
  });

  jest.on("exit", (code, signal) => finish(code, signal));
});
