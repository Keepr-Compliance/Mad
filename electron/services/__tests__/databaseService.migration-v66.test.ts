/**
 * @jest-environment node
 *
 * Integration test for migration v66 (BACKLOG-2859 — the role collapse).
 *
 * v66 does two things, both pure DML:
 *   - collapses `buyer_agent` / `seller_agent` / `listing_agent` into the single
 *     side-neutral `agent`, across `transaction_contacts.role`,
 *     `transaction_contacts.specific_role` and `contacts.default_role`;
 *   - DELETES the counterparty-principal assignments (`buyer` / `seller`) from
 *     `transaction_contacts`. Founder-approved silent drop.
 *
 * Properties locked in here:
 *
 *  1. ALL THREE legacy agent values collapse — asserted BY EXACT ID SET, not by
 *     count. A migration that moved the right NUMBER of rows onto the wrong ones
 *     passes a count and fails an id set.
 *  2. BOTH columns move together. `specific_role` is canonical when present and
 *     is NULL on most historical rows, so a migration that updated only `role`
 *     would leave the canonical column still reading `buyer_agent`.
 *  3. THE PRINCIPALS ARE DELETED, AND ONLY THEY. The surviving id set and the
 *     removed id set PARTITION the seed, so "deleted too much" and "deleted too
 *     little" are separately detectable.
 *  4. THE COLLAPSE IS NARROW. Service-provider roles and unrelated columns are
 *     asserted unchanged — a broader UPDATE would pass every assertion above.
 *  5. `contacts.default_role` collapses for agent values and is LEFT ALONE for
 *     `buyer`/`seller`. That asymmetry is a decision, not an oversight: unlike an
 *     assignment row, a default_role that is no longer offered degrades safely to
 *     the `client` baseline, so there is nothing to fix by deleting data.
 *  6. CASE-INSENSITIVITY. Roles reach the database both ways.
 *  7. RE-RUNNING IS SAFE (idempotent).
 *  8. IT NO-OPS without the tables, so a minimal partial-schema fixture does not
 *     throw.
 *
 * Follows the v47..v65 convention: real better-sqlite3 driver, in-memory DB via
 * createMigrationHarness, seeded at 65 AND clipped to 66 so ONLY v66 runs.
 *
 * Clipping with `filter(m => m.version <= 66)` keeps a CONTIGUOUS PREFIX, which
 * matters: `validateNoVersionGaps` runs on every `_runVersionedMigrations` call
 * and throws on a chain with a hole, so clipping to a set that omitted a middle
 * version would fail before any migration ran.
 */

import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";

const USER_ID = "user-v66-test";
const TXN_LISTING = "txn-v66-listing"; // stored `purchase`
const TXN_SALE = "txn-v66-sale";

/** Post-v65 / pre-v66 shape — only what v66 reads. */
const PRE_V66_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT,
    default_role TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    transaction_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE transaction_contacts (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    role TEXT,
    role_category TEXT,
    specific_role TEXT,
    is_primary INTEGER DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

/**
 * The seed. Every branch v66 can take has at least one row, and the untouched
 * roles are here so the migration's NARROWNESS is testable too.
 *
 * `tc-mixed-case` exists because roles reach the database both ways and the
 * migration compares with LOWER(). Remove the LOWER() and only that row fails —
 * which is what makes it worth seeding rather than assuming.
 */
const SEED: ReadonlyArray<{
  id: string;
  txn: string;
  contact: string;
  role: string | null;
  specific: string | null;
}> = [
  // --- collapse inputs: all three legacy agent values ---
  { id: "tc-buyer-agent", txn: TXN_LISTING, contact: "c-1", role: "buyer_agent", specific: null },
  { id: "tc-seller-agent", txn: TXN_SALE, contact: "c-2", role: "seller_agent", specific: null },
  { id: "tc-listing-agent", txn: TXN_LISTING, contact: "c-3", role: "listing_agent", specific: null },
  // --- both columns populated ---
  {
    id: "tc-both-cols",
    txn: TXN_SALE,
    contact: "c-4",
    role: "buyer_agent",
    specific: "buyer_agent",
  },
  // --- specific_role legacy while `role` is already something else ---
  { id: "tc-specific-only", txn: TXN_SALE, contact: "c-5", role: "agent", specific: "seller_agent" },
  // --- case variance ---
  { id: "tc-mixed-case", txn: TXN_LISTING, contact: "c-6", role: "Seller_Agent", specific: null },
  // --- deletion inputs: the counterparty principals, on BOTH deal types ---
  { id: "tc-buyer-on-listing", txn: TXN_LISTING, contact: "c-7", role: "buyer", specific: null },
  { id: "tc-seller-on-sale", txn: TXN_SALE, contact: "c-8", role: "seller", specific: null },
  // --- same-side principals: also removed. The final model offers neither on
  //     ANY type, so a surviving row would be unrenderable by every picker.
  { id: "tc-seller-on-listing", txn: TXN_LISTING, contact: "c-9", role: "seller", specific: null },
  { id: "tc-buyer-on-sale", txn: TXN_SALE, contact: "c-10", role: "buyer", specific: null },
  // --- principal named in the CANONICAL column only ---
  {
    id: "tc-principal-specific",
    txn: TXN_SALE,
    contact: "c-11",
    role: "client",
    specific: "buyer",
  },
  // --- untouched: proves the collapse is narrow ---
  { id: "tc-client", txn: TXN_LISTING, contact: "c-12", role: "client", specific: null },
  { id: "tc-inspector", txn: TXN_SALE, contact: "c-13", role: "inspector", specific: null },
  { id: "tc-escrow", txn: TXN_LISTING, contact: "c-14", role: "escrow_officer", specific: "escrow_officer" },
  { id: "tc-co-agent", txn: TXN_SALE, contact: "c-15", role: "co_agent", specific: null },
];

/** Rows v66 must DELETE. */
const DELETED_IDS = [
  "tc-buyer-on-listing",
  "tc-seller-on-sale",
  "tc-seller-on-listing",
  "tc-buyer-on-sale",
  "tc-principal-specific",
].sort();

/** The exact `role` every surviving row holds afterwards, keyed by id. */
const ROLE_AFTER: Readonly<Record<string, string>> = {
  "tc-buyer-agent": "agent",
  "tc-seller-agent": "agent",
  "tc-listing-agent": "agent",
  "tc-both-cols": "agent",
  "tc-specific-only": "agent",
  "tc-mixed-case": "agent",
  "tc-client": "client",
  "tc-inspector": "inspector",
  "tc-escrow": "escrow_officer",
  "tc-co-agent": "co_agent",
};

/** The exact `specific_role` every surviving row holds afterwards. */
const SPECIFIC_AFTER: Readonly<Record<string, string | null>> = {
  "tc-buyer-agent": null,
  "tc-seller-agent": null,
  "tc-listing-agent": null,
  "tc-both-cols": "agent",
  "tc-specific-only": "agent",
  "tc-mixed-case": null,
  "tc-client": null,
  "tc-inspector": null,
  "tc-escrow": "escrow_officer",
  "tc-co-agent": null,
};

/** `contacts.default_role` afterwards, keyed by contact id. */
const DEFAULT_ROLE_AFTER: Readonly<Record<string, string | null>> = {
  "c-1": "agent", // was buyer_agent
  "c-2": "agent", // was seller_agent
  "c-3": "agent", // was listing_agent
  "c-4": "agent", // was LISTING_AGENT (upper case)
  // Deliberately NOT migrated — see property 5 in the header.
  "c-5": "buyer",
  "c-6": "seller",
  "c-7": "client",
  "c-8": "inspector",
  "c-9": null,
  "c-10": null,
  "c-11": null,
  "c-12": null,
  "c-13": null,
  "c-14": null,
  "c-15": null,
};

const DEFAULT_ROLE_SEED: Readonly<Record<string, string | null>> = {
  "c-1": "buyer_agent",
  "c-2": "seller_agent",
  "c-3": "listing_agent",
  "c-4": "LISTING_AGENT",
  "c-5": "buyer",
  "c-6": "seller",
  "c-7": "client",
  "c-8": "inspector",
  "c-9": null,
  "c-10": null,
  "c-11": null,
  "c-12": null,
  "c-13": null,
  "c-14": null,
  "c-15": null,
};

function schemaVersion(db: DatabaseType): number {
  return (
    db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
  ).version;
}

function surviving(db: DatabaseType): Array<{
  id: string;
  role: string | null;
  specific_role: string | null;
}> {
  return db
    .prepare("SELECT id, role, specific_role FROM transaction_contacts ORDER BY id")
    .all() as Array<{ id: string; role: string | null; specific_role: string | null }>;
}

describe("databaseService migration v66 (BACKLOG-2859 — role collapse)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V66_FIXTURE);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);

    harness.db
      .prepare("INSERT INTO transactions (id, user_id, transaction_type) VALUES (?, ?, ?)")
      .run(TXN_LISTING, USER_ID, "purchase");
    harness.db
      .prepare("INSERT INTO transactions (id, user_id, transaction_type) VALUES (?, ?, ?)")
      .run(TXN_SALE, USER_ID, "sale");

    for (const [id, role] of Object.entries(DEFAULT_ROLE_SEED)) {
      harness.db
        .prepare(
          "INSERT INTO contacts (id, user_id, display_name, default_role) VALUES (?, ?, ?, ?)",
        )
        .run(id, USER_ID, `Contact ${id}`, role);
    }

    for (const r of SEED) {
      harness.db
        .prepare(
          `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, specific_role, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(r.id, r.txn, r.contact, r.role, r.specific, `note-${r.id}`);
    }
  });

  afterEach(async () => {
    if (harness) {
      try {
        await harness.cleanup();
      } catch {
        /* already cleaned */
      }
    }
  });

  /** Seed at v65 AND clip the chain at v66 so ONLY v66 runs. */
  async function runV66(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 65)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 66);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  it("advances schema_version to 66", async () => {
    await runV66();
    expect(schemaVersion(harness.db)).toBe(66);
  });

  it("collapses all three legacy agent values to 'agent' — BY EXACT ID, both columns", async () => {
    await runV66();
    const rows = surviving(harness.db);

    // Identity, not counts. This is the assertion that separates "collapsed the
    // right rows" from "collapsed the right number of rows".
    expect(Object.fromEntries(rows.map((r) => [r.id, r.role]))).toEqual(ROLE_AFTER);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.specific_role]))).toEqual(SPECIFIC_AFTER);
  });

  it("leaves NO legacy agent value anywhere, in either column", async () => {
    await runV66();
    for (const r of surviving(harness.db)) {
      expect(["buyer_agent", "seller_agent", "listing_agent"]).not.toContain(
        (r.role ?? "").toLowerCase(),
      );
      expect(["buyer_agent", "seller_agent", "listing_agent"]).not.toContain(
        (r.specific_role ?? "").toLowerCase(),
      );
    }
  });

  it("matches roles case-insensitively", async () => {
    await runV66();
    const row = surviving(harness.db).find((r) => r.id === "tc-mixed-case");
    // Seeded as "Seller_Agent". Drop LOWER() from the migration and only this
    // row survives at its legacy value.
    expect(row?.role).toBe("agent");
  });

  it("deletes the principal assignments — and EXACTLY those", async () => {
    await runV66();
    const ids = surviving(harness.db).map((r) => r.id);

    const expectedSurvivors = SEED.map((r) => r.id)
      .filter((id) => !DELETED_IDS.includes(id))
      .sort();

    // Two exact sets that partition the seed: "deleted too much" and "deleted
    // too little" are separately detectable.
    expect(ids).toEqual(expectedSurvivors);
    for (const gone of DELETED_IDS) expect(ids).not.toContain(gone);
    expect(ids.length + DELETED_IDS.length).toBe(SEED.length);
  });

  it("deletes a principal named in the CANONICAL column even when `role` says otherwise", async () => {
    await runV66();
    // tc-principal-specific is role='client', specific_role='buyer'. Readers
    // resolve specific_role first, so this row IS a principal assignment. A
    // DELETE keyed on `role` alone would leave it behind.
    expect(surviving(harness.db).map((r) => r.id)).not.toContain("tc-principal-specific");
  });

  it("removes assignments, never contacts", async () => {
    await runV66();
    const contactIds = (
      harness.db.prepare("SELECT id FROM contacts ORDER BY id").all() as Array<{ id: string }>
    ).map((r) => r.id);
    // Every seeded contact survives, including the five whose assignments went.
    expect(contactIds.sort()).toEqual(Object.keys(DEFAULT_ROLE_SEED).sort());
  });

  it("collapses contacts.default_role, and leaves buyer/seller deliberately alone", async () => {
    await runV66();
    const rows = harness.db
      .prepare("SELECT id, default_role FROM contacts ORDER BY id")
      .all() as Array<{ id: string; default_role: string | null }>;

    // Asserts the migration's NARROWNESS as much as its effect: a broader UPDATE
    // sweeping every principal default_role into `agent` passes a
    // "no legacy agent values remain" check and fails this one.
    expect(Object.fromEntries(rows.map((r) => [r.id, r.default_role]))).toEqual(
      DEFAULT_ROLE_AFTER,
    );
  });

  it("does not disturb any other column on a migrated row", async () => {
    await runV66();
    const row = harness.db
      .prepare("SELECT * FROM transaction_contacts WHERE id = ?")
      .get("tc-buyer-agent") as Record<string, unknown>;
    expect(row.transaction_id).toBe(TXN_LISTING);
    expect(row.contact_id).toBe("c-1");
    expect(row.notes).toBe("note-tc-buyer-agent");
  });

  it("is idempotent — running the chain again changes nothing", async () => {
    await runV66();
    const first = surviving(harness.db);

    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 65)").run();
    await runV66();

    expect(surviving(harness.db)).toEqual(first);
  });

  it("no-ops when the tables are absent", async () => {
    harness.db.exec("DROP TABLE transaction_contacts; DROP TABLE contacts;");
    await expect(runV66()).resolves.toBeUndefined();
    expect(schemaVersion(harness.db)).toBe(66);
  });
});
