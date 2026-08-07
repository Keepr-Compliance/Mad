/**
 * @jest-environment node
 *
 * BACKLOG-2514 — the three contact surfaces must return the same rows.
 *
 * ===========================================================================
 * WHAT DIFFERS TODAY, AND WHY IT IS INVISIBLE
 * ===========================================================================
 * All three screens render through `ContactSearchList` and one shared pure
 * matcher. What differs is the PRODUCER that fills the `contacts` prop:
 *
 *   getImportedContactsByUserId       (sync)     all addresses + message-derived
 *   getImportedContactsByUserIdAsync  (worker)   all addresses, NO message-derived
 *   getContactsSortedByActivity       (activity) primary address ONLY, message-derived
 *
 * So the matcher's `allEmails` / `allPhones` arms receive EMPTY ARRAYS on the
 * new-transaction wizard and add-to-existing: a contact with a work address and
 * a personal one is findable by both in Clients & Contacts and by only one when
 * the user is actually building a transaction.
 *
 * ===========================================================================
 * THE POOL-WARMTH FORK — THE FOUNDER HAS ALREADY BEEN IN THIS STATE
 * ===========================================================================
 * `getImportedContactsByUserIdAsync` falls back to the sync producer ONLY when
 * `isPoolReady()` is false. The sync producer merges message-derived people and
 * the worker path does not — so Clients & Contacts shows a DIFFERENT SET OF
 * PEOPLE depending on whether the worker pool happens to be warm. Same user,
 * same data, same screen, different rows.
 *
 * That fork is not hypothetical. The worker pool's init timeout fires under CPU
 * starvation, leaving the pool cold — which is exactly the condition
 * BACKLOG-2576 records the founder hitting on 2026-08-06. On that night his
 * contact list CONTENTS were also silently different, at the same time as the
 * stall he reported.
 *
 * `parity: warm and cold pool return the same people` is therefore a
 * reproduction of a state he has been in, not a synthetic edge case.
 *
 * ===========================================================================
 * ASSERTIONS ARE EXACT ID SETS
 * ===========================================================================
 * Never counts. A count cannot distinguish "the second address matched" from "a
 * different contact came back", and "the right number of wrong rows" is the
 * exact failure this item is about. The address boundary is SWEPT, not sampled:
 * a contact with two addresses, one with exactly one, and one with none.
 *
 * Real `node:sqlite` and the real schema throughout — the SQL under test is the
 * thing under test.
 */

import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";
import { CONTACT_COMMUNICATION_SCHEMA } from "./helpers/contactCommunicationSchema";
import { openTestDb, type TestDb } from "./helpers/syncSqliteDriver";

/**
 * TRANSCRIBED from `electron/database/schema.sql:1269-1275`, not written from
 * memory — the recency fragment the projection carries reads this table, and a
 * fixture that accepts what production refuses can only prove things about
 * itself. The FK to `users_local` is dropped because this fixture has no users
 * table; every column and the composite primary key are the real ones.
 */
const PHONE_LAST_MESSAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS phone_last_message (
  phone_normalized TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_message_at DATETIME NOT NULL,
  PRIMARY KEY (phone_normalized, user_id)
);
`;

/**
 * The two denormalized recency columns, TRANSCRIBED from `schema.sql:168-169`
 * (`last_inbound_at DATETIME` / `last_outbound_at DATETIME`). The shared
 * identity fixture omits them; the recency fragment inside the projection reads
 * both, so without them the statement under test cannot even prepare.
 */
const CONTACT_RECENCY_COLUMNS = [
  "ALTER TABLE contacts ADD COLUMN last_inbound_at DATETIME",
  "ALTER TABLE contacts ADD COLUMN last_outbound_at DATETIME",
];

let mockDb: TestDb | null = null;
let poolReady = false;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...params);
    return { lastInsertRowid: r.lastInsertRowid as number, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

/**
 * The worker pool, faked at its boundary.
 *
 * `queryContacts` runs the SHARED SQL CONSTANT the real worker runs, against
 * this test's database. That is the point: the worker thread cannot be started
 * under jest, but the STATEMENT it executes is an imported constant, so
 * executing it here exercises the same SQL the worker will. If someone gives
 * the worker a different statement, it stops being shared and this stops
 * proving anything — which is why the parity test below asserts the projected
 * COLUMN SET too, not just the rows.
 */
jest.mock("../../workers/contactWorkerPool", () => ({
  __esModule: true,
  isPoolReady: () => poolReady,
  queryContacts: (_type: string, userId: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { IMPORTED_CONTACTS_SELECT_SQL } = require("../db/contactProjectionSql");
    return Promise.resolve(mockDb!.prepare(IMPORTED_CONTACTS_SELECT_SQL).all(userId));
  },
}));

import {
  getImportedContactsByUserId,
  getImportedContactsByUserIdAsync,
} from "../db/contactDbService";

const USER = "550e8400-e29b-41d4-a716-446655440000";

const TWO = "contact-two-addresses";
const ONE = "contact-one-address";
const NONE = "contact-no-addresses";

function seed(): void {
  const c = mockDb!.prepare(
    "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)",
  );
  c.run(TWO, USER, "Robin Marsh");
  c.run(ONE, USER, "Pat Riverton");
  c.run(NONE, USER, "Jane Seller");

  const e = mockDb!.prepare(
    "INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, ?)",
  );
  e.run("e1", TWO, "work@example.com", 1);
  e.run("e2", TWO, "personal@example.net", 0);
  e.run("e3", ONE, "only@example.com", 1);

  const p = mockDb!.prepare(
    "INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary) VALUES (?, ?, ?, ?)",
  );
  p.run("p1", TWO, "+14085550101", 1);
  p.run("p2", TWO, "+14085550102", 0);
  p.run("p3", ONE, "+14085550103", 1);

  /**
   * A MESSAGE-DERIVED PERSON — the fixture row without which the pool-warmth
   * control cannot fail.
   *
   * Learned the hard way on this very PR: the first version of this suite had
   * no such row, so `getMessageDerivedContacts` returned [] and REMOVING the
   * merge from the async producer changed nothing. The control stayed green
   * over the exact defect it was written to catch — the 2026-08-04 shape, where
   * a parity test's corpus had no input at the boundary.
   *
   * Shaped to pass the producer's own filters (transcribed from its WHERE): a
   * plain NAME in `participants.$.from` — not an email, not "me", not starting
   * with "+" or a digit, not a urn: — and a channel the CHECK admits.
   */
  mockDb!
    .prepare(
      `INSERT INTO messages (id, user_id, channel, direction, participants, sent_at)
       VALUES (?, ?, 'sms', 'inbound', ?, ?)`,
    )
    .run("m1", USER, JSON.stringify({ from: "Sam Rivers" }), "2026-08-01T10:00:00.000Z");
}

/** The id the producer synthesises for the seeded message-derived person. */
const DERIVED = "msg_sam rivers";

/** Exact identity, sorted. Never a count. */
function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((r) => r.id).sort();
}

function addressesOf(rows: Array<Record<string, unknown>>, id: string) {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`row ${id} not returned`);
  return {
    allEmails: [...((row.allEmails as string[]) ?? [])].sort(),
    allPhones: [...((row.allPhones as string[]) ?? [])].sort(),
  };
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockDb.exec(CONTACT_COMMUNICATION_SCHEMA);
  mockDb.exec(PHONE_LAST_MESSAGE_SCHEMA);
  for (const stmt of CONTACT_RECENCY_COLUMNS) mockDb.exec(stmt);
  seed();
  poolReady = false;
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("every producer projects EVERY address (BACKLOG-2514)", () => {
  /**
   * CONTROL: drop the two `json_group_array` columns from the shared projection
   * -> every case in this describe goes red, on every producer at once. That is
   * the point of one fragment: one revert, one behaviour.
   */
  it("sync producer: both addresses on the two-address contact", async () => {
    const rows = (await getImportedContactsByUserId(USER)) as unknown as Array<
      Record<string, unknown>
    >;

    expect(addressesOf(rows, TWO)).toEqual({
      allEmails: ["personal@example.net", "work@example.com"],
      allPhones: ["+14085550101", "+14085550102"],
    });
  });

  it("worker producer: the same two addresses", async () => {
    poolReady = true;
    const rows = (await getImportedContactsByUserIdAsync(USER)) as unknown as Array<
      Record<string, unknown>
    >;

    expect(addressesOf(rows, TWO)).toEqual({
      allEmails: ["personal@example.net", "work@example.com"],
      allPhones: ["+14085550101", "+14085550102"],
    });
  });

  /**
   * The boundary, swept rather than sampled: one address and none. An
   * off-by-one in the aggregate (or a JOIN that multiplies rows) shows up here
   * and nowhere else.
   */
  it("one address and no addresses are projected honestly, not as empty or duplicated", async () => {
    const rows = (await getImportedContactsByUserId(USER)) as unknown as Array<
      Record<string, unknown>
    >;

    expect(addressesOf(rows, ONE)).toEqual({
      allEmails: ["only@example.com"],
      allPhones: ["+14085550103"],
    });
    expect(addressesOf(rows, NONE)).toEqual({ allEmails: [], allPhones: [] });

    // A row must appear exactly once — a LEFT JOIN on is_primary would
    // multiply a contact carrying two primaries. The message-derived person is
    // in this set because the sync producer merges them.
    expect(ids(rows as Array<{ id: string }>)).toEqual([NONE, ONE, TWO, DERIVED].sort());
  });
});

describe("the pool-warmth fork (BACKLOG-2514 control #4)", () => {
  /**
   * THE ONE THAT REPRODUCES THE FOUNDER'S NIGHT. Cold pool -> sync producer;
   * warm pool -> worker producer. Before this fix the two returned different
   * PEOPLE, because only the sync side merged message-derived contacts.
   *
   * CONTROL: remove the message-derived merge from the async producer -> this
   * goes red and the two above stay green. The projection and the membership
   * fail independently, which is why they are separate tests.
   */
  it("warm and cold pool return the same people", async () => {
    poolReady = false;
    const cold = (await getImportedContactsByUserIdAsync(USER)) as unknown as Array<{ id: string }>;

    poolReady = true;
    const warm = (await getImportedContactsByUserIdAsync(USER)) as unknown as Array<{ id: string }>;

    expect(ids(warm)).toEqual(ids(cold));

    // And say WHICH people, not merely that the two agree: two empty lists
    // would also be equal. The message-derived person is the one the warm path
    // used to drop.
    expect(ids(warm)).toEqual([NONE, ONE, TWO, DERIVED].sort());
    expect(ids(warm)).toContain(DERIVED);
  });

  it("warm and cold pool return the same addresses for the same person", async () => {
    poolReady = false;
    const cold = (await getImportedContactsByUserIdAsync(USER)) as unknown as Array<
      Record<string, unknown>
    >;

    poolReady = true;
    const warm = (await getImportedContactsByUserIdAsync(USER)) as unknown as Array<
      Record<string, unknown>
    >;

    expect(addressesOf(warm, TWO)).toEqual(addressesOf(cold, TWO));
  });
});
