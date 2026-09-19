/**
 * Pins for `db/emailAddressDiagnosticSql` — BACKLOG-2989 chunk 2.
 *
 * These three statements answer "I added this person and nothing showed up",
 * and they earn their keep by separating three causes that look identical from
 * the UI. So the pin's job is not to prove each returns rows — it is to prove
 * each returns rows in the cases the OTHER two do not.
 *
 * `diagnosticHandlers.ts` has no test suite at all, so nothing existed to
 * inherit. The schema is `electron/database/schema.sql`, executed in full with
 * `foreign_keys = ON`: nothing here is transcribed or invented.
 *
 * The statements' text is separately verified byte-identical to what the
 * handler held before the move, by the SQL boundary gate's own content hashes
 * (`9ec8520585e5`, `6b6102b3de10`, `f1e55b3c17d3`).
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  CONTACT_EMAILS_BY_ADDRESS_SQL,
  EMAILS_BY_PARTICIPANT_SQL,
  USER_EMAIL_COUNT_SQL,
} from "../emailAddressDiagnosticSql";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-2989-addr";
const OTHER_USER = "user-2989-other";
const ADDRESS = "madison@example.test";

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

const insertUser = (id: string, email: string): void => {
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`,
  ).run(id, email, `oauth-${id}`);
};

const insertEmail = (id: string, userId: string, sentAt: string): void => {
  db.prepare(
    `INSERT INTO emails (id, user_id, subject, sender, recipients, sent_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, `subject ${id}`, "sender@example.test", ADDRESS, sentAt);
};

const addParticipant = (emailId: string, address: string, role = "to"): void => {
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, ?, 0, ?, ?)`,
  ).run(emailId, role, `${emailId}-${address}`, address);
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-addr-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  insertUser(USER, "owner@example.test");
  insertUser(OTHER_USER, "other@example.test");
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("CONTACT_EMAILS_BY_ADDRESS_SQL", () => {
  const addContactEmail = (id: string, userId: string, email: string): void => {
    db.prepare(`INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)`).run(
      `c-${id}`,
      userId,
      `Contact ${id}`,
    );
    db.prepare(`INSERT INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)`).run(
      id,
      `c-${id}`,
      email,
    );
  };

  it("matches case-insensitively on both sides", () => {
    // Addresses are stored as the provider supplied them. Comparing raw would
    // report "not found" for an address that is present under a different
    // capitalisation — the exact confusion this diagnostic exists to end.
    addContactEmail("ce1", USER, "Madison@Example.Test");

    const rows = db
      .prepare(CONTACT_EMAILS_BY_ADDRESS_SQL)
      .all(USER, "MADISON@EXAMPLE.TEST") as Array<{ display_name: string }>;

    expect(rows.map((r) => r.display_name)).toEqual(["Contact ce1"]);
  });

  it("is scoped to the requesting user", () => {
    addContactEmail("ce-mine", USER, ADDRESS);
    addContactEmail("ce-theirs", OTHER_USER, ADDRESS);

    const rows = db
      .prepare(CONTACT_EMAILS_BY_ADDRESS_SQL)
      .all(USER, ADDRESS) as Array<{ display_name: string }>;

    expect(rows.map((r) => r.display_name)).toEqual(["Contact ce-mine"]);
  });

  it("returns nothing when the address is on no contact — diagnostic cause 1", () => {
    addContactEmail("ce-other-addr", USER, "someone.else@example.test");

    expect(db.prepare(CONTACT_EMAILS_BY_ADDRESS_SQL).all(USER, ADDRESS)).toEqual([]);
  });
});

describe("EMAILS_BY_PARTICIPANT_SQL", () => {
  it("finds an email where the address appears ONLY as BCC", () => {
    // The unindexed LIKE scan this replaced missed BCC-only matches, so an
    // address that appeared solely as a BCC recipient reported as "never
    // seen" — the worst possible wrong answer for this diagnostic.
    insertEmail("m-bcc", USER, "2026-08-01T10:00:00Z");
    addParticipant("m-bcc", ADDRESS, "bcc");

    const rows = db
      .prepare(EMAILS_BY_PARTICIPANT_SQL)
      .all(USER, ADDRESS) as Array<{ id: string }>;

    expect(rows.map((r) => r.id)).toEqual(["m-bcc"]);
  });

  it("returns unlinked emails with a null transaction_id — diagnostic cause 3", () => {
    // A LEFT JOIN, not an inner one. Cause 3 is precisely the case where the
    // transaction link is what is missing, so an inner join would report
    // "no mail found" for the one situation this query is meant to expose.
    insertEmail("m-unlinked", USER, "2026-08-01T10:00:00Z");
    addParticipant("m-unlinked", ADDRESS);

    const rows = db
      .prepare(EMAILS_BY_PARTICIPANT_SQL)
      .all(USER, ADDRESS) as Array<{ id: string; transaction_id: string | null }>;

    expect(rows).toEqual([{ ...rows[0], id: "m-unlinked", transaction_id: null }]);
    expect(rows[0].transaction_id).toBeNull();
  });

  it("orders newest first and caps at 20", () => {
    for (let i = 0; i < 25; i++) {
      const id = `m${String(i).padStart(2, "0")}`;
      insertEmail(id, USER, `2026-08-${String(i + 1).padStart(2, "0")}T10:00:00Z`);
      addParticipant(id, ADDRESS);
    }

    const rows = db
      .prepare(EMAILS_BY_PARTICIPANT_SQL)
      .all(USER, ADDRESS) as Array<{ id: string }>;

    expect(rows).toHaveLength(20);
    // Identity, not just length: newest first means m24 down to m05.
    expect(rows[0].id).toBe("m24");
    expect(rows[19].id).toBe("m05");
  });

  it("is scoped to the requesting user", () => {
    insertEmail("m-mine", USER, "2026-08-01T10:00:00Z");
    addParticipant("m-mine", ADDRESS);
    insertEmail("m-theirs", OTHER_USER, "2026-08-02T10:00:00Z");
    addParticipant("m-theirs", ADDRESS);

    const rows = db
      .prepare(EMAILS_BY_PARTICIPANT_SQL)
      .all(USER, ADDRESS) as Array<{ id: string }>;

    expect(rows.map((r) => r.id)).toEqual(["m-mine"]);
  });
});

describe("USER_EMAIL_COUNT_SQL", () => {
  it("counts this user's emails only — the denominator that separates two tickets", () => {
    // "No mail for THIS address" and "no mail at all" are different tickets.
    insertEmail("m1", USER, "2026-08-01T10:00:00Z");
    insertEmail("m2", USER, "2026-08-02T10:00:00Z");
    insertEmail("m3", OTHER_USER, "2026-08-03T10:00:00Z");

    expect(db.prepare(USER_EMAIL_COUNT_SQL).get(USER)).toEqual({ count: 2 });
    expect(db.prepare(USER_EMAIL_COUNT_SQL).get(OTHER_USER)).toEqual({ count: 1 });
  });

  it("returns 0, not undefined, when the user has no email at all", () => {
    // The handler reads `.count` off the result. An aggregate always returns a
    // row, so this is 0 rather than undefined — and the handler would crash if
    // it were not.
    expect(db.prepare(USER_EMAIL_COUNT_SQL).get(USER)).toEqual({ count: 0 });
  });
});
