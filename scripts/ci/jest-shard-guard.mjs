#!/usr/bin/env node
/**
 * Guards for the sharded desktop jest run in ci.yml (BACKLOG-4125).
 *
 * The desktop suite runs as four `jest --shard=i/4` jobs per OS. A shard that
 * runs nothing must never read as green, so every count is checked twice: by
 * the shard itself, and by the per-OS "Test & Lint" aggregator that sums all
 * shards and compares the sum with `jest --listTests` from the Checks job.
 *
 * Modes (exit 0 = pass, 1 = guard failed, 2 = bad usage):
 *
 *   expected --list <listTests.json>
 *       Count the paths in `jest --listTests --json` output. Fails on zero.
 *       Writes `suite-total=<n>` to $GITHUB_OUTPUT when that is set.
 *
 *   shard --json <jest-output.json> --shard <i>/<n> --out <summary.json>
 *       Validate one shard's `jest --json --outputFile` result. Fails when the
 *       file is missing or unreadable (a throwing globalTeardown suppresses it,
 *       see tests/net-guard/globalTeardown.js), or when numTotalTestSuites or
 *       numTotalTests is 0. Writes a small summary for the aggregator.
 *
 *   results --require <job,job,...>
 *       Read `toJSON(needs)` from the NEEDS_JSON env var. Fails unless every
 *       named job has result "success" (failure, cancelled and skipped all fail).
 *
 *   aggregate --dir <dir> --shards <n> --expected <total>
 *       Read every shard summary in <dir>. Fails unless there are exactly <n>,
 *       one per shard index 1..n, each non-zero, and the summed
 *       numTotalTestSuites equals <total>. TOTAL suites are compared, not
 *       passed: skipped suites differ by OS.
 */
import fs from "node:fs";
import path from "node:path";

function fail(msg) {
  console.error(`::error title=jest-shard-guard::${msg}`);
  console.error(`jest-shard-guard: FAIL — ${msg}`);
  process.exit(1);
}

function usage(msg) {
  console.error(`jest-shard-guard: usage error — ${msg}`);
  process.exit(2);
}

function opt(args, name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function readJson(file, what) {
  if (!file) usage(`${what}: no path given`);
  if (!fs.existsSync(file)) fail(`${what} not found: ${file}`);
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) fail(`${what} is empty: ${file}`);
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${what} is not valid JSON (${file}): ${err.message}`);
  }
  return undefined;
}

function positiveInt(value, what) {
  if (!Number.isInteger(value) || value <= 0) fail(`${what} is ${JSON.stringify(value)} — must be a positive integer`);
  return value;
}

function modeExpected(args) {
  const list = readJson(opt(args, "--list"), "listTests output");
  if (!Array.isArray(list)) fail("listTests output is not a JSON array");
  const total = positiveInt(list.length, "listed suite count");
  console.log(`jest-shard-guard: ${total} suites listed`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `suite-total=${total}\n`);
}

function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(spec || "");
  if (!m) usage(`--shard must be i/n, got ${JSON.stringify(spec)}`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (index < 1 || count < 1 || index > count) usage(`--shard ${spec} is out of range`);
  return { index, count };
}

function modeShard(args) {
  const { index, count } = parseShard(opt(args, "--shard"));
  const out = opt(args, "--out");
  if (!out) usage("--out is required");
  const r = readJson(opt(args, "--json"), "jest JSON result");
  const suites = positiveInt(r.numTotalTestSuites, "numTotalTestSuites");
  const tests = positiveInt(r.numTotalTests, "numTotalTests");
  const summary = {
    shard: index,
    shards: count,
    numTotalTestSuites: suites,
    numTotalTests: tests,
    numFailedTestSuites: r.numFailedTestSuites ?? null,
    numFailedTests: r.numFailedTests ?? null,
    numPendingTestSuites: r.numPendingTestSuites ?? null,
    numPendingTests: r.numPendingTests ?? null,
    numRuntimeErrorTestSuites: r.numRuntimeErrorTestSuites ?? null,
    success: r.success === true,
  };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`jest-shard-guard: shard ${index}/${count}: ${suites} suites, ${tests} tests, success=${summary.success}`);
}

function modeResults(args) {
  const required = (opt(args, "--require") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (required.length === 0) usage("--require lists no jobs");
  const raw = process.env.NEEDS_JSON;
  if (!raw) usage("NEEDS_JSON is not set");
  let needs;
  try {
    needs = JSON.parse(raw);
  } catch (err) {
    fail(`NEEDS_JSON is not valid JSON: ${err.message}`);
  }
  const bad = [];
  for (const job of required) {
    const result = needs?.[job]?.result;
    console.log(`  ${job}: ${result ?? "(absent)"}`);
    if (result !== "success") bad.push(`${job}=${result ?? "absent"}`);
  }
  if (bad.length) fail(`required jobs did not all succeed: ${bad.join(", ")}`);
  console.log(`jest-shard-guard: all ${required.length} required jobs succeeded`);
}

function modeAggregate(args) {
  const dir = opt(args, "--dir");
  if (!dir) usage("--dir is required");
  const shards = Number(opt(args, "--shards"));
  const expected = Number(opt(args, "--expected"));
  if (!Number.isInteger(shards) || shards < 1) usage("--shards must be a positive integer");
  positiveInt(expected, "--expected suite total");
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    : [];
  if (files.length !== shards) fail(`expected ${shards} shard summaries in ${dir}, found ${files.length}: ${files.join(", ") || "none"}`);
  const seen = new Map();
  let suites = 0;
  let tests = 0;
  for (const f of files) {
    const s = readJson(path.join(dir, f), `shard summary ${f}`);
    if (s.shards !== shards) fail(`${f} was written for ${s.shards} shards, not ${shards}`);
    if (!Number.isInteger(s.shard) || s.shard < 1 || s.shard > shards) fail(`${f} has shard index ${s.shard}`);
    if (seen.has(s.shard)) fail(`shard ${s.shard} reported twice (${seen.get(s.shard)} and ${f})`);
    seen.set(s.shard, f);
    suites += positiveInt(s.numTotalTestSuites, `${f} numTotalTestSuites`);
    tests += positiveInt(s.numTotalTests, `${f} numTotalTests`);
    console.log(`  shard ${s.shard}/${shards}: ${s.numTotalTestSuites} suites, ${s.numTotalTests} tests`);
  }
  console.log(`  sum: ${suites} suites, ${tests} tests; expected ${expected} suites`);
  if (suites !== expected) fail(`shards ran ${suites} suites in total; jest --listTests lists ${expected}`);
  console.log(`jest-shard-guard: OK — ${shards} shards, ${suites} suites, ${tests} tests`);
}

const [mode, ...rest] = process.argv.slice(2);
switch (mode) {
  case "expected":
    modeExpected(rest);
    break;
  case "shard":
    modeShard(rest);
    break;
  case "results":
    modeResults(rest);
    break;
  case "aggregate":
    modeAggregate(rest);
    break;
  default:
    usage(`unknown mode ${JSON.stringify(mode)} (expected | shard | results | aggregate)`);
}
