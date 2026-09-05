/**
 * @jest-environment node
 *
 * BACKLOG-3103 — the rejected-deal status must reach SQLite as a BOUND
 * PARAMETER, not as text hand-quoted into the statement.
 *
 * ## What this file watches, and how
 *
 * Runs against a REAL in-memory better-sqlite3 database wired through the real
 * `dbConnection` via `setDb` — the defect IS the statement text and its params,
 * so a mocked conduit could not see it. The handle handed to `setDb` is a
 * `Proxy` that records, for every `prepare`, the EXACT SQL text and the EXACT
 * params array the driver was called with, plus the rows it returned. Every
 * assertion below reads that recording, so it is a claim about what the driver
 * received rather than about what a constant in a module says.
 *
 * ## The base state, transcribed rather than described
 *
 * At `1ba6557ff` (before the fix) the four sites emitted a quoted literal. The
 * pair query, verbatim from this file's own recorder:
 *
 *     WHERE t.user_id = ?
 *       AND t.status != 'rejected'
 *       AND tc.removed_at IS NULL
 *
 * with `params = ["user-3103"]`. That is what `it("… no site sends a quoted
 * status literal …")` fails on when run against the pre-fix tree: the control
 * was run in exactly that state and went red, then green after binding. See the
 * PR body for both runs.
 *
 * ## The four sites
 *
 *   A  autoLinkService.countContactCandidateTransactions       predicate last
 *   B  autoLinkService.getOtherCandidateTransactionAddresses   predicate last AFTER
 *                                                              BACKLOG-3103 reordered it
 *   C  autoLinkService.autoLinkNewMessagesForUser (pair query) predicate last
 *   D  importPlanInputs.readNonRejectedTransactions            predicate last
 *
 * ## Why site D is asserted on `started_at` and not on `id`
 *
 * `readNonRejectedTransactions` selects `started_at, created_at, closed_at` and
 * no id — that is its production shape and changing it to suit a test would be
 * testing a different statement. Each fixture deal is therefore given a UNIQUE
 * `started_at`, and the exact SET of those values is the exact set of deals. The
 * mapping is stated once, here, so the assertion is still about identity:
 *
 *     txn-rejected   2020-01-01T00:00:00.000Z
 *     txn-live       2021-01-01T00:00:00.000Z
 *     txn-pending    2022-01-01T00:00:00.000Z
 *     txn-closed     2023-01-01T00:00:00.000Z
 *     txn-null       2024-01-01T00:00:00.000Z
 *
 * All assertions are exact SETS or exact values, never counts of anonymous rows.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

// Mocks must be registered before the SUT is imported.
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: { info: noop, warn: noop, error: noop, debug: noop },
  };
});

import { setDb, dbAll } from "../db/core/dbConnection";
import { sql } from "../db/core/sqlText";
import {
  LIVE_TRANSACTION_SQL_PREDICATE,
  LIVE_TRANSACTION_SQL_PREDICATE_UNALIASED,
  withLiveTransactionParam,
} from "../db/core/transactionEligibilitySql";
import { REJECTED_TRANSACTION_STATUS } from "../transactionEligibility";
import {
  countContactCandidateTransactions,
  getOtherCandidateTransactionAddresses,
  autoLinkNewMessagesForUser,
} from "../autoLinkService";
import { readNonRejectedTransactions } from "../importPlanInputs";

// ---------------------------------------------------------------------------
// Fixture identities. Every deal carries the shared contact, so the ONLY thing
// separating them in every statement under test is `status`.
// ---------------------------------------------------------------------------
const USER_ID = "user-3103";
const CONTACT = "contact-3103";

const TXN_REJECTED = "txn-rejected";
const TXN_LIVE = "txn-live";
const TXN_PENDING = "txn-pending";
const TXN_CLOSED = "txn-closed";
const TXN_NULL = "txn-null";

/** id -> started_at, the mapping site D's assertions are read through. */
const STARTED_AT: Record<string, string> = {
  [TXN_REJECTED]: "2020-01-01T00:00:00.000Z",
  [TXN_LIVE]: "2021-01-01T00:00:00.000Z",
  [TXN_PENDING]: "2022-01-01T00:00:00.000Z",
  [TXN_CLOSED]: "2023-01-01T00:00:00.000Z",
  [TXN_NULL]: "2024-01-01T00:00:00.000Z",
};

const ADDRESS: Record<string, string> = {
  [TXN_REJECTED]: "742 Evergreen Terrace",
  [TXN_LIVE]: "100 Oak Street",
  [TXN_PENDING]: "200 Elm Avenue",
  [TXN_CLOSED]: "300 Maple Court",
  [TXN_NULL]: "400 Birch Lane",
};

/** Every deal EXCEPT the rejected one. The set the rule must admit. */
const LIVE_DEALS = [TXN_LIVE, TXN_PENDING, TXN_CLOSED];

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------
interface Emitted {
  text: string;
  params: unknown[];
  rows: unknown[];
}

let db: DatabaseType;
let emitted: Emitted[] = [];

/**
 * Wrap a real database handle so every `prepare` records the text, and every
 * `all`/`get` on the resulting statement records its params and its rows.
 *
 * The wrapper returns the driver's own values untouched — it observes, it does
 * not substitute. If it altered one character the behavioural assertions below
 * would be measuring the wrapper rather than the app.
 */
function recording(real: DatabaseType): DatabaseType {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (text: string) => {
        const stmt = target.prepare(text);
        return new Proxy(stmt, {
          get(sTarget, sProp, sReceiver) {
            if (sProp !== "all" && sProp !== "get") {
              return Reflect.get(sTarget, sProp, sReceiver);
            }
            return (...params: unknown[]) => {
              const out = (sTarget[sProp] as (...a: unknown[]) => unknown)(...params);
              emitted.push({
                text,
                params,
                rows: Array.isArray(out) ? out : out === undefined ? [] : [out],
              });
              return out;
            };
          },
        });
      };
    },
  }) as DatabaseType;
}

/** The one statement emitted whose text contains `needle`. Exactly one. */
function only(needle: string): Emitted {
  const hits = emitted.filter((e) => e.text.includes(needle));
  expect(hits.map((h) => h.text.replace(/\s+/g, " ").trim())).toHaveLength(1);
  return hits[0];
}

function createSchema(database: DatabaseType): void {
  database.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT);
    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, email TEXT NOT NULL, is_primary INTEGER DEFAULT 0
    );
    CREATE TABLE contact_phones (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, phone_e164 TEXT NOT NULL, is_primary INTEGER DEFAULT 0
    );

    -- Mirrors the production CHECK. 'archived' is NOT a permitted value; NULL is
    -- permitted, which is why the NULL row below is a real state and not an
    -- invented one.
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT CHECK (status IN ('pending', 'active', 'closed', 'rejected')),
      property_address TEXT,
      property_street TEXT,
      skip_address_filter INTEGER DEFAULT 0,
      started_at DATETIME,
      created_at DATETIME,
      closed_at DATETIME,
      text_thread_count INTEGER DEFAULT 0
    );

    CREATE TABLE transaction_contacts (
      id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, contact_id TEXT NOT NULL, removed_at DATETIME
    );

    CREATE TABLE emails (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, sender TEXT, recipients TEXT, cc TEXT, bcc TEXT,
      sent_at DATETIME, subject TEXT, body_plain TEXT, thread_id TEXT
    );
    CREATE TABLE email_participants (
      email_id TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL,
      email_address TEXT NOT NULL, display_name TEXT, resolved_contact_id TEXT,
      PRIMARY KEY (email_id, role, position)
    );
    CREATE TABLE communications (
      id TEXT PRIMARY KEY, user_id TEXT, transaction_id TEXT, email_id TEXT, message_id TEXT,
      thread_id TEXT, link_source TEXT, link_confidence REAL, match_reason TEXT, linked_at DATETIME
    );
    CREATE TABLE ignored_communications (
      id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, email_id TEXT, thread_id TEXT,
      original_communication_id TEXT
    );
    CREATE TABLE pending_review_communications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, transaction_id TEXT NOT NULL, email_id TEXT,
      thread_id TEXT, found_at DATETIME
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT, thread_id TEXT, sent_at DATETIME);
  `);
}

function insertTransaction(id: string, status: string | null): void {
  db.prepare(
    `INSERT INTO transactions (id, user_id, status, property_address, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, USER_ID, status, ADDRESS[id], STARTED_AT[id], STARTED_AT[id]);
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);

  db.prepare(`INSERT INTO users_local (id, email) VALUES (?, ?)`).run(USER_ID, "agent@keepr.test");
  db.prepare(`INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)`).run(
    CONTACT,
    USER_ID,
    "Shared Party",
  );

  insertTransaction(TXN_REJECTED, "rejected");
  insertTransaction(TXN_LIVE, "active");
  insertTransaction(TXN_PENDING, "pending");
  insertTransaction(TXN_CLOSED, "closed");
  insertTransaction(TXN_NULL, null);

  for (const id of [TXN_REJECTED, TXN_LIVE, TXN_PENDING, TXN_CLOSED, TXN_NULL]) {
    db.prepare(
      `INSERT INTO transaction_contacts (id, transaction_id, contact_id, removed_at)
       VALUES (?, ?, ?, NULL)`,
    ).run(`tc-${id}`, id, CONTACT);
  }

  emitted = [];
  setDb(recording(db));
});

afterEach(() => {
  db.close();
});

/** Run every one of the four sites once, so `emitted` holds all four. */
async function exerciseAllFourSites(): Promise<void> {
  countContactCandidateTransactions(USER_ID, CONTACT);
  getOtherCandidateTransactionAddresses(USER_ID, CONTACT, TXN_LIVE);
  await autoLinkNewMessagesForUser(USER_ID);
  readNonRejectedTransactions(USER_ID);
}

// ===========================================================================
// CONTROL 3 — the must-not-fire case, stated before anything about parameters.
//
// This is the behaviour the whole item must not disturb, so it is asserted
// against the emitted rows of each statement rather than against a helper.
// ===========================================================================
describe("a rejected deal is excluded and every other status is not", () => {
  it("site A — the candidate count sees the live deals and not the rejected one", () => {
    // This site returns a COUNT, so a count is the only thing there is to assert
    // — and a count is exactly what a wrong bound value can survive. With the
    // five-deal fixture, binding 'rejected' admits {active, pending, closed} = 3
    // and binding 'closed' admits {rejected, active, pending} = 3: the SAME
    // NUMBER for the wrong set. The mutation control proved it (BACKLOG-3103,
    // mutation M1: this assertion alone stayed green).
    //
    // So the count is made identity-bearing by asking it about fixtures where
    // the right answer and every wrong answer differ in SIZE.
    expect(countContactCandidateTransactions(USER_ID, CONTACT)).toBe(LIVE_DEALS.length);

    // Only the rejected deal remains: the answer is 0 for the correct rule and
    // 1 for any other bound status, because there is one row and its status IS
    // the constant.
    db.prepare(`DELETE FROM transactions WHERE id != ?`).run(TXN_REJECTED);
    expect(countContactCandidateTransactions(USER_ID, CONTACT)).toBe(0);

    // ... and the inverse, so a rule that admits NOTHING cannot pass either:
    // restore one live deal and the answer moves to exactly 1.
    insertTransaction(TXN_LIVE, "active");
    expect(countContactCandidateTransactions(USER_ID, CONTACT)).toBe(1);
  });

  it("site B — the other-candidate addresses are exactly the live deals' addresses", () => {
    const addresses = getOtherCandidateTransactionAddresses(USER_ID, CONTACT, TXN_LIVE);
    expect([...addresses].sort()).toEqual(
      LIVE_DEALS.filter((id) => id !== TXN_LIVE)
        .map((id) => ADDRESS[id])
        .sort(),
    );
    expect(addresses).not.toContain(ADDRESS[TXN_REJECTED]);
    expect(addresses).not.toContain(ADDRESS[TXN_NULL]);
  });

  it("site C — the pair query returns exactly the live transaction ids", async () => {
    await autoLinkNewMessagesForUser(USER_ID);
    const pairQuery = only("tc.contact_id,");
    const ids = (pairQuery.rows as { transaction_id: string }[])
      .map((r) => r.transaction_id)
      .sort();
    expect(ids).toEqual([...LIVE_DEALS].sort());
  });

  it("site D — the import floor reads exactly the live deals", () => {
    const rows = readNonRejectedTransactions(USER_ID);
    expect(rows.map((r) => r.started_at).sort()).toEqual(
      LIVE_DEALS.map((id) => STARTED_AT[id]).sort(),
    );
    expect(rows.map((r) => r.started_at)).not.toContain(STARTED_AT[TXN_REJECTED]);
  });

  it("a NULL status is excluded by all four sites, exactly as the quoted form excluded it", () => {
    // The one input where a reader might expect the bound and the quoted forms to
    // differ. They do not: `x != NULL` is NULL under SQLite's three-valued logic
    // whichever side is a literal and whichever is a placeholder. Shown by
    // executing BOTH forms over the same table, not asserted in prose.
    const quoted = db
      .prepare(`SELECT id FROM transactions t WHERE t.status != 'rejected'`)
      .all() as { id: string }[];
    const bound = db
      .prepare(`SELECT id FROM transactions t WHERE t.status != ?`)
      .all(REJECTED_TRANSACTION_STATUS) as { id: string }[];

    expect(quoted.map((r) => r.id).sort()).toEqual([...LIVE_DEALS].sort());
    expect(bound.map((r) => r.id).sort()).toEqual([...LIVE_DEALS].sort());
    expect(bound.map((r) => r.id).sort()).toEqual(quoted.map((r) => r.id).sort());
  });
});

// ===========================================================================
// CONTROL 1 — the status reaches the driver as a PARAMETER, not as text.
//
// This is the assertion that was RED before the fix: the pre-fix tree put
// `'rejected'` in the statement and nothing in the params.
// ===========================================================================
describe("the status is bound, not spliced", () => {
  it("no site sends a quoted status literal to the driver", async () => {
    await exerciseAllFourSites();

    const withPredicate = emitted.filter((e) => /\bstatus\s*!=/.test(e.text));
    expect(withPredicate).toHaveLength(4);

    for (const e of withPredicate) {
      expect(e.text).not.toContain(`'${REJECTED_TRANSACTION_STATUS}'`);
      expect(e.text).not.toContain(`"${REJECTED_TRANSACTION_STATUS}"`);
      // Nothing quoted at all where the status used to be.
      expect(e.text).toMatch(/status\s*!=\s*\?/);
    }
  });

  it("every site passes the status in its params instead", async () => {
    await exerciseAllFourSites();

    const withPredicate = emitted.filter((e) => /\bstatus\s*!=/.test(e.text));
    expect(withPredicate).toHaveLength(4);

    for (const e of withPredicate) {
      expect(e.params).toContain(REJECTED_TRANSACTION_STATUS);
    }
  });

  it("the status is the LAST param at every site, which is the fragment's contract", async () => {
    await exerciseAllFourSites();

    const withPredicate = emitted.filter((e) => /\bstatus\s*!=/.test(e.text));
    expect(withPredicate).toHaveLength(4);

    // The position rule from `transactionEligibilitySql`'s docblock, held by
    // execution rather than by memory: the fragment is the last placeholder, so
    // its value is the last param, at all four sites including the one that was
    // reordered to make it so.
    for (const e of withPredicate) {
      // The value is appended, so it is last in the array...
      expect(e.params[e.params.length - 1]).toBe(REJECTED_TRANSACTION_STATUS);

      // ...and the TEXT has to agree, or the append lands on the wrong `?` and
      // every placeholder after the fragment silently shifts by one. So: the
      // fragment's own placeholder must BE the last placeholder in the
      // statement, not merely be followed by one.
      //
      // An earlier spelling of this asserted `lastPlaceholder > predicateStart`,
      // which is true whenever ANY placeholder follows — i.e. exactly in the
      // broken case. It survived the position mutation (BACKLOG-3103, M2). This
      // spelling does not.
      const match = /\bstatus\s*!=\s*\?/.exec(e.text);
      expect(match).not.toBeNull();
      const predicatePlaceholder = e.text.indexOf("?", match!.index);
      expect(predicatePlaceholder).toBe(e.text.lastIndexOf("?"));
    }
  });

  it("the params array is otherwise unchanged — one extra element, appended", async () => {
    await exerciseAllFourSites();

    const siteA = only("COUNT(DISTINCT tc.transaction_id)");
    expect(siteA.params).toEqual([CONTACT, USER_ID, REJECTED_TRANSACTION_STATUS]);

    const siteB = only("COALESCE(t.property_address");
    expect(siteB.params).toEqual([CONTACT, USER_ID, TXN_LIVE, REJECTED_TRANSACTION_STATUS]);

    const siteC = only("tc.contact_id,");
    expect(siteC.params).toEqual([USER_ID, REJECTED_TRANSACTION_STATUS]);

    const siteD = only("started_at, created_at, closed_at");
    expect(siteD.params).toEqual([USER_ID, REJECTED_TRANSACTION_STATUS]);
  });
});

// ===========================================================================
// CONTROL 6 — the four sites can now go through the `sql` tag.
//
// This is what BACKLOG-3044 PR 5 is waiting on. The MOVE is that item's; what
// is proved here is that the refusal is gone: the tag takes `SafeSql[]`, so a
// `string` fragment does not compile and a branded one does. If this file
// compiles, the fragment is branded — and it also runs, so the branding did not
// come at the cost of the statement working.
// ===========================================================================
describe("the fragment now composes through the sql tag", () => {
  it("an aliased statement built exactly as BACKLOG-3044 builds one compiles and runs", () => {
    const statement = sql`
      SELECT t.id AS id
      FROM transactions t
      WHERE t.user_id = ?
        AND ${LIVE_TRANSACTION_SQL_PREDICATE}
    `;
    const rows = dbAll<{ id: string }>(statement, withLiveTransactionParam([USER_ID]));
    expect(rows.map((r) => r.id).sort()).toEqual([...LIVE_DEALS].sort());
  });

  it("an unaliased statement does too", () => {
    const statement = sql`
      SELECT id
      FROM transactions
      WHERE user_id = ?
        AND ${LIVE_TRANSACTION_SQL_PREDICATE_UNALIASED}
    `;
    const rows = dbAll<{ id: string }>(statement, withLiveTransactionParam([USER_ID]));
    expect(rows.map((r) => r.id).sort()).toEqual([...LIVE_DEALS].sort());
  });
});
