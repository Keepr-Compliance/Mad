/**
 * @jest-environment node
 *
 * BACKLOG-2371 — A MIGRATION MAY NOT COPY A TABLE POSITIONALLY.
 *
 * ===========================================================================
 * THE LANDMINE
 * ===========================================================================
 * Migration v36 rebuilt `contacts` and copied the old rows with
 *
 *     INSERT OR IGNORE INTO contacts_new SELECT * FROM contacts;
 *
 * `contacts_new` declares 15 columns. `schema.sql:contacts` declared 15. **That
 * equality was undocumented and load-bearing.**
 *
 * Fresh installs seed `schema_version = 32`, so they RUN v36. Adding any column
 * to `schema.sql:contacts` makes `SELECT *` supply 16 values into a 15-column
 * table — **a PREPARE-TIME parse error on every fresh install.** `OR IGNORE`
 * does not suppress it (it is not a row-level conflict) and an empty table does
 * not save you.
 *
 * It never fired only because nobody had added a `contacts` column since v36.
 *
 * ===========================================================================
 * WHY A GUARD RATHER THAN THE FIX ALONE
 * ===========================================================================
 * The fix is a named column list, and it is one line per site. **The guard is
 * for the next person**, who will write a rebuild migration the same way v36
 * was written, because that is the shape every rebuild in this file already
 * had.
 *
 * ===========================================================================
 * AND WHY IT SCANS RATHER THAN LISTING
 * ===========================================================================
 * BACKLOG-2371 asked for the audit explicitly, and gave the reason: v36 was
 * missed once already by someone who checked migration v48, found it safe, and
 * generalised from it. **Enumerating found a SECOND instance the item itself
 * did not name — the `audit_logs` rebuild, with the identical 14 = 14
 * equality.** A hand-written list of known sites would have missed it too.
 */

import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DB_SERVICE = path.join(REPO_ROOT, "electron", "services", "databaseService.ts");

/**
 * Sites allowed to copy positionally, with a reason each.
 *
 * `oldDb.prepare('SELECT * FROM "<table>"').all()` in the encrypted-database
 * rebuild is NOT a positional INSERT — it reads rows into JavaScript objects
 * and the writer binds them by NAME. Different mechanism, not this hazard.
 */
const ALLOWED = [
  {
    fragment: 'SELECT * FROM "${tableName}"',
    why: "reads rows into JS objects; the writer binds by name, not by position",
  },
];

function source(): string {
  return fs.readFileSync(DB_SERVICE, "utf8");
}

/** Every `INSERT ... SELECT *` — the shape that copies by position. */
function positionalCopies(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(\*|\/\/)/.test(line)) continue; // a comment describing the hazard is not the hazard
    if (!/INSERT\s+(OR\s+\w+\s+)?INTO\s+\S+\s+SELECT\s+\*/i.test(line)) continue;
    if (ALLOWED.some((a) => line.includes(a.fragment))) continue;
    out.push(`databaseService.ts:${i + 1}  ${line.trim()}`);
  }
  return out;
}

describe("a migration may not copy a table positionally (BACKLOG-2371)", () => {
  it("PRECONDITION: the file is found and is the real one", () => {
    const text = source();
    expect(text.length).toBeGreaterThan(10000);
    // If this ever stops matching, the scan below passes vacuously.
    expect(text).toContain("INSERT OR IGNORE INTO contacts_new");
  });

  it("PRECONDITION: the scan can still SEE a positional copy", () => {
    // A fabricated line, proving the matcher works. Without this the assertion
    // below is satisfied by a regex that matches nothing at all.
    const fake = 'd.exec("INSERT OR IGNORE INTO widgets_new SELECT * FROM widgets;");';
    expect(positionalCopies(fake)).toHaveLength(1);
  });

  it("no migration copies with SELECT *", () => {
    // Exact set, not a count — a count cannot tell a new offender from a
    // different one that replaced it.
    expect(positionalCopies(source())).toEqual([]);
  });

  it("every allowance gives a reason", () => {
    for (const a of ALLOWED) {
      expect(a.why.length).toBeGreaterThan(30);
      expect(a.why).not.toMatch(/^(ok|fine|safe|n\/a)/i);
    }
    // A growing allowance list is how a guard like this stops guarding.
    expect(ALLOWED.length).toBeLessThanOrEqual(3);
  });
});
