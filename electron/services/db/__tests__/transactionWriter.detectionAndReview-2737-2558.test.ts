/**
 * @jest-environment node
 *
 * BACKLOG-2737 + BACKLOG-2558 — THE TRANSACTION WRITER MUST PERSIST WHAT ITS
 * CALLER PASSED, AND THE REVIEW QUEUE MUST BE REACHABLE.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * `createTransactionSync` hard-coded a 13-column INSERT. The detection path
 * (`transactionService.ts:972-998`) builds a 22-field object including
 * `detection_status: "pending"`, and every detection column was discarded on
 * the way to the database with no error. `schema.sql:690` defaults
 * `detection_status` to `'confirmed'`, so an auto-detected deal landed as a
 * CONFIRMED one and the review queue — counted by
 * `WHERE detection_status = 'pending'` — could never populate (BACKLOG-2737).
 *
 * Downstream, `updateTransaction`'s hand-typed `allowedFields` array never
 * mentioned `detection_status`, `reviewed_at` or `rejection_reason`, so
 * Approve wrote 1 of its 3 fields and returned success, and Reject — which
 * sends no `status` — had ALL of its fields dropped and threw
 * "No valid fields to update" (BACKLOG-2558).
 *
 * ===========================================================================
 * WHY THIS SUITE READS THE ROW BACK FROM THE DATABASE
 * ===========================================================================
 * `createTransactionSync` returns a row it re-SELECTs, and `updateTransaction`
 * returns nothing but logs success. **A test asserting a returned object can
 * pass while the database is wrong** — that is the trap this entire defect
 * class is made of (epic BACKLOG-2738, control 1). Every assertion below is a
 * `SELECT` issued directly on the test database, never the writer's return
 * value.
 *
 * ===========================================================================
 * WHY THE FIXTURE IS A REAL MIGRATED DATABASE, NOT A HAND-WRITTEN CREATE TABLE
 * ===========================================================================
 * The whole defect turns on a schema DEFAULT (`detection_status` = `'confirmed'`)
 * and on CHECK constraints. A hand-written `CREATE TABLE transactions (...)`
 * fixture would be describing a schema the app does not have, and the pre-fix
 * control would then be proving a fiction. This suite runs the app's own
 * `runMigrations()` — `schema.sql` followed by the full versioned chain — and
 * asserts `schema_version` reached the head migration BEFORE any behavioural
 * assertion, so a chain that stopped early cannot make the suite vacuous.
 *
 * Same pattern as `sqlFieldWhitelist.schemaParity.test.ts` (BACKLOG-2739).
 *
 * ===========================================================================
 * WHY THE PRE-STATE IS SEEDED WITH RAW SQL
 * ===========================================================================
 * The Approve and Restore cases need a row that is already `pending` /
 * `rejected`. Producing that state THROUGH the writer would make the assertion
 * depend on the very fix under test: pre-fix the row would sit at `'confirmed'`
 * and "Approve leaves it confirmed" would pass vacuously. The pre-state is
 * therefore written with a direct `UPDATE`, so each control separates fixed
 * from broken code on its own.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/db/__tests__/transactionWriter.detectionAndReview-2737-2558.test.ts
 *
 * Fixture values are reserved-for-documentation only. Names and addresses invented.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — same block as sqlFieldWhitelist.schemaParity.test.ts. Sentry.flush is
// included because runMigrations() awaits it on the failure path; without it a
// genuine migration failure surfaces as "Sentry.flush is not a function".
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
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

import { setDb, setDbPath, setEncryptionKey } from "../core/dbConnection";
import {
  createTransactionSync,
  updateTransaction,
  getPendingTransactionCount,
  TRANSACTION_COLUMN_POLICY,
} from "../transactionDbService";
import { sanitizeObject, validateTransactionData } from "../../../utils/validation";
import type { NewTransaction, Transaction } from "../../../types";

// Bypass the Jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock — the whole point of this file is a real file-backed DB.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const USER = "user-2737";

/**
 * TRANSCRIBED, NOT INVENTED — the field set and the literal values that are
 * load-bearing (`detection_status: "pending"`, `detection_source`,
 * `closing_date_verified: false`, the zeroed counters) are copied from the
 * object the detection path actually builds at
 * `electron/services/transactionService/transactionService.ts:972-998`.
 * Only the address, the confidence numbers and the suggested-contact names are
 * substituted, and they are documentation-only values.
 *
 * The five `@deprecated` names at the end (`extraction_confidence`,
 * `first_communication_date`, `last_communication_date`,
 * `total_communications_count`, `offer_count`, `failed_offers_count`) are
 * columns of NO table. They are kept in the fixture deliberately: the writer
 * must go on ignoring them, and a test below asserts they are not columns so
 * that stays a recorded decision rather than an accident.
 */
const DETECTED = {
  user_id: USER,
  property_address: "742 Evergreen Terrace, Springfield, IL 62704",
  property_street: "742 Evergreen Terrace",
  property_city: "Springfield",
  property_state: "IL",
  property_zip: "62704",
  transaction_type: "purchase",
  status: "active",
  closed_at: "2026-03-14",
  closing_date_verified: false,
  extraction_confidence: 87,
  first_communication_date: "2026-01-02",
  last_communication_date: "2026-03-01",
  total_communications_count: 12,
  export_status: "not_exported",
  export_count: 0,
  offer_count: 0,
  failed_offers_count: 0,
  detection_source: "auto",
  detection_status: "pending",
  detection_confidence: 0.87,
  detection_method: "hybrid",
  suggested_contacts: JSON.stringify([
    { name: "Dana Example", role: "buyer_agent" },
  ]),
} as unknown as NewTransaction;

/**
 * TRANSCRIBED from the MANUAL path,
 * `transactionService.ts:1103-1123` (`createManualTransaction`).
 *
 * BACKLOG-2737's correction comment established that every field this path
 * drops happens to equal its schema default, so the drop is currently
 * harmless. This fixture exists so that stays true BY VALUE after the writer
 * starts persisting these columns, instead of staying true by accident because
 * they are still being discarded.
 */
const MANUAL = {
  user_id: USER,
  property_address: "88 Fictional Lane, Shelbyville, IL 62565",
  transaction_type: "sale",
  status: "active",
  started_at: "2026-02-01",
  closing_date_verified: false,
  export_status: "not_exported",
  export_count: 0,
  communications_scanned: 0,
  total_communications_count: 0,
  offer_count: 0,
  failed_offers_count: 0,
} as unknown as NewTransaction;

describe("transaction writer — detection fields and the review queue (BACKLOG-2737 / BACKLOG-2558)", () => {
  jest.setTimeout(120000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  let db: DatabaseType;
  let tmpDir: string;
  let dbFile: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2737-writer-"));
    dbFile = path.join(tmpDir, "mad.db");

    db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Deferred require so the jest.mock factories above are applied first.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../../databaseService").default;
    service.db = db;
    service.dbPath = dbFile;
    service.encryptionKey = "test-encryption-key-hex";
    setDb(db);
    setDbPath(dbFile);
    setEncryptionKey("test-encryption-key-hex");

    await service.runMigrations();
    db = service.db as DatabaseType;
    setDb(db);

    // `transactions.user_id` is a real FOREIGN KEY onto `users_local` and
    // `foreign_keys = ON` above is deliberate — the owning row has to exist or
    // every INSERT below fails for a reason that has nothing to do with the
    // defect under test.
    db.prepare(
      "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, ?, ?)",
    ).run(USER, "auditor@example.invalid", "google", "oauth-2737");
  });

  afterAll(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    service.db = null;
    setDb(null as never);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  beforeEach(() => {
    db.prepare("DELETE FROM transactions").run();
  });

  /** The row as the DATABASE has it. Never the writer's return value. */
  function row(id: string): Record<string, unknown> {
    return db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as Record<
      string,
      unknown
    >;
  }

  function realColumns(): Set<string> {
    return new Set(
      (db.prepare('PRAGMA table_info("transactions")').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
  }

  /** The review queue, as identity — never as a count. */
  function pendingIds(): string[] {
    return (
      db
        .prepare(
          "SELECT id FROM transactions WHERE user_id = ? AND detection_status = 'pending' ORDER BY id",
        )
        .all(USER) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  // -------------------------------------------------------------------------
  // ANCHOR — every assertion below is meaningless if the chain did not reach
  // head, because the columns and DEFAULTS under test arrive from migrations.
  // -------------------------------------------------------------------------

  it("migrated a real on-disk database all the way to the head migration", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const DatabaseService =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../databaseService").DatabaseService ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../databaseService").default.constructor;
    const migrations = DatabaseService.MIGRATIONS as Array<{ version: number }>;
    const head = migrations[migrations.length - 1].version;

    const version = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
        version: number;
      }
    ).version;
    expect(version).toBe(head);

    // ...and the handle really is bound to THAT file. An in-memory connection
    // would report an EMPTY file here and silently turn this suite into a test
    // of nothing.
    const list = db.pragma("database_list") as Array<{ name: string; file: string }>;
    const mainDb = list.find((r) => r.name === "main");
    expect(fs.realpathSync(String(mainDb?.file))).toBe(fs.realpathSync(dbFile));
  });

  it("the schema default this defect hides behind is still 'confirmed'", () => {
    // If this ever changes, the pre-fix control below stops meaning what it
    // says, so it is asserted rather than assumed. Read from the live table.
    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'")
        .get() as { sql: string }
    ).sql;
    expect(sql).toMatch(/detection_status\s+TEXT\s+DEFAULT\s+'confirmed'/i);
  });

  // -------------------------------------------------------------------------
  // The policy is total AGAINST THE DATABASE, not merely against itself.
  //
  // The compile-time gate keys the policy off `TABLE_FIELDS.transactions`, so
  // it proves the policy agrees with that list. This proves the list agrees
  // with the actual table — the same both-ways check the whitelist parity test
  // makes, applied to the decision table, so a column can never reach the
  // schema without a recorded decision.
  // -------------------------------------------------------------------------

  it("records a decision for every real column, and invents none", () => {
    const declared = Object.keys(TRANSACTION_COLUMN_POLICY).sort();
    expect(declared).toEqual([...realColumns()].sort());
  });

  it("gives every decision a stated reason", () => {
    const unexplained = Object.entries(TRANSACTION_COLUMN_POLICY)
      .filter(([, policy]) => !policy.why || policy.why.trim().length === 0)
      .map(([column]) => column);
    expect(unexplained).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // BACKLOG-2737 — the INSERT
  // -------------------------------------------------------------------------

  describe("BACKLOG-2737 — a detected transaction reaches the database as detected", () => {
    it("persists detection_status = 'pending' (pre-fix this row reads 'confirmed')", () => {
      const created = createTransactionSync(DETECTED);
      expect(row(created.id).detection_status).toBe("pending");
    });

    it("persists every detection column the caller supplied", () => {
      const created = createTransactionSync(DETECTED);
      const r = row(created.id);

      expect({
        detection_source: r.detection_source,
        detection_status: r.detection_status,
        detection_confidence: r.detection_confidence,
        detection_method: r.detection_method,
        suggested_contacts: r.suggested_contacts,
      }).toEqual({
        detection_source: "auto",
        detection_status: "pending",
        detection_confidence: 0.87,
        detection_method: "hybrid",
        suggested_contacts: DETECTED.suggested_contacts,
      });
    });

    it("still persists every column the 13-column INSERT already carried", () => {
      const created = createTransactionSync(DETECTED);
      const r = row(created.id);

      expect({
        user_id: r.user_id,
        property_address: r.property_address,
        property_street: r.property_street,
        property_city: r.property_city,
        property_state: r.property_state,
        property_zip: r.property_zip,
        transaction_type: r.transaction_type,
        status: r.status,
        closed_at: r.closed_at,
      }).toEqual({
        user_id: USER,
        property_address: DETECTED.property_address,
        property_street: DETECTED.property_street,
        property_city: DETECTED.property_city,
        property_state: DETECTED.property_state,
        property_zip: DETECTED.property_zip,
        transaction_type: "purchase",
        status: "active",
        closed_at: "2026-03-14",
      });
    });

    it("puts the detected transaction in the review queue, by exact id", () => {
      const created = createTransactionSync(DETECTED);
      // Identity, not a count: a count cannot tell the right row from a wrong one.
      expect(pendingIds()).toEqual([created.id]);
      // The badge the UI actually renders agrees with the identity set.
      expect(getPendingTransactionCount(USER)).toBe(1);
    });

    it("a manually created transaction does NOT enter the review queue", () => {
      createTransactionSync(MANUAL);
      expect(pendingIds()).toEqual([]);
    });

    it("the caller's deprecated non-columns are still ignored, and are still not columns", () => {
      // These six names are on the `Transaction` interface as @deprecated and
      // exist in no table. The writer must go on discarding them; this records
      // that as a decision instead of leaving it to chance.
      const cols = realColumns();
      const phantoms = [
        "extraction_confidence",
        "first_communication_date",
        "last_communication_date",
        "total_communications_count",
        "offer_count",
        "failed_offers_count",
        "communications_scanned",
      ];
      expect(phantoms.filter((p) => cols.has(p))).toEqual([]);

      // ...and passing them does not break the write.
      const created = createTransactionSync(DETECTED);
      expect(row(created.id).id).toBe(created.id);
    });
  });

  // -------------------------------------------------------------------------
  // The manual path must be BYTE-IDENTICAL. BACKLOG-2737's correction comment
  // established that every value it drops equals the schema default; this keeps
  // that true by VALUE now that the columns are written.
  // -------------------------------------------------------------------------

  describe("the manual creation path is unchanged", () => {
    it("lands exactly the schema defaults it was already landing", () => {
      const created = createTransactionSync(MANUAL);
      const r = row(created.id);

      expect({
        closing_date_verified: r.closing_date_verified,
        export_status: r.export_status,
        export_count: r.export_count,
        detection_status: r.detection_status,
        detection_source: r.detection_source,
        status: r.status,
        started_at: r.started_at,
      }).toEqual({
        closing_date_verified: 0,
        export_status: "not_exported",
        export_count: 0,
        detection_status: "confirmed",
        detection_source: "manual",
        status: "active",
        started_at: "2026-02-01",
      });
    });
  });

  // -------------------------------------------------------------------------
  // BACKLOG-2558 — the three review actions
  //
  // Payloads transcribed from `src/services/transactionService.ts`
  // approve(:164-186) / reject(:192-217) / restore(:223-233), which is what
  // `useTransactionStatusUpdate` sends through `window.api.transactions.update`.
  // -------------------------------------------------------------------------

  describe("BACKLOG-2558 — Approve / Reject / Restore", () => {
    const REVIEWED_AT = "2026-08-15T10:30:00.000Z";

    /**
     * Seeded with raw SQL on purpose: producing this state through the writer
     * would make the assertion depend on the fix under test, and pre-fix the
     * row would sit at 'confirmed' so "Approve leaves it confirmed" would pass
     * vacuously.
     */
    function seedPending(): string {
      const created = createTransactionSync(MANUAL);
      db.prepare(
        "UPDATE transactions SET detection_status = 'pending', status = 'pending', reviewed_at = NULL, rejection_reason = NULL WHERE id = ?",
      ).run(created.id);
      return created.id;
    }

    function seedRejected(): string {
      const created = createTransactionSync(MANUAL);
      db.prepare(
        "UPDATE transactions SET detection_status = 'rejected', status = 'rejected', rejection_reason = ?, reviewed_at = ? WHERE id = ?",
      ).run("Not one of my deals", REVIEWED_AT, created.id);
      return created.id;
    }

    it("APPROVE writes all three fields, not just status", async () => {
      const id = seedPending();

      await updateTransaction(id, {
        detection_status: "confirmed",
        status: "active",
        reviewed_at: REVIEWED_AT,
      } as Partial<Transaction>);

      const r = row(id);
      expect({
        detection_status: r.detection_status,
        status: r.status,
        reviewed_at: r.reviewed_at,
      }).toEqual({
        detection_status: "confirmed",
        status: "active",
        reviewed_at: REVIEWED_AT,
      });
    });

    it("APPROVE removes the transaction from the review queue, by exact id", async () => {
      const approved = seedPending();
      const untouched = seedPending();

      await updateTransaction(approved, {
        detection_status: "confirmed",
        status: "active",
        reviewed_at: REVIEWED_AT,
      } as Partial<Transaction>);

      // Exact surviving id, never a count.
      expect(pendingIds()).toEqual([untouched]);
    });

    it("REJECT does not throw (pre-fix: DatabaseError 'No valid fields to update')", async () => {
      const id = seedPending();

      // Asserted with try/catch rather than `.rejects` — see BACKLOG-2539: two
      // `expect` packages coexist in this tree. This form states plainly that
      // nothing was thrown and names what was.
      let thrown: unknown = null;
      try {
        await updateTransaction(id, {
          detection_status: "rejected",
          rejection_reason: "Not one of my deals",
          reviewed_at: REVIEWED_AT,
        } as Partial<Transaction>);
      } catch (e) {
        thrown = e;
      }
      expect(thrown === null ? null : String(thrown)).toBeNull();
    });

    it("REJECT writes detection_status and rejection_reason", async () => {
      const id = seedPending();

      await updateTransaction(id, {
        detection_status: "rejected",
        rejection_reason: "Not one of my deals",
        reviewed_at: REVIEWED_AT,
      } as Partial<Transaction>);

      const r = row(id);
      expect({
        detection_status: r.detection_status,
        rejection_reason: r.rejection_reason,
        reviewed_at: r.reviewed_at,
      }).toEqual({
        detection_status: "rejected",
        rejection_reason: "Not one of my deals",
        reviewed_at: REVIEWED_AT,
      });
    });

    it("RESTORE clears the rejection reason instead of leaving it behind", async () => {
      const id = seedRejected();

      await updateTransaction(id, {
        detection_status: "confirmed",
        status: "active",
        reviewed_at: REVIEWED_AT,
        rejection_reason: null,
      } as unknown as Partial<Transaction>);

      const r = row(id);
      expect({
        detection_status: r.detection_status,
        status: r.status,
        rejection_reason: r.rejection_reason,
      }).toEqual({
        detection_status: "confirmed",
        status: "active",
        rejection_reason: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // THE SAME THREE ACTIONS, THROUGH THE VALIDATOR THIS TIME.
  //
  // Every assertion above calls `updateTransaction` directly, which SKIPS
  // `validateTransactionData` — the handler-side list that had drifted away
  // from the writer's (SR finding F6). A writer that accepts a column the
  // validator strips first is still broken for the user, and a suite that only
  // tests the writer cannot see it. `suggested_contacts` is exactly that case:
  // the review UI sends it as the sole key of its payload
  // (`useTransactionDetails.ts:283`) and the validator used to drop it, so the
  // writer received `{}` and threw.
  //
  // This block is the handler's own chain, minus the IPC hop:
  //   validateTransactionData(payload, true) -> updateTransaction
  // -------------------------------------------------------------------------

  describe("the handler chain — validator and writer agree (SR finding F6)", () => {
    const REVIEWED_AT = "2026-08-15T10:30:00.000Z";

    /**
     * The handler's chain verbatim, `sanitizeObject` included
     * (transactionCrudHandlers.ts:356-360).
     *
     * `sanitizeObject` is in here rather than assumed away because
     * `suggested_contacts` is a JSON string full of quotes and brackets, and
     * before this change it never crossed the IPC boundary at all — the
     * detection path is main-process-internal. Starting the test one hop later
     * would leave the only step that has never carried this value untested.
     */
    async function throughValidator(
      id: string,
      payload: Record<string, unknown>,
    ): Promise<void> {
      const sanitized = sanitizeObject(payload);
      const validated = validateTransactionData(sanitized, true);
      await updateTransaction(id, validated as unknown as Partial<Transaction>);
    }

    it("APPROVE survives the validator with all three fields intact", async () => {
      const created = createTransactionSync(MANUAL);
      db.prepare(
        "UPDATE transactions SET detection_status = 'pending', reviewed_at = NULL WHERE id = ?",
      ).run(created.id);

      await throughValidator(created.id, {
        detection_status: "confirmed",
        status: "active",
        reviewed_at: REVIEWED_AT,
      });

      const r = row(created.id);
      expect({ detection_status: r.detection_status, reviewed_at: r.reviewed_at }).toEqual({
        detection_status: "confirmed",
        reviewed_at: REVIEWED_AT,
      });
    });

    it("REJECT survives the validator and does not throw", async () => {
      const created = createTransactionSync(MANUAL);

      let thrown: unknown = null;
      try {
        await throughValidator(created.id, {
          detection_status: "rejected",
          rejection_reason: "Not one of my deals",
          reviewed_at: REVIEWED_AT,
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown === null ? null : String(thrown)).toBeNull();

      const r = row(created.id);
      expect({
        detection_status: r.detection_status,
        rejection_reason: r.rejection_reason,
      }).toEqual({
        detection_status: "rejected",
        rejection_reason: "Not one of my deals",
      });
    });

    it("DISMISSING A SUGGESTED PARTY reaches the database (pre-fix: threw)", async () => {
      const created = createTransactionSync(MANUAL);
      db.prepare("UPDATE transactions SET suggested_contacts = ? WHERE id = ?").run(
        JSON.stringify([
          { name: "Dana Example", role: "buyer_agent" },
          { name: "Robin Example", role: "inspector" },
        ]),
        created.id,
      );

      // The payload the review UI actually sends — one key, nothing else.
      const remaining = JSON.stringify([{ name: "Robin Example", role: "inspector" }]);
      await throughValidator(created.id, { suggested_contacts: remaining });

      expect(row(created.id).suggested_contacts).toBe(remaining);
    });

    it("dismissing the LAST suggested party clears the column to NULL", async () => {
      const created = createTransactionSync(MANUAL);
      db.prepare("UPDATE transactions SET suggested_contacts = ? WHERE id = ?").run(
        JSON.stringify([{ name: "Dana Example", role: "buyer_agent" }]),
        created.id,
      );

      // `null`, not an empty array — that is what the hook sends when the list
      // empties, and a validator that dropped null would leave the last
      // suggestion on screen forever.
      await throughValidator(created.id, { suggested_contacts: null });

      expect(row(created.id).suggested_contacts).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // The two documented exclusions must survive the rewrite.
  // -------------------------------------------------------------------------

  describe("the deliberate exclusions are preserved", () => {
    it("last_exported_at is still not updatable (transactionDbService.ts:444)", async () => {
      const id = createTransactionSync(MANUAL).id;

      let thrown: unknown = null;
      try {
        await updateTransaction(id, {
          last_exported_at: "2026-08-15T00:00:00.000Z",
          status: "closed",
        } as Partial<Transaction>);
      } catch (e) {
        thrown = e;
      }

      // The write succeeds for the accepted field and leaves the excluded one alone.
      expect(thrown).toBeNull();
      const r = row(id);
      expect({ last_exported_at: r.last_exported_at, status: r.status }).toEqual({
        last_exported_at: null,
        status: "closed",
      });
    });

    it("the unfreeze override sentinel never reaches SQL", async () => {
      const id = createTransactionSync(MANUAL).id;

      let thrown: unknown = null;
      try {
        await updateTransaction(id, {
          __unfreezeOverride: true,
          status: "closed",
        } as unknown as Partial<Transaction>);
      } catch (e) {
        thrown = e;
      }
      expect(thrown === null ? null : String(thrown)).toBeNull();
      expect(row(id).status).toBe("closed");
    });

    it("an update carrying no writable field still throws, and names what it dropped", async () => {
      const id = createTransactionSync(MANUAL).id;

      let message = "";
      try {
        await updateTransaction(id, { created_at: "2020-01-01" } as Partial<Transaction>);
      } catch (e) {
        message = String((e as Error).message);
      }
      expect(message).toContain("No valid fields to update");
      // The evidence is no longer discarded before the error is raised.
      expect(message).toContain("created_at");
    });
  });
});
