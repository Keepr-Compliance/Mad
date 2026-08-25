#!/usr/bin/env node
/**
 * Verification harness for scripts/ci/check-fixture-pii.mjs (BACKLOG-2657).
 *
 *   node scripts/__tests__/check-fixture-pii.verify.js
 *
 * Exits 0 only if every case passes.
 *
 * ## Why this is a standalone script and not a jest suite
 *
 * The same reason its sibling `test-with-restore.verify.js` gives: `jest.config.js`
 * restricts `testMatch` to `src/**`, `electron/**` and two named `__tests__`
 * directories, so a suite under `scripts/` would never run in CI. Worse, a file
 * named `*.test.mjs` here would match `TEST_FILE_RE` in
 * `scripts/ci/check-test-drift.mjs` — the gate that fails the build when a tracked
 * test file is run by NO CI config — so adding one would turn CI red rather than
 * add coverage. The `.verify.js` extension matches neither.
 *
 * ## Why the fixtures are built at runtime and never committed
 *
 * The subject reads a fixed set of directories under a repo root, and `src/` and
 * `scripts/` are both in it. So a committed fixture would be scanned by the real
 * guard on every run, and a committed fixture carrying a raw NUL would also fail
 * `scripts/ci/check-text-sources.mjs`, the sibling guard that rejects any tracked
 * source with a control byte in it. Both are correct behaviour and neither can be
 * worked around, which is why the subject grew a `--root` flag: every fixture here
 * is a throwaway tree under `os.tmpdir()`, built by this file and deleted after.
 *
 * `mkdtempSync` rather than a fixed path: this harness writes executable JS into
 * the tree and then RUNS it, and a predictable path in a world-writable directory
 * is CodeQL `js/insecure-temporary-file` — the same finding the sibling harness
 * took eight alerts for.
 *
 * The fixtures also prove themselves. A NUL fixture asserts `buf[i] === 0` before
 * the scanner ever sees it, and a bad-UTF-8 fixture asserts a strict decode throws
 * on it. A fixture that quietly failed to contain the byte it is named for would
 * make every case below pass for the wrong reason — which is precisely the shape
 * of false green this whole item is about.
 *
 * ## The negative controls need the PRE-FIX scanner
 *
 * "The fixed guard finds it" is not evidence on its own; the claim is that the
 * OLD guard did NOT. So the red half runs the pre-fix script over the identical
 * fixture:
 *
 *   FX_PREFIX_SCANNER=/tmp/prefix-check-fixture-pii.mjs \
 *     node scripts/__tests__/check-fixture-pii.verify.js
 *
 *   # to obtain one:
 *   git show <sha-before-the-fix>:scripts/ci/check-fixture-pii.mjs > /tmp/prefix-check-fixture-pii.mjs
 *
 * It is an env var rather than a hardcoded SHA so this harness does not rot the
 * moment history moves — the same trade `FX_WRAPPER` makes next door. When it is
 * unset the negative controls print as NOT RUN, loudly, because a run that skipped
 * them silently would be a green badge over the exact gap being fixed.
 *
 * Both halves run a COPY of their scanner placed at
 * `<fixture>/scripts/ci/check-fixture-pii.mjs`, so the scanner is the only
 * variable between them: each resolves its own repo root from `import.meta.url`
 * and the pre-fix script needs no `--root` support it does not have. Case R1 then
 * pins that `--root` agrees with the copy, byte for byte, so the flag is not
 * quietly a second code path.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const SCANNER = path.join(REPO_ROOT, "scripts", "ci", "check-fixture-pii.mjs");
const PREFIX_SCANNER = process.env.FX_PREFIX_SCANNER || null;

// Assembled from fragments at runtime. This harness lives in `scripts/`, which is
// inside the subject's own SCAN_ROOTS: a literal consumer address written out here
// would be reported as a new finding by the very guard under test, and the pre-push
// hook would refuse the push. Nothing below matches the subject's regexes as
// written — only once joined.
const FLAGGED_EMAIL = ["grover.mailbox", "@", "g", "mail", ".com"].join("");
const EXPECTED_MATCH = FLAGGED_EMAIL.toLowerCase();

const results = [];
function record(id, name, ok, detail) {
  results.push({ id, name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}`);
  if (detail) console.log(`        ${detail}`);
}
function skip(id, name, why) {
  results.push({ id, name, ok: true, skipped: true });
  console.log(`SKIP  ${id}  ${name}`);
  console.log(`        ${why}`);
}

// --------------------------------------------------------------------------
// Fixture construction
// --------------------------------------------------------------------------

const fixtures = [];

/**
 * A throwaway tree shaped like the repo: a scan root the subject walks, and the
 * scanner itself at the path its own `import.meta.url` resolution expects.
 * No baseline file is written, so in a fixture EVERY finding is a new finding.
 */
function newFixture(name, scannerSrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `keepr-2657-${name}-`));
  fixtures.push(dir);
  fs.mkdirSync(path.join(dir, "scripts", "ci"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "fixtures"), { recursive: true });
  fs.copyFileSync(scannerSrc, path.join(dir, "scripts", "ci", "check-fixture-pii.mjs"));
  return dir;
}

function fixtureFile(dir, name) {
  return path.join(dir, "src", "fixtures", name);
}

// -------------------------------------------------------------------------
// Git-backed fixtures (BACKLOG-2871)
//
// The bare-uuid rule reads COMMITS, not the checkout, so its fixtures need real
// git history. Same throwaway-tmpdir discipline as everything above, for the
// same reasons: a committed fixture would be scanned by the real guard, and a
// predictable path in a world-writable directory is CodeQL
// `js/insecure-temporary-file`.
// -------------------------------------------------------------------------

/** Generated per call. Never a literal: this file lives inside the guard's own scan roots. */
function randomUuid() {
  return require("crypto").randomUUID();
}

function gitIn(dir, argv) {
  const r = spawnSync("git", ["-C", dir, ...argv], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${argv.join(" ")} failed in ${dir}: ${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? "").trim();
}

/** A fixture tree that is also a git repo, with one commit already in it. */
function newGitFixture(name, scannerSrc) {
  const dir = newFixture(`git-${name}`, scannerSrc);
  gitIn(dir, ["init", "-q", "."]);
  gitIn(dir, ["config", "user.email", "harness@example.test"]);
  gitIn(dir, ["config", "user.name", "PII Harness"]);
  gitIn(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "src", "fixtures", "seed.ts"), "export const SEED = 0;\n");
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-qm", "seed"]);
  return dir;
}

function headSha(dir) {
  return gitIn(dir, ["rev-parse", "HEAD"]);
}

function commitFile(dir, rel, content, message) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-qm", message]);
}

function runDiff(dir, range) {
  return runCopied(dir, ["--diff-range", range]);
}

/** Runs the copy inside the fixture, so the scanner resolves the fixture as its root. */
function runCopied(dir, extraArgs = []) {
  return run(path.join(dir, "scripts", "ci", "check-fixture-pii.mjs"), extraArgs);
}

function run(scriptPath, extraArgs = []) {
  const r = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { code: r.status, stdout, stderr, out: stdout + stderr };
}

/**
 * Two lines the subject must treat differently, with the NUL between them.
 * The address is on line 7 and nothing about the sanitising may move it.
 */
function nulSourceLines() {
  return [
    "// fixture: a source file carrying a raw NUL byte",
    "export const NOTE_A = 'nothing here';",
    `export const CONTROL = 'before${String.fromCharCode(0)}after';`,
    "export const NOTE_B = 'nothing here either';",
    "",
    "export const CONTACT = {",
    `  email: '${FLAGGED_EMAIL}',`,
    "};",
    "",
  ];
}
const NUL_FINDING_LINE = 7;

function assertContainsNul(file) {
  const buf = fs.readFileSync(file);
  const at = buf.indexOf(0);
  if (at === -1) throw new Error(`fixture ${file} was supposed to contain a NUL and does not`);
  // The finding must sit AFTER the NUL, or the line-number case below could pass
  // against an implementation that renumbers everything following a control byte.
  const linesBefore = buf.subarray(0, at).toString("latin1").split("\n").length;
  if (linesBefore >= NUL_FINDING_LINE) {
    throw new Error(`fixture ${file}: NUL is not before the flagged value`);
  }
  return at;
}

function assertInvalidUtf8(file) {
  const buf = fs.readFileSync(file);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return true;
  }
  throw new Error(`fixture ${file} was supposed to be invalid UTF-8 and decodes cleanly`);
}

// --------------------------------------------------------------------------
// Cases
// --------------------------------------------------------------------------

function buildNulFixture(scannerSrc, name) {
  const dir = newFixture(name, scannerSrc);
  const file = fixtureFile(dir, "withNul.ts");
  fs.writeFileSync(file, nulSourceLines().join("\n"), "latin1");
  assertContainsNul(file);
  return dir;
}

function buildBadUtf8Fixture(scannerSrc, name) {
  const dir = newFixture(name, scannerSrc);
  const file = fixtureFile(dir, "badUtf8.ts");
  // A lone 0x80 INSIDE the domain of one address; a second, intact address two
  // lines down. The mangled one is unfindable either way — a lossy decode has
  // already destroyed it — so the fix's claim about this file is not "it finds
  // more" but "it SAYS the file was mangled", and that the rest still scanned.
  const head = Buffer.from(
    ["// fixture: not valid UTF-8", "export const MANGLED = 'grover.mailbox@gm"].join("\n"),
    "utf8",
  );
  const bad = Buffer.from([0x80]);
  const tail = Buffer.from(
    ["ail.com';", "", `export const INTACT = '${FLAGGED_EMAIL}';`, ""].join("\n"),
    "utf8",
  );
  fs.writeFileSync(file, Buffer.concat([head, bad, tail]));
  assertInvalidUtf8(file);
  return dir;
}

function main() {
  // ------------------------------------------------------------------ C1
  // The hole, from the fixed side.
  {
    const dir = buildNulFixture(SCANNER, "nul-post");
    const r = runCopied(dir);
    const failed = r.code === 1 && r.out.includes("Fixture PII guard: FAILED");
    const named = r.out.includes("src/fixtures/withNul.ts");
    const value = r.out.includes(EXPECTED_MATCH);
    const counted = r.out.includes("1 with a NUL byte");
    record(
      "C1",
      "a file with a raw NUL is READ, and the address in it is reported",
      failed && named && value && counted,
      `exit=${r.code} failed=${failed} namedFile=${named} reportedValue=${value} nulCounted=${counted}`,
    );

    // ---------------------------------------------------------------- C5
    // Line-number fidelity. A NUL replaced by a newline — or deleted — shifts
    // every following line, and the fixture guarantees the NUL is above the
    // finding, so this can actually go wrong.
    const onRightLine = new RegExp(
      `src/fixtures/withNul\\.ts:${NUL_FINDING_LINE}\\b`,
    ).test(r.out);
    const onWrongLine = /src\/fixtures\/withNul\.ts:(?!7\b)\d+/.test(r.out);
    record(
      "C5",
      `sanitising does not renumber lines (address is on line ${NUL_FINDING_LINE})`,
      onRightLine && !onWrongLine,
      `reportedCorrectLine=${onRightLine} reportedAnyOtherLine=${onWrongLine}`,
    );

    // ---------------------------------------------------------------- R1
    // --root is not a second code path.
    const viaRoot = run(SCANNER, ["--root", dir]);
    const identical =
      viaRoot.code === r.code && viaRoot.stdout === r.stdout && viaRoot.stderr === r.stderr;
    record(
      "R1",
      "--root DIR on the in-repo script matches a copy run inside DIR, byte for byte",
      identical,
      `exit ${viaRoot.code} vs ${r.code}; output identical=${identical}`,
    );
  }

  // ------------------------------------------------------------------ C1n
  if (PREFIX_SCANNER) {
    const dir = buildNulFixture(PREFIX_SCANNER, "nul-pre");
    const r = runCopied(dir);
    const green = r.code === 0 && r.out.includes("0 new");
    const silent = !r.out.includes("withNul.ts") && !r.out.includes(EXPECTED_MATCH);
    record(
      "C1n",
      "NEGATIVE CONTROL — the pre-fix scanner reports OK on the same file",
      green && silent,
      `exit=${r.code} green=${green} saidNothingAboutTheFile=${silent}`,
    );
  } else {
    skip("C1n", "NEGATIVE CONTROL — pre-fix scanner on the NUL fixture", "FX_PREFIX_SCANNER unset");
  }

  // ------------------------------------------------------------------ C2
  // Invalid UTF-8 is a REPORTED degradation, not a skip and not an error.
  {
    const dir = buildBadUtf8Fixture(SCANNER, "utf8-post");
    const r = runCopied(dir);
    const counted = r.out.includes("1 not valid UTF-8");
    const namedInIntegrity = r.out.includes("src/fixtures/badUtf8.ts");
    // The intact address two lines below the bad byte still has to be found:
    // that is what "decoded lossily and scanned anyway" has to mean.
    const stillScanned = r.out.includes(EXPECTED_MATCH) && r.code === 1;
    record(
      "C2",
      "invalid UTF-8 is reported, and the rest of the file is still scanned",
      counted && namedInIntegrity && stillScanned,
      `exit=${r.code} badUtf8Counted=${counted} named=${namedInIntegrity} intactValueFound=${stillScanned}`,
    );
  }

  // ------------------------------------------------------------------ C2n
  if (PREFIX_SCANNER) {
    const dir = buildBadUtf8Fixture(PREFIX_SCANNER, "utf8-pre");
    const r = runCopied(dir);
    // The pre-fix scanner DOES find the intact address here — this file has no
    // NUL, so nothing skips it. What it cannot do is say the file was mangled,
    // and that silence is the defect: the mangled address is gone from the scan
    // with nothing anywhere recording that it was ever there.
    const noIntegrityReport =
      !r.out.includes("not valid UTF-8") && !r.out.includes("scan integrity");
    record(
      "C2n",
      "NEGATIVE CONTROL — the pre-fix scanner never mentions the mangled bytes",
      noIntegrityReport,
      `exit=${r.code} silentAboutEncoding=${noIntegrityReport}`,
    );
  } else {
    skip("C2n", "NEGATIVE CONTROL — pre-fix scanner on the bad-UTF-8 fixture", "FX_PREFIX_SCANNER unset");
  }

  // ------------------------------------------------------------------ C4
  // A genuinely binary fixture must not become an error. It never reaches the
  // read at all: `.png` is not in SCAN_EXTENSIONS, so `walk()` does not yield it.
  {
    const dir = newFixture("binary", SCANNER);
    // A real PNG signature + IHDR, NULs and all.
    fs.writeFileSync(
      fixtureFile(dir, "logo.png"),
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89,
      ]),
    );
    fs.writeFileSync(fixtureFile(dir, "clean.ts"), "export const OK = true;\n");
    const r = runCopied(dir);
    const ok = r.code === 0 && r.out.includes("0 new");
    const noError = !r.out.includes("ERROR");
    const zeroUnreadable = r.out.includes("0 unreadable");
    // Two .ts files are read (clean.ts and the scanner copy); the .png is not.
    const twoRead = r.out.includes("2 file(s) read");
    record(
      "C4",
      "a real binary fixture is neither read nor an error — the extension gate stops it",
      ok && noError && zeroUnreadable && twoRead,
      `exit=${r.code} green=${ok} noError=${noError} zeroUnreadable=${zeroUnreadable} readExactlyTheTextFiles=${twoRead}`,
    );
  }

  // ------------------------------------------------------------------ C6
  // A file that genuinely cannot be read is an ERROR, not a skip.
  {
    const dir = newFixture("unreadable", SCANNER);
    const file = fixtureFile(dir, "locked.ts");
    fs.writeFileSync(file, `export const CONTACT = '${FLAGGED_EMAIL}';\n`);
    fs.chmodSync(file, 0o000);
    let reallyUnreadable = false;
    try {
      fs.readFileSync(file);
    } catch {
      reallyUnreadable = true;
    }
    if (!reallyUnreadable) {
      skip("C6", "an unreadable file is exit 2", "this process can read a mode-000 file (running as root?)");
    } else {
      const r = runCopied(dir);
      const isError = r.code === 2 && r.out.includes("could not be read");
      const named = r.out.includes("src/fixtures/locked.ts");
      record(
        "C6",
        "an unreadable file is an ERROR (exit 2), never a silent skip",
        isError && named,
        `exit=${r.code} error=${isError} namedFile=${named}`,
      );

      // And it must be an error in --update-baseline too: a baseline written
      // over a tree the guard could not fully read records the wrong thing,
      // permanently, and is exactly the artefact nobody re-derives later.
      const b = runCopied(dir, ["--update-baseline"]);
      const wroteNothing = !fs.existsSync(
        path.join(dir, "scripts", "ci", "fixture-pii-baseline.json"),
      );
      record(
        "C6b",
        "--update-baseline refuses to write a baseline over an unreadable tree",
        b.code === 2 && wroteNothing,
        `exit=${b.code} baselineAbsent=${wroteNothing}`,
      );
    }
    fs.chmodSync(file, 0o600);
  }

  // ------------------------------------------------------------------ C7
  // The over-long line is still skipped, but it is no longer silent.
  {
    const dir = newFixture("longline", SCANNER);
    const filler = "x".repeat(20001);
    fs.writeFileSync(
      fixtureFile(dir, "minified.ts"),
      `// fixture: an over-long line\nexport const BLOB = '${filler}${FLAGGED_EMAIL}';\n`,
    );
    const r = runCopied(dir);
    const reported = r.out.includes("1 line(s) over 20000 chars skipped");
    const namedWithLine = r.out.includes("src/fixtures/minified.ts:2");
    const notFound = !r.out.includes(EXPECTED_MATCH);
    record(
      "C7",
      "an over-long line is still skipped — but the skip is now counted and located",
      reported && namedWithLine && notFound,
      `exit=${r.code} counted=${reported} located=${namedWithLine} valueStillUnscanned=${notFound}`,
    );
  }

  // ------------------------------------------------------------------ C3
  // The clean case: the zero line is the product. A tree with nothing wrong in
  // it must still SAY that nothing was dropped.
  {
    const dir = newFixture("clean", SCANNER);
    fs.writeFileSync(fixtureFile(dir, "clean.ts"), "export const OK = true;\n");
    const r = runCopied(dir);
    const green = r.code === 0 && r.out.includes("0 new");
    const zeros =
      r.out.includes("0 with a NUL byte") &&
      r.out.includes("0 not valid UTF-8") &&
      r.out.includes("0 line(s) over 20000 chars skipped") &&
      r.out.includes("0 unreadable");
    record(
      "C3",
      "a clean tree prints the integrity counts anyway — all zero",
      green && zeros,
      `exit=${r.code} green=${green} allCountersPrintedZero=${zeros}`,
    );
  }

  // ==================================================================== 2871
  // Bare UUIDs in added lines. See UUID_RE in the subject for why this rule is
  // diff-scoped and waiver-gated rather than tree-scoped or live-resolving.
  //
  // EVERY UUID BELOW IS GENERATED AT RUNTIME. This repository is public and this
  // harness sits in `scripts/`, which the subject scans: a literal id written
  // here would be the exact bug under repair. The only literal is the nil UUID,
  // which is exempt by construction and identifies nothing.

  // ------------------------------------------------------------------ D1
  // The ACTUAL leak, reproduced: bare UUIDs in a JSDoc comment in
  // electron/services/**. Not a fixture file, not a test — a comment in source,
  // which is the shape that reached the public repo in b0685f4a3.
  {
    const dir = newGitFixture("d1", SCANNER);
    const base = headSha(dir);
    const org = randomUuid();
    const txn = randomUuid();
    commitFile(
      dir,
      "electron/services/submissionService.ts",
      [
        "/**",
        " * Transcribed from the live row (see BACKLOG-2867):",
        " *",
        ` *   organization_id       ${org}`,
        ` *   local_transaction_id  ${txn}`,
        " */",
        "export const SUBMISSION_VERSION = 1;",
        "",
      ].join("\n"),
      "fix(submissions): name the current submission version",
    );

    const r = runDiff(dir, `${base}..HEAD`);
    const failed = r.code === 1 && r.out.includes("Fixture PII guard: FAILED");
    const named = r.out.includes("electron/services/submissionService.ts:4");
    const both = r.out.includes(org) && r.out.includes(txn);
    const labelled = r.out.includes("Bare UUID(s) added by the commits being pushed");
    record(
      "D1",
      "THE LEAK: bare UUIDs in a JSDoc comment under electron/services/ are rejected",
      failed && named && both && labelled,
      `exit=${r.code} failed=${failed} lineNumber=${named} bothValues=${both} section=${labelled}`,
    );

    // ---------------------------------------------------------------- D1t
    // The tree scan over the SAME worktree stays green. This is what proves the
    // finding comes from the diff pass and not from some incidental tree match —
    // and it is why the rule needed to be written as a diff rule at all.
    const t = runCopied(dir);
    record(
      "D1t",
      "the tree scan over the same checkout says nothing — the diff pass is what found it",
      t.code === 0 && !t.out.includes(org),
      `treeExit=${t.code} treeMentionedTheValue=${t.out.includes(org)}`,
    );
  }

  // ------------------------------------------------------------------ D1n
  // NEGATIVE CONTROL. "The new guard finds it" is not the claim; the claim is
  // that the SHIPPED guard did not.
  if (PREFIX_SCANNER) {
    const dir = newGitFixture("d1-pre", PREFIX_SCANNER);
    const org = randomUuid();
    commitFile(
      dir,
      "electron/services/submissionService.ts",
      `/**\n *   organization_id  ${org}\n */\nexport const V = 1;\n`,
      "leak",
    );
    const r = runCopied(dir);
    const green = r.code === 0 && r.out.includes("0 new");
    record(
      "D1n",
      "NEGATIVE CONTROL — the pre-fix scanner reports OK on the leaked shape",
      green && !r.out.includes(org),
      `exit=${r.code} green=${green} mentionedValue=${r.out.includes(org)}`,
    );
  } else {
    skip("D1n", "NEGATIVE CONTROL — pre-fix scanner on the leaked shape", "FX_PREFIX_SCANNER unset");
  }

  // ------------------------------------------------------------------ D2
  // A waiver ON THE LINE, and a waiver ON THE LINE ABOVE, both with a reason.
  {
    const dir = newGitFixture("d2", SCANNER);
    const base = headSha(dir);
    const a = randomUuid();
    const b = randomUuid();
    commitFile(
      dir,
      "src/fixtures/waived.ts",
      [
        `export const SAME_LINE = "${a}"; // pii-allow-uuid: invented for this suite`,
        "// pii-allow-uuid: invented, not from any live row",
        `export const LINE_ABOVE = "${b}";`,
        "",
      ].join("\n"),
      "test: waived fixtures",
    );
    const r = runDiff(dir, `${base}..HEAD`);
    record(
      "D2",
      "a waiver WITH A REASON, on the line or the line above, allows the value",
      r.code === 0 && !r.out.includes(a) && !r.out.includes(b),
      `exit=${r.code} sameLineWaived=${!r.out.includes(a)} lineAboveWaived=${!r.out.includes(b)}`,
    );
  }

  // ------------------------------------------------------------------ D3
  // A BARE marker waives nothing. Without this the waiver is a magic word rather
  // than a statement someone can disagree with at review.
  {
    const dir = newGitFixture("d3", SCANNER);
    const base = headSha(dir);
    const a = randomUuid();
    commitFile(
      dir,
      "src/fixtures/bareMarker.ts",
      `export const X = "${a}"; // pii-allow-uuid:\n`,
      "test: marker with no reason",
    );
    const r = runDiff(dir, `${base}..HEAD`);
    record(
      "D3",
      "a waiver marker with NO REASON does not waive",
      r.code === 1 && r.out.includes(a),
      `exit=${r.code} stillReported=${r.out.includes(a)}`,
    );
  }

  // ------------------------------------------------------------------ D4
  // The nil UUID is the one exemption, and it is structural: no real record id
  // can be nil.
  {
    const dir = newGitFixture("d4", SCANNER);
    const base = headSha(dir);
    commitFile(
      dir,
      "src/fixtures/nil.ts",
      'export const EMPTY = "00000000-0000-0000-0000-000000000000";\n',
      "test: nil sentinel",
    );
    const r = runDiff(dir, `${base}..HEAD`);
    record(
      "D4",
      "the nil UUID is exempt and needs no waiver",
      r.code === 0,
      `exit=${r.code}`,
    );
  }

  // ------------------------------------------------------------------ D5
  // An "obviously fake" repeated-nibble UUID is NOT exempt. Deliberate: a
  // shape-based hole is a hole a real-looking id can be hand-crafted into, and
  // the measured hit rate (10 firing commits per 200) does not need one.
  {
    const dir = newGitFixture("d5", SCANNER);
    const base = headSha(dir);
    const fake = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");
    commitFile(dir, "src/fixtures/fake.ts", `export const F = "${fake}";\n`, "test: fake");
    const r = runDiff(dir, `${base}..HEAD`);
    record(
      "D5",
      "a repeated-nibble UUID is still reported — the only exemption is nil",
      r.code === 1 && r.out.includes(fake),
      `exit=${r.code} reported=${r.out.includes(fake)}`,
    );
  }

  // ------------------------------------------------------------------ D6
  // THE INTERMEDIATE COMMIT. Added in one commit, deleted in the next: the tree
  // at HEAD is spotless, and pushing the pair still publishes the first commit.
  // This is `.husky/pre-push` documented limit 1 (PR #2314's shape), and closing
  // it is why this rule reads commits rather than the checkout.
  {
    const dir = newGitFixture("d6", SCANNER);
    const base = headSha(dir);
    const leaked = randomUuid();
    commitFile(dir, "src/fixtures/oops.ts", `export const ID = "${leaked}";\n`, "oops");
    commitFile(dir, "src/fixtures/oops.ts", 'export const ID = "scrubbed";\n', "scrub it");

    const tree = runCopied(dir);
    const r = runDiff(dir, `${base}..HEAD`);
    record(
      "D6",
      "a value added then removed in a later commit is STILL caught (tree scan cannot see it)",
      tree.code === 0 && r.code === 1 && r.out.includes(leaked),
      `treeExit=${tree.code} (clean, as expected) diffExit=${r.code} caught=${r.out.includes(leaked)}`,
    );
  }

  // ------------------------------------------------------------------ D7
  // FAIL CLOSED. A range git cannot resolve is exit 2, never a clean bill of
  // health. "Could not check" and "found nothing" must not print the same way.
  {
    const dir = newGitFixture("d7", SCANNER);
    const r = runDiff(dir, "refs/heads/no-such-branch..HEAD");
    const isError = r.code === 2;
    const saysSo =
      r.out.includes("could not read the commit range") &&
      r.out.includes("This is an ERROR and not a pass");
    record(
      "D7",
      "an unresolvable range exits 2 and says nothing was checked — it never passes",
      isError && saysSo,
      `exit=${r.code} (want 2) explained=${saysSo}`,
    );
  }

  // ------------------------------------------------------------------ D8
  // A NUL-bearing file. Without --text git renders it "Binary files ... differ"
  // and every added line disappears from the scan SILENTLY — BACKLOG-2657 /
  // BACKLOG-2637 reborn in diff mode.
  {
    const dir = newGitFixture("d8", SCANNER);
    const base = headSha(dir);
    const hidden = randomUuid();
    const file = path.join(dir, "src", "fixtures", "withNul.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        "// fixture: a source file carrying a raw NUL byte",
        `export const CONTROL = 'before${String.fromCharCode(0)}after';`,
        `export const ID = "${hidden}";`,
        "",
      ].join("\n"),
      "latin1",
    );
    // Prove the fixture is what it is named for, before the subject sees it.
    if (fs.readFileSync(file).indexOf(0) === -1) {
      throw new Error("D8 fixture was supposed to contain a NUL and does not");
    }
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-qm", "nul"]);

    const r = runDiff(dir, `${base}..HEAD`);
    const caught = r.out.includes(hidden);
    const noBinaryHunks = r.out.includes("0 binary hunk(s)");
    record(
      "D8",
      "a UUID after a raw NUL is still scanned in diff mode (--text), and 0 binary hunks is reported",
      r.code === 1 && caught && noBinaryHunks,
      `exit=${r.code} caught=${caught} binaryHunksZero=${noBinaryHunks}`,
    );
  }

  // ------------------------------------------------------------------ D9
  // Scope holds: a root the guard does not scan, and an extension it does not
  // scan, are both left alone.
  {
    const dir = newGitFixture("d9", SCANNER);
    const base = headSha(dir);
    const inDocs = randomUuid();
    const inBinExt = randomUuid();
    commitFile(dir, "docs/notes.md", `runbook id ${inDocs}\n`, "docs");
    commitFile(dir, "src/fixtures/blob.bin", `${inBinExt}\n`, "blob");
    const r = runDiff(dir, `${base}..HEAD`);
    record(
      "D9",
      "an unscanned root (docs/) and an unscanned extension (.bin) are not flagged",
      r.code === 0 && !r.out.includes(inDocs) && !r.out.includes(inBinExt),
      `exit=${r.code} docsQuiet=${!r.out.includes(inDocs)} extQuiet=${!r.out.includes(inBinExt)}`,
    );
  }

  // ------------------------------------------------------------------ D10
  // bare-uuid is NOT baselineable. Two halves, because there are two ways the
  // baseline could become the escape hatch that silences a new rule:
  //   a) an entry in the file suppressing a finding, and
  //   b) --update-baseline quietly absorbing one.
  {
    const dir = newGitFixture("d10", SCANNER);
    const base = headSha(dir);
    const id = randomUuid();
    commitFile(dir, "src/fixtures/baselined.ts", `export const ID = "${id}";\n`, "add");

    fs.writeFileSync(
      path.join(dir, "scripts", "ci", "fixture-pii-baseline.json"),
      `${JSON.stringify(
        {
          $comment: "D10: an attempt to silence a bare-uuid finding via the baseline.",
          entryCount: 1,
          entries: [{ file: "src/fixtures/baselined.ts", rule: "bare-uuid", match: id }],
        },
        null,
        2,
      )}\n`,
    );

    const r = runDiff(dir, `${base}..HEAD`);
    const stillFails = r.code === 1 && r.out.includes(id);

    const upd = runCopied(dir, ["--diff-range", `${base}..HEAD`, "--update-baseline"]);
    const refused = upd.code === 2 && upd.out.includes("mutually exclusive");

    record(
      "D10",
      "a baseline entry does NOT silence bare-uuid, and --update-baseline refuses to record one",
      stillFails && refused,
      `baselineIgnored=${stillFails} updateRefused=${refused} (exit ${upd.code})`,
    );
  }

  // ------------------------------------------------------------------ D11
  // The empty-range trap. A caller that passes an empty spec must get an error,
  // not a scan of nothing that prints a clean bill of health.
  {
    const dir = newGitFixture("d11", SCANNER);
    const r = runCopied(dir, ["--diff-range", "   "]);
    record(
      "D11",
      "an EMPTY --diff-range is refused rather than silently scanning nothing",
      r.code === 2 && r.out.includes("was empty"),
      `exit=${r.code} (want 2)`,
    );
  }

  // ------------------------------------------------------------------ D12
  // The counters print on the PASS path too, zeros included — same argument as
  // C3. "0 commit(s)" is a statement; its absence is indistinguishable from diff
  // mode never having run.
  {
    const dir = newGitFixture("d12", SCANNER);
    const base = headSha(dir);
    commitFile(dir, "src/fixtures/clean.ts", "export const OK = true;\n", "clean");
    const r = runDiff(dir, `${base}..HEAD`);
    record(
      "D12",
      "a clean diff still prints the diff-scan counters",
      r.code === 0 && /diff scan: 1 commit\(s\)/.test(r.out) && r.out.includes("0 binary hunk(s)"),
      `exit=${r.code} printedCounters=${/diff scan: /.test(r.out)}`,
    );
  }
}

// --------------------------------------------------------------------------

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
}

const skipped = results.filter((r) => r.skipped);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (skipped.length > 0) {
  console.log("");
  console.log(`${skipped.length} case(s) NOT RUN: ${skipped.map((s) => s.id).join(", ")}`);
  console.log("The negative controls are the half that proves the hole was real.");
  console.log("A run without them shows the fix works and says nothing about what");
  console.log("it fixed. Re-run with FX_PREFIX_SCANNER set — see the header.");
}
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.id).join(", ")}`);
  process.exitCode = 1;
}
