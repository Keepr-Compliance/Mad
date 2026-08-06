/**
 * @jest-environment node
 *
 * BACKLOG-2532 — ONE DEFINITION OF A CONTACT'S EDITABLE FIELDS.
 *
 * ===========================================================================
 * WHAT WAS WRONG
 * ===========================================================================
 * A contact's editable fields were described in TWO places that had to agree
 * and were kept in step by hand: the `ContactUpdateFields` interface, and a
 * `Map` inside `contactDbService`.
 *
 * **A field on one side and not the other was discarded in silence, and the
 * handler still returned success.** That is BACKLOG-2528 — renaming a contact
 * did nothing and the form said it worked. Fixing that one field did not fix
 * the arrangement that produced it.
 *
 * The mapping is now the single definition and the type is DERIVED from it, so
 * the two cannot disagree: a field the type accepts but the writer does not is
 * no longer expressible.
 *
 * ===========================================================================
 * WHAT THIS SUITE ADDS THAT THE COMPILER CANNOT
 * ===========================================================================
 * TypeScript now guarantees the type and the mapping agree. **It cannot check
 * that the mapping's COLUMNS exist** — `title: "titel"` compiles perfectly and
 * fails at runtime, on the same silent path this item exists to close.
 *
 * So the assertion below is against the REAL `schema.sql`: every column the
 * mapping targets must be a real column of `contacts`.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/db/__tests__/contactDbService.oneFieldDefinition-2532.test.ts
 */

import fs from "fs";
import path from "path";
import { CONTACT_UPDATE_FIELD_TO_COLUMN } from "../../../types/models";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SCHEMA = path.join(REPO_ROOT, "electron", "database", "schema.sql");

/** Column names declared on `contacts` in the real schema. */
function contactsColumns(): string[] {
  const sql = fs.readFileSync(SCHEMA, "utf8");
  const start = sql.indexOf("CREATE TABLE IF NOT EXISTS contacts (");
  if (start === -1) throw new Error("contacts table not found in schema.sql");
  const end = sql.indexOf("\n);", start);
  const body = sql.slice(start, end);

  return body
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("--") && !/^(FOREIGN|PRIMARY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(l))
    .map((l) => l.split(/\s+/)[0])
    .filter((n) => /^[a-z_]+$/.test(n));
}

describe("one definition of a contact's editable fields (BACKLOG-2532)", () => {
  const columns = contactsColumns();

  it("PRECONDITION: the schema was read and looks like the real contacts table", () => {
    // Without this the assertion below passes vacuously against an empty list.
    expect(columns.length).toBeGreaterThan(10);
    expect(columns).toContain("display_name");
    expect(columns).toContain("id");
  });

  it("PRECONDITION: the mapping is non-empty and includes the field that caused BACKLOG-2528", () => {
    const fields = Object.keys(CONTACT_UPDATE_FIELD_TO_COLUMN);
    expect(fields.length).toBeGreaterThan(0);
    // `name` is the renderer's spelling. Its ABSENCE from the writer's list is
    // exactly what made renaming a contact do nothing.
    expect(fields).toContain("name");
  });

  /**
   * THE CHECK THE COMPILER CANNOT MAKE.
   *
   * NEGATIVE CONTROL (executed): change `title: "title"` to `title: "titel"` in
   * `types/models.ts` — it compiles — and this goes red naming `titel`.
   */
  it("every column the mapping targets is a real column of contacts", () => {
    const targeted = [...new Set(Object.values(CONTACT_UPDATE_FIELD_TO_COLUMN))];
    const missing = targeted.filter((c) => !columns.includes(c));

    // Exact set, not a count.
    expect(missing).toEqual([]);
  });

  it("`name` and `display_name` both target the same column, so an edit cannot split", () => {
    // Reads hand the renderer `name`; it sends `name` back. Both spellings must
    // land on one column or a single save could write two different values.
    expect(CONTACT_UPDATE_FIELD_TO_COLUMN.name).toBe(
      CONTACT_UPDATE_FIELD_TO_COLUMN.display_name,
    );
  });

  it("email and phone are NOT in the mapping — they are not columns of contacts", () => {
    // They live in `contact_emails` / `contact_phones` and are written by their
    // own paths. A validator that accepts them does not make them updatable
    // here, and pretending otherwise is what made BACKLOG-2534 hard to read.
    const fields = Object.keys(CONTACT_UPDATE_FIELD_TO_COLUMN);
    expect(fields).not.toContain("email");
    expect(fields).not.toContain("phone");
    expect(columns).not.toContain("email");
  });
});
