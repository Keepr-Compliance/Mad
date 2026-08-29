/**
 * @jest-environment node
 *
 * BACKLOG-2987 — SYNCING THE SAME ADDRESS BOOK TWICE MUST CREATE NOTHING TWICE.
 *
 * ===========================================================================
 * THE DEFECT, MEASURED RATHER THAN REASONED
 * ===========================================================================
 * From the founder's machine, 2026-08-29, three consecutive syncs of ONE
 * unchanged phone:
 *
 *     Promoted 26 Android contacts to main contacts table (363 already existed)
 *     Promoted 26 Android contacts to main contacts table (363 already existed)
 *     Promoted 26 Android contacts to main contacts table (363 already existed)
 *
 * The created-contact log lines were compared across the three runs with
 * `LC_ALL=C comm`: **0 differing entries** between run 2 and run 3, and between
 * run 3 and run 4. The same 26 people, every time, all of them members of the
 * 379 created on the first sync. 25 of the 26 carried at least one email.
 *
 * `promoteToMainContacts` decided "already exists" by PHONE NUMBER ALONE. A
 * contact carrying no matchable phone — an email-only address-book entry, or one
 * whose only number is a short code below the 7-digit matching floor — never
 * entered that loop, so `alreadyExists` stayed false and it was created AGAIN,
 * on every sync, forever.
 *
 * ===========================================================================
 * WHY THIS SUITE RUNS THE REAL WRITERS
 * ===========================================================================
 * The question is "does the SECOND run see what the FIRST run wrote", so
 * anything that stubs the writing cannot answer it. `createContactsBatch` and
 * `findContactByNormalizedPhone` are the REAL implementations from
 * `db/contactDbService`, running against a real in-memory SQLite, so the second
 * run reads exactly the `contact_phones` and `contact_source_links` rows the
 * first run actually produced — including the phone key spelling, which is
 * computed on the write side by `toLookupKey(normalizeToE164(phone))` and on the
 * read side by `toMatchingKey(phone)`, and which no fixture here restates.
 *
 * `databaseService` is a thin pass-through to those two real functions. That
 * indirection exists only because `localSyncService` imports the aggregate
 * module, which drags in Electron app wiring; the behaviour under test is not
 * mocked.
 *
 * ===========================================================================
 * MUTATION THAT MUST GO RED (run, not asserted — results in the PR body)
 * ===========================================================================
 *   P1  Delete the `claimedRecordIds.has(...)` skip from
 *       `promoteToMainContacts`. `the second sync creates NOTHING` fails, and
 *       the email-only and short-code contacts are created a second time —
 *       reproducing the founder's 26 exactly.
 *   P2  Additionally revert the device id (pass a different `deviceId` to the
 *       second run, which is what every re-pair did before the companion fix).
 *       The same case fails, which is why the two halves of BACKLOG-2987 ship
 *       together.
 *
 * FIXTURES ARE INVENTED. Names are placeholders; numbers are inside the
 * reserved-for-fiction `+1 555 01xx` range; addresses use `example.test`. None
 * of the founder's 26 appear here or anywhere in this repository.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/__tests__/localSyncService.promoteTwice-2987.test.ts
 */

import { openTestDb, type TestDb } from "./helpers/syncSqliteDriver";
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";

let mockDb: TestDb | null = null;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  // A REAL transaction, not a passthrough: `createContactsBatch` writes the
  // contact, its addresses and its crosswalk claim inside one (BACKLOG-2496),
  // and the claim is the thing this suite reads back.
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../contactsService", () => ({ getContactNames: () => new Map() }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: () => false,
}));

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: () => ({ auth: { getUser: jest.fn() } }) },
}));

// The shadow-table write is not what this suite is about; `promoteToMainContacts`
// reads nothing from it.
jest.mock("../db/externalContactDbService", () => ({
  __esModule: true,
  syncContactsBySource: jest.fn(() => ({ inserted: 0, updated: 0, deleted: 0, total: 0 })),
  upsertExternalContacts: jest.fn(() => 0),
  markSourceRecordsCurrent: jest.fn(() => 0),
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
  getCount: jest.fn(() => 0),
}));

/**
 * The aggregate module `localSyncService` imports, forwarding to the REAL
 * contact writers. `require`d inside the factory because jest hoists mocks above
 * the imports.
 */
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    findContactByNormalizedPhone: (userId: string, normalized: string) =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../db/contactDbService").findContactByNormalizedPhone(userId, normalized),
    createContactsBatch: (rows: unknown[]) =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../db/contactDbService").createContactsBatch(rows),
  },
}));

import localSyncService from "../localSyncService";
import type { SyncContact } from "../../types/localSync";

type StoreContacts = (
  userId: string,
  deviceId: string,
  contacts: SyncContact[],
  isFullSync?: boolean,
) => number;

const storeContacts = (
  localSyncService as unknown as { storeContacts: StoreContacts }
).storeContacts.bind(localSyncService);

const USER = "user-2987";
// pii-allow-uuid: a hand-written placeholder device id, not a real record — the digits are a visible pattern, never generated
const DEVICE = "11111111-2222-4333-8444-555555555555";

/**
 * THREE SHAPES, one per branch of the old phone-only test. Every value invented.
 *
 *  - `phone-and-email` has a matchable phone — the 363 that always worked.
 *  - `email-only`      has no phone at all — never entered the phone loop.
 *  - `short-code-only` has a phone BELOW the 7-digit matching floor, so
 *                      `toMatchingKey` returns "" and the loop `continue`s past
 *                      it. Same outcome by a different route, and it is the one
 *                      member of the founder's 26 that carried no email.
 */
const ADDRESS_BOOK: SyncContact[] = [
  {
    id: "phone-and-email",
    displayName: "Fixture One",
    phones: [{ number: "+15550100" + "1" }],
    emails: [{ address: "one@example.test" }],
  },
  {
    id: "email-only",
    displayName: "Fixture Two",
    phones: [],
    emails: [{ address: "two@example.test" }],
  },
  {
    id: "short-code-only",
    displayName: "22395",
    phones: [{ number: "22395" }],
    emails: [],
  },
];

/** Every contact id on disk with its display name — an exact set, not a count. */
function contactsOnDisk(): Array<{ id: string; display_name: string }> {
  return mockDb!
    .prepare("SELECT id, display_name FROM contacts ORDER BY display_name, id")
    .all() as Array<{ id: string; display_name: string }>;
}

/** Every display name on disk, with duplicates preserved — duplicates ARE the bug. */
function displayNames(): string[] {
  return contactsOnDisk().map((c) => c.display_name);
}

/** Every crosswalk claim on disk, as `source_type|source_record_id`. */
function claims(): string[] {
  return (
    mockDb!
      .prepare(
        `SELECT source_type, source_record_id FROM contact_source_links
          ORDER BY source_type, source_record_id`,
      )
      .all() as Array<{ source_type: string; source_record_id: string }>
  ).map((r) => `${r.source_type}|${r.source_record_id}`);
}

beforeEach(() => {
  mockDb = openTestDb(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("promoting the same Android address book twice (BACKLOG-2987)", () => {
  it("the FIRST sync creates all three, whatever their shape", () => {
    storeContacts(USER, DEVICE, ADDRESS_BOOK, true);

    expect(displayNames()).toEqual(["22395", "Fixture One", "Fixture Two"]);
  });

  it("the SECOND sync of an unchanged address book creates NOTHING", () => {
    storeContacts(USER, DEVICE, ADDRESS_BOOK, true);
    const afterFirst = displayNames();

    storeContacts(USER, DEVICE, ADDRESS_BOOK, true);

    // Exact set, duplicates included. A count would pass on a run that deleted
    // one contact and created another.
    expect(displayNames()).toEqual(afterFirst);
    expect(displayNames()).toEqual(["22395", "Fixture One", "Fixture Two"]);
  });

  it("nor a THIRD, which is where the founder's log had already produced 78 duplicate rows", () => {
    storeContacts(USER, DEVICE, ADDRESS_BOOK, true);
    storeContacts(USER, DEVICE, ADDRESS_BOOK, true);
    storeContacts(USER, DEVICE, ADDRESS_BOOK, true);

    expect(displayNames()).toEqual(["22395", "Fixture One", "Fixture Two"]);
  });

  it("the two shapes the PHONE probe cannot answer for are the ones that repeated", () => {
    // Named precisely so a regression says WHICH shape came back, and so the
    // suite records what actually distinguished the founder's 26 from his 363.
    storeContacts(USER, DEVICE, ADDRESS_BOOK, true);
    const idByName = new Map(contactsOnDisk().map((c) => [c.display_name, c.id]));

    storeContacts(USER, DEVICE, ADDRESS_BOOK, true);

    // The same ROWS, not merely the same number of rows — nothing was replaced.
    for (const [name, id] of idByName) {
      const rows = contactsOnDisk().filter((c) => c.display_name === name);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
    }
  });

  it("each promoted contact claims its record exactly once", () => {
    storeContacts(USER, DEVICE, ADDRESS_BOOK, true);
    storeContacts(USER, DEVICE, ADDRESS_BOOK, true);

    // Two kinds of row live under `android_sync`, both written by
    // `writeContactOriginInTransaction`: the RECORD claim (what this item's
    // probe reads) and the synthetic `origin:<contactId>` floor row that every
    // contact gets whatever its provenance. Asserted separately so a regression
    // that stopped writing the record claim — and left the floor rows behind,
    // which is precisely the `{ kind: "derived" }` state BACKLOG-2556 removed —
    // cannot hide inside a total.
    const all = claims().filter((c) => c.startsWith("android_sync|"));
    expect(all.filter((c) => c.startsWith("android_sync|android-"))).toEqual([
      `android_sync|android-${DEVICE}-email-only`,
      `android_sync|android-${DEVICE}-phone-and-email`,
      `android_sync|android-${DEVICE}-short-code-only`,
    ]);
    expect(all.filter((c) => c.startsWith("android_sync|origin:"))).toHaveLength(3);
  });

  it("a phone that presents a DIFFERENT device id re-creates everything — the other half of this item", () => {
    // This is the state BEFORE the companion fix: every re-pair minted a new
    // UUID, so the claim key changed and no probe could match. It is asserted
    // rather than described so that "the desktop fix alone is not sufficient"
    // is a fact in the suite instead of a claim in a comment.
    // pii-allow-uuid: a hand-written placeholder device id, not a real record — the digits are a visible pattern, never generated
    const OTHER_DEVICE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    storeContacts(USER, DEVICE, ADDRESS_BOOK, true);
    storeContacts(USER, OTHER_DEVICE, ADDRESS_BOOK, true);

    // The phone-bearing contact is still caught by the phone probe. The two the
    // phone probe cannot see come back — exactly the founder's shape.
    expect(displayNames()).toEqual([
      "22395",
      "22395",
      "Fixture One",
      "Fixture Two",
      "Fixture Two",
    ]);
  });
});
