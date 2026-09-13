/**
 * BACKLOG-3284 — per-RUN record directory for the globalTeardown backstop.
 *
 * Scoped to one run on purpose, and the assignment is UNCONDITIONAL. See install.js
 * ("THE RECORD DIRECTORY") for why that one line is load-bearing: it is what makes a
 * leftover record from a killed run unreachable, and what keeps the child jest
 * process spawned by the red-proof from writing into its parent's record.
 *
 * globalSetup runs in the main process BEFORE jest forks its workers, so the env var
 * set here is inherited by every worker. Proven at --maxWorkers=2.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

module.exports = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-net-guard-"));
  process.env.KEEPR_NET_GUARD_RECORD_DIR = dir;
};
