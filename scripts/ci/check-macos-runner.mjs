#!/usr/bin/env node
/**
 * macOS runner pin (BACKLOG-3198).
 *
 * .github/macos-runner.json records the runner label every macOS job uses and
 * the macOS version and build that label was last measured at. Moving either
 * is meant to be a PR, not something that happens to the release.
 *
 * GitHub-hosted runners can be pinned by LABEL only (macos-26), not by image
 * version: the OS inside a label still moves (26.5.2 -> 26.6.2 is the same
 * label). So there are two checks:
 *
 *   --workflows   every macOS `runs-on` in release.yml and ci.yml resolves to
 *                 the pinned label, and no job asks for macos-latest. Static;
 *                 runs on any OS.
 *   --host        sw_vers on this machine matches the recorded version and
 *                 build. Run on the macOS runner. --warn prints a workflow
 *                 warning instead of failing.
 *
 * Options: --config <path>, --workflow <path> (repeatable),
 *          --observed-product <v> --observed-build <b> (instead of sw_vers).
 * Exit 0 = matches; exit 1 = drift or a malformed input.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);

function opt(name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
}
function opts(name) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  });
  return out;
}
function fail(message) {
  console.error(`check-macos-runner: FAIL — ${message}`);
  process.exit(1);
}

const configPath = path.resolve(opt("--config") ?? path.join(ROOT, ".github/macos-runner.json"));
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  fail(`cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
}
for (const key of ["label", "productVersion", "buildVersion"]) {
  if (typeof config[key] !== "string" || config[key].trim() === "") fail(`${configPath}: "${key}" must be a non-empty string`);
}
if (!/^macos-\d+(-[a-z0-9]+)*$/.test(config.label) || config.label.startsWith("macos-latest")) {
  fail(`${configPath}: label "${config.label}" is not a versioned macOS label (e.g. macos-26)`);
}

/** Every `runs-on:` value in a workflow file, with its line number. */
function runsOnValues(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*runs-on:\s*(.+?)\s*(#.*)?$/);
    if (m) out.push({ line: i + 1, value: m[1].replace(/^["']|["']$/g, "") });
  });
  return out;
}

function checkWorkflows() {
  const files = opts("--workflow");
  const workflows = files.length
    ? files.map((f) => path.resolve(f))
    : [".github/workflows/release.yml", ".github/workflows/ci.yml"].map((f) => path.join(ROOT, f));
  // The ci.yml matrix keeps the value macos-latest because it is part of the
  // required status-check names; runs-on maps it to the pinned label.
  const mapped = `\${{ matrix.os == 'macos-latest' && '${config.label}' || matrix.os }}`;
  const problems = [];
  let macJobs = 0;
  for (const file of workflows) {
    for (const { line, value } of runsOnValues(file)) {
      const where = `${path.relative(ROOT, file) || file}:${line}`;
      if (value === config.label || value === mapped) {
        macJobs++;
      } else if (/matrix\.os/.test(value)) {
        problems.push(`${where}: runs-on "${value}" does not map macOS to ${config.label} (expected ${mapped})`);
      } else if (/macos/i.test(value)) {
        problems.push(`${where}: runs-on "${value}" is not the pinned label ${config.label}`);
      }
    }
  }
  if (problems.length) fail(`macOS runners not pinned:\n  ${problems.join("\n  ")}`);
  if (macJobs === 0) fail("no macOS runs-on found — the check read nothing");
  console.log(`check-macos-runner: OK — ${macJobs} macOS runs-on use ${config.label}`);
}

function checkHost() {
  const warnOnly = argv.includes("--warn");
  const read = (flag) => execFileSync("sw_vers", [flag], { encoding: "utf8" }).trim();
  let product = opt("--observed-product");
  let build = opt("--observed-build");
  try {
    product ??= read("-productVersion");
    build ??= read("-buildVersion");
  } catch (error) {
    fail(`cannot run sw_vers: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (product === config.productVersion && build === config.buildVersion) {
    console.log(`check-macos-runner: OK — macOS ${product} (${build}) matches ${path.basename(configPath)}`);
    return;
  }
  const message =
    `this runner is macOS ${product} (${build}); ${path.basename(configPath)} records ` +
    `${config.productVersion} (${config.buildVersion}) for ${config.label}. The runner image moved. ` +
    `Update .github/macos-runner.json in a PR, then run the Release workflow by workflow_dispatch ` +
    `on that branch to prove signing and notarisation on the new OS before releasing.`;
  if (warnOnly) {
    console.log(`::warning title=macOS runner moved::${message}`);
    return;
  }
  fail(message);
}

if (argv.includes("--workflows")) checkWorkflows();
else if (argv.includes("--host")) checkHost();
else fail("pass --workflows or --host");
