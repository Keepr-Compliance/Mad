/**
 * BACKLOG-3284 — the backstop. Fails the RUN on any blocked connection that no jest
 * hook reported.
 *
 * Two measured shapes reach here and nothing else can see them:
 *   - a network call in a test file's OWN afterAll (the guard's root afterAll,
 *     registered by setupFilesAfterEnv, runs FIRST and finds nothing)
 *   - a module-scope call in a file whose tests are all skipped (no hook runs)
 *
 * Anything a hook DID report was consumed from the record at the same moment, so a
 * non-empty record here means exactly "nobody reported this".
 *
 * The directory is removed BEFORE the throw, so a red run does not leave its own
 * record behind for the next one.
 *
 * NOTE: a throwing globalTeardown suppresses --json --outputFile entirely. A
 * verification step that parses that JSON must treat "exit 1, no JSON" as a backstop
 * failure, not a harness error.
 */
const fs = require("fs");
const path = require("path");

module.exports = () => {
  const dir = process.env.KEEPR_NET_GUARD_RECORD_DIR;
  if (!dir || !fs.existsSync(dir)) return;

  const records = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith("attempts-") || !f.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (line.trim()) records.push(JSON.parse(line));
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });

  if (records.length > 0) {
    const list = records.map((r) => `  - ${r.host}:${r.port}   from ${r.testPath}`).join("\n");
    throw new Error(
      `NET_GUARD BACKSTOP: ${records.length} blocked connection(s) were never reported by a jest hook:\n${list}\n` +
        `Most likely a call in a file's own afterAll, or in a file whose tests are all skipped. (BACKLOG-3284)`
    );
  }
};
