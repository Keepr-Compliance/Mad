/**
 * Pins for `db/appleAddressBookSql` — BACKLOG-2990 chunk 1.
 *
 * ## The aliasing is the whole subject
 *
 * SQLite resolves an identifier case-insensitively but names the RESULT column
 * after the case it was DECLARED with — and an IMPLICIT rowid has no declared
 * case at all. So `SELECT ROWID` comes back under the key `rowid`, and
 * `row.ROWID` is `undefined`.
 *
 * That is not cosmetic. `buildLookupIndexes()` then misses on
 * `multiValuesByContact.get(undefined)`, so every contact imports with zero
 * phones and zero emails, and `contactCache.set(undefined, …)` collapses the
 * address book to one entry — while the import reports success.
 *
 * These assertions are BOTH-HALVES-MUST-AGREE: the query's result keys and the
 * property names the parser reads must match. Either alone passes while the
 * import silently produces contacts that can match nothing.
 *
 * ## A stated limit of this fixture
 *
 * `AddressBook.sqlitedb` is Apple's and there is no real one in this repository
 * to transcribe. The schema below is built from what the parser reads and casts
 * — the columns it names and the types it expects. It therefore pins THE
 * STATEMENTS' behaviour, not Apple's schema. If Apple changes `ABPerson`, this
 * stays green and the real path breaks; that failure mode is recorded, not
 * hidden.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  ABPERSON_OPTIONAL_COLUMNS,
  ABPERSON_TABLE_INFO_SQL,
  AB_MULTIVALUE_ALL_SQL,
  AB_MULTIVALUE_BY_RECORD_SQL,
  prepareAbPersonStatements,
} from "../appleAddressBookSql";

const PHONE = 3;
const EMAIL = 4;

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

/** `full` declares every optional column; `minimal` declares none. */
function openBook(shape: "full" | "minimal"): void {
  const optional =
    shape === "full" ? ABPERSON_OPTIONAL_COLUMNS.map((c) => `${c} TEXT`).join(", ") : "";
  db.exec(`
    CREATE TABLE ABPerson (
      First TEXT, Last TEXT, Organization TEXT${optional ? ", " + optional : ""}
    );
    CREATE TABLE ABMultiValue (
      record_id INTEGER, property INTEGER, label INTEGER, value TEXT
    );
    CREATE TABLE ABMultiValueLabel (ROWID INTEGER PRIMARY KEY, value TEXT);
  `);
}

const present = (): Set<string> =>
  new Set(
    (db.prepare(ABPERSON_TABLE_INFO_SQL).all() as Array<{ name: string }>).map((r) => r.name),
  );

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2990-ab-"));
  db = new RealDatabase(path.join(tmpRoot, "AddressBook.sqlitedb"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("the result keys the parser reads", () => {
  it("returns ROWID under the key `ROWID`, not `rowid`", () => {
    openBook("full");
    db.prepare("INSERT INTO ABPerson (First, Last) VALUES ('Ada', 'Lovelace')").run();

    const row = prepareAbPersonStatements(db as never, present()).all.get() as Record<
      string,
      unknown
    >;

    // The implicit-rowid trap. Without `ROWID AS ROWID` this key is `rowid`,
    // `row.ROWID` is undefined, and every contact imports with no phones.
    expect(Object.keys(row)).toContain("ROWID");
    expect(row.ROWID).toBe(1);
    expect(row).not.toHaveProperty("rowid");
  });

  it("returns First / Last / Organization under their declared case", () => {
    openBook("full");
    db.prepare(
      "INSERT INTO ABPerson (First, Last, Organization) VALUES ('Ada', 'Lovelace', 'AA')",
    ).run();

    const row = prepareAbPersonStatements(db as never, present()).all.get() as Record<
      string,
      unknown
    >;
    expect(row.First).toBe("Ada");
    expect(row.Last).toBe("Lovelace");
    expect(row.Organization).toBe("AA");
  });

  it("emits NULL AS <col> for a column this backup does NOT have, so the shape is constant", () => {
    // A minimal backup declares no optional columns. The parser must not have
    // to ask which ones it got — every key is present, missing ones are null.
    openBook("minimal");
    db.prepare("INSERT INTO ABPerson (First) VALUES ('Ada')").run();

    const row = prepareAbPersonStatements(db as never, present()).all.get() as Record<
      string,
      unknown
    >;
    for (const col of ABPERSON_OPTIONAL_COLUMNS) {
      expect(Object.keys(row)).toContain(col);
      expect(row[col]).toBeNull();
    }
  });

  it("returns the real value when the column IS present", () => {
    openBook("full");
    db.prepare("INSERT INTO ABPerson (First, ExternalUUID) VALUES ('Ada', 'uuid-1')").run();

    const row = prepareAbPersonStatements(db as never, present()).all.get() as Record<
      string,
      unknown
    >;
    expect(row.ExternalUUID).toBe("uuid-1");
  });
});

describe("prepareAbPersonStatements — the pair is built from ONE list", () => {
  it("the by-id form returns the same keys as the all form", () => {
    /**
     * BACKLOG-2407. `getContactById()` falls through to the by-id statement on
     * a cache miss, so a column list that widened only the first would leave
     * that path returning contacts whose identity fields are silently
     * undefined. Returning them as a pair makes the divergence unrepresentable;
     * this asserts it holds.
     */
    openBook("full");
    db.prepare("INSERT INTO ABPerson (First, ExternalUUID) VALUES ('Ada', 'uuid-1')").run();

    const { all, byId } = prepareAbPersonStatements(db as never, present());
    const fromAll = all.get() as Record<string, unknown>;
    const fromId = byId.get(1) as Record<string, unknown>;

    expect(Object.keys(fromId).sort()).toEqual(Object.keys(fromAll).sort());
    expect(fromId).toEqual(fromAll);
  });

  it("orders the all form by ROWID, so an import is deterministic", () => {
    openBook("full");
    for (const n of ["Cleo", "Ada", "Brin"])
      db.prepare("INSERT INTO ABPerson (First) VALUES (?)").run(n);

    const rows = prepareAbPersonStatements(db as never, present()).all.all() as Array<{
      ROWID: number;
    }>;
    expect(rows.map((r) => r.ROWID)).toEqual([1, 2, 3]);
  });
});

describe("the multivalue statements", () => {
  beforeEach(() => {
    openBook("full");
    db.prepare("INSERT INTO ABMultiValueLabel (ROWID, value) VALUES (1, 'home')").run();
    const ins = db.prepare(
      "INSERT INTO ABMultiValue (record_id, property, label, value) VALUES (?, ?, ?, ?)",
    );
    ins.run(1, PHONE, 1, "+15555550101");
    ins.run(1, EMAIL, null, "ada@example.test");   // label id absent from the label table
    ins.run(2, PHONE, 1, "+15555550102");
    ins.run(1, 99, 1, "ignored-property");          // a property neither phone nor email
  });

  it("labels an unmatched label id 'other' rather than dropping the value", () => {
    const rows = db.prepare(AB_MULTIVALUE_ALL_SQL).all(PHONE, EMAIL) as Array<{
      value: string;
      label: string;
    }>;
    const email = rows.find((r) => r.value === "ada@example.test");
    expect(email?.label).toBe("other");
  });

  it("returns only the two requested properties, ordered by record", () => {
    const rows = db.prepare(AB_MULTIVALUE_ALL_SQL).all(PHONE, EMAIL) as Array<{
      record_id: number;
      value: string;
    }>;
    expect(rows.map((r) => r.value)).toEqual([
      "+15555550101",
      "ada@example.test",
      "+15555550102",
    ]);
  });

  it("the by-record form narrows to one contact and keeps the same shape", () => {
    const all = db.prepare(AB_MULTIVALUE_ALL_SQL).all(PHONE, EMAIL) as Array<Record<string, unknown>>;
    const one = db.prepare(AB_MULTIVALUE_BY_RECORD_SQL).all(1, PHONE, EMAIL) as Array<
      Record<string, unknown>
    >;

    expect(one.map((r) => r.value)).toEqual(["+15555550101", "ada@example.test"]);
    expect(Object.keys(one[0]).sort()).toEqual(Object.keys(all[0]).sort());
  });
});
