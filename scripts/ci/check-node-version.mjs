#!/usr/bin/env node
// BACKLOG-4053: fail the CI job when the runtime Node is older than the
// minimum patch release. Node 20 is end-of-life; CI pins 22.23.4.
//
// Usage: node scripts/ci/check-node-version.mjs [version]
//   version defaults to process.version (e.g. "v22.23.4").
// Exit 0 = at or above the minimum, 1 = below, 2 = unparseable input.

export const MINIMUM = "22.23.4";

export function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function atLeast(actual, minimum) {
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

const input = process.argv[2] ?? process.version;
const actual = parse(input);
if (!actual) {
  console.error(`check-node-version: cannot parse version "${input}"`);
  process.exit(2);
}
if (!atLeast(actual, parse(MINIMUM))) {
  console.error(`check-node-version: Node ${input} is below the minimum ${MINIMUM}`);
  process.exit(1);
}
console.log(`check-node-version: Node ${input} >= ${MINIMUM} OK`);
