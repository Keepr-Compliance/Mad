/**
 * @jest-environment node
 *
 * BACKLOG-2986 — WHAT THE ANDROID CONTACT WRITE ACTUALLY COSTS.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * `PREFERENCES_READ_TIMEOUT_MS` splits a budget with a hard ceiling: the
 * companion aborts the POST at `REQUEST_TIMEOUT_MS = 10_000`
 * (`android-companion/services/syncService.ts:120`). Whatever the preference
 * read is allowed to take, the DB write and the response have to fit in what is
 * left.
 *
 * The first version of that split reserved 7s for the write and gave the read
 * 3s. **The 7s was an estimate. Nobody had run it.** And it was the wrong way
 * round: the read is the variable half — a Supabase round trip over whatever
 * connection the desktop has — while the write is local `better-sqlite3`.
 *
 * MEASURED HERE, three runs, +/-5ms: **121ms for 389 contacts, 358ms for 2,200,
 * 88ms for a re-sync where every contact is already claimed.** Roughly twenty
 * times smaller than the reservation it replaced. The split is now 6s for the
 * read and ~4s for everything else — eleven times the measured write.
 *
 * That matters for this item's own promise. A read that WOULD have returned a
 * stored `androidContacts: false` at 3.5s was abandoned, fail-open applied, and
 * an OFF switch silently promoted. Failing open on an UNAVAILABLE preference is
 * right; doing it because the read was merely slow is not.
 *
 * ===========================================================================
 * THIS SUITE IS THE MEASUREMENT, AND IT IS RE-RUNNABLE
 * ===========================================================================
 * It drives the real write path at full address-book size and prints the
 * elapsed time. **It does NOT assert a duration** — a wall-clock assertion on a
 * shared CI runner is a flake generator, and this repo has enough real reds. It
 * asserts the write is CORRECT at that size (every contact promoted, exactly
 * once), which nothing else in the repo does: the next largest fixture is three
 * contacts.
 *
 * The number in `PREFERENCES_READ_TIMEOUT_MS`'s docblock comes from running
 * this. Re-run it and the docblock's claim is checkable rather than inherited:
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/__tests__/localSyncService.writeCost-2986.test.ts
 *
 * ===========================================================================
 * WHAT THE MEASUREMENT DOES AND DOES NOT COVER — read before quoting it
 * ===========================================================================
 * COVERED: the real `syncContactsBySource` shadow write, the real
 * `findContactByNormalizedPhone` probe per contact, the real
 * `createContactsBatch` insert with its addresses and crosswalk claims, over a
 * real ON-DISK SQLite file (not `:memory:`, which would understate it by
 * removing the filesystem entirely).
 *
 * NOT COVERED, and the headroom below is sized for it:
 *   - **Encryption.** Production runs better-sqlite3-multiple-ciphers with a
 *     key; this file is unencrypted, so every page read and write here is
 *     cheaper than the real one.
 *   - A cold page cache, a busy disk, and a Windows filesystem.
 *   - Whatever else the desktop is doing during a sync.
 *
 * So the figure is a FLOOR on the write, not a ceiling. It is still worth far
 * more than the 7s guess it replaces, because it establishes the order of
 * magnitude — and the order of magnitude is what the split was wrong about.
 *
 * FIXTURES ARE GENERATED, not transcribed: names are `Bench Fixture <n>`,
 * numbers are inside the reserved-for-fiction `+1 <area> 555-01xx` range, and
 * addresses use `example.test`.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { openTestDb, type TestDb } from "./helpers/syncSqliteDriver";
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";

let mockDb: TestDb | null = null;
let dbFile: string | null = null;

const mockGetPreferences = jest.fn();

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
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => dbFile ?? "/fake/path/mad.db",
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
  default: {
    getClient: () => ({ auth: { getUser: jest.fn() } }),
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
  },
}));

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
) => Promise<number>;

const storeContacts = (
  localSyncService as unknown as { storeContacts: StoreContacts }
).storeContacts.bind(localSyncService);

const USER = "user-2986-cost";
// pii-allow-uuid: a hand-written placeholder device id, not a real record — the digits are a visible pattern, never generated
const DEVICE = "33333333-4444-4555-8666-777777777777";

/**
 * The founder's own sync was 389 contacts; the companion capacity fixture is
 * ~2,200. Both are generated, never transcribed.
 *
 * Phone shape `+1 <area> 555-01<nn>`: the reserved-for-fiction exchange with a
 * rolling area code, which is what makes 2,200 DISTINCT numbers possible while
 * staying inside the range the PII guard permits. Distinct matters — identical
 * numbers would collapse in the phone probe and measure the wrong thing.
 *
 * ONE IN TEN CARRIES NO PHONE, and that is not decoration. An all-phone book is
 * protected on a re-sync by `findContactByNormalizedPhone` alone: every contact
 * matches an existing one and is skipped, so the BACKLOG-2987 crosswalk claims
 * never have to do anything. Proven by mutation — disabling the claims skip left
 * this suite fully GREEN while `promoteTwice-2987` went red, because that suite
 * uses precisely the shapes the phone probe cannot answer for.
 *
 * A control whose "creates nothing" is carried by a mechanism it did not intend
 * to test is a control that would not notice the mechanism it did. The
 * email-only tenth restores that: the re-sync case below now exercises the phone
 * probe AND the claims, at full size.
 */
function addressBook(size: number): SyncContact[] {
  return Array.from({ length: size }, (_unused, i) => {
    const area = 200 + Math.floor(i / 100);
    const line = String(i % 100).padStart(2, "0");
    const emailOnly = i % 10 === 0;
    return {
      id: `bench-${i}`,
      displayName: `Bench Fixture ${i}`,
      phones: emailOnly ? [] : [{ number: `+1${area}55501${line}` }],
      emails: [{ address: `bench-${i}@example.test` }],
    };
  });
}

function contactCount(): number {
  return (
    mockDb!
      .prepare("SELECT COUNT(*) AS n FROM contacts WHERE user_id = ?")
      .get(USER) as { n: number }
  ).n;
}

beforeEach(() => {
  dbFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "keepr-writecost-")),
    "bench.db",
  );
  mockDb = openTestDb(dbFile);
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  // The shared helper's `external_contacts` is a deliberately minimal shape
  // (see its own docblock) and omits columns the REAL shadow write touches.
  // The other localSync suites do not hit this because they mock
  // `externalContactDbService` away; this one runs it, because the shadow write
  // is half of what is being measured.
  //
  // TRANSCRIBED FROM THEIR PRODUCERS, not invented:
  //   `source_identity_json`  — databaseService.ts:3172 (the v-migration ALTER)
  //   `last_message_at`       — electron/database/schema.sql, external_contacts
  //   `sync_session_id`       — electron/database/schema.sql, external_contacts
  for (const ddl of [
    "ALTER TABLE external_contacts ADD COLUMN source_identity_json TEXT",
    "ALTER TABLE external_contacts ADD COLUMN last_message_at DATETIME",
    "ALTER TABLE external_contacts ADD COLUMN sync_session_id TEXT",
  ]) {
    mockDb.exec(ddl);
  }
  // The recency UPDATE that `syncContactsBySource` runs at the end of the
  // shadow write. It is called MODULE-INTERNALLY
  // (`externalContactDbService.ts:775,810,849`), so it cannot be stubbed from
  // out here — the tables have to exist. Transcribed verbatim from
  // `db/__tests__/externalContactDbService.recency.test.ts:82-103`, the suite
  // that owns this statement, rather than re-derived here.
  //
  // They stay EMPTY, and the figure is quoted with that stated: this step is
  // O(messages), not O(contacts), so it is the same work whether one contact
  // arrived or two thousand — it is not part of what the budget scales with.
  mockDb.exec(`
    CREATE TABLE phone_last_message (
      phone_normalized TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_message_at DATETIME NOT NULL,
      PRIMARY KEY (phone_normalized, user_id)
    );
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      sent_at DATETIME,
      received_at DATETIME
    );
    CREATE TABLE email_participants (
      email_id TEXT NOT NULL,
      role TEXT NOT NULL,
      position INTEGER NOT NULL,
      email_address TEXT NOT NULL,
      PRIMARY KEY (email_id, role, position)
    );
    CREATE INDEX idx_email_participants_email_address ON email_participants(email_address);
  `);
  jest.clearAllMocks();
  // Resolves immediately, so the elapsed time below is the WRITE and nothing
  // else. Measuring the read here would measure this mock.
  mockGetPreferences.mockResolvedValue({
    phone_type: "android",
    contactSources: { direct: { androidContacts: true } },
  });
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
  if (dbFile) {
    fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
    dbFile = null;
  }
});

describe("BACKLOG-2986 — the cost of an Android contact write, measured", () => {
  for (const size of [389, 2200]) {
    it(`writes and promotes a ${size}-contact address book correctly`, async () => {
      const book = addressBook(size);

      const startedAt = Date.now();
      await storeContacts(USER, DEVICE, book, true);
      const elapsedMs = Date.now() - startedAt;

      // The assertion is CORRECTNESS at this size, not the clock. Nothing else
      // in the repo drives this path with more than three contacts.
      expect(contactCount()).toBe(size);

      // Printed, not asserted. This is the number the timeout docblock cites,
      // so it is re-derived on every run rather than inherited from a comment.
      // `process.stdout.write` rather than `console.log`: jest captures console
      // output and this suite exists to be read.
      process.stdout.write(
        `\n[BACKLOG-2986] storeContacts write: ${size} contacts in ${elapsedMs}ms ` +
          `(on-disk unencrypted SQLite; production adds page encryption)\n`,
      );
    });
  }

  it("a second sync of the same book creates nothing and costs less", async () => {
    // The steady state after the first full snapshot — what a real desktop does
    // every 24h once it is caught up.
    //
    // WHICH MECHANISM ACTUALLY CARRIES THIS, established by mutation rather than
    // by reading the code:
    //   - Disable the BACKLOG-2987 claims skip -> this case goes RED. The
    //     email-only tenth is re-created, because the phone probe cannot see a
    //     contact with no phone. The claims are load-bearing.
    //   - Disable `findContactByNormalizedPhone` -> this case stays GREEN, and
    //     that is correct, not a hole: after the first sync every contact is
    //     claimed, so the claims skip already covers the nine tenths the probe
    //     would have. On the RE-SYNC path the probe is redundant.
    // Recorded because the second result looks like a missing control until you
    // know why, and the first is the reason the fixture is not all-phone.
    const book = addressBook(2200);
    await storeContacts(USER, DEVICE, book, true);

    const startedAt = Date.now();
    await storeContacts(USER, DEVICE, book, true);
    const elapsedMs = Date.now() - startedAt;

    expect(contactCount()).toBe(2200);
    process.stdout.write(
      `\n[BACKLOG-2986] storeContacts re-sync (all skipped): 2200 contacts in ${elapsedMs}ms\n`,
    );
  });
});
