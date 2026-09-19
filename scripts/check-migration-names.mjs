#!/usr/bin/env node
/**
 * Every Supabase migration filename must be `YYYYMMDDHHMMSS_name.sql`, and no two
 * migrations may claim the same version stamp.
 *
 * WHY THIS EXISTS: `supabase migration new` generates that stamp from the clock,
 * so two files can never collide. Hand-named files can, and did — on 2026-09-07
 * two migrations both claimed `20260905`. `version` is the PRIMARY KEY of
 * `supabase_migrations.schema_migrations`, so only one of them could ever be
 * recorded: the second migration's SQL would run and then be invisible to the
 * ledger. That is how a migration goes missing while everything looks green.
 *
 * TWO CHECKS, TWO DIFFERENT SCOPES. The distinction is the whole point of the file:
 *
 *   NAME FORMAT is grandfathered. 130 files predate the rule; failing on them would
 *   block every PR until BACKLOG-3126 reconciles them.
 *
 *   DUPLICATE STAMPS ARE NEVER GRANDFATHERED. Every file enters the duplicate map,
 *   legacy or not. The first version of this script skipped legacy files BEFORE they
 *   were counted, so a collision involving one was invisible to it: with two files
 *   both named `20260905_…sql` and both listed in `.legacy-names`, it printed
 *   "no duplicate timestamps" and exited 0 — about a directory holding 20 real
 *   collision groups. A gate whose success line is false is worse than no gate.
 *
 * Four outcomes:
 *   1. a NEW malformed name                        → FAIL
 *   2. a duplicate involving any non-legacy file   → FAIL
 *   3. a duplicate among grandfathered files only  → REPORTED, does not fail
 *      (20 such groups exist today; they are BACKLOG-3126's job, and failing on
 *      them would block every PR until it lands — but they are never silent again,
 *      because the count is printed on the success path)
 *   4. `.legacy-names` gaining an entry            → FAIL
 *
 * Outcome 4 is what makes outcome 3 safe to allow. "Legacy-only" is a sound proxy
 * for "pre-existing" ONLY while the legacy list cannot grow; without the pin, any
 * new collision could be waved through by appending two lines to `.legacy-names`.
 */
import { readdirSync, readFileSync } from "node:fs";

const DIR = "supabase/migrations";

/**
 * The grandfather roster is a CLOSED set. Lower this as BACKLOG-3126 shrinks the
 * list; never raise it. See outcome 4 above.
 */
const LEGACY_MAX = 130;

const LEGACY = new Set(
  readFileSync(`${DIR}/.legacy-names`, "utf8")
    .split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#")),
);

/** The name every NEW migration must have. */
const SHAPE = /^(\d{14})_[a-z0-9_]+\.sql$/;
/** The leading digit run is the version the Supabase CLI keys history by. */
const STAMP = /^(\d+)_/;

const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const malformed = [];
const unversioned = [];
const seen = new Map();

for (const f of files) {
  if (!SHAPE.test(f) && !LEGACY.has(f)) malformed.push(f);

  // Deliberately outside the check above: legacy status excuses the NAME, never the
  // STAMP. A file the CLI cannot key at all is its own error.
  const s = STAMP.exec(f);
  if (!s) { unversioned.push(f); continue; }
  const stamp = s[1];
  if (seen.has(stamp)) seen.get(stamp).push(f);
  else seen.set(stamp, [f]);
}

const duplicates = [...seen.entries()].filter(([, fs]) => fs.length > 1);
// A group is pre-existing only if EVERY file in it is grandfathered. One new file at
// a legacy stamp makes the whole group blocking — that is a new collision.
const blocking = duplicates.filter(([, fs]) => fs.some((f) => !LEGACY.has(f)));
const preExisting = duplicates.filter(([, fs]) => fs.every((f) => LEGACY.has(f)));

let failed = false;

if (malformed.length) {
  failed = true;
  console.error(`\n${malformed.length} NEW migration file(s) are not named YYYYMMDDHHMMSS_name.sql:\n`);
  for (const f of malformed) console.error(`  ${f}`);
  console.error("\nGenerate migrations with `supabase migration new <name>` so the stamp comes from the clock.\n");
}

if (unversioned.length) {
  failed = true;
  console.error(`\n${unversioned.length} migration file(s) have no leading version stamp at all:\n`);
  for (const f of unversioned) console.error(`  ${f}`);
  console.error("\nThe Supabase CLI keys history by the leading digits; these cannot be recorded.\n");
}

if (blocking.length) {
  failed = true;
  console.error(`\n${blocking.length} timestamp(s) claimed by more than one migration:\n`);
  for (const [stamp, fs] of blocking) {
    console.error(`  ${stamp}`);
    for (const f of fs) console.error(`      ${f}${LEGACY.has(f) ? "  (grandfathered name)" : ""}`);
  }
  console.error("\n`version` is the PRIMARY KEY of schema_migrations — only one of these can ever be recorded.");
  console.error("Renaming is safe ONLY while a migration is still pending; check the ledger before you rename.\n");
}

if (LEGACY.size > LEGACY_MAX) {
  failed = true;
  console.error(
    `\n${DIR}/.legacy-names has grown to ${LEGACY.size} entries (max ${LEGACY_MAX}).\n\n` +
    "That list is a closed record of names that predate this gate. A new entry is not a\n" +
    "grandfathered file — it is this check being worked around. Rename the file instead.\n",
  );
}

// Reported on BOTH paths. The point of this block is that the pre-existing collisions
// can never again be summarised as "no duplicate timestamps".
if (preExisting.length) {
  const n = preExisting.reduce((acc, [, fs]) => acc + fs.length, 0);
  console.log(
    `NOTE — ${preExisting.length} stamp(s) are shared by ${n} grandfathered file(s), not blocking (BACKLOG-3126):`,
  );
  console.log(`  ${preExisting.map(([stamp]) => stamp).join(" ")}`);
}

if (failed) process.exit(1);
console.log(
  `Migration names OK — ${files.length} file(s): ${files.length - LEGACY.size} conforming, ` +
  `${LEGACY.size} grandfathered (BACKLOG-3126); ` +
  (preExisting.length
    ? `${preExisting.length} pre-existing shared stamp(s) reported above, `
    : "no shared stamps among grandfathered files, ") +
  "no new or mixed duplicate stamps.",
);
