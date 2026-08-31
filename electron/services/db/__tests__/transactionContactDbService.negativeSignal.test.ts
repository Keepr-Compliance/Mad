/**
 * @jest-environment node
 *
 * BACKLOG-2366 — removing a contact from a transaction is a NEGATIVE SIGNAL.
 *
 * THE FINDING THAT SHAPES THIS FILE. The ticket asks that auto-linking must not
 * "resurrect a contact the user removed from a deal", by analogy with
 * `ignored_communications`. Tracing every writer first: **nothing in this
 * codebase ever attaches a contact to a transaction automatically.** All three
 * INSERT sites on `transaction_contacts` live in `transactionContactDbService`
 * and every caller is an explicit user action (the assign-contact IPC, the
 * create-audited-transaction payload, and the two edit modals). Auto-detected
 * deals stop short deliberately: they write a `suggested_contacts` JSON blob on
 * `transactions` and never touch the junction table.
 *
 * So there is no automatic WRITER to suppress. The real resurrection risk runs
 * the other way: auto-link READS this table to decide whose mail and messages
 * get pulled into a deal. Left unfiltered, a party the user removed would keep
 * dragging their communications back in on every sync — the same failure mode
 * `ignored_communications` prevents for individually unlinked emails, arriving
 * by a different route.
 *
 * The tombstone row IS the suppression record. That is the difference from the
 * `ignored_communications` idiom: an unlinked email has no row of its own to
 * mark, so it needs a side table; a removed role already has one worth keeping.
 * Migration v56 chose the in-row shape for exactly this reason.
 *
 * These cases lock in the READ side at the two services that decide what
 * attaches: `messageMatchingService` (the phone/email match sets) and the
 * `transaction_contacts` reads behind them.
 *
 * Fixtures use reserved values only (example.com, +1 555 01xx) per BACKLOG-2485.
 */

import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("../../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../../contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import {
  createMigrationHarness,
  type MigrationHarness,
} from "../../__tests__/helpers/migrationTestHarness";

import {
  assignContactToTransaction,
  unlinkContactFromTransaction,
} from "../transactionContactDbService";
import {
  getTransactionContactPhones,
  getTransactionContactEmails,
} from "../../messageMatchingService";
import { autoLinkNewMessagesForUser } from "../../autoLinkService";

const USER_ID = "user-2366-neg";
const TXN_A = "txn-alpha";
const TXN_B = "txn-beta";
const JANE = "contact-jane";
const OMAR = "contact-omar";

const JANE_EMAIL = "jane@example.com";
const OMAR_EMAIL = "omar@example.com";
const JANE_PHONE = "+15550101";
const OMAR_PHONE = "+15550102";

let harness: MigrationHarness;
let db: DatabaseType;

beforeEach(async () => {
  harness = createMigrationHarness({ seedV29Schema: false });
  // BACKLOG-2993: the chain that used to deliver v56's tombstone columns (and
  // v62's participant view) is gone — the regenerated schema.sql IS the
  // producer now: full shape, real UNIQUE constraint, version 70. Still no
  // hand-rolled schema; still the artefact every install actually gets.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = jest.requireActual("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = jest.requireActual("path") as typeof import("path");
  harness.db.exec(
    fs.readFileSync(
      nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql"),
      "utf8",
    ),
  );
  db = harness.db;

  // See the companion tombstone suite: the harness seeds `contacts` at its v29
  // shape, before these two real production columns.

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, 'owner@example.com', 'google', 'oauth-test')`,
  ).run(USER_ID);

  const people: Array<[string, string, string, string]> = [
    [JANE, "Jane Example", JANE_EMAIL, JANE_PHONE],
    [OMAR, "Omar Example", OMAR_EMAIL, OMAR_PHONE],
  ];
  for (const [id, name, email, phone] of people) {
    db.prepare(
      `INSERT INTO contacts (id, user_id, display_name, source, is_imported)
       VALUES (?, ?, ?, 'manual', 1)`,
    ).run(id, USER_ID, name);
    db.prepare(
      `INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, 1)`,
    ).run(`email-${id}`, id, email);
    db.prepare(
      `INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary) VALUES (?, ?, ?, 1)`,
    ).run(`phone-${id}`, id, phone);
  }

  // `status` must exist AND be non-NULL: the sweep query filters on transaction
  // eligibility (`t.status != 'rejected'` — BACKLOG-2562 replaced the dead
  // `!= 'archived'` form with the shared `LIVE_TRANSACTION_SQL_PREDICATE`), and
  // in SQL a NULL status makes that predicate NULL, which excludes the row. A
  // fixture leaving it NULL would show an empty fan-out and "prove" the filter
  // works for the wrong reason. The NULL behaviour is identical under both
  // spellings, so this fixture requirement is unchanged by the migration.
  for (const txn of [TXN_A, TXN_B]) {
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address, status) VALUES (?, ?, '123 Test St', 'active')`,
    ).run(txn, USER_ID);
  }

  await assignContactToTransaction(TXN_A, {
    contact_id: JANE,
    specific_role: "Buyer Agent",
  });
  await assignContactToTransaction(TXN_A, {
    contact_id: OMAR,
    specific_role: "Seller Agent",
  });
});

afterEach(async () => {
  await harness.cleanup();
});

// ---------------------------------------------------------------------------
// The match sets. These are what decide which messages and emails get pulled
// into a transaction on every sync.
//
// INJECTED-DEFECT CONTROL: drop `AND tc.removed_at IS NULL` from
// getTransactionContactPhones (messageMatchingService.ts) and the phone case
// below goes red — the removed party's number is back in the match set.
// Likewise for getTransactionContactEmails and the email case.
// ---------------------------------------------------------------------------
describe("a removed party drops out of the auto-link match sets", () => {
  it("stops contributing a phone number to the transaction's match set", async () => {
    const before = (await getTransactionContactPhones(TXN_A))
      .map((r) => r.phone)
      .sort();
    expect(before).toEqual([JANE_PHONE, OMAR_PHONE]);

    await unlinkContactFromTransaction(TXN_A, JANE, "Not on this deal");

    const after = await getTransactionContactPhones(TXN_A);
    // Exact identity set, not a count: the surviving party must still match.
    expect(after.map((r) => r.phone)).toEqual([OMAR_PHONE]);
    expect(after.map((r) => r.contactId)).toEqual([OMAR]);
  });

  it("stops contributing an email address to the transaction's match set", async () => {
    const before = (await getTransactionContactEmails(TXN_A))
      .map((r) => r.email)
      .sort();
    expect(before).toEqual([JANE_EMAIL, OMAR_EMAIL]);

    await unlinkContactFromTransaction(TXN_A, JANE, "Not on this deal");

    const after = await getTransactionContactEmails(TXN_A);
    expect(after.map((r) => r.email)).toEqual([OMAR_EMAIL]);
    expect(after.map((r) => r.contactId)).toEqual([OMAR]);
  });

  it("re-adding the party puts them back in the match sets", async () => {
    await unlinkContactFromTransaction(TXN_A, JANE, "Removed by mistake");
    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Buyer Agent",
    });

    expect((await getTransactionContactPhones(TXN_A)).map((r) => r.phone).sort()).toEqual(
      [JANE_PHONE, OMAR_PHONE],
    );
    expect((await getTransactionContactEmails(TXN_A)).map((r) => r.email).sort()).toEqual(
      [JANE_EMAIL, OMAR_EMAIL],
    );
  });

  it("suppresses only the deal the party was removed from", async () => {
    await assignContactToTransaction(TXN_B, {
      contact_id: JANE,
      specific_role: "Lender",
    });

    await unlinkContactFromTransaction(TXN_A, JANE, "Off deal A only");

    expect((await getTransactionContactPhones(TXN_A)).map((r) => r.phone)).toEqual([
      OMAR_PHONE,
    ]);
    // Deal B is untouched — the suppression is per-transaction, exactly like
    // ignored_communications.
    expect((await getTransactionContactPhones(TXN_B)).map((r) => r.phone)).toEqual([
      JANE_PHONE,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The other half of the negative-signal contract: the post-sync auto-link sweep
// must not offer a removed pair back to the linker.
//
// This drives the REAL `autoLinkNewMessagesForUser` rather than re-typing its
// SQL into the test. A copied query would pass no matter what production did —
// it would assert that SQLite works, not that autoLinkService filters. The
// observable is the pair fan-out: every pair the production query returns is
// either processed or errors, so `pairsProcessed + totalErrors` is exactly the
// row count that query produced.
//
// INJECTED-DEFECT CONTROL: drop `AND tc.removed_at IS NULL` from the sweep query
// in autoLinkService.ts and the fan-out stays at 3 after the removal, so this
// case goes red.
// ---------------------------------------------------------------------------
describe("the post-sync auto-link sweep skips removed pairs", () => {
  async function sweepFanOut(userId: string): Promise<number> {
    const r = await autoLinkNewMessagesForUser(userId);
    return r.pairsProcessed + r.totalErrors;
  }

  it("drops the removed pair and keeps every other one", async () => {
    await assignContactToTransaction(TXN_B, {
      contact_id: JANE,
      specific_role: "Lender",
    });

    // Jane on both deals, Omar on one.
    expect(await sweepFanOut(USER_ID)).toBe(3);

    await unlinkContactFromTransaction(TXN_A, JANE, "Off deal A");

    // Jane/deal-A is gone; Jane/deal-B and Omar/deal-A remain.
    expect(await sweepFanOut(USER_ID)).toBe(2);
  });

  it("restores the pair when the party is re-added", async () => {
    await unlinkContactFromTransaction(TXN_A, JANE, "Off deal A");
    expect(await sweepFanOut(USER_ID)).toBe(1);

    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Buyer Agent",
    });
    expect(await sweepFanOut(USER_ID)).toBe(2);
  });
});
