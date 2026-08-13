#!/usr/bin/env node
/**
 * Fixture PII guard (BACKLOG-2485).
 *
 * This repository is PUBLIC. Test fixtures, comments and seed data must never
 * contain a real person's contact details: once committed they are permanently
 * republished to every clone, fork and mirror.
 *
 * The guard scans source and test paths for two shapes of personal-looking data:
 *
 *   1. Email addresses on real consumer mailbox domains (gmail.com, icloud.com,
 *      yahoo.com, hotmail.com, outlook.com, me.com, aol.com). Fixtures should use
 *      the RFC 2606 reserved domains instead: example.com / example.org /
 *      example.net / example.test / *.invalid / *.localhost.
 *
 *   2. US-format telephone numbers outside the range reserved for fiction,
 *      555-0100 .. 555-0199 (NANP / ATIS-0300115). Fixtures should use
 *      +1 <area> 555-01xx.
 *
 * Existing occurrences that predate the guard are recorded in the baseline file
 * (see BASELINE_PATH). The guard fails ONLY on findings that are not in the
 * baseline, so it cannot go red on day one and get switched off on day two.
 *
 * Usage:
 *   node scripts/ci/check-fixture-pii.mjs            # scan, fail on new findings
 *   node scripts/ci/check-fixture-pii.mjs --list     # print every finding, never fail
 *   node scripts/ci/check-fixture-pii.mjs --update-baseline
 *
 * Adding to the baseline is a deliberate act and should be reviewed: it means
 * "a human has confirmed this value is invented".
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE_PATH = join(
  REPO_ROOT,
  "scripts",
  "ci",
  "fixture-pii-baseline.json",
);

// --------------------------------------------------------------------------
// Scope
// --------------------------------------------------------------------------

/** Directories scanned, relative to the repo root. Source + test surfaces only. */
const SCAN_ROOTS = [
  "src",
  "electron",
  "tests",
  "e2e",
  "scripts",
  "packages",
  "broker-portal",
  "admin-portal",
  "android-companion",
  "supabase",
];

/** Directory names skipped anywhere in the tree. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "build",
  "out",
  "coverage",
  ".next",
  ".git",
  ".turbo",
  ".expo",
  "__snapshots__",
  "release",
]);

/** File extensions scanned. */
const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".sql",
  ".md",
  ".yml",
  ".yaml",
  ".html",
  ".txt",
  ".xml",
  ".csv",
]);

/** Exact file basenames skipped (generated / vendored). */
const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "fixture-pii-baseline.json",
]);

// --------------------------------------------------------------------------
// Rules
// --------------------------------------------------------------------------

const CONSUMER_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "me.com",
  "mac.com",
  "aol.com",
];

/**
 * name@<consumer domain>. The `@` is required immediately before the domain, so
 * "readme.com" or "https://outlook.com/…" cannot match; the trailing lookahead
 * stops "@gmail.community" from being reported as "@gmail.com".
 */
const CONSUMER_EMAIL_RE = new RegExp(
  `[A-Za-z0-9._%+-]+@(?:${CONSUMER_DOMAINS.map((d) => d.replace(".", "\\.")).join("|")})(?![A-Za-z0-9.-])`,
  "gi",
);

/**
 * US-format phone numbers. Deliberately requires punctuation, parentheses or a
 * +1 country code: a bare run of ten digits is far more often an id, a unix
 * timestamp or a hash prefix than a telephone number, and matching those would
 * bury the real signal.
 *
 *   +1 (206) 555-0142 / +12065550142 / (206) 555-0142 / 206-555-0142 / 206.555.0142
 */
const PHONE_RES = [
  // country code present
  /\+1[-. ]?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}(?!\d)/g,
  // parenthesised area code
  /\(\d{3}\)[-. ]?\d{3}[-. ]?\d{4}(?!\d)/g,
  // separated, no country code
  /(?<![\d.-])\d{3}[-.]\d{3}[-.]\d{4}(?![\d-])/g,
];

/**
 * 555-0100..555-0199 is reserved for fictional use (NANP / ATIS-0300115).
 * Digits arrive as AAA555 01XX after the country code is stripped.
 */
const RESERVED_PHONE_RE = /^\d{3}55501\d{2}$/;

/**
 * Domains that are allowed to appear in fixtures: the RFC 2606 reserved set plus
 * our own company domain, whose addresses belong to us and are not third-party
 * personal data.
 *
 * These are allowed by construction — none of them is in CONSUMER_DOMAINS, so
 * the detector never sees them. The assertion below keeps that true: if someone
 * later adds an allowed domain to the consumer list the guard fails loudly at
 * start-up instead of silently flagging every internal address.
 */
const ALLOWED_DOMAINS = [
  "example.com",
  "example.org",
  "example.net",
  "example.test",
  "test",
  "invalid",
  "localhost",
  "keeprcompliance.com",
];

/**
 * ## Personal names (BACKLOG-2542)
 *
 * The email and phone rules above ran for the first time over
 * `int/contacts-followups` and found 210 values. Scrubbing exactly those would
 * have left this behind, in the same object literal:
 *
 *     shadowRow("out-juan", "<a real person's full name>", "outlook",
 *               ["<their gmail address>"], ["<their mobile>"])
 *
 * The address and the number were caught. **The name was not, because nothing
 * looked for names** — so the guard would have reported OK over a row that still
 * identified someone, now beside a fictional address, which reads as safe and is
 * not. A name alone is personal data.
 *
 * ## Why this rule needs a second signal
 *
 * "Two capitalised words" matches an enormous amount of legitimate text — prose
 * in comments, component names, test descriptions. Flagging that would produce a
 * guard everyone learns to baseline past, which is worse than no guard.
 *
 * So a name is only reported when it appears **on a line that also carries an
 * email address or a phone number** — the identity-triple shape that actually
 * leaked. A name on its own line is not reported; that is a deliberate gap, and
 * the reason `FICTIONAL_NAMES` below exists rather than a cleverer regex.
 */
const QUOTED_NAME_RE =
  /["'`]([A-Z][a-z]{1,15}(?:['-][A-Z][a-z]{1,15})?[ ][A-Z][a-z]{1,15}(?:['-][A-Z]?[a-z]{1,15})?)["'`]/g;

/** An email address or something phone-shaped on the same line. */
const IDENTITY_CONTEXT_RE = /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+?\d[\d ().-]{8,}\d/;

/**
 * Names known to be invented. Keep this list SHORT and obviously fictional —
 * it is not a place to park a real name someone decided was fine. Anything not
 * listed here is reported and must be replaced or recorded in the baseline with
 * a human's confirmation.
 */
const FICTIONAL_NAMES = new Set([
  "pat riverton",
  "robin marsh",
  "jane seller",
  "jane doe",
  "john doe",
  "john smith",
  "test user",
  "test contact",
  // BACKLOG-2556 — the no-consolidation suite. These are PAIRS BY DESIGN: the
  // rule under test is "a shared identifier is not evidence of one person", so
  // every case needs two people whose names a compatibility check would accept
  // (a shared surname) or reject. Invented for that suite; none refers to
  // anyone. Listed here rather than baselined because they are fictional, and
  // the baseline is for values a human confirmed are safe, not for invented
  // ones.
  "chris alvarez",
  "dana alvarez",
  "robin hale",
  "sam hale",
  "lee park",
  "mo park",
  // Already this repo's established scrub name for the founder's own case —
  // see `contact-handlers.importLinking.test.ts`, where the surrounding
  // `mac-paul` / `out-paul` variables still carry the pre-scrub spelling.
  "casey lane",
  // BACKLOG-2514 — the message-derived person in the projection-parity fixture.
  // Invented. It must be a PLAIN NAME (not an email, not a number) because that
  // is exactly what `getMessageDerivedContacts` filters `participants.$.from`
  // down to — a fixture that did not look like a name would not reach the
  // producer at all, and the control it feeds could not fail.
  "sam rivers",
  // BACKLOG-2365's documented case, and this repo's established name for it —
  // `contactTombstone.test.ts` has used it since that item shipped. Invented,
  // and self-evidently so: the surname is literally "Example". Listed rather
  // than renamed because BACKLOG-2608's picker suite asserts the SAME case
  // through the handler, and the two suites naming the same person is how a
  // reader connects them. It fires there and not in `contactTombstone` only
  // because that fixture puts the name and the address on separate lines.
  "dana example",
  // BACKLOG-2700 — the migration-chain rehearsal corpus
  // (electron/services/__tests__/fixtures/rehearsalCorpus.ts). Invented to seed
  // the database that gets upgraded v55 -> v62; none refers to anyone. The two
  // "External" names are deliberately literal: they label rows in
  // `external_contacts`, the address-book side of the crosswalk, so a reader can
  // tell at a glance which side of the join a row is on. Every address in that
  // corpus uses the reserved `.test` domain and every number is 415-555-01xx.
  // Listed here rather than baselined because they are invented, and the
  // baseline is for values a human confirmed are safe.
  "rehearsal user",
  "external fran",
  "external gus",
  // BACKLOG-2669 — the founder's OWN seeded test contacts, transcribed from the
  // live reproduction on his machine (the `# LIVE REPRODUCTION` comment on that
  // item, which states plainly that these are test contacts and that no real
  // data is affected). Kept under their original names rather than renamed,
  // because the value of that fixture is that it is his trail and not an
  // invention: the two-hop cascade in
  // `contactSourceLinkSql.unlinkedCopy-2669.test.ts` is his timestamps, his
  // numbers and his addresses.
  "wendell marchetti",
  "bianca okafor",
  "bea okafor",
]);

const overlap = ALLOWED_DOMAINS.filter((d) => CONSUMER_DOMAINS.includes(d));
if (overlap.length > 0) {
  console.error(
    `check-fixture-pii: misconfigured — ${overlap.join(", ")} is in both ` +
      "ALLOWED_DOMAINS and CONSUMER_DOMAINS.",
  );
  process.exit(2);
}

function normalisePhoneDigits(raw) {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits;
}

// --------------------------------------------------------------------------
// Scanning
// --------------------------------------------------------------------------

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0) continue;
    if (!SCAN_EXTENSIONS.has(entry.name.slice(dot))) continue;
    yield full;
  }
}

/** @returns {{file: string, line: number, rule: string, match: string}[]} */
function scan() {
  const findings = [];

  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }

    for (const file of walk(abs)) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (text.indexOf(String.fromCharCode(0)) !== -1) continue; // binary

      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 20000) continue; // minified / generated blob

        for (const m of line.matchAll(CONSUMER_EMAIL_RE)) {
          const value = m[0];
          findings.push({
            file: rel,
            line: i + 1,
            rule: "consumer-email",
            match: value.toLowerCase(),
          });
        }

        // Names, but only alongside an address or a number on the same line —
        // see QUOTED_NAME_RE for why the second signal is required.
        if (IDENTITY_CONTEXT_RE.test(line)) {
          QUOTED_NAME_RE.lastIndex = 0;
          for (const m of line.matchAll(QUOTED_NAME_RE)) {
            const value = m[1];
            if (FICTIONAL_NAMES.has(value.toLowerCase())) continue;
            findings.push({
              file: rel,
              line: i + 1,
              rule: "personal-name",
              match: value,
            });
          }
        }

        // The three phone patterns overlap by design: "+1 (206) 555-0142" is
        // matched by the country-code pattern AND, one character in, by the
        // parenthesised pattern. Record the character range each accepted match
        // covers and drop any later match that lands inside one, so a single
        // number is reported once.
        const claimedSpans = [];
        for (const re of PHONE_RES) {
          re.lastIndex = 0;
          for (const m of line.matchAll(re)) {
            const start = m.index;
            const end = start + m[0].length;
            if (claimedSpans.some(([s, e]) => start < e && end > s)) continue;
            const digits = normalisePhoneDigits(m[0]);
            if (digits.length !== 10) continue;
            claimedSpans.push([start, end]);
            if (RESERVED_PHONE_RE.test(digits)) continue;
            findings.push({
              file: rel,
              line: i + 1,
              rule: "non-reserved-phone",
              match: digits,
            });
          }
        }
      }
    }
  }

  return findings;
}

// --------------------------------------------------------------------------
// Baseline
// --------------------------------------------------------------------------

/**
 * A baseline entry is keyed on file + rule + matched value, NOT on line number,
 * so unrelated edits that shift lines around do not invalidate it.
 */
function keyOf(finding) {
  return `${finding.file} :: ${finding.rule} :: ${finding.match}`;
}

function loadBaseline() {
  try {
    const raw = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    const set = new Set();
    for (const entry of raw.entries ?? []) {
      set.add(keyOf(entry));
    }
    return { set, meta: raw };
  } catch {
    return { set: new Set(), meta: null };
  }
}

function writeBaseline(findings) {
  const seen = new Map();
  for (const f of findings) {
    const key = keyOf(f);
    if (!seen.has(key)) {
      seen.set(key, { file: f.file, rule: f.rule, match: f.match });
    }
  }
  const entries = [...seen.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.rule.localeCompare(b.rule) ||
      a.match.localeCompare(b.match),
  );
  const payload = {
    $comment:
      "Pre-existing consumer-domain addresses and non-reserved phone numbers, " +
      "recorded so scripts/ci/check-fixture-pii.mjs fails only on NEW ones. " +
      "Entries here are believed to be invented but have not all been audited. " +
      "Adding an entry is a review decision: it asserts the value is not a real " +
      "person's. Never add one to silence a genuine finding — replace the value " +
      "with example.com / +1 555 01xx instead.",
    generatedBy: "node scripts/ci/check-fixture-pii.mjs --update-baseline",
    backlog: "BACKLOG-2485",
    entryCount: entries.length,
    entries,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return entries.length;
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const findings = scan();

if (args.has("--update-baseline")) {
  const count = writeBaseline(findings);
  console.log(`Wrote ${count} baseline entries to ${relative(REPO_ROOT, BASELINE_PATH)}`);
  process.exit(0);
}

if (args.has("--list")) {
  for (const f of findings) {
    console.log(`${f.file}:${f.line}  [${f.rule}]  ${f.match}`);
  }
  console.log(`\n${findings.length} total occurrence(s).`);
  process.exit(0);
}

const { set: baseline } = loadBaseline();
const offenders = findings.filter((f) => !baseline.has(keyOf(f)));

if (offenders.length === 0) {
  console.log(
    `Fixture PII guard: OK — ${findings.length} known occurrence(s), ` +
      `${baseline.size} baselined, 0 new.`,
  );
  process.exit(0);
}

const emails = offenders.filter((f) => f.rule === "consumer-email");
const phones = offenders.filter((f) => f.rule === "non-reserved-phone");
const names = offenders.filter((f) => f.rule === "personal-name");

console.error("");
console.error("Fixture PII guard: FAILED");
console.error("");
console.error(
  `${offenders.length} new occurrence(s) of personal-looking data in source/test paths.`,
);
console.error("This repository is public — committed fixture data cannot be un-published.");
console.error("");

if (emails.length > 0) {
  console.error(`Email addresses on real consumer domains (${emails.length}):`);
  for (const f of emails) console.error(`  ${f.file}:${f.line}  ${f.match}`);
  console.error("");
  console.error("  Fix: use an RFC 2606 reserved domain — example.com, example.org,");
  console.error("       example.net, example.test.");
  console.error("");
}

if (phones.length > 0) {
  console.error(`US phone numbers outside the reserved fictional range (${phones.length}):`);
  for (const f of phones) console.error(`  ${f.file}:${f.line}  ${f.match}`);
  console.error("");
  console.error("  Fix: use +1 <area code> 555-01xx (555-0100..555-0199 is reserved");
  console.error("       for fictional use).");
  console.error("");
}

if (names.length > 0) {
  const distinct = [...new Set(names.map((f) => f.match))].sort();
  console.error(
    `Personal names beside an address or a number (${names.length} occurrence(s), ` +
      `${distinct.length} distinct):`,
  );
  for (const f of names) console.error(`  ${f.file}:${f.line}  ${f.match}`);
  console.error("");
  console.error("  A name is personal data on its own. This rule fires only when the");
  console.error("  name shares a line with an address or a number — the identity-row");
  console.error("  shape that leaked in BACKLOG-2542.");
  console.error("");
  console.error("  Fix: replace with an invented name, or — if it IS invented — add it");
  console.error("       to FICTIONAL_NAMES in this file, or record it in the baseline.");
  console.error("");
}

console.error(
  "If — and only if — a human has confirmed the value is invented, record it with:",
);
console.error("  node scripts/ci/check-fixture-pii.mjs --update-baseline");
console.error("");

process.exit(1);
