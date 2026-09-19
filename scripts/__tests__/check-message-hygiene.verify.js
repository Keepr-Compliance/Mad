#!/usr/bin/env node
/**
 * VERIFICATION HARNESS for scripts/ci/check-message-hygiene.mjs — BACKLOG-3133
 * =============================================================================
 * A verification harness that never executes is indistinguishable from one that
 * passes (BACKLOG-2871). This runs in CI as the "Verify the guard itself" step
 * of the Message Hygiene Gate, and in the pre-push hook's own controls.
 *
 * Every control below was made to FAIL ON PURPOSE during implementation. Each
 * RED control asserts exit code 1 (findings) and each GREEN one asserts exit 0,
 * so a guard that stopped detecting anything would turn this harness red rather
 * than quietly passing.
 *
 * EVERY PLANTED STRING IN THIS FILE IS A PLACEHOLDER. The addresses are
 * documentation-range or deliberately-invalid, the role names are the literals
 * the rule matches on (they have to be, or the control tests nothing), the
 * tailnet name is invented, and the denylist term is "ExampleCorp". Nothing
 * here came from a live host, a live tenant or a live customer.
 *
 * Controls
 *   R1   CGNAT-shaped address in a commit message          -> RED
 *   R2   RFC1918 10/8 address                              -> RED
 *   R3   RFC1918 192.168/16 address                        -> RED
 *   R4   RFC1918 172.16/12 address                         -> RED
 *   R5   a *.ts.net name                                   -> RED
 *   R6   a privileged role literal                         -> RED
 *   R7   a user:password literal                           -> RED
 *   R8   the admin API path fragment                       -> RED
 *   R9   "default password"                                -> RED
 *   R10  "unauthenticated"                                 -> RED
 *   R11  a bare UUID                                       -> RED
 *   G1   the nil UUID                                      -> GREEN (structural exemption)
 *   G2   a UUID with pii-allow-uuid: <reason>              -> GREEN
 *   R12  a UUID with pii-allow-uuid: and NO reason         -> RED  (kills the emptiness mutation)
 *   G3   hygiene-allow on a WAIVABLE rule, with a reason   -> GREEN
 *   R13  hygiene-allow with an EMPTY reason                -> RED  (kills the same mutation)
 *   R14  hygiene-allow naming a NON-waivable rule (cgnat)  -> RED
 *   R15  hygiene-allow for one rule does not waive another -> RED
 *   D1   denylist term present, file present               -> RED
 *   D2   the SAME message with NO denylist file            -> GREEN (must not fail closed)
 *   D3   denylist file unreadable (a directory)            -> EXIT 2
 *   D4   denylist output contains the term nowhere         -> asserted on stdout+stderr
 *   D5   the denylist line prints location ONLY (no mask) -> kills the NEVER_PRINT mutation
 *   D6   denylist matching is case-insensitive           -> RED
 *   M1   a non-denylist finding is MASKED, not printed raw
 *   M2   --reveal under CI=true                            -> EXIT 2
 *   N1   an ordinary commit message                        -> GREEN
 *   N2   four-part version-like strings, not private space -> GREEN
 *   N3   a public IPv4 address                             -> GREEN
 *   T1   --text-file with a role literal (a PR body)       -> RED
 *   T2   --text-file, clean body                           -> GREEN
 *   T3   --text-file that does not exist                   -> EXIT 2
 *   E1   an unresolvable range                             -> EXIT 2 (fails closed)
 *   E2   --range and --text-file together                  -> EXIT 2
 *   S1   a message containing a fake record delimiter does
 *        not hide the NEXT commit from the scan            -> RED, 2 commits seen
 *   S2   a waiver with a clean reason                       -> GREEN
 *   S3   a waiver whose REASON names an address           -> RED  (the line is still scanned)
 *   S4   one commit's waiver does not reach another commit -> RED
 *   S5   a MERGE commit message is scanned                -> RED
 *   N4   a 4-part string with an out-of-range octet       -> GREEN
 *   P1   a UUID on a line naming pm_comments               -> GREEN (PM allowance)
 *   P2   the same line in a PR body                        -> GREEN
 *   P3   the same UUID with no pm_ table on the line       -> RED
 *   P4   pm_projects (outside the closed set) + a UUID     -> RED
 *   P5   pm_comments and the UUID on DIFFERENT lines       -> RED  (per-line)
 *   X1   --new-to-head, head's own origin ref held out     -> RED
 *   X2   the same commit already on another origin ref     -> GREEN + plain note
 *   X3   the origin ref count appears in the output
 *   X4   --new-to-head with no other origin refs           -> EXIT 2
 *   X5   --new-to-head with --range                        -> EXIT 2
 *   X6   --head-ref without --new-to-head                  -> EXIT 2
 */

const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const GATE = path.join(REPO_ROOT, "scripts", "ci", "check-message-hygiene.mjs");

const results = [];
const record = (id, name, ok, detail, skipped = false) =>
  results.push({ id, name, ok, detail, skipped });

// --- placeholders -----------------------------------------------------------
// Assembled from parts so that this FILE does not itself contain a literal that
// the guard would flag if it were ever pasted into a commit message. The guard
// scans messages, not files, so this is belt-and-braces — but the file is also
// the thing a reviewer reads, and a reviewer should not have to squint at four
// octets to know whether they are real.
const PH_CGNAT = ["100", "64", "255", "254"].join(".");
const PH_10 = ["10", "0", "0", "254"].join(".");
const PH_192 = ["192", "168", "0", "254"].join(".");
const PH_172 = ["172", "20", "0", "254"].join(".");
const PH_PUBLIC = ["203", "0", "113", "5"].join("."); // TEST-NET-3, RFC5737
const PH_TAILNET = ["placeholder-tailnet", "ts", "net"].join(".");
const PH_ROLE = ["supabase", "admin"].join("_");
const PH_PGPG = ["postgres", "postgres"].join(":");
const PH_ENDPOINT = "/api/" + "platform/" + "pg-meta/example/query";
// pii-allow-uuid: RFC 4122 §C.2's own example UUID; invented, not from any live row
const PH_UUID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const PH_DENY = "ExampleCorp";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function runGate(args, env = {}) {
  const r = spawnSync(process.execPath, [GATE, ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: { ...process.env, CI: "", GITHUB_ACTIONS: "", ...env },
  });
  const out = r.stdout || "";
  const err = r.stderr || "";
  return { code: r.status, out, err, all: out + err };
}

/**
 * A throwaway git repo with one commit per planted message.
 *
 * Commit messages are written through `-F <file>` rather than `-m`, so a
 * multi-line message with blank lines and trailers survives verbatim — the
 * waiver controls depend on a trailer arriving in the message body exactly as
 * written.
 *
 * The first commit is a base that every range EXCLUDES, so the range under test
 * contains exactly the messages the control planted and nothing else.
 */
function mkRepoWithMessages(messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msghyg-verify-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "verify",
    GIT_AUTHOR_EMAIL: "verify@example.com",
    GIT_COMMITTER_NAME: "verify",
    GIT_COMMITTER_EMAIL: "verify@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: base");
  const base = git("rev-parse", "HEAD").trim();
  messages.forEach((msg, i) => {
    const mf = path.join(dir, `.msg${i}`);
    fs.writeFileSync(mf, msg);
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`);
    git("add", "f" + i + ".txt");
    git("commit", "-q", "-F", mf);
    fs.unlinkSync(mf);
  });
  return { dir, base, head: git("rev-parse", "HEAD").trim() };
}

/** Run the gate over a temp repo's planted commits. */
function scanMessages(messages, extraArgs = [], env = {}) {
  const { dir, base } = mkRepoWithMessages(messages);
  const r = spawnSync(
    process.execPath,
    [GATE, "--range", `HEAD --not ${base}`, ...extraArgs],
    {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, CI: "", GITHUB_ACTIONS: "", ...env },
    },
  );
  const out = r.stdout || "";
  const err = r.stderr || "";
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out, err, all: out + err };
}

/**
 * A throwaway repo whose planted commit sits on a branch that ALSO has a
 * `refs/remotes/origin/<name>` ref, plus one other origin ref.
 *
 * Real `refs/remotes/origin/*` refs in a scratch repo, never in the shared one:
 * `--new-to-head` reads the ref list from the repo it runs in, so a control that
 * wrote fake refs into the working checkout would be editing the thing under
 * test.
 */
function mkRepoWithOriginRefs(message, { headRefName, otherRefName }) {
  const { dir, base, head } = mkRepoWithMessages([message]);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
  if (headRefName) git("update-ref", `refs/remotes/origin/${headRefName}`, head);
  if (otherRefName) git("update-ref", `refs/remotes/origin/${otherRefName}`, base);
  return { dir, base, head };
}

/** Run the gate in --new-to-head mode inside a scratch repo. */
function runInRepo(dir, args) {
  const r = spawnSync(process.execPath, [GATE, ...args], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, CI: "", GITHUB_ACTIONS: "" },
  });
  const out = r.stdout || "";
  const err = r.stderr || "";
  return { code: r.status, out, err, all: out + err };
}

/** Run the gate over a blob of text. */
function scanBlob(text, extraArgs = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msghyg-blob-"));
  const f = path.join(dir, "body.md");
  fs.writeFileSync(f, text);
  const r = runGate(["--text-file", f, "--label", "PR body", ...extraArgs], env);
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

/** A denylist file containing the given terms; returns its path and a cleanup. */
function mkDenylist(terms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msghyg-deny-"));
  const p = path.join(dir, "pii-denylist.txt");
  fs.writeFileSync(p, `# comment line\n\n${terms.join("\n")}\n`);
  return { path: p, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Every control points --denylist at a path that does not exist unless the
 * control is about the denylist. Without this the harness would read the
 * DEVELOPER'S ~/.keepr/pii-denylist.txt and its results would differ per
 * machine — a harness whose verdict depends on the operator's private file is
 * not a control.
 */
const NO_DENYLIST = ["--denylist", path.join(os.tmpdir(), "msghyg-absent-denylist-xyz")];

const red = (r) => r.code === 1;
const green = (r) => r.code === 0;
const usage = (r) => r.code === 2;

// ---------------------------------------------------------------------------
// R1-R11 — every rule fires
// ---------------------------------------------------------------------------

const RULE_CASES = [
  ["R1", "CGNAT-shaped address", `fix(nas): bind the stack to ${PH_CGNAT}`, "cgnat"],
  ["R2", "RFC1918 10/8", `chore: point the job at ${PH_10}`, "rfc1918"],
  ["R3", "RFC1918 192.168/16", `chore: reach the host on ${PH_192}`, "rfc1918"],
  ["R4", "RFC1918 172.16/12", `chore: reach the host on ${PH_172}`, "rfc1918"],
  ["R5", "tailnet MagicDNS name", `chore: use ${PH_TAILNET} instead`, "tailnet-name"],
  ["R6", "privileged role literal", `fix(db): stop connecting as ${PH_ROLE}`, "privileged-role"],
  ["R7", "user:password literal", `fix(db): the CLI defaults to ${PH_PGPG}`, "privileged-role"],
  ["R8", "admin API path fragment", `docs: ${PH_ENDPOINT} answers without a token`, "platform-endpoint"],
  ["R9", "the default-credential phrase", "fix: it accepts the default password remotely", "security-phrase"],
  ["R10", "the unauthenticated phrase", "docs: the studio endpoint is unauthenticated", "security-phrase"],
  ["R11", "a bare UUID", `fix(org): repair the row for ${PH_UUID}`, "bare-uuid"],
];

for (const [id, name, msg, rule] of RULE_CASES) {
  const r = scanMessages([msg], NO_DENYLIST);
  record(
    id,
    `${name} -> RED`,
    red(r) && r.all.includes(`[${rule}]`),
    `code=${r.code} rule '${rule}' reported=${r.all.includes(`[${rule}]`)}`,
  );
}

// ---------------------------------------------------------------------------
// G1-G2, R12 — the bare-uuid exemption and BACKLOG-2871's waiver
// ---------------------------------------------------------------------------

{
  const r = scanMessages(
    ["chore: reset the sentinel row 00000000-0000-0000-0000-000000000000"],
    NO_DENYLIST,
  );
  record("G1", "the nil UUID -> GREEN", green(r), `code=${r.code}`);
}
{
  const r = scanMessages(
    [`test: seed ${PH_UUID} // pii-allow-uuid: invented, not from any live row`],
    NO_DENYLIST,
  );
  record("G2", "UUID with pii-allow-uuid: <reason> -> GREEN", green(r), `code=${r.code}`);
}
{
  const r = scanMessages([`test: seed ${PH_UUID} // pii-allow-uuid:`], NO_DENYLIST);
  record(
    "R12",
    "UUID with pii-allow-uuid: and NO reason -> RED",
    red(r) && r.all.includes("[bare-uuid]"),
    `code=${r.code} — a bare marker must waive nothing`,
  );
}

// ---------------------------------------------------------------------------
// G3, R13-R15 — the hygiene-allow waiver
// ---------------------------------------------------------------------------

{
  const r = scanMessages(
    [
      `fix(rls): grant EXECUTE to ${PH_ROLE} only\n\nhygiene-allow: privileged-role: names a role in a migration, not a live host`,
    ],
    NO_DENYLIST,
  );
  record("G3", "hygiene-allow on a waivable rule, with a reason -> GREEN", green(r), `code=${r.code}`);
}
{
  const r = scanMessages(
    [`fix(rls): grant EXECUTE to ${PH_ROLE} only\n\nhygiene-allow: privileged-role:`],
    NO_DENYLIST,
  );
  record(
    "R13",
    "hygiene-allow with an EMPTY reason -> RED",
    red(r) && r.all.includes("[privileged-role]"),
    `code=${r.code} — the reason is the review artifact; a bare marker waives nothing`,
  );
}
{
  const r = scanMessages(
    [`fix(nas): bind to ${PH_CGNAT}\n\nhygiene-allow: cgnat: it is only a lab address`],
    NO_DENYLIST,
  );
  record(
    "R14",
    "hygiene-allow naming a NON-waivable rule -> RED",
    red(r) && r.all.includes("[cgnat]"),
    `code=${r.code} — addresses and customer names are not waivable by design`,
  );
}
{
  const r = scanMessages(
    [
      `fix(db): ${PH_ROLE} and ${PH_ENDPOINT}\n\nhygiene-allow: privileged-role: migration only`,
    ],
    NO_DENYLIST,
  );
  record(
    "R15",
    "a waiver for one rule does not waive another -> RED",
    red(r) && r.all.includes("[platform-endpoint]") && !r.all.includes("[privileged-role]"),
    `code=${r.code} endpoint=${r.all.includes("[platform-endpoint]")} role=${r.all.includes("[privileged-role]")}`,
  );
}

// ---------------------------------------------------------------------------
// D1-D4 — the denylist, including the must-not-fail-closed case
// ---------------------------------------------------------------------------

const DENY_MSG = `feat(import): handle the ${PH_DENY} export format`;

{
  const dl = mkDenylist([PH_DENY, "AnotherPlaceholderCo"]);
  const r = scanMessages([DENY_MSG], ["--denylist", dl.path]);
  record(
    "D1",
    "denylist term present, file present -> RED",
    red(r) && r.all.includes("[denylist]"),
    `code=${r.code}`,
  );
  record(
    "D4",
    "denylist output never contains the term",
    !r.all.includes(PH_DENY) && !r.all.includes(PH_DENY.toLowerCase()),
    `term appeared in output=${r.all.includes(PH_DENY)}`,
  );
  // D4 alone cannot see a MASKED term: "E***p" does not contain "ExampleCorp",
  // so emptying NEVER_PRINT left D4 green. D5 asserts the stronger property the
  // rule actually promises — the denylist line carries no match of any kind.
  const denyLines = r.all
    .split("\n")
    .filter((l) => /^\s{6}\S/.test(l) && /line \d+/.test(l));
  const denySection = r.all.slice(r.all.indexOf("[denylist]"));
  const denyLoc = denySection.split("\n").filter((l) => /line \d+/.test(l));
  record(
    "D5",
    "the denylist finding prints location only — no mask, no value",
    denyLoc.length > 0 && denyLoc.every((l) => !l.includes("***") && !/line \d+:/.test(l)),
    `lines=${JSON.stringify(denyLoc)} (${denyLines.length} finding line(s) total) — a mask that preserves first letter and length is still an identifier`,
  );
  dl.cleanup();
}
{
  // A customer name typed in a different case is the same customer name.
  // Without this control the "gi" flag could be dropped and D1 would stay green,
  // because D1's fixture spells the term exactly as the denylist file does.
  const dl = mkDenylist([PH_DENY]);
  const r = scanMessages(
    [`feat(import): support the ${PH_DENY.toUpperCase()} csv layout`],
    ["--denylist", dl.path],
  );
  record(
    "D6",
    "denylist matching is case-insensitive -> RED",
    red(r) && r.all.includes("[denylist]"),
    `code=${r.code} — the term was planted upper-case, the denylist holds mixed case`,
  );
  dl.cleanup();
}
{
  const r = scanMessages([DENY_MSG], NO_DENYLIST);
  record(
    "D2",
    "the SAME message with NO denylist file -> GREEN",
    green(r) && r.all.includes("no denylist file"),
    `code=${r.code} — an optional file that fails closed takes the whole fleet down`,
  );
}
{
  // A directory at the denylist path: it EXISTS, so this is not the absent
  // case, and it cannot be read. The operator believes they are protected.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msghyg-denydir-"));
  const r = scanMessages([DENY_MSG], ["--denylist", dir]);
  record(
    "D3",
    "denylist present but unreadable -> EXIT 2",
    usage(r),
    `code=${r.code} — absent is fine, broken is not`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// M1-M2 — the guard must not republish what it caught
// ---------------------------------------------------------------------------

{
  const r = scanMessages([`fix(nas): bind the stack to ${PH_CGNAT}`], NO_DENYLIST);
  record(
    "M1",
    "a finding is MASKED in the default output",
    red(r) && !r.all.includes(PH_CGNAT) && /1\*\*\*4/.test(r.all),
    `code=${r.code} raw=${r.all.includes(PH_CGNAT)} — CI logs on a public repo are world-readable`,
  );
}
{
  const r = scanMessages(
    [`fix(nas): bind the stack to ${PH_CGNAT}`],
    [...NO_DENYLIST, "--reveal"],
    { CI: "true" },
  );
  record(
    "M2",
    "--reveal under CI=true -> EXIT 2",
    usage(r) && !r.all.includes(PH_CGNAT),
    `code=${r.code} raw=${r.all.includes(PH_CGNAT)}`,
  );
}

// ---------------------------------------------------------------------------
// N1-N3 — negative controls. A guard that fires on ordinary work gets bypassed.
// ---------------------------------------------------------------------------

{
  const r = scanMessages(
    [
      "fix(contacts): stop the picker showing the same person twice (BACKLOG-2352)\n\nThe view ordered by a column that is not stable across pages, so a\ncontact could appear on two pages at once.",
      "chore(deps): bump electron to 35.7.5",
    ],
    NO_DENYLIST,
  );
  record("N1", "two ordinary commit messages -> GREEN", green(r), `code=${r.code}\n${r.all.trim()}`);
}
{
  const r = scanMessages(
    ["chore: bump the schema to 4.2.3.1 and pin the driver at 172.4.1.0"],
    NO_DENYLIST,
  );
  record(
    "N2",
    "four-part version-like strings outside private space -> GREEN",
    green(r),
    `code=${r.code} — 172.4 is outside 172.16/12, so the second-octet test is doing work`,
  );
}
{
  const r = scanMessages([`docs: the CDN answers on ${PH_PUBLIC}`], NO_DENYLIST);
  record("N3", "a public IPv4 address -> GREEN", green(r), `code=${r.code}`);
}

// ---------------------------------------------------------------------------
// T1-T3 — text-file mode (the PR title / PR body path)
// ---------------------------------------------------------------------------

{
  const r = scanBlob(
    `## Summary\n\nWe dropped the connection from ${PH_ROLE} to a scoped role.\n`,
    NO_DENYLIST,
  );
  record(
    "T1",
    "--text-file with a role literal -> RED",
    red(r) && r.all.includes("PR body"),
    `code=${r.code}`,
  );
}
{
  const r = scanBlob(
    "## Summary\n\nFour ports moved off the wildcard bind. Residual detail is on BACKLOG-3114.\n",
    NO_DENYLIST,
  );
  record("T2", "--text-file, clean body -> GREEN", green(r), `code=${r.code}`);
}
{
  const r = runGate([
    "--text-file",
    path.join(os.tmpdir(), "msghyg-absent-body-xyz.md"),
    ...NO_DENYLIST,
  ]);
  record("T3", "--text-file that does not exist -> EXIT 2", usage(r), `code=${r.code}`);
}

// ---------------------------------------------------------------------------
// E1-E2 — the input contract. Exit 2 is not exit 0.
// ---------------------------------------------------------------------------

{
  const r = runGate(["--range", "definitely-not-a-ref-xyz", ...NO_DENYLIST]);
  record(
    "E1",
    "an unresolvable range -> EXIT 2, not 0",
    usage(r),
    `code=${r.code} — a pre-publication gate must block when it cannot check`,
  );
}
{
  const r = runGate(["--range", "HEAD", "--text-file", GATE, ...NO_DENYLIST]);
  record("E2", "--range and --text-file together -> EXIT 2", usage(r), `code=${r.code}`);
}

// ---------------------------------------------------------------------------
// S1-S2 — parsing cannot be steered by message content
// ---------------------------------------------------------------------------

{
  // A message that ends with something resembling a record boundary. If the
  // parser split on newlines or on a printable delimiter, the SECOND commit
  // would vanish from the scan and its finding would be missed.
  const sneaky =
    "chore: routine change\n\n--\ncommit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\nAuthor: someone\n";
  const r = scanMessages([sneaky, `fix(nas): bind to ${PH_CGNAT}`], NO_DENYLIST);
  record(
    "S1",
    "a fake record delimiter cannot hide the next commit",
    red(r) && r.all.includes("[cgnat]"),
    `code=${r.code} — records are NUL-separated with a unit-separator field split`,
  );
}
{
  const r = scanMessages(
    [
      "fix(rls): scope the grant\n\nhygiene-allow: security-phrase: the fixture is a stub, not a live surface",
    ],
    NO_DENYLIST,
  );
  record(
    "S2",
    "a waiver with a clean reason -> GREEN",
    green(r),
    `code=${r.code} — otherwise the waiver could never be written down`,
  );
}
{
  // The waiver LINE is public text like any other. A reason that names an
  // address publishes the address, whatever rule the trailer claims to waive.
  const r = scanMessages(
    [
      `fix(rls): scope the grant\n\nhygiene-allow: privileged-role: the box at ${PH_10} is a lab host`,
    ],
    NO_DENYLIST,
  );
  record(
    "S3",
    "a waiver whose REASON names an address -> RED",
    red(r) && r.all.includes("[rfc1918]") && !r.all.includes("[privileged-role]"),
    `code=${r.code} rfc1918=${r.all.includes("[rfc1918]")} role=${r.all.includes("[privileged-role]")} — the trailer waives its rule, not the whole line`,
  );
}

{
  // Two commits. The FIRST carries a valid waiver; the SECOND does not. If the
  // records were ever merged into one blob (a dropped `-z`, a newline split),
  // the first commit's waiver would silence the second commit's finding.
  const r = scanMessages(
    [
      `fix(rls): grant to ${PH_ROLE}\n\nhygiene-allow: privileged-role: migration only, no live host`,
      `chore(db): connect as ${PH_ROLE} for the backfill`,
    ],
    NO_DENYLIST,
  );
  record(
    "S4",
    "one commit's waiver does not carry to another commit -> RED",
    red(r) && r.all.includes("[privileged-role]"),
    `code=${r.code} — a waiver is scoped to the message it appears in`,
  );
}

{
  // A MERGE commit message is scanned. Nothing else in this harness produces a
  // merge, so without this control `--no-merges` could be reintroduced and
  // every control would stay green.
  const { dir, base } = mkRepoWithMessages(["chore: side work"]);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "verify",
    GIT_AUTHOR_EMAIL: "verify@example.com",
    GIT_COMMITTER_NAME: "verify",
    GIT_COMMITTER_EMAIL: "verify@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env });
  git("checkout", "-q", "-b", "side", base);
  fs.writeFileSync(path.join(dir, "side.txt"), "side\n");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: a side commit");
  git("checkout", "-q", "main");
  const mf = path.join(dir, ".mergemsg");
  fs.writeFileSync(mf, `Merge branch 'side'\n\nThe host at ${PH_192} was the reason.`);
  git("merge", "-q", "--no-ff", "-F", mf, "side");
  const r = spawnSync(process.execPath, [GATE, "--range", `HEAD --not ${base}`, ...NO_DENYLIST], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, CI: "", GITHUB_ACTIONS: "" },
  });
  const all = (r.stdout || "") + (r.stderr || "");
  fs.rmSync(dir, { recursive: true, force: true });
  record(
    "S5",
    "a MERGE commit message is scanned -> RED",
    r.status === 1 && all.includes("[rfc1918]"),
    `code=${r.status} — --no-merges would make this green and nothing else would notice`,
  );
}
{
  const r = scanMessages(["chore: bump the pinned toolchain to 10.300.1.2"], NO_DENYLIST);
  record(
    "N4",
    "a 4-part string with an out-of-range octet -> GREEN",
    green(r),
    `code=${r.code} — 10.300.1.2 is not an address; the octet test is what makes it not a finding`,
  );
}

// ---------------------------------------------------------------------------
// P1-P5 — the PM-record-id allowance (BACKLOG-3133, PM ruling)
//
// The rule tells authors to put the WHY in pm_comments and link the item. The
// link is a record id, so without this allowance the guard fires on compliance.
// The allowance is a CLOSED SET of table names and it is PER-LINE; P3 and P4
// are the two controls that say so, and both go green if the allowance is
// widened to a `pm_` prefix or to whole-message scope.
// ---------------------------------------------------------------------------

{
  const r = scanMessages(
    [`docs: record the decision\n\nPlan posted to pm_comments (${PH_UUID}).`],
    NO_DENYLIST,
  );
  record(
    "P1",
    "a UUID on a line naming pm_comments -> GREEN",
    green(r),
    `code=${r.code} — kills the allowance mutation: without it this is RED`,
  );
}
{
  const r = scanBlob(
    `## Notes\n\nPlan posted to pm_comments (${PH_UUID}).\n`,
    NO_DENYLIST,
  );
  record(
    "P2",
    "the same line in a PR BODY -> GREEN",
    green(r),
    `code=${r.code} — the body is the surface where 14 of 30 merged PRs were red`,
  );
}
{
  const r = scanMessages([`chore: retire the row ${PH_UUID}`], NO_DENYLIST);
  record(
    "P3",
    "the SAME UUID with no pm_ table on the line -> RED",
    red(r) && r.all.includes("[bare-uuid]"),
    `code=${r.code} — the allowance must not clear every UUID`,
  );
}
{
  const r = scanMessages([`chore: retire the pm_projects row ${PH_UUID}`], NO_DENYLIST);
  record(
    "P4",
    "pm_projects (outside the closed set) + UUID -> RED",
    red(r) && r.all.includes("[bare-uuid]"),
    `code=${r.code} — a pm_ PREFIX match would make this green`,
  );
}
{
  const r = scanMessages(
    [`docs: record the decision\n\nSee pm_comments.\n\nThe row is ${PH_UUID}.`],
    NO_DENYLIST,
  );
  record(
    "P5",
    "pm_comments on one line, the UUID on another -> RED",
    red(r) && r.all.includes("[bare-uuid]"),
    `code=${r.code} — per-LINE, like the pii-allow-uuid: waiver`,
  );
}

// ---------------------------------------------------------------------------
// X1-X4 — --new-to-head, the CI commit range
//
// The range is "reachable from the head, not reachable from any OTHER
// refs/remotes/origin/* ref". X1 and X2 are the discriminating pair: the same
// repo, the same planted commit, differing only in whether the head's own
// origin ref is held out of the exclusion set. Drop that hold-out and X1 turns
// green, which is a gate that scans nothing on every PR.
// ---------------------------------------------------------------------------

{
  const { dir } = mkRepoWithOriginRefs(
    `fix(nas): bind the stack to ${PH_CGNAT}`,
    { headRefName: "feat", otherRefName: "develop" },
  );
  const r = runInRepo(dir, ["--new-to-head", "HEAD", "--head-ref", "feat", ...NO_DENYLIST]);
  fs.rmSync(dir, { recursive: true, force: true });
  record(
    "X1",
    "planted commit, head's own origin ref held out -> RED",
    red(r) && r.all.includes("[cgnat]"),
    `code=${r.code} — origin/feat points at the head; excluding it would scan nothing`,
  );
}
{
  const { dir } = mkRepoWithOriginRefs(
    `fix(nas): bind the stack to ${PH_CGNAT}`,
    { headRefName: "feat", otherRefName: "develop" },
  );
  const r = runInRepo(dir, ["--new-to-head", "HEAD", "--head-ref", "other", ...NO_DENYLIST]);
  fs.rmSync(dir, { recursive: true, force: true });
  record(
    "X2",
    "the SAME commit already on another origin ref -> GREEN, and says so",
    green(r) && r.all.includes("0 commits are new to this head"),
    `code=${r.code} — an empty range must not read as a bare "0 scanned"`,
  );
}
{
  const { dir } = mkRepoWithOriginRefs(
    `fix(nas): bind the stack to ${PH_CGNAT}`,
    { headRefName: "feat", otherRefName: "develop" },
  );
  const r = runInRepo(dir, ["--new-to-head", "HEAD", "--head-ref", "feat", ...NO_DENYLIST]);
  fs.rmSync(dir, { recursive: true, force: true });
  record(
    "X3",
    "the ref list is counted in the output",
    /\d+ refs\/remotes\/origin\/\* ref\(s\) present; \d+ excluded/.test(r.all),
    `code=${r.code} — a fetch that populated nothing must be visible in the log`,
  );
}
{
  const { dir } = mkRepoWithOriginRefs(
    `fix(nas): bind the stack to ${PH_CGNAT}`,
    { headRefName: null, otherRefName: null },
  );
  const r = runInRepo(dir, ["--new-to-head", "HEAD", "--head-ref", "feat", ...NO_DENYLIST]);
  fs.rmSync(dir, { recursive: true, force: true });
  record(
    "X4",
    "no other origin refs at all -> EXIT 2 (fails closed)",
    usage(r) && r.all.includes("no other refs/remotes/origin/* refs"),
    `code=${r.code} — an unfetched ref list must not read as "everything is new" or as "nothing is new"`,
  );
}
{
  const r = runGate(["--new-to-head", "HEAD", "--range", "HEAD~1..HEAD", ...NO_DENYLIST]);
  record(
    "X5",
    "--new-to-head with --range -> EXIT 2",
    usage(r),
    `code=${r.code}`,
  );
}
{
  const r = runGate(["--head-ref", "feat", "--text-file", "/dev/null", ...NO_DENYLIST]);
  record(
    "X6",
    "--head-ref without --new-to-head -> EXIT 2",
    usage(r),
    `code=${r.code} — a flag that silently does nothing is a flag someone trusts`,
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
let failed = 0;
console.log("check-message-hygiene.mjs — guard verification\n");
for (const r of results) {
  if (!r.ok) failed++;
  const label = r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL";
  const showDetail = !r.ok || r.skipped;
  console.log(
    `  ${label}  ${r.id.padEnd(5)} ${r.name}${showDetail ? `\n          -> ${r.detail}` : ""}`,
  );
}
console.log(`\n${results.length - failed}/${results.length} controls passed.`);
if (failed) {
  console.error(`\n${failed} control(s) FAILED. The guard does not behave as specified.`);
  process.exit(1);
}
process.exit(0);
