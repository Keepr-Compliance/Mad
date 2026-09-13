/**
 * BACKLOG-3284 — the network guard. A missing mock is a RED test, not a live request.
 *
 * Installed from jest `setupFiles`, which runs before the test framework and before
 * the test file is required, so an unmocked call at MODULE SCOPE is covered too.
 * It patches the one choke point every outbound TCP connection in Node passes
 * through: `net.Socket.prototype.connect`. `tls.connect`, `http(s).request`, axios
 * (jsdom -> XMLHttpRequest) and global `fetch` (undici) all bottom out there — each
 * verified by execution, not by reasoning. DNS runs INSIDE `Socket.connect`, so a
 * blocked host is never even resolved.
 *
 * What re-runs on every CI run is narrower than what was measured: the shipped
 * controls cover `http.request` and the `net.connect` array form. The per-client
 * matrix (tls, https, axios under jsdom, undici fetch under @jest-environment node)
 * was measured once during design with probes that are NOT shipped — so treat this
 * paragraph as a record of that measurement, not as something the suite re-proves.
 *
 * THREE PARTS, all three load-bearing:
 *
 *   setupFiles           this file — patches, records, throws.
 *   setupFilesAfterEnv   assert.js — turns a record into a failing test. A throw on
 *                        its own is swallowed by any production catch block, which
 *                        is the entire reason the assertion half exists: the
 *                        handler returns `{ success: true }` and the suite stays
 *                        green with the mock still missing.
 *   globalSetup /        globalTeardown.js — the backstop. A file whose call happens
 *   globalTeardown       in its OWN afterAll, or whose tests are ALL skipped, is
 *                        seen by NO jest hook (the root afterAll registered by
 *                        setupFilesAfterEnv runs BEFORE a file's own afterAll, and a
 *                        fully-skipped file runs no hook at all). The backstop fails
 *                        the RUN on any record nobody reported.
 *
 * THE RECORD DIRECTORY. `globalSetup` mints a fresh per-run directory and overwrites
 * `KEEPR_NET_GUARD_RECORD_DIR` UNCONDITIONALLY. Do not "simplify" that into a
 * fallback: it is the single line that makes two separate things safe. A record left
 * behind by a killed run can never be read by a later run, so a stale record cannot
 * produce the false positive that gets a guard switched off; and the child jest
 * process spawned by netGuard.redproof.test.js inherits the parent's environment yet
 * cannot write into the parent's record and trip the parent's backstop.
 *
 * WHAT IT DOES NOT COVER — measured, not assumed:
 *   - `child_process` (`curl`, `wget`, `Invoke-WebRequest`, `execFileSync`): a probe
 *     shelling out to curl resolved the host for real and the guard recorded 0.
 *   - jsdom SYNCHRONOUS XHR (`xhr.open(..., false)`): jsdom runs it in its own child
 *     process; the probe saw a real `ENOTFOUND` and the guard recorded 0.
 *   - UDP / `dgram`, and DNS lookups made on their own: no `Socket.connect` involved.
 *   Neither blind spot is how any service under `electron/` or `src/` reaches the
 *   network today (zero hits for either shape across both trees), so they are stated
 *   limits rather than open follow-ups. If one ever becomes reachable, this header is
 *   the place that says the guard will not see it.
 *
 * OUT OF SCOPE — separate runners, unaffected by this guard:
 *   `broker-portal/`, `android-companion/`, `packages/ui/` (their own jest configs),
 *   `admin-portal/` (vitest), and the Playwright tier under `e2e/tests/`.
 *
 * THERE IS DELIBERATELY NO OPT-IN. An `allowNetwork()` helper was built and proven
 * during design and is NOT shipped: measured across the whole suite, zero tests need
 * a non-self host, and an escape hatch with no consumers is a hole whose first use is
 * more likely to be silencing the guard than fixing a mock. The `SELF` allow-list
 * below is the only path, and widening it is a reviewed change to this file. Do not
 * add an opt-in thinking its absence was an oversight.
 *
 * THESE FILES GET NO ESLINT PASS. `npm run lint` is `eslint electron src scripts
 * .claude/scripts` — it does not reach `tests/`, locally or in CI's `Run linter`
 * step. That is a property of the current lint script, not an exemption claimed by
 * this directory; widening eslint to the whole test tree is its own change.
 *
 * Never assert on the error MESSAGE. Under jsdom the marker becomes "Network Error";
 * under `@jest-environment node` / undici it becomes "fetch failed" with the marker
 * buried in `err.cause`. Assert on `err.code` and on the record.
 */
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Loopback, plus every address THIS MACHINE owns. A connection to an address the
// host itself is bound to is not a third-party call — localSyncService.startServer()
// binds on the LAN interface and its suites then connect to the server they just
// started. Measured: that is the ONLY reason any suite contacts a non-loopback
// address, and with these folded in, zero existing suites go red.
const SELF = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]);
for (const addrs of Object.values(os.networkInterfaces() || {})) {
  for (const a of addrs || []) SELF.add(a.address);
}

// Shared record for this test file. Consumed by tests/net-guard/assert.js.
const attempts = [];
// The sequence counter must survive the per-test-file module-registry reset, or two
// test files in one worker both restart at 0 and consume() deletes the wrong record.
// `globalThis` is NOT a safe home — jest gives each test file a fresh global. The
// `net` core-module object is the same object for the whole worker, so it is.
// Regression control: netGuard.redproof.test.js, "a consuming file does not delete a
// sibling file's unreported record".
if (typeof net.__keeprNetSeq !== "number") net.__keeprNetSeq = 0;
global.__KEEPR_NET_ATTEMPTS__ = attempts;
// The ONLY sanctioned way to clear a recorded attempt. Used by assert.js's hooks and
// by the guard's own control suite.
global.__KEEPR_NET_CONSUME__ = consume;

const RECORD_DIR = process.env.KEEPR_NET_GUARD_RECORD_DIR || "";
const RECORD_FILE = RECORD_DIR
  ? path.join(RECORD_DIR, `attempts-${process.env.JEST_WORKER_ID || "0"}.jsonl`)
  : "";

// CONSUME, not drain. The in-memory array and the durable record are two views of the
// same fact and must clear together: a hook that reports an attempt has to clear
// BOTH, or the globalTeardown backstop re-reports it and the guard's own controls —
// which provoke blocked calls on purpose — fail the run.
//
// It removes the consumed records BY ID, never by truncating the file. The two views
// sit at different scopes: the array is per TEST FILE (a fresh `global` each time),
// the record file is per WORKER (one file, many test files). A blind truncate
// therefore deletes a SIBLING file's unreported records — measured: it silently
// dropped one probe's record when another ran later in the same worker, and the
// backstop then reported 1 of 2.
function consume() {
  const copy = attempts.slice();
  attempts.length = 0;
  if (RECORD_FILE && copy.length) {
    try {
      const gone = new Set(copy.map((r) => r.seq));
      const kept = fs
        .readFileSync(RECORD_FILE, "utf8")
        .split("\n")
        .filter((l) => l.trim() && !gone.has(JSON.parse(l).seq));
      fs.writeFileSync(RECORD_FILE, kept.length ? kept.join("\n") + "\n" : "");
    } catch (_) { /* the array is still authoritative for the hook that called us */ }
  }
  return copy.length ? copy : null;
}

function isAllowed(host) {
  return SELF.has(host);
}

function normalizeArgs(args) {
  // net.Socket.prototype.connect accepts FOUR shapes. The fourth is the trap:
  //   (options[, cb]) | (port[, host][, cb]) | (unixPath[, cb])
  //   ([options, cb])  <-- net.connect()/net.createConnection() pre-normalize and
  //                        pass a single ARRAY. Parsing args[0] as the options
  //                        object silently yields host === undefined, and an
  //                        undefined host in a loopback allow-list FAILS OPEN.
  //                        Measured on the first prototype: https was blocked while
  //                        http sailed through and resolved a host for real.
  let a = args;
  if (Array.isArray(a[0])) a = a[0];
  const first = a[0];
  if (first && typeof first === "object") {
    if (typeof first.path === "string") return { unix: true, host: null, port: null };
    // Node defaults a hostless TCP connect to localhost.
    return { unix: false, host: first.host === undefined ? "localhost" : first.host, port: first.port };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) {
    return { unix: true, host: null, port: null }; // unix socket path
  }
  return { unix: false, host: typeof a[1] === "string" ? a[1] : "localhost", port: first };
}

// net.Socket is a CORE module object, shared across every test file in a worker.
// tests/net-guard/install.js is re-required per test file (fresh module registry) but
// the prototype is not — so a once-only install captures the FIRST test file's
// `global`, and every later file's attempts are recorded against, and asserted in,
// the wrong environment. Measured: 26 attempts from two suites were all filed under a
// third suite that makes no connection at all. Re-install every file; keep the true
// original on the patched function so re-installing never double-wraps.
{
  const original = net.Socket.prototype.connect.__keeprOriginal || net.Socket.prototype.connect;

  function guardedConnect(...args) {
    const { unix, host, port } = normalizeArgs(args);
    if (unix || isAllowed(host)) {
      return original.apply(this, args);
    }
    const testPath = global.__KEEPR_TEST_PATH__ || "(unknown)";
    // seq is worker-local and monotonic: it is what lets consume() remove exactly the
    // records a hook reported, without touching a sibling test file's.
    const record = { seq: net.__keeprNetSeq++, testPath, host: String(host), port: port == null ? null : Number(port) };
    attempts.push(record);
    if (RECORD_FILE) {
      try {
        // Host and port only. Never a header, a body, or a credential.
        fs.appendFileSync(RECORD_FILE, JSON.stringify(record) + "\n");
      } catch (_) { /* the in-memory array is still authoritative for the hooks */ }
    }
    const err = new Error(
      `NET_GUARD: blocked outbound connection to ${host}:${port} from ${testPath}. ` +
        `Mock the client. (BACKLOG-3284)`
    );
    err.code = "KEEPR_NET_GUARD_BLOCKED";
    throw err;
  }
  guardedConnect.__keeprNetGuard = true;
  guardedConnect.__keeprOriginal = original;
  net.Socket.prototype.connect = guardedConnect;
}

// tsconfig.test.json includes tests/** — a .js file with no `module.exports` is a
// SCRIPT to TypeScript, and its top-level names land in the global declaration
// space. `function drain()` here collided with one in an unrelated electron test
// and took `npm run type-check:tests` red. Every file in this directory is an
// explicit CommonJS module for that reason; keep it that way.
module.exports = {};
