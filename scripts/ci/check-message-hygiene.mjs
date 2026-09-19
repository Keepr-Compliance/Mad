#!/usr/bin/env node
/**
 * check-message-hygiene — scan COMMIT MESSAGES, PR TITLES and PR BODIES for
 * detail that must not be published to a public repository. (BACKLOG-3133)
 *
 * ## Why this exists, and why the file scanner was not enough
 *
 * `check-fixture-pii.mjs` scans TRACKED FILES. Two incidents in two days were
 * both agents writing accurate, correct, useful security detail into surfaces
 * that scanner cannot see:
 *
 *   2026-09-03 (BACKLOG-3087) — a customer name and a live tenant id in a
 *   fixture comment. Caught, but only after the object existed on GitHub.
 *
 *   2026-09-06 (BACKLOG-3114, PR #2524) — a commit message and then a PR
 *   description carrying a privileged role name, a no-credential endpoint and
 *   its exact response, a home-network inventory, and a statement that the
 *   mitigation was NOT YET APPLIED. Nothing scanned either surface.
 *
 * The instruction to keep that detail in `pm_comments` already existed, in
 * CLAUDE.md and in the engineer brief. It is prose, and the surface is the one
 * the agent is already typing into. This file is the mechanical form of it.
 *
 * ## The rule this enforces
 *
 * A public repo gets WHAT changed. Every WHY that touches security, customers,
 * addresses, credentials, endpoints or network layout goes to `pm_comments`
 * with a link. Correcting a wrong public sentence about a live surface means
 * DELETING it, not replacing it with the accurate one — an inaccurate public
 * description of a vulnerability is safer than a precise one.
 *
 * ## THIS SCANNER NEVER PRINTS WHAT IT MATCHED
 *
 * Findings report a rule id, a location, and a MASKED match (first and last
 * character kept, middle replaced). Denylist hits print the rule and the
 * location and nothing else — not even masked, because a masked customer name
 * with its length intact is still an identifier.
 *
 * This is not fastidiousness. GitHub Actions logs on a PUBLIC repository are
 * world-readable, and they outlive the branch. A guard that echoes the string
 * it caught into a CI log has not prevented the publication; it has made a
 * second copy of it, in a place nobody thinks to scrub. `--reveal` exists for
 * the local hook only and is refused whenever `CI` is set.
 *
 * ## Modes
 *
 *   --range "<rev-list args>"     scan every commit MESSAGE in the range.
 *                                 Same shape `check-fixture-pii.mjs` takes:
 *                                 "<tip> --not --remotes=origin".
 *   --text-file <path>            scan one text blob (a PR title, a PR body).
 *   --label "<name>"              what to call that blob in output.
 *   --reveal                      print unmasked matches. LOCAL ONLY; refused
 *                                 when CI=true. Never applies to `denylist`.
 *   --denylist <path>             override the denylist location (controls).
 *
 * Exit codes — the same contract as the fixture scanner, for the same reason:
 *   0  clean
 *   1  findings
 *   2  cannot resolve the input (bad range, unreadable file, usage error)
 *
 * Exit 2 is NOT exit 0. The pre-push hook is a PRE-publication gate, so
 * "could not check" must block. CI is post-publication and is allowed to
 * degrade loudly instead — but for a PR title/body there is always an input,
 * so in practice CI only sees 0 or 1.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * RFC1918 private space and RFC6598 CGNAT space.
 *
 * Built from four octets with an explicit first-octet test rather than a fuzzy
 * `\d+\.\d+\.\d+\.\d+`, so a version string cannot match: a semver has three
 * components, and a four-component version whose FIRST component is exactly
 * 10, 100, 172 or 192 and whose second is in the private sub-range does not
 * occur in this repo (measured: 0 hits across the last 2000 commit messages).
 *
 * 100.64.0.0/10 is the CGNAT range. It is here because a tailnet address lives
 * in it, and a tailnet address in a public message is a target profile even
 * though it is not routable from the internet — the same reasoning the SR
 * applied to an RFC1918 literal on PR #2521.
 */
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

function classifyIpv4(a, b, c, d) {
  const o = [a, b, c, d].map(Number);
  if (o.some((n) => Number.isNaN(n) || n > 255)) return null;
  if (o[0] === 10) return "rfc1918";
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return "rfc1918";
  if (o[0] === 192 && o[1] === 168) return "rfc1918";
  // 100.64.0.0/10 -> second octet 64..127
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return "cgnat";
  return null;
}

/**
 * A Tailscale MagicDNS name. Naming the tailnet is naming the network, and the
 * tailnet name is stable and guessable-adjacent in a way an ephemeral address
 * is not.
 */
const TAILNET_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/gi;

/**
 * Privileged role and credential literals. `postgres:postgres` is the
 * user:password shape, not the role name on its own.
 */
const PRIVILEGED_ROLE_RE = /\b(?:supabase_admin|service_role|postgres:postgres)\b/g;

/**
 * The Supabase Studio admin API prefix. A path is not a secret, but "here is
 * the admin surface" plus anything else in the same paragraph is a technique.
 */
const PLATFORM_ENDPOINT_RE = /\/api\/platform\//g;

/**
 * Two phrases. Both appeared in incident 2 and both are, on their own, the
 * sentence that turns a description into an invitation.
 *
 * `unauthenticated` is ordinary auth vocabulary — measured 6 times in the last
 * 2000 commit messages, in subjects like "bypass RLS for unauthenticated
 * invite token validation". It is waivable for exactly that reason. It is not
 * DROPPED, because "the endpoint is unauthenticated" is the single most
 * load-bearing sentence in the incident this file exists to prevent, and a
 * waiver makes an author state which of the two they meant.
 */
const SECURITY_PHRASE_RE = /\b(?:default\s+password|unauthenticated)\b/gi;

/**
 * BACKLOG-2871's rule and its exemption, reused verbatim rather than reinvented
 * so there is ONE definition of "a bare UUID" in this repo.
 */
const UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/** A real record id can never be nil. The only exemption, and it is structural. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * `pii-allow-uuid: <reason>` — BACKLOG-2871's waiver form, unchanged. A bare
 * UUID in a commit message is the same finding as a bare UUID in a fixture, so
 * it takes the same waiver rather than a second syntax for one rule.
 */
const UUID_WAIVER_RE = /pii-allow-uuid:([^\r\n]*)/;

/**
 * A UUID on a line that names one of the PM tables needs no waiver.
 *
 * The rule this file enforces tells authors to put the WHY in `pm_comments` and
 * link the item. That link IS a record id, so the rule as first written made 14
 * of the last 30 merged PR bodies red for obeying it. A guard that fires on
 * compliance is a guard that gets bypassed.
 *
 * A CLOSED SET of six table names, not a `pm_\w+` prefix. A prefix would let any
 * future `pm_`-named thing silence the rule by accident, and the point of an
 * exemption is that somebody chose it. `pm_projects` is deliberately absent.
 *
 * PER-LINE, exactly like the `pii-allow-uuid:` waiver above: the table name and
 * the id must be on the SAME line, so a `pm_comments` mention in a heading does
 * not clear every UUID in the body under it.
 *
 * Every OTHER bare UUID still needs `pii-allow-uuid: <why>` — a session id, an
 * agent id and a customer row id are all still findings. PM ruling on
 * BACKLOG-3133, reversible by the founder.
 */
const PM_TABLE_RE =
  /\bpm_(?:comments|backlog_items|tasks|sprints|events|token_metrics)\b/;

/**
 * `hygiene-allow: <rule-id>: <reason>` — PER-RULE, and the reason is REQUIRED.
 *
 * Per-rule on purpose. A blanket "this message is fine" trailer is exactly what
 * the engineer in incident 2 would have written: they believed the text was
 * legitimate, and they were wrong about the surface, not about the content. A
 * waiver naming ONE rule makes the author say which specific thing they are
 * asserting is safe, and leaves every other rule live in the same message.
 *
 * The pattern captures everything after the second colon rather than demanding
 * a non-space character itself, so "a reason is required" is enforced in ONE
 * place (the emptiness test in `waivedRules`) and a control can therefore kill
 * it. Written the other way round the two halves are redundant and a mutation
 * of either leaves the suite green — the trap BACKLOG-2871 recorded.
 */
const HYGIENE_WAIVER_RE = /hygiene-allow:\s*([a-z0-9-]+)\s*:([^\r\n]*)/gi;

/**
 * Which rules a `hygiene-allow:` trailer can silence.
 *
 * NOT WAIVABLE, and this is the load-bearing half of the design:
 *   denylist      — a customer or org name. There is no legitimate reason to
 *                   put one in a public commit message. If you need to name the
 *                   customer, that sentence belongs in pm_comments.
 *   rfc1918 /
 *   cgnat /
 *   tailnet-name  — an address or a network name. Same reasoning, and the SR
 *                   already blocked PR #2521 over a single unroutable literal.
 *                   Making it waivable would retract that ruling.
 *
 * WAIVABLE, and only because the measurement says they must be: `service_role`
 * appears in 22 of the last 2000 commit messages and `unauthenticated` in 6,
 * in ordinary RLS and auth work. A rule that fires on ~1.4% of commits with no
 * escape hatch trains `--no-verify`, and `.husky/pre-push` says in its own
 * header that a hook which is always bypassed is not a hook.
 */
const WAIVABLE = new Set(["privileged-role", "security-phrase", "platform-endpoint"]);

/**
 * Rules whose match is NEVER printed — not revealed, not even masked.
 *
 * A masked customer name with its length intact is still an identifier, so
 * `denylist` gets no output beyond the rule id and the location.
 *
 * THIS IS THE ONLY MECHANISM. The finding still carries its match in memory,
 * deliberately: an earlier draft ALSO set `match: null` for denylist findings,
 * and the two guards were redundant — deleting this set left the term still
 * suppressed by the null, so the mutation survived and the control proved
 * nothing. One enforcement point, killable by one mutation (BACKLOG-2871's
 * lesson, and the same redundancy trap its own UUID waiver documents).
 */
const NEVER_PRINT = new Set(["denylist"]);

const RULE_HELP = {
  rfc1918:
    "a private (RFC1918) address. Describe the host by role, not by address.",
  cgnat:
    "a CGNAT / tailnet-range address. Describe the host by role, not by address.",
  "tailnet-name": "a tailnet MagicDNS name. Name the role, not the network.",
  "privileged-role":
    "a privileged role or credential literal. Say what changed, not which role is privileged.",
  "platform-endpoint":
    "an admin API path. An endpoint plus any context is a technique, not a description.",
  "security-phrase":
    "a phrase describing an authentication weakness. If it describes a LIVE surface, it belongs in pm_comments.",
  "bare-uuid":
    "a bare UUID. A PM record id on a line naming pm_comments / pm_backlog_items / pm_tasks / pm_sprints / pm_events / pm_token_metrics needs no waiver. Any other id: replace it, or waive it with pii-allow-uuid: <why>.",
  denylist:
    "a term from your local denylist (~/.keepr/pii-denylist.txt). Not waivable, and not printed here.",
};

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

const DEFAULT_DENYLIST = join(homedir(), ".keepr", "pii-denylist.txt");

/**
 * Load the out-of-repo denylist.
 *
 * MUST NOT FAIL CLOSED ON A MISSING FILE. The file is optional by design: it
 * holds customer and org names, so it can never be committed, which means most
 * machines in the fleet will not have one. Blocking every push on a machine
 * that never had the file would take the whole fleet down and teach everyone
 * to set the skip variable — which disables the seven rules that DO work.
 *
 * An UNREADABLE file (present but permission-denied, or a directory) is a
 * different case and is reported, because there the operator believes they have
 * protection and does not.
 */
function loadDenylist(path) {
  if (!existsSync(path)) return { terms: [], present: false, error: null };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { terms: [], present: true, error: err.message };
  }
  const terms = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  return { terms, present: true, error: null };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/**
 * Keep the first and last character, replace the middle with a fixed-width
 * ellipsis rather than one dot per character — a length-preserving mask leaks
 * the length, and for a short identifier the length plus the first letter is
 * most of the identifier.
 */
export function mask(value) {
  const s = String(value);
  if (s.length <= 2) return "**";
  return `${s[0]}***${s[s.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Waivers
// ---------------------------------------------------------------------------

/**
 * Which rules this message waives. A trailer with an EMPTY reason waives
 * nothing — the single place that requirement is enforced.
 */
export function waivedRules(text) {
  const out = new Set();
  const re = new RegExp(HYGIENE_WAIVER_RE.source, HYGIENE_WAIVER_RE.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    const rule = m[1].toLowerCase();
    const reason = m[2].trim();
    if (reason.length === 0) continue;
    if (!WAIVABLE.has(rule)) continue;
    out.add(rule);
  }
  return out;
}

function uuidWaived(text) {
  const m = UUID_WAIVER_RE.exec(text ?? "");
  if (m === null) return false;
  return m[1].trim().length > 0;
}

/** Does this ONE line name a PM table? The only place the allowance is applied. */
function namesPmTable(line) {
  return PM_TABLE_RE.test(line ?? "");
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * Scan one blob of text. Returns findings; never throws on content.
 *
 * `where` is a human label (a short SHA, "PR title", "PR body"). Line numbers
 * are 1-based within the blob.
 */
export function scanText(text, where, denylistTerms) {
  const findings = [];
  if (typeof text !== "string" || text.length === 0) return findings;

  const waived = waivedRules(text);
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // The waiver line is scanned like every other line, on purpose. The
    // per-rule waiver below already suppresses the rule being waived, which is
    // all that ever needed suppressing — and a REASON string is public text
    // too. "hygiene-allow: privileged-role: the box at <a private address> is
    // a lab host" must still be blocked for the address it names. An earlier
    // draft skipped the whole line and would have published exactly that.

    const push = (rule, match) => {
      if (waived.has(rule)) return;
      findings.push({ rule, where, line: lineNo, match });
    };

    let m;

    const ipRe = new RegExp(IPV4_RE.source, IPV4_RE.flags);
    while ((m = ipRe.exec(line)) !== null) {
      const kind = classifyIpv4(m[1], m[2], m[3], m[4]);
      if (kind !== null) push(kind, m[0]);
    }

    const tnRe = new RegExp(TAILNET_RE.source, TAILNET_RE.flags);
    while ((m = tnRe.exec(line)) !== null) push("tailnet-name", m[0]);

    const prRe = new RegExp(PRIVILEGED_ROLE_RE.source, PRIVILEGED_ROLE_RE.flags);
    while ((m = prRe.exec(line)) !== null) push("privileged-role", m[0]);

    const peRe = new RegExp(PLATFORM_ENDPOINT_RE.source, PLATFORM_ENDPOINT_RE.flags);
    while ((m = peRe.exec(line)) !== null) push("platform-endpoint", m[0]);

    const spRe = new RegExp(SECURITY_PHRASE_RE.source, SECURITY_PHRASE_RE.flags);
    while ((m = spRe.exec(line)) !== null) push("security-phrase", m[0]);

    // bare-uuid keeps BACKLOG-2871's waiver, which is per-LINE, not per-message,
    // and adds the per-LINE PM-table allowance. Two separate conditions, each
    // killable on its own: delete the first and the waiver controls go red,
    // delete the second and the PM-record controls go red. One mechanism each.
    if (!uuidWaived(line) && !namesPmTable(line)) {
      const uRe = new RegExp(UUID_RE.source, UUID_RE.flags);
      while ((m = uRe.exec(line)) !== null) {
        if (m[0].toLowerCase() === NIL_UUID) continue;
        findings.push({ rule: "bare-uuid", where, line: lineNo, match: m[0] });
      }
    }

    for (const term of denylistTerms) {
      const dRe = new RegExp(escapeRe(term), "gi");
      if (dRe.test(line)) {
        // Not waivable by design. The match travels in memory so that
        // NEVER_PRINT is the single thing standing between it and the log —
        // see that set's comment for why it is not ALSO nulled here.
        findings.push({ rule: "denylist", where, line: lineNo, match: term });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * Every commit message in the range, as { sha, message }.
 *
 * Records are NUL-separated and fields are separated by a unit separator, so a
 * message containing any line of text — including something that looks like a
 * delimiter — cannot split a record. A newline-delimited format here would let
 * a crafted commit message hide the next commit from the scan.
 */
const LOG_ARGS = [
    // Merge commits INCLUDED. A sync-merge message is generated and harmless,
    // but a hand-written one is author prose like any other, and excluding
    // them opened a hole for the sake of nothing: measured across the last
    // 2000 messages on this branch (merges included), the address, tailnet and
    // endpoint rules hit ZERO times, so admitting merges costs no false
    // positives. `check-fixture-pii.mjs` documents a merge gap it cannot close
    // because `git log -p` emits no patch for a merge; a MESSAGE has no such
    // problem.
  "-z",
  "--pretty=format:%H%x1f%B",
];

/** One git-log invocation and one failure path, shared by both range modes. */
function runGitLog(args, input) {
  const opts = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  if (input !== undefined) opts.input = input;
  try {
    return execFileSync("git", ["log", ...args], opts);
  } catch (err) {
    const msg = err && err.stderr ? String(err.stderr).trim() : String(err);
    console.error(`check-message-hygiene: git log failed for the given range.`);
    console.error(`  ${msg}`);
    process.exit(2);
  }
}

function parseCommitRecords(out) {
  const records = out.split("\0").filter((r) => r.length > 0);
  return records.map((r) => {
    const sep = r.indexOf("\x1f");
    if (sep === -1) return { sha: "(unknown)", message: r };
    return { sha: r.slice(0, sep), message: r.slice(sep + 1) };
  });
}

function commitMessages(rangeArgs) {
  return parseCommitRecords(runGitLog([...LOG_ARGS, ...rangeArgs]));
}

/**
 * Commits reachable from `headRev` and NOT reachable from any OTHER
 * `refs/remotes/origin/*` ref — the CI mirror of the pre-push hook's
 * `--not --remotes=origin`.
 *
 * WHY THE RANGE IS THIS AND NOT `head --not base`. `base.sha` on a
 * `pull_request` event tracks the current tip of the TARGET branch, so for a
 * feature PR the range is that PR's own commits — correct. But for an aggregate
 * PR (`int/* -> develop`, `chore/release-* -> main`) it is every commit being
 * merged, all of it merged history that nobody can amend. Measured on this repo:
 * that shape made both classes permanently red with no author remedy, which is
 * how a gate teaches bypass.
 *
 * A commit already reachable from another origin ref is already published. This
 * gate is a PRE-publication gate; re-reporting a published commit gives the
 * author nothing they can act on.
 *
 * The head's OWN origin ref is excluded from the exclusion set. After a push
 * `refs/remotes/origin/<head-ref>` equals the PR head, so leaving it in would
 * whitewash every PR to an empty range. A fork PR has no such ref, and then the
 * full origin set applies — which is the correct answer for a fork.
 *
 * DEPENDS ON: branches are never deleted in this repo (CLAUDE.md). Deleting a
 * merged branch can put its commits back in range on a later aggregate PR.
 *
 * Refs go in on STDIN, not argv: this repo has ~490 origin refs, ~28 KB of ref
 * names.
 */
function commitMessagesNewToHead(headRev, excludeRefs) {
  const input = [headRev, ...excludeRefs.map((r) => `^${r}`)].join("\n") + "\n";
  return parseCommitRecords(runGitLog([...LOG_ARGS, "--stdin"], input));
}

/**
 * Every `refs/remotes/origin/*` ref except `origin/HEAD` (a symref to another
 * ref already in the list) and the PR's own head ref.
 */
function otherOriginRefs(headRef) {
  let out;
  try {
    out = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err) {
    const msg = err && err.stderr ? String(err.stderr).trim() : String(err);
    console.error("check-message-hygiene: could not list refs/remotes/origin/*.");
    console.error(`  ${msg}`);
    process.exit(2);
  }
  const all = out
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const skip = new Set(["refs/remotes/origin/HEAD"]);
  if (headRef) skip.add(`refs/remotes/origin/${headRef}`);
  return { total: all.length, others: all.filter((r) => !skip.has(r)) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(msg) {
  if (msg) console.error(`check-message-hygiene: ${msg}`);
  console.error("");
  console.error("Usage:");
  console.error('  check-message-hygiene.mjs --range "<rev-list args>"');
  console.error("  check-message-hygiene.mjs --new-to-head <rev> [--head-ref <name>]");
  console.error("  check-message-hygiene.mjs --text-file <path> [--label <name>]");
  console.error("");
  console.error("Options:");
  console.error("  --denylist <path>   override ~/.keepr/pii-denylist.txt");
  console.error("  --reveal            print unmasked matches (refused under CI)");
  console.error("");
  console.error("--new-to-head scans commits reachable from <rev> and NOT from any");
  console.error("other refs/remotes/origin/* ref. --head-ref names the PR's own");
  console.error("branch so its origin ref does not exclude the whole range.");
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  let range = null;
  let newToHead = null;
  let headRef = null;
  let textFile = null;
  let label = null;
  let denylistPath = DEFAULT_DENYLIST;
  let reveal = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--range") {
      const spec = argv[++i];
      if (spec === undefined || spec.trim().length === 0) {
        usage("--range needs a git commit range, e.g. \"HEAD --not --remotes=origin\"");
      }
      range = spec.trim().split(/\s+/);
    } else if (arg.startsWith("--range=")) {
      const spec = arg.slice("--range=".length).trim();
      if (spec.length === 0) usage("--range was empty.");
      range = spec.split(/\s+/);
    } else if (arg === "--new-to-head") {
      newToHead = argv[++i];
      if (newToHead === undefined || newToHead.trim().length === 0) {
        usage("--new-to-head needs a revision.");
      }
      newToHead = newToHead.trim();
    } else if (arg === "--head-ref") {
      headRef = argv[++i];
      if (headRef === undefined) usage("--head-ref needs a branch name.");
      headRef = headRef.trim().replace(/^refs\/heads\//, "");
    } else if (arg === "--text-file") {
      textFile = argv[++i];
      if (textFile === undefined) usage("--text-file needs a path.");
    } else if (arg === "--label") {
      label = argv[++i];
      if (label === undefined) usage("--label needs a name.");
    } else if (arg === "--denylist") {
      denylistPath = argv[++i];
      if (denylistPath === undefined) usage("--denylist needs a path.");
    } else if (arg === "--reveal") {
      reveal = true;
    } else {
      usage(`unknown argument '${arg}'.`);
    }
  }

  const modes = [range, newToHead, textFile].filter((m) => m !== null);
  if (modes.length === 0) usage("nothing to scan.");
  if (modes.length > 1) {
    usage("--range, --new-to-head and --text-file are mutually exclusive; run it twice.");
  }
  if (headRef !== null && newToHead === null) {
    usage("--head-ref only means anything with --new-to-head.");
  }

  // `--reveal` is for a human at a terminal who already wrote the text. In CI
  // the log is world-readable on a public repo, so revealing there would
  // republish exactly what was blocked.
  if (reveal && (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true")) {
    console.error("check-message-hygiene: --reveal is refused under CI.");
    console.error("  CI logs on a public repository are world-readable; printing");
    console.error("  the matched text there republishes what this guard blocked.");
    process.exit(2);
  }

  const denylist = loadDenylist(denylistPath);
  if (denylist.error !== null) {
    console.error(
      `check-message-hygiene: denylist at ${denylistPath} exists but could not be read.`,
    );
    console.error(`  ${denylist.error}`);
    console.error("  Refusing to run with a denylist you believe is active and is not.");
    process.exit(2);
  }

  let findings = [];
  let scanned = 0;
  let emptyRangeNote = null;

  if (range !== null || newToHead !== null) {
    let commits;
    if (newToHead !== null) {
      const refs = otherOriginRefs(headRef);
      console.log(
        `check-message-hygiene: ${refs.total} refs/remotes/origin/* ref(s) present; ` +
          `${refs.others.length} excluded from the range` +
          (headRef ? ` (the head's own ref, origin/${headRef}, is not one of them).` : "."),
      );
      // An empty exclusion set means the fetch did not populate the remote refs,
      // NOT that every commit is new. Widening the range silently would re-red
      // every aggregate PR on merged history; reporting green would scan the
      // whole history against nothing. Neither is honest, so refuse.
      if (refs.others.length === 0) {
        console.error(
          "check-message-hygiene: no other refs/remotes/origin/* refs are present.",
        );
        console.error(
          "  The range cannot be narrowed against a ref list that was never fetched.",
        );
        console.error(
          "  Run: git fetch origin '+refs/heads/*:refs/remotes/origin/*'",
        );
        process.exit(2);
      }
      commits = commitMessagesNewToHead(newToHead, refs.others);
      if (commits.length === 0) {
        emptyRangeNote =
          "0 commits are new to this head; every commit is already on another origin ref.";
      }
    } else {
      commits = commitMessages(range);
    }
    scanned = commits.length;
    for (const c of commits) {
      findings = findings.concat(
        scanText(c.message, `commit ${c.sha.slice(0, 9)}`, denylist.terms),
      );
    }
  } else {
    if (!existsSync(textFile)) {
      console.error(`check-message-hygiene: --text-file '${textFile}' does not exist.`);
      process.exit(2);
    }
    let text;
    try {
      text = readFileSync(textFile, "utf8");
    } catch (err) {
      console.error(`check-message-hygiene: could not read '${textFile}': ${err.message}`);
      process.exit(2);
    }
    scanned = 1;
    findings = scanText(text, label || textFile, denylist.terms);
  }

  const denyNote = denylist.present
    ? `${denylist.terms.length} denylist term(s) loaded`
    : "no denylist file (optional — this is not an error)";

  if (findings.length === 0) {
    if (emptyRangeNote !== null) {
      // Not a bare "OK - 0 scanned". A reader must be able to tell "nothing to
      // check" from "checked nothing" without opening the workflow file.
      console.log(`check-message-hygiene: ${emptyRangeNote}`);
      console.log(`check-message-hygiene: nothing to scan, ${denyNote}.`);
      process.exit(0);
    }
    console.log(
      `check-message-hygiene: OK — ${scanned} message(s)/blob(s) scanned, ${denyNote}.`,
    );
    process.exit(0);
  }

  console.error("");
  console.error("check-message-hygiene: FINDINGS");
  console.error("");
  console.error("  This repository is PUBLIC. A commit message, a PR title and a PR");
  console.error("  body are all world-readable, and a pushed object cannot be");
  console.error("  unpublished — GitHub still serves an orphaned commit by SHA after a");
  console.error("  force-push, and it keeps every prior revision of a PR description.");
  console.error("");

  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }

  for (const [rule, list] of [...byRule.entries()].sort()) {
    console.error(`  [${rule}] ${list.length} occurrence(s) — ${RULE_HELP[rule] ?? ""}`);
    for (const f of list) {
      if (NEVER_PRINT.has(rule)) {
        // Rule id and location only. No match, masked or otherwise, and no
        // second condition here: a `|| f.match === null` fallback made this
        // branch unreachable-by-mutation, so deleting NEVER_PRINT changed
        // nothing and the control could not tell the two apart.
        console.error(`      ${f.where}, line ${f.line}`);
      } else if (reveal) {
        console.error(`      ${f.where}, line ${f.line}: ${f.match}`);
      } else {
        console.error(`      ${f.where}, line ${f.line}: ${mask(f.match)}`);
      }
    }
    console.error("");
  }

  console.error("  What to do:");
  console.error("    State WHAT changed. Put every WHY that touches security,");
  console.error("    customers, addresses, credentials, endpoints or network layout");
  console.error("    into pm_comments and link the backlog item.");
  console.error("");
  console.error("    Correcting a wrong public sentence about a live surface means");
  console.error("    DELETING it, not replacing it with the accurate one.");
  console.error("");
  console.error("    A commit message cannot be fixed forward — AMEND or REBASE.");
  console.error("    A follow-up commit publishes the offending one anyway.");
  console.error("");
  console.error("    If a finding is genuinely about code and not a live surface:");
  console.error("      hygiene-allow: <rule>: <why this one is safe>");
  console.error(`    Waivable: ${[...WAIVABLE].sort().join(", ")}.`);
  console.error("    A PM record id needs no waiver when the line names its table");
  console.error("    (pm_comments, pm_backlog_items, pm_tasks, pm_sprints,");
  console.error("     pm_events, pm_token_metrics).");
  console.error("");
  console.error("    NOT waivable: bare-uuid (use pii-allow-uuid: <why>), cgnat,");
  console.error("    denylist, rfc1918, tailnet-name.");
  console.error("");
  process.exit(1);
}

// Only run the CLI when executed directly, so the verify harness can import the
// pure functions without the process exiting underneath it.
const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("check-message-hygiene.mjs");
if (invokedDirectly) main();

export {
  scanText as _scanText,
  classifyIpv4 as _classifyIpv4,
  loadDenylist as _loadDenylist,
  WAIVABLE as _WAIVABLE,
  NEVER_PRINT as _NEVER_PRINT,
};
