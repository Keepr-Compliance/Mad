/**
 * Pins for `db/storageDiagnosticsSql` — BACKLOG-2989 chunk 2.
 *
 * ## Why these four functions need a pin more than anything else in this item
 *
 * Every other statement BACKLOG-2989 moves is verified by CONTENT HASH: the new
 * constant hashes to the value the gate recorded for the site it replaced, so
 * the move provably altered nothing. The four functions below cannot have that
 * control. They interpolate a table or column name, so moving them meant
 * RECOMPOSING the statement, and byte-identity does not exist to be claimed.
 *
 * For these four, this file is the only thing standing between a recomposition
 * and a silent behaviour change.
 *
 * ## The fixture is the real schema
 *
 * `electron/database/schema.sql` is executed in full, with `foreign_keys = ON`,
 * so every table shape, CHECK constraint, default and index is the one
 * production creates. Nothing here is transcribed and nothing is invented.
 *
 * ## Assertions are on identity, not counts, wherever a count could coincide
 *
 * Two tables holding the same number of rows cannot distinguish a query that
 * reads the right table from one that reads the wrong one, so the fixtures
 * below give every table a DIFFERENT row count on purpose.
 */

import fs from "fs";
import os from "os";
import path from "path";

// The real driver, required by path so jest's moduleNameMapper mock for
// `better-sqlite3-multiple-ciphers` does not intercept it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  CONTACTS_WITH_EMAIL_SQL,
  CONTACTS_WITH_NEITHER_SQL,
  CONTACTS_WITH_PHONE_SQL,
  DIAGNOSABLE_TABLES,
  EXISTING_TABLE_NAMES_SQL,
  PHONES_NORMALIZED_SQL,
  SCHEMA_VERSION_SQL,
  countBySourceIn,
  countRowsIn,
  selectDateRangeIn,
  selectDeepestScannedIn,
  type StorageQueryable,
} from "../storageDiagnosticsSql";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-2989-diag";

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;
let q: StorageQueryable;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-diagsql-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  q = db as unknown as StorageQueryable;

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, ?, 'google', ?)`,
  ).run(USER, "diag@example.test", "oauth-diag");
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Deliberately unequal row counts, so a wrong table cannot pass as the right one. */
function seedUnequalCounts(): void {
  const c = db.prepare(
    `INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)`,
  );
  for (let i = 0; i < 5; i++) c.run(`c${i}`, USER, `Contact ${i}`);

  const p = db.prepare(
    `INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES (?, ?, ?)`,
  );
  for (let i = 0; i < 3; i++) p.run(`p${i}`, "c0", `+1206555000${i}`);

  const e = db.prepare(
    `INSERT INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)`,
  );
  for (let i = 0; i < 2; i++) e.run(`e${i}`, "c1", `c1-${i}@example.test`);
}

describe("countRowsIn", () => {
  it("counts the NAMED table, and the tables hold different totals so a swap cannot pass", () => {
    seedUnequalCounts();

    expect(countRowsIn(q, "contacts")?.n).toBe(5);
    expect(countRowsIn(q, "contact_phones")?.n).toBe(3);
    expect(countRowsIn(q, "contact_emails")?.n).toBe(2);
  });

  it("returns 0 for an existing but empty table, which is not the same as unavailable", () => {
    expect(countRowsIn(q, "transactions")?.n).toBe(0);
  });

  it("rejects a table that is not on the allow-list, by throwing", () => {
    // The constraint is a runtime check, not a comment and not an erasable
    // type. `users_local` is a real table in the schema — it is refused
    // because it is not DIAGNOSABLE, which is the point.
    expect(() =>
      countRowsIn(q, "users_local" as unknown as (typeof DIAGNOSABLE_TABLES)[number]),
    ).toThrow(/not diagnosable/);

    expect(() =>
      countRowsIn(q, '"; DROP TABLE contacts; --' as unknown as (typeof DIAGNOSABLE_TABLES)[number]),
    ).toThrow(/not diagnosable/);

    // And the injection attempt did nothing.
    expect(countRowsIn(q, "contacts")?.n).toBe(0);
  });
});

describe("countBySourceIn", () => {
  const insertExternal = (id: string, source: string | null): void => {
    db.prepare(
      `INSERT INTO external_contacts (id, user_id, source, external_record_id)
       VALUES (?, ?, ?, ?)`,
    ).run(id, USER, source, id);
  };

  it("groups by source and orders by count DESC", () => {
    insertExternal("x1", "macos");
    insertExternal("x2", "macos");
    insertExternal("x3", "macos");
    insertExternal("x4", "google");

    expect(countBySourceIn(q, "external_contacts")).toEqual([
      { source: "macos", n: 3 },
      { source: "google", n: 1 },
    ]);
  });

  it("breaks a count tie by source ASC — the tiebreak is load-bearing", () => {
    // Without `ORDER BY … source ASC`, two equal counts come back in whatever
    // order the planner picks, and a diagnostics line that reorders itself
    // between two runs of the same database is a defect, not a cosmetic.
    insertExternal("z1", "zeta");
    insertExternal("a1", "alpha");
    insertExternal("m1", "mu");

    expect(countBySourceIn(q, "external_contacts").map((r) => r.source)).toEqual([
      "alpha",
      "mu",
      "zeta",
    ]);
  });

  it("reports a NULL source as the literal '(null)' rather than dropping the row", () => {
    insertExternal("n1", null);
    insertExternal("n2", "macos");

    const rows = countBySourceIn(q, "external_contacts");
    expect(rows).toEqual([
      { source: "(null)", n: 1 },
      { source: "macos", n: 1 },
    ]);
  });
});

describe("selectDateRangeIn", () => {
  const insertEmail = (id: string, sentAt: string, receivedAt: string): void => {
    db.prepare(
      `INSERT INTO emails (id, user_id, sent_at, received_at) VALUES (?, ?, ?, ?)`,
    ).run(id, USER, sentAt, receivedAt);
  };

  it("returns the min and max of the NAMED column", () => {
    // `received_at` deliberately carries a different range from `sent_at`, so
    // reading the wrong column cannot produce the right answer.
    insertEmail("m1", "2025-11-02T08:00:00Z", "2019-01-01T00:00:00Z");
    insertEmail("m2", "2026-07-28T19:30:00Z", "2019-02-02T00:00:00Z");
    insertEmail("m3", "2026-01-15T12:00:00Z", "2019-03-03T00:00:00Z");

    expect(selectDateRangeIn(q, "emails", "sent_at")).toEqual({
      lo: "2025-11-02T08:00:00Z",
      hi: "2026-07-28T19:30:00Z",
    });
  });

  it("returns nulls, not undefined, for an empty table", () => {
    // An aggregate over zero rows still yields one row. The caller relies on
    // this: `toDateOnly(null)` gives null, and "no window" is reported as
    // absent rather than crashing.
    expect(selectDateRangeIn(q, "emails", "sent_at")).toEqual({ lo: null, hi: null });
  });

  it("rejects a column that is not on the allow-list", () => {
    expect(() =>
      selectDateRangeIn(q, "emails", "subject" as never),
    ).toThrow(/not a diagnosable date column/);
  });
});

describe("selectDeepestScannedIn", () => {
  it("returns the earliest value of the named column", () => {
    const ins = db.prepare(
      `INSERT INTO email_sync_state (user_id, account_id, provider, oldest_cached_at, newest_cached_at)
       VALUES (?, ?, 'google', ?, ?)`,
    );
    ins.run(USER, "acct-a", "2025-11-02T00:00:00Z", "2026-08-01T00:00:00Z");
    ins.run(USER, "acct-b", "2024-06-15T00:00:00Z", "2026-08-01T00:00:00Z");

    // Across two accounts the deepest scan is the EARLIEST of them — this is
    // the number that separates "nothing found" from "never looked that far
    // back", which is the distinction the whole coverage line exists for.
    expect(selectDeepestScannedIn(q, "email_sync_state", "oldest_cached_at")).toEqual({
      d: "2024-06-15T00:00:00Z",
    });
  });
});

describe("the static constants still select what the diagnostics block reports", () => {
  it("EXISTING_TABLE_NAMES_SQL lists tables and excludes indexes", () => {
    const names = (
      db.prepare(EXISTING_TABLE_NAMES_SQL).all() as Array<{ name: string }>
    ).map((r) => r.name);

    expect(names).toContain("contacts");
    expect(names).toContain("emails");
    expect(names).not.toContain("idx_communications_email_id");
  });

  /**
   * The second statement in this item whose discriminating clause turns out to
   * be unreachable, found the same way: by executing the real schema.
   *
   * The first draft inserted a row with `id = 2`, so that dropping
   * `WHERE id = 1` would return the wrong version. `schema_version` is a
   * SINGLETON — it carries `CHECK (id = 1)` — so that row cannot exist and the
   * `WHERE` clause can never select the wrong row.
   *
   * The clause stays (this is a mechanical move, and the constant is verified
   * byte-identical by content hash `00b445d23efa`), and what is pinned instead
   * is the constraint it leans on. If that CHECK is ever relaxed to let a
   * second row in, this test fails and `WHERE id = 1` becomes load-bearing
   * rather than redundant — which is exactly when someone needs to know.
   */
  it("reads the singleton version row, and the schema is what makes it singular", () => {
    db.prepare("DELETE FROM schema_version").run();
    db.prepare("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(73);

    expect(db.prepare(SCHEMA_VERSION_SQL).get()).toEqual({ version: 73 });

    expect(() =>
      db.prepare("INSERT INTO schema_version (id, version) VALUES (2, ?)").run(999),
    ).toThrow(/CHECK constraint failed: id = 1/);
  });

  it("the three contact-reachability counts distinguish phone, email and neither", () => {
    seedUnequalCounts();
    // c0 has phones, c1 has emails, c2/c3/c4 have neither.
    const n = (sql: string): number =>
      (db.prepare(sql).get() as { n: number }).n;

    expect(n(CONTACTS_WITH_PHONE_SQL)).toBe(1);
    expect(n(CONTACTS_WITH_EMAIL_SQL)).toBe(1);
    expect(n(CONTACTS_WITH_NEITHER_SQL)).toBe(3);
  });

  it("PHONES_NORMALIZED_SQL excludes NULL *and* empty string", () => {
    db.prepare(`INSERT INTO contacts (id, user_id, display_name) VALUES ('c0', ?, 'C')`).run(USER);
    const p = db.prepare(
      `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES (?, 'c0', ?, ?)`,
    );
    p.run("p1", "+12065550001", "+12065550001");
    p.run("p2", "+12065550002", null);
    p.run("p3", "+12065550003", ""); // stored, not absent

    // Ticket 94: the gap between this and the raw count IS the bug report, so
    // counting an empty string as normalized would understate the gap.
    expect((db.prepare(PHONES_NORMALIZED_SQL).get() as { n: number }).n).toBe(1);
    expect(countRowsIn(q, "contact_phones")?.n).toBe(3);
  });
});
