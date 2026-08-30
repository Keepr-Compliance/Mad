/**
 * @jest-environment node
 *
 * BACKLOG-2368 — remove -> revive -> remove -> revive ROUND TRIP on a
 * transaction role. The acceptance gate for the tombstone epic.
 *
 * ===========================================================================
 * WHAT THIS ADDS OVER THE EXISTING BACKLOG-2366 SUITES
 * ===========================================================================
 * `transactionContactDbService.tombstone.test.ts` proves ONE removal tombstones
 * and ONE re-add revives. That is a single lap. It cannot see anything that only
 * goes wrong on the SECOND lap, and there is a specific reason to expect the
 * second lap to be where a defect hides:
 *
 * Every removal path is guarded by `AND removed_at IS NULL`. That predicate does
 * two jobs at once, and they pull in opposite directions:
 *
 *   - a removal REPLAYED while the row is still removed must NOT re-stamp
 *     (the first removal's timestamp is the audit-relevant one) — covered there;
 *   - a removal issued AFTER a revive MUST re-stamp, because that is a new,
 *     genuine removal of a party who really was back on the deal.
 *
 * Only the first is currently pinned. A plausible "hardening" of idempotence —
 * keying the guard on `removed_reason IS NULL`, say — satisfies the covered case
 * and silently swallows the second removal, leaving a party the user removed
 * still reading as current on an audited deal. That is the failure this file
 * exists to catch, and it is invisible to a one-lap test.
 *
 * ===========================================================================
 * EXACT ID SETS, NEVER COUNTS
 * ===========================================================================
 * `toHaveLength(1)` is satisfied just as well by the WRONG row, and "the wrong
 * party stayed on the deal" is precisely the defect that would matter. Every
 * phase assertion below names the exact contact ids, sorted, in one `toEqual` —
 * and asserts BOTH the current set and the removed set, so a filter that dropped
 * everyone fails just as loudly as one that dropped nobody.
 *
 * ===========================================================================
 * WHY TIMESTAMPS ARE NOT THE OBSERVABLE FOR "RE-STAMPED"
 * ===========================================================================
 * `removed_at` is written with SQLite's `CURRENT_TIMESTAMP`, whose resolution is
 * ONE SECOND. A full remove/revive/remove cycle completes well inside that, so
 * both removals in this suite genuinely produce the same timestamp string —
 * observed, not assumed:
 *
 *     A1 removed#1 : ... "removed_at":"2026-08-05 02:45:17","removed_reason":"REASON-1"
 *     A3 removed#2 : ... "removed_at":"2026-08-05 02:45:17","removed_reason":"REASON-2"
 *
 * So `expect(second.removed_at).not.toBe(first.removed_at)` would be a FLAKY
 * assertion that happens to pass only when a test straddles a second boundary.
 * `removed_reason` is the observable that actually distinguishes the two
 * removals, and it is what these cases assert.
 *
 * ===========================================================================
 * FIXTURE — REAL SCHEMA, REAL MIGRATION CHAIN
 * ===========================================================================
 * Tables come from the REAL `electron/database/schema.sql`, so
 * `UNIQUE(transaction_id, contact_id)` is the real constraint rather than one
 * the test author remembered to type. That constraint is the whole reason a
 * revive cannot be an INSERT — an invented fixture without it would let a
 * duplicate-row defect pass green — so the fixture-integrity case below proves
 * it actually fires rather than assuming it.
 *
 * The two tombstone columns are applied with migration v56's exact DDL,
 * transcribed from `databaseService.ts` (v56, BACKLOG-2364):
 *
 *     { name: "removed_at",     ddl: "removed_at DATETIME" },
 *     { name: "removed_reason", ddl: "removed_reason TEXT" },
 *     for (const table of ["contacts", "transaction_contacts"]) ...
 *
 * WHY `openTestDb` AND NOT THE MIGRATION HARNESS. The companion BACKLOG-2366
 * suites use `createMigrationHarness`, which hard-requires
 * `better-sqlite3-multiple-ciphers`. On a dev machine that binary is an ELECTRON
 * build (NODE_MODULE_VERSION 139) while plain node is 127, so those suites
 * cannot load it and are red locally — including under the pre-push hook.
 * `openTestDb` (BACKLOG-2427) prefers the real driver and falls back to
 * `node:sqlite`, so this suite is executable in BOTH places: CI still exercises
 * the production driver, and the assertions stay runnable while writing them.
 *
 * Fixtures use reserved fictional values only (example.com, +1 555 01xx).
 */

import { readFileSync } from "fs";
import path from "path";
import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";
import { CONTACT_SOURCE_LINKS_TABLE_SQL } from "../contactIdentitySchemaSql";

let db: TestDb;

jest.mock("../core/dbConnection", () => ({
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
  // batchUpdateContactAssignments does `ensureDb().transaction(fn)()`.
  ensureDb: () => db,
  /**
   * BACKLOG-2543 — `linkContactToTransaction` now runs its INSERT and its role
   * UPDATE in one transaction, so this mock has to provide one.
   *
   * Routed to a REAL transaction, not the `(fn) => fn()` passthrough that
   * BACKLOG-2537 removed from eleven suites: a passthrough satisfies every
   * caller while silently deleting the atomicity, which would make any
   * rollback assertion written here unfailable.
   */
  dbTransaction: <T>(fn: () => T): T => db.transaction(fn)(),
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

import {
  assignContactToTransaction,
  batchUpdateContactAssignments,
  getRemovedTransactionContacts,
  getTransactionContacts,
  getTransactionContactsWithRoles,
  isContactAssignedToTransaction,
  linkContactToTransaction,
  unlinkContactFromTransaction,
} from "../transactionContactDbService";
import {
  getTransactionContactEmails,
  getTransactionContactPhones,
} from "../../messageMatchingService";

const USER_ID = "user-2368";
const TXN_A = "txn-alpha";

const JANE = "contact-jane";
const OMAR = "contact-omar";

const JANE_EMAIL = "jane@example.com";
const OMAR_EMAIL = "omar@example.com";
const JANE_PHONE = "+15550101";
const OMAR_PHONE = "+15550102";

interface JunctionRow {
  id: string;
  contact_id: string;
  role: string | null;
  role_category: string | null;
  specific_role: string | null;
  removed_at: string | null;
  removed_reason: string | null;
  created_at: string;
}

const SCHEMA_PATH = path.join(__dirname, "../../../database/schema.sql");

/** Migration v56's exact DDL — see the file header for the source it came from. */
const V56_TOMBSTONE_DDL = [
];

/** Every junction row on a transaction, tombstoned or not — read RAW. */
function allRows(transactionId = TXN_A): JunctionRow[] {
  return db
    .prepare(
      `SELECT id, contact_id, role, role_category, specific_role,
              removed_at, removed_reason, created_at
         FROM transaction_contacts
        WHERE transaction_id = ?
        ORDER BY contact_id`,
    )
    .all(transactionId) as JunctionRow[];
}

function rowFor(contactId: string, transactionId = TXN_A): JunctionRow | undefined {
  return allRows(transactionId).find((r) => r.contact_id === contactId);
}

/** The three role fields, as one comparable value. */
function roleFieldsOf(row: JunctionRow) {
  return {
    role: row.role,
    role_category: row.role_category,
    specific_role: row.specific_role,
  };
}

/**
 * A full snapshot of what every surface says at one moment in the cycle.
 * Asserting the whole thing in ONE `toEqual` means a defect cannot hide by
 * moving between surfaces — a party who drops off the current list must show up
 * in the removed list, and vice versa.
 */
async function phase(transactionId = TXN_A) {
  const withRoles = await getTransactionContactsWithRoles(transactionId);
  const removed = await getRemovedTransactionContacts(transactionId);
  return {
    current: withRoles.map((r) => r.contact_id).sort(),
    removed: removed.map((r) => r.contact_id).sort(),
    // The junction rows that physically exist. Identity, not count: a revive
    // that INSERTed instead of reviving shows up here as a second id.
    rowIds: allRows(transactionId).map((r) => r.id).sort(),
  };
}

beforeEach(() => {
  db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  for (const ddl of V56_TOMBSTONE_DDL) db.exec(ddl);
  db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, 'owner@example.com', 'google', 'oauth-2368')`,
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

  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '1 Example Way')`,
  ).run(TXN_A, USER_ID);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Without these the whole file is vacuous.
// ---------------------------------------------------------------------------
describe("fixture integrity", () => {
  it("v56 columns are present AND the UNIQUE constraint is the real one", () => {
    const cols = (
      db.prepare(`PRAGMA table_info(transaction_contacts)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["removed_at", "removed_reason"]));

    // The constraint that makes a revive mandatory rather than optional: with it
    // in place a second INSERT over a tombstone THROWS, so any code path that
    // "re-adds" by inserting cannot silently produce a duplicate — it fails.
    db.prepare(
      `INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, ?)`,
    ).run("dupe-1", TXN_A, JANE);
    expect(() =>
      db
        .prepare(
          `INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, ?)`,
        )
        .run("dupe-2", TXN_A, JANE),
    ).toThrow(/UNIQUE/i);
  });
});

// ---------------------------------------------------------------------------
// THE ROUND TRIP — assignContactToTransaction
//
// INJECTED-DEFECT CONTROL: drop `removed_at = NULL, removed_reason = NULL` from
// the UPDATE in assignContactToTransaction (the revive) and every "revived"
// phase below goes red — the party stays in the removed set.
// ---------------------------------------------------------------------------
describe("assignContactToTransaction — two full laps", () => {
  const ROLE = {
    specific_role: "Buyer Agent",
    role_category: "agent",
  } as const;

  const reAdd = () =>
    assignContactToTransaction(TXN_A, { contact_id: JANE, ...ROLE });

  beforeEach(async () => {
    await assignContactToTransaction(TXN_A, { contact_id: JANE, ...ROLE });
    await assignContactToTransaction(TXN_A, {
      contact_id: OMAR,
      specific_role: "Seller Agent",
      role_category: "agent",
    });
  });

  it("survives remove -> revive -> remove -> revive as ONE row with its history", async () => {
    const original = rowFor(JANE)!;
    const originalRoleFields = roleFieldsOf(original);
    const bothRowIds = allRows().map((r) => r.id).sort();

    // ── lap 0: both parties on the deal ──────────────────────────────────
    expect(await phase()).toEqual({
      current: [JANE, OMAR],
      removed: [],
      rowIds: bothRowIds,
    });

    // ── lap 1: remove ────────────────────────────────────────────────────
    await unlinkContactFromTransaction(TXN_A, JANE, "First removal");
    expect(await phase()).toEqual({
      current: [OMAR],
      removed: [JANE],
      // Still two PHYSICAL rows — the tombstone is the whole point.
      rowIds: bothRowIds,
    });

    // ── lap 1: revive ────────────────────────────────────────────────────
    await reAdd();
    expect(await phase()).toEqual({
      current: [JANE, OMAR],
      removed: [],
      rowIds: bothRowIds,
    });
    const revived1 = rowFor(JANE)!;
    expect(revived1.id).toBe(original.id);
    expect(revived1.created_at).toBe(original.created_at);
    expect(roleFieldsOf(revived1)).toEqual(originalRoleFields);
    expect(revived1.removed_reason).toBeNull();

    // ── lap 2: remove again ──────────────────────────────────────────────
    await unlinkContactFromTransaction(TXN_A, JANE, "Second removal");
    expect(await phase()).toEqual({
      current: [OMAR],
      removed: [JANE],
      rowIds: bothRowIds,
    });

    // ── lap 2: revive again ──────────────────────────────────────────────
    await reAdd();
    expect(await phase()).toEqual({
      current: [JANE, OMAR],
      removed: [],
      rowIds: bothRowIds,
    });
    const revived2 = rowFor(JANE)!;
    expect(revived2.id).toBe(original.id);
    expect(revived2.created_at).toBe(original.created_at);
    expect(roleFieldsOf(revived2)).toEqual(originalRoleFields);
  });

  it("the SECOND removal re-stamps — the idempotence guard must not swallow it", async () => {
    // The case a one-lap suite cannot see. `AND removed_at IS NULL` has to block
    // a REPLAYED removal while still admitting a genuine NEW one after a revive.
    // See the file header for why `removed_reason`, not `removed_at`, is the
    // observable here (CURRENT_TIMESTAMP has one-second resolution).
    await unlinkContactFromTransaction(TXN_A, JANE, "First removal");
    await reAdd();
    expect(rowFor(JANE)!.removed_at).toBeNull();

    await unlinkContactFromTransaction(TXN_A, JANE, "Second removal");

    const row = rowFor(JANE)!;
    expect(row.removed_at).not.toBeNull();
    // If the guard swallowed this removal the reason would still read
    // "First removal" — or the row would still be live.
    expect(row.removed_reason).toBe("Second removal");
    expect(await isContactAssignedToTransaction(TXN_A, JANE)).toBe(false);
  });

  it("a replay WHILE removed still does not re-stamp, on either lap", async () => {
    // The other half of the same guard, asserted on lap 2 as well as lap 1 —
    // sweeping the boundary rather than sampling one side of it.
    for (const lap of [1, 2]) {
      await unlinkContactFromTransaction(TXN_A, JANE, `Removal ${lap}`);
      await unlinkContactFromTransaction(TXN_A, JANE, `Replay ${lap}`);

      expect(rowFor(JANE)!.removed_reason).toBe(`Removal ${lap}`);
      await reAdd();
    }
  });

  it("removing and reviving Jane never disturbs Omar", async () => {
    const omarBefore = rowFor(OMAR)!;

    for (let lap = 0; lap < 2; lap += 1) {
      await unlinkContactFromTransaction(TXN_A, JANE, `Removal ${lap}`);
      expect(rowFor(OMAR)).toEqual(omarBefore);
      await reAdd();
      expect(rowFor(OMAR)).toEqual(omarBefore);
    }
  });

  it("getTransactionContacts agrees with the roles view at every phase", async () => {
    // Two independent readers of the same fact. They diverging is its own
    // defect class — one query filtered, the other not.
    const plainIds = async () =>
      (await getTransactionContacts(TXN_A)).map((c) => c.id).sort();

    expect(await plainIds()).toEqual([JANE, OMAR]);
    await unlinkContactFromTransaction(TXN_A, JANE, "off");
    expect(await plainIds()).toEqual([OMAR]);
    await reAdd();
    expect(await plainIds()).toEqual([JANE, OMAR]);
    await unlinkContactFromTransaction(TXN_A, JANE, "off again");
    expect(await plainIds()).toEqual([OMAR]);
  });
});

// ---------------------------------------------------------------------------
// THE ROUND TRIP — batchUpdateContactAssignments
//
// INJECTED-DEFECT CONTROL: drop `removed_at = NULL, removed_reason = NULL` from
// the `action: "add"` UPDATE branch and the revive phases go red.
// ---------------------------------------------------------------------------
describe("batchUpdateContactAssignments — two full laps", () => {
  /**
   * THE OPERATION SHAPES ARE TRANSCRIBED FROM THE REAL PRODUCER, NOT INVENTED.
   *
   * `EditContactsModal.tsx` is the only shipping caller of
   * `transactions:batchUpdateContacts`. Its add operations set all THREE role
   * fields and its remove operations set two (EditContactsModal.tsx:316-345):
   *
   *     operations.push({ action: "remove", contactId, role, specificRole: role });
   *     operations.push({ action: "add", contactId, role,
   *                       roleCategory: ROLE_TO_CATEGORY[role] || "support",
   *                       specificRole: role, isPrimary: false, notes: undefined });
   *
   * This matters and was found the hard way. An earlier draft of this suite sent
   * only `specificRole` on the add, and the revive came back with `role` NULL —
   * because unlike `assignContactToTransaction` (which normalises
   * `data.role = data.specific_role`) the batch path writes `op.role || null`
   * verbatim, with no normalisation. That is a genuine asymmetry between the two
   * write paths, but it is LATENT: the shipping caller always sends `role`, so
   * no user can reach it. It is pinned by its own case at the bottom of this
   * block and raised in the PR rather than silently "fixed" by a test that
   * describes a payload the app never sends.
   */
  const ROLE = "Inspector";
  const CATEGORY = "inspection";

  const addOp = {
    action: "add" as const,
    contactId: JANE,
    role: ROLE,
    roleCategory: CATEGORY,
    specificRole: ROLE,
    isPrimary: false,
    notes: undefined,
  };
  /** The modal's remove shape: role-scoped (call site 2). */
  const removeScopedOp = {
    action: "remove" as const,
    contactId: JANE,
    role: ROLE,
    specificRole: ROLE,
  };
  /** The all-roles fallback (call site 3) — reachable via the service API. */
  const removeAllOp = { action: "remove" as const, contactId: JANE };

  beforeEach(async () => {
    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: ROLE,
      role_category: CATEGORY,
    });
  });

  it.each([
    ["role-scoped remove (the shipping modal's shape)", removeScopedOp],
    ["all-roles remove (the fallback branch)", removeAllOp],
  ])("cycles through separate batches without duplicating the row — %s", async (_name, removeOp) => {
    const original = rowFor(JANE)!;

    for (let lap = 1; lap <= 2; lap += 1) {
      await batchUpdateContactAssignments(TXN_A, [removeOp]);
      expect(await phase()).toEqual({
        current: [],
        removed: [JANE],
        rowIds: [original.id],
      });

      await batchUpdateContactAssignments(TXN_A, [addOp]);
      expect(await phase()).toEqual({
        current: [JANE],
        removed: [],
        rowIds: [original.id],
      });

      const row = rowFor(JANE)!;
      expect(row.created_at).toBe(original.created_at);
      expect(roleFieldsOf(row)).toEqual(roleFieldsOf(original));
    }
  });

  it("a remove+add in ONE batch, replayed twice, still leaves one live row", async () => {
    const original = rowFor(JANE)!;

    for (let lap = 1; lap <= 2; lap += 1) {
      await batchUpdateContactAssignments(TXN_A, [removeScopedOp, addOp]);
      expect(await phase()).toEqual({
        current: [JANE],
        removed: [],
        rowIds: [original.id],
      });
      expect(roleFieldsOf(rowFor(JANE)!)).toEqual(roleFieldsOf(original));
    }
  });

  it("BACKLOG-2498 (latent, pinned): an add that omits `role` clears it — no shipping caller does this", async () => {
    // Documented, not blocking, and EXPECTED TO FLIP when BACKLOG-2498 is
    // fixed. `assignContactToTransaction` normalises specific_role -> role;
    // `batchUpdateContactAssignments` does not. If a future caller sends only
    // `specificRole`, the revive loses `role`.
    await batchUpdateContactAssignments(TXN_A, [removeScopedOp]);
    await batchUpdateContactAssignments(TXN_A, [
      { action: "add", contactId: JANE, specificRole: ROLE, roleCategory: CATEGORY },
    ]);

    expect(roleFieldsOf(rowFor(JANE)!)).toEqual({
      role: null, // <- not normalised from specific_role, unlike the assign path
      role_category: CATEGORY,
      specific_role: ROLE,
    });
  });
});

// ---------------------------------------------------------------------------
// THE ROUND TRIP — linkContactToTransaction (the ON CONFLICT upsert path)
//
// INJECTED-DEFECT CONTROL: drop `removed_at = NULL` from the ON CONFLICT DO
// UPDATE and the revive phase goes red. Revert the whole ON CONFLICT clause to
// the pre-BACKLOG-2366 bare INSERT and the call THROWS on the UNIQUE slot the
// tombstone still occupies.
// ---------------------------------------------------------------------------
describe("linkContactToTransaction — two full laps", () => {
  it("revives on each lap instead of throwing on the UNIQUE constraint", async () => {
    await linkContactToTransaction(TXN_A, JANE, "Buyer Agent");
    const original = rowFor(JANE)!;

    for (let lap = 1; lap <= 2; lap += 1) {
      await unlinkContactFromTransaction(TXN_A, JANE, `Removal ${lap}`);
      expect(await phase()).toEqual({
        current: [],
        removed: [JANE],
        rowIds: [original.id],
      });

      await expect(
        linkContactToTransaction(TXN_A, JANE, "Buyer Agent"),
      ).resolves.toBeUndefined();

      expect(await phase()).toEqual({
        current: [JANE],
        removed: [],
        rowIds: [original.id],
      });
      expect(rowFor(JANE)!.created_at).toBe(original.created_at);
    }
  });
});

// ---------------------------------------------------------------------------
// ROLE FIELDS ACROSS A REVIVE — the two paths do NOT agree, and that is worth
// pinning rather than assuming.
// ---------------------------------------------------------------------------
describe("what a revive does to role_category", () => {
  /**
   * BACKLOG-2368 asked that all three role fields come back identical to their
   * pre-removal values. They do — PROVIDED the caller re-supplies them. The two
   * revive paths differ on what happens when the caller does not, and the
   * difference is in the SQL, not in anything a reader would guess:
   *
   *   assignContactToTransaction  UPDATE ... role_category = ?   <- writes the
   *                               argument, so an omitted role_category
   *                               overwrites the stored one with NULL.
   *   linkContactToTransaction    ON CONFLICT DO UPDATE SET role = ...,
   *                               specific_role = ..., removed_at = NULL
   *                               <- never mentions role_category, so the
   *                               stored value survives.
   *
   * Both behaviours are observed, not inferred. Pinning them means a future
   * change to either path is a decision someone makes on purpose. Whether
   * `assignContactToTransaction` SHOULD preserve an omitted role_category is a
   * product question, raised in the PR rather than settled by this test.
   */
  beforeEach(async () => {
    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Buyer Agent",
      role_category: "agent",
    });
    await unlinkContactFromTransaction(TXN_A, JANE, "off");
  });

  it("all three fields round-trip intact when the re-add supplies them", async () => {
    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Buyer Agent",
      role_category: "agent",
    });

    expect(roleFieldsOf(rowFor(JANE)!)).toEqual({
      role: "Buyer Agent",
      role_category: "agent",
      specific_role: "Buyer Agent",
    });
  });

  it("BACKLOG-2498 (latent, pinned): assignContactToTransaction CLEARS role_category when the re-add omits it", async () => {
    // EXPECTED TO FLIP when BACKLOG-2498 is fixed. This asserts CURRENT
    // behaviour, not desired behaviour — a red here after that work is the
    // fix landing, not a regression.
    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Buyer Agent",
    });

    expect(roleFieldsOf(rowFor(JANE)!)).toEqual({
      role: "Buyer Agent",
      role_category: null, // <- overwritten, not preserved
      specific_role: "Buyer Agent",
    });
  });

  it("BACKLOG-2498 (latent, pinned): linkContactToTransaction PRESERVES role_category, which it never writes", async () => {
    // The other half of the asymmetry. If BACKLOG-2498 settles on "preserve",
    // this case is the one that already encodes the target behaviour and should
    // stay green while its sibling flips.
    await linkContactToTransaction(TXN_A, JANE, "Lender");

    expect(roleFieldsOf(rowFor(JANE)!)).toEqual({
      role: "Lender",
      role_category: "agent", // <- untouched by the ON CONFLICT clause
      specific_role: "Lender",
    });
  });
});

// ---------------------------------------------------------------------------
// THE NEGATIVE SIGNAL, ACROSS THE WHOLE CYCLE.
//
// A removed party must stop attracting the deal's mail and messages, and must
// start again when re-added — on every lap, not just the first.
//
// INJECTED-DEFECT CONTROL: drop `AND tc.removed_at IS NULL` from
// getTransactionContactPhones / getTransactionContactEmails
// (messageMatchingService.ts) and the removed phases go red.
// ---------------------------------------------------------------------------
describe("the auto-link match sets track every lap of the cycle", () => {
  beforeEach(async () => {
    await assignContactToTransaction(TXN_A, {
      contact_id: JANE,
      specific_role: "Buyer Agent",
    });
    await assignContactToTransaction(TXN_A, {
      contact_id: OMAR,
      specific_role: "Seller Agent",
    });
  });

  const matchSets = async () => ({
    phones: (await getTransactionContactPhones(TXN_A)).map((r) => r.phone).sort(),
    emails: (await getTransactionContactEmails(TXN_A)).map((r) => r.email).sort(),
  });

  it("drops and restores exactly the removed party's identifiers, twice over", async () => {
    const both = {
      phones: [JANE_PHONE, OMAR_PHONE].sort(),
      emails: [JANE_EMAIL, OMAR_EMAIL].sort(),
    };
    const omarOnly = { phones: [OMAR_PHONE], emails: [OMAR_EMAIL] };

    expect(await matchSets()).toEqual(both);

    for (let lap = 1; lap <= 2; lap += 1) {
      await unlinkContactFromTransaction(TXN_A, JANE, `Removal ${lap}`);
      // Exact identity sets: the surviving party must still match. A filter that
      // emptied the set entirely fails here just as loudly.
      expect(await matchSets()).toEqual(omarOnly);

      await assignContactToTransaction(TXN_A, {
        contact_id: JANE,
        specific_role: "Buyer Agent",
      });
      expect(await matchSets()).toEqual(both);
    }
  });

  it("a party left removed stays out of the match sets", async () => {
    // The end state that matters most: the user's last action was a removal, so
    // the removal is what the next sync must honour.
    //
    // Snapshotted BEFORE the laps. Reading it from `allRows()` at assert time
    // would compare `phase()`'s output against the very expression `phase()`
    // evaluates, so the field would assert nothing.
    const rowIdsBefore = allRows().map((r) => r.id).sort();

    await unlinkContactFromTransaction(TXN_A, JANE, "off");
    await assignContactToTransaction(TXN_A, { contact_id: JANE, specific_role: "Buyer Agent" });
    await unlinkContactFromTransaction(TXN_A, JANE, "off for good");

    expect(await matchSets()).toEqual({ phones: [OMAR_PHONE], emails: [OMAR_EMAIL] });
    expect(await phase()).toEqual({
      current: [OMAR],
      removed: [JANE],
      // Both physical rows survive the whole cycle — no revive INSERTed a new one.
      rowIds: rowIdsBefore,
    });
  });
});
