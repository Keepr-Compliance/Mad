/**
 * @jest-environment node
 *
 * BACKLOG-2461 — the display fallback must stay OUT of the database.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS DEFENDING
 * ---------------------------------------------------------------------------
 * `contactDisplayLabel` answers "what do we call this person on screen?" by
 * falling through to their phone number when they have no name. That answer is
 * safe to print and unsafe to store.
 *
 * Stored, it stops being a label and becomes an identity:
 *   - a later rename cannot dislodge it, so the number is frozen as the name;
 *   - `namesAreCompatible` gates phone-based dedup on the name, so the picker
 *     starts merging and suppressing records on a string we invented.
 *
 * So the rule is: the label is computed at the point of render and thrown away.
 * These tests read the column back from a real SQLite database after rendering
 * to prove it, rather than trusting that no write path calls the helper.
 *
 * ---------------------------------------------------------------------------
 * THE DEDUP CONTROL (second describe block)
 * ---------------------------------------------------------------------------
 * SR review caught a live defect in the first draft of this change, and this is
 * the control that catches it if it ever returns.
 *
 * The draft also cleared the persisted literal "Unknown" out of `display_name`.
 * That looked like tidying. It is not: `namesAreCompatible` short-circuits with
 * `if (!na || !nb) return true`, so an EMPTY name is compatible with EVERY name,
 * while the string "Unknown" is compatible with none of them. Clearing the
 * column would have let one nameless record claim a shared office line against
 * every real person on it — suppressing named contacts from the picker as
 * "already imported", one-to-many and silently.
 *
 * The literal is therefore accidentally load-bearing, and this PR leaves every
 * write path alone. These tests pin that: the verdicts must be identical before
 * and after this change.
 *
 * Strategy follows `phoneNormalization.writePath.test.ts` — load the real
 * `better-sqlite3-multiple-ciphers` by explicit path (Jest's default
 * moduleNameMapper rewrites it to a stub) and drive an in-memory database.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import { labelForTransactionContact, NO_NAME_PLACEHOLDER } from "../contactDisplayLabel";
import { namesAreCompatible } from "../contactNameCompat";

const USER_ID = "user-1";

function makeDb(): DatabaseType {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT,
      company TEXT,
      source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE contact_phones (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0
    );
    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0
    );
  `);
  return db;
}

/** Insert a contact with NO name, plus optional primary phone/email. */
function insertNamelessContact(
  db: DatabaseType,
  id: string,
  opts: { phone?: string; email?: string; company?: string } = {},
): void {
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, company, source) VALUES (?, ?, ?, ?, ?)",
  ).run(id, USER_ID, "", opts.company ?? null, "contacts_app");
  if (opts.phone) {
    db.prepare(
      "INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary) VALUES (?, ?, ?, 1)",
    ).run(`${id}-p`, id, opts.phone);
  }
  if (opts.email) {
    db.prepare(
      "INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, 1)",
    ).run(`${id}-e`, id, opts.email);
  }
}

/** The same projection the export query builds (transactionContactDbService). */
function readForDisplay(db: DatabaseType, id: string) {
  return db
    .prepare(
      `SELECT
         c.display_name AS contact_name,
         c.company      AS contact_company,
         (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1) AS contact_phone,
         (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1) AS contact_email
       FROM contacts c WHERE c.id = ?`,
    )
    .get(id) as {
    contact_name: string | null;
    contact_company: string | null;
    contact_phone: string | null;
    contact_email: string | null;
  };
}

function readStoredDisplayName(db: DatabaseType, id: string): string | null {
  return (
    db.prepare("SELECT display_name FROM contacts WHERE id = ?").get(id) as {
      display_name: string | null;
    }
  ).display_name;
}

describe("BACKLOG-2461 — the fallback label is never written to contacts.display_name", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it("a nameless contact with a phone displays the number and stores nothing", () => {
    insertNamelessContact(db, "c-phone", { phone: "+14155550134" });

    const label = labelForTransactionContact(readForDisplay(db, "c-phone"));

    expect(label).toBe("+1 (415) 555-0134");
    // The whole point: the column is untouched by having rendered the label.
    expect(readStoredDisplayName(db, "c-phone")).toBe("");
  });

  it("a nameless contact with only an email displays the email and stores nothing", () => {
    insertNamelessContact(db, "c-email", { email: "jane@acme.com" });

    const label = labelForTransactionContact(readForDisplay(db, "c-email"));

    expect(label).toBe("jane@acme.com");
    expect(readStoredDisplayName(db, "c-email")).toBe("");
  });

  it('a contact with neither displays "No name" and stores nothing', () => {
    insertNamelessContact(db, "c-nothing");

    const label = labelForTransactionContact(readForDisplay(db, "c-nothing"));

    expect(label).toBe(NO_NAME_PLACEHOLDER);
    expect(readStoredDisplayName(db, "c-nothing")).toBe("");
  });

  it("a non-US number survives the round trip with its country code", () => {
    // The founder's own data. A bare "50664103686" is not dialable.
    insertNamelessContact(db, "c-cr", { phone: "+50664103686" });

    const label = labelForTransactionContact(readForDisplay(db, "c-cr"));

    expect(label).toBe("+50664103686");
    expect(readStoredDisplayName(db, "c-cr")).toBe("");
  });

  it("rendering every contact repeatedly still leaves the column empty", () => {
    insertNamelessContact(db, "a", { phone: "+14155550134" });
    insertNamelessContact(db, "b", { email: "b@acme.com" });
    insertNamelessContact(db, "c");

    for (let pass = 0; pass < 3; pass++) {
      for (const id of ["a", "b", "c"]) {
        labelForTransactionContact(readForDisplay(db, id));
      }
    }

    const stored = db
      .prepare("SELECT id, display_name FROM contacts ORDER BY id")
      .all() as Array<{ id: string; display_name: string | null }>;
    expect(stored).toEqual([
      { id: "a", display_name: "" },
      { id: "b", display_name: "" },
      { id: "c", display_name: "" },
    ]);
  });

  it("two nameless contacts are told apart on screen — the founder's actual complaint", () => {
    insertNamelessContact(db, "p1", { phone: "+14155550134" });
    insertNamelessContact(db, "p2", { phone: "+14155550199" });

    const first = labelForTransactionContact(readForDisplay(db, "p1"));
    const second = labelForTransactionContact(readForDisplay(db, "p2"));

    expect(first).toBe("+1 (415) 555-0134");
    expect(second).toBe("+1 (415) 555-0199");
    expect(first).not.toBe(second);
  });
});

/**
 * SR-mandated control. If a future change starts clearing or rewriting
 * `display_name`, these verdicts move and this file goes red.
 */
describe("BACKLOG-2461 — dedup verdicts are unchanged by this PR", () => {
  it('the persisted "Unknown" still contradicts a real name', () => {
    // This is what stops a nameless record matching everyone. It is load-bearing.
    expect(namesAreCompatible("Unknown", "Jane Doe")).toBe(false);
    expect(namesAreCompatible("Unknown", "Bob Smith")).toBe(false);
  });

  it("an EMPTY name would be compatible with every name — which is why we did not clear it", () => {
    // Documented, not endorsed. Clearing display_name would flip the assertions
    // above to `true` and let one nameless record claim a shared line against
    // every named person on it. See BACKLOG-2416.
    expect(namesAreCompatible("", "Jane Doe")).toBe(true);
    expect(namesAreCompatible("", "Bob Smith")).toBe(true);
  });

  it("two nameless records read as compatible either way — pre-existing, BACKLOG-2416", () => {
    expect(namesAreCompatible("Unknown", "Unknown")).toBe(true);
    expect(namesAreCompatible("", "")).toBe(true);
  });

  it("computing a display label does not change what dedup sees", () => {
    const db = makeDb();
    try {
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, ?, ?, ?)",
      ).run("legacy", USER_ID, "Unknown", "contacts_app");
      db.prepare(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary) VALUES (?, ?, ?, 1)",
      ).run("legacy-p", "legacy", "+14155550134");

      const before = readStoredDisplayName(db, "legacy");
      const label = labelForTransactionContact(readForDisplay(db, "legacy"));
      const after = readStoredDisplayName(db, "legacy");

      // The screen heals — the row does not.
      expect(label).toBe("+1 (415) 555-0134");
      expect(after).toBe(before);
      expect(after).toBe("Unknown");
      expect(namesAreCompatible(after, "Jane Doe")).toBe(false);
    } finally {
      db.close();
    }
  });
});
