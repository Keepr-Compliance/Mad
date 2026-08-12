/**
 * BACKLOG-2571 — the ignore key survives `sent_at` changing meaning.
 *
 * WHAT BREAKS WITHOUT THIS
 *
 * `ignored_communications` identifies a dismissed email by
 * (scope, sender, subject, timestamp), matched with EXACT string equality. The
 * timestamp is copied out of an email row's `sent_at`
 * (`transactionService.unlinkCommunication`).
 *
 * BACKLOG-2571 changed what `sent_at` means — receive time before, sender
 * asserted send time after. So the table ends up holding keys written under two
 * different semantics, and a single-value equality match misses whichever half
 * it was not handed. A miss is not cosmetic: an email the founder explicitly
 * dismissed comes back on the next scan, and he has to dismiss it again.
 *
 * The bridge is `email_sent_at IN (?, ?)` — offer both candidate timestamps and
 * a key written under either semantics still matches.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CLAIM
 *
 * It does not claim the regression is fully closed. The live scan path
 * (`transactionService._saveCommunications`) looks up with a timestamp derived
 * from the FETCHED message, while the write path keys off a DB row, and those
 * two do not necessarily name the same instant. Re-keying on
 * `message_id_header`/`email_id` is the real fix and is filed as the follow-up.
 * What is pinned here is that the matchers themselves accept both semantics —
 * the half this task owns.
 *
 * Fixtures: RFC 2606 domains, and timestamps in the ISO form
 * `toIsoStringOrNull` writes.
 */

import * as path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Bypass the Jest moduleNameMapper that rewrites
 * `better-sqlite3-multiple-ciphers` to the auto-mock (jest.config.js). The
 * mock's `prepare().get()` returns `undefined` for everything, so an
 * `IN (?, ?)` matcher would "pass" its negative cases and fail its positive
 * ones without ever executing SQL — a suite that cannot tell a working query
 * from a broken one. This file needs the real engine because the whole subject
 * is what the SQL matches.
 *
 * Same idiom as databaseService.onDiskUpgrade.test.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

/**
 * The matchers run through the module's shared connection helpers, so the test
 * points those at an in-memory database rather than reaching for the real one.
 */
let db: DatabaseType;

jest.mock("../core/dbConnection", () => ({
  __esModule: true,
  dbGet: (sql: string, params: unknown[]) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[]) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[]) => db.prepare(sql).run(...(params as never[])),
}));

import {
  isEmailIgnoredForTransaction,
  isEmailIgnoredByUser,
} from "../communicationDbService";

const USER_ID = "user-2571";
const TXN_ID = "txn-2571";
const SENDER = "agent@example.com";
const SUBJECT = "Closing docs";

/** The two semantics the one column now holds, nine minutes apart. */
const RECEIVE_TIME = "2026-08-05T20:22:41.000Z";
const SEND_TIME = "2026-08-05T20:13:41.000Z";

beforeEach(() => {
  db = new RealDatabase(":memory:");
  // Sanity: the real engine, not the auto-mock. Without this the negative
  // assertions below would pass against a mock that returns undefined for
  // everything, and the file would prove nothing.
  expect(db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
  db.exec(`
    CREATE TABLE ignored_communications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      transaction_id TEXT,
      email_subject TEXT,
      email_sender TEXT,
      email_sent_at TEXT
    );
  `);
});

afterEach(() => {
  db.close();
});

function seedIgnore(id: string, sentAt: string) {
  db.prepare(
    `INSERT INTO ignored_communications
       (id, user_id, transaction_id, email_subject, email_sender, email_sent_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, USER_ID, TXN_ID, SUBJECT, SENDER, sentAt);
}

describe("ignore-key bridge across the sent_at meaning change (BACKLOG-2571)", () => {
  describe("isEmailIgnoredByUser (user-scoped — the scan filter)", () => {
    it("T6a: a LEGACY key (receive time) still matches when both timestamps are offered", async () => {
      seedIgnore("ig-legacy", RECEIVE_TIME);

      // A post-2571 caller leads with the send time, because that is what the
      // email row's sent_at now holds. Without the second candidate this is the
      // lookup that misses and the dismissed email returns.
      await expect(
        isEmailIgnoredByUser(USER_ID, SENDER, SUBJECT, SEND_TIME, RECEIVE_TIME),
      ).resolves.toBe(true);
    });

    it("T6b: a NEW key (send time) matches too — the bridge works in both directions", async () => {
      seedIgnore("ig-new", SEND_TIME);

      await expect(
        isEmailIgnoredByUser(USER_ID, SENDER, SUBJECT, SEND_TIME, RECEIVE_TIME),
      ).resolves.toBe(true);
    });

    it("T6c: offering ONE timestamp still behaves exactly as the old single-value form", async () => {
      seedIgnore("ig-legacy", RECEIVE_TIME);

      await expect(
        isEmailIgnoredByUser(USER_ID, SENDER, SUBJECT, RECEIVE_TIME),
      ).resolves.toBe(true);
      await expect(
        isEmailIgnoredByUser(USER_ID, SENDER, SUBJECT, SEND_TIME),
      ).resolves.toBe(false);
    });

    it("does not match a different sender or subject — the bridge widens the timestamp only", async () => {
      seedIgnore("ig-legacy", RECEIVE_TIME);

      await expect(
        isEmailIgnoredByUser(USER_ID, "other@example.com", SUBJECT, SEND_TIME, RECEIVE_TIME),
      ).resolves.toBe(false);
      await expect(
        isEmailIgnoredByUser(USER_ID, SENDER, "Other subject", SEND_TIME, RECEIVE_TIME),
      ).resolves.toBe(false);
      // And an unrelated timestamp pair still misses — `IN` is not a wildcard.
      await expect(
        isEmailIgnoredByUser(
          USER_ID,
          SENDER,
          SUBJECT,
          "2026-01-01T00:00:00.000Z",
          "2026-01-02T00:00:00.000Z",
        ),
      ).resolves.toBe(false);
    });

    it("does not leak across users", async () => {
      seedIgnore("ig-legacy", RECEIVE_TIME);

      await expect(
        isEmailIgnoredByUser("other-user", SENDER, SUBJECT, SEND_TIME, RECEIVE_TIME),
      ).resolves.toBe(false);
    });
  });

  describe("isEmailIgnoredForTransaction (transaction-scoped)", () => {
    // SR's R1: this matcher carries the same `email_sent_at = ?` and was NOT
    // named in the plan's §4. Fixing only the user-scoped one would let a
    // transaction-scoped dismissal come back while the user-scoped one held.
    it("T6d: a LEGACY key still matches when both timestamps are offered", async () => {
      seedIgnore("ig-legacy", RECEIVE_TIME);

      await expect(
        isEmailIgnoredForTransaction(TXN_ID, SENDER, SUBJECT, SEND_TIME, RECEIVE_TIME),
      ).resolves.toBe(true);
    });

    it("T6e: a NEW key matches too", async () => {
      seedIgnore("ig-new", SEND_TIME);

      await expect(
        isEmailIgnoredForTransaction(TXN_ID, SENDER, SUBJECT, SEND_TIME, RECEIVE_TIME),
      ).resolves.toBe(true);
    });

    it("does not leak across transactions", async () => {
      seedIgnore("ig-legacy", RECEIVE_TIME);

      await expect(
        isEmailIgnoredForTransaction("other-txn", SENDER, SUBJECT, SEND_TIME, RECEIVE_TIME),
      ).resolves.toBe(false);
    });
  });
});
