/**
 * @jest-environment node
 *
 * BACKLOG-4243 — Keepr Cloud and the local database across the 2.48.0 <-> 2.49 boundary, on the
 * REAL driver (by absolute path, as databaseService.cloudSync-4243.test.ts does) and the REAL open
 * path (databaseService.initialize on an on-disk keyed file).
 *
 * Starting point: fixtures/v2.48.0/profile-v79.sql, the database a v2.48.0 build creates (generated
 * by that tag's own initialize(); command in the fixture header and in generateProfileV79.gen.ts.txt).
 * Going back: the statements a v2.48.0 build runs, transcribed from the tag with file:line, on a
 * connection opened with the tag's pragmas after the tag's own schema.sql (fixtures/v2.48.0/schema.sql,
 * verbatim) — what a 2.48.0 launch does to the file. Ids and addresses are invented.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { CLOUD_SYNC_TABLES, CLOUD_SYNC_TABLES_DDL, CLOUD_SYNC_TRIGGERS, ELIGIBLE_DEAL_WHERE } from "../db/cloudSyncSql";

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

let userDataDir = "/tmp/unset-4243-248";
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
    isPackaged: true,
    isReady: jest.fn(() => true),
    whenReady: jest.fn(() => Promise.resolve()),
    quit: jest.fn(),
  },
  dialog: { showMessageBox: jest.fn().mockResolvedValue({ response: 0 }) },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
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
const KEY = "test-encryption-key-hex";
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(true),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({ queryContacts: jest.fn(), isPoolReady: jest.fn(() => false) }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")) as new (
  file: string,
) => DatabaseType;

const FIXTURES = path.join(__dirname, "fixtures", "v2.48.0");
const PROFILE_V79_SQL = fs.readFileSync(path.join(FIXTURES, "profile-v79.sql"), "utf8");
const TAG_SCHEMA_SQL = fs.readFileSync(path.join(FIXTURES, "schema.sql"), "utf8");
/** `git rev-parse v2.48.0:electron/database/schema.sql` (tag commit 52afbd8aee45c63c2333a8e712f29a581010cdde). */
const TAG_SCHEMA_BLOB = "06ea2f5dcb987f78d46d8993876a6e8450433ff2";

const PROJECT = "test-project.supabase.co";
/** Invented all-zero-pattern ids: 00000000-0000-0000-<kind>-<n>. */
const id = (kind: number, n: number) => `00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(n).padStart(12, "0")}`;
const U_ON = id(99, 1);
const U_OFF = id(99, 2);
// Deals: D1, D4 eligible (U_ON); D2 pending, D3 rejected (U_ON, not eligible); D5 another user.
const D1 = id(1, 1);
const D2 = id(1, 2);
const D3 = id(1, 3);
const D4 = id(1, 4);
const D5 = id(1, 5);
const C1 = id(2, 1);
const C2 = id(2, 2);
const C3 = id(2, 3);
const CL1 = id(3, 1);
const CL2 = id(3, 2);
const CL_PRIVATE = id(3, 3);
const I1 = id(4, 1);
const I2 = id(4, 2);
const I3 = id(4, 3);
const I_PRIVATE = id(4, 4);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;
type Row = Record<string, unknown>;

function loadService(): AnyService {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../tests/helpers/installTestCapabilities").installTestCapabilities();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../databaseService").default;
}

function insert(db: DatabaseType, table: string, row: Row): void {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k]));
}

/** Invented rows in every table a cloud trigger watches, every table v80 reads or writes, and messages / files. */
function seedV79(db: DatabaseType): void {
  const now = "2026-11-01T00:00:00.000Z";
  insert(db, "users_local", { id: U_ON, email: "agent-on@example.test", oauth_provider: "google", oauth_id: "oauth-a001" });
  insert(db, "users_local", { id: U_OFF, email: "agent-off@example.test", oauth_provider: "microsoft", oauth_id: "oauth-a002" });
  const deal = (dealId: string, user: string, status: string, detection: string, n: number) =>
    insert(db, "transactions", {
      id: dealId,
      user_id: user,
      property_address: `${n} Example Ave, Testville`,
      property_city: "Testville",
      transaction_type: "purchase",
      status,
      detection_status: detection,
      listing_price: 100000 + n,
    });
  deal(D1, U_ON, "active", "confirmed", 1);
  deal(D2, U_ON, "active", "pending", 2);
  deal(D3, U_ON, "rejected", "confirmed", 3);
  deal(D4, U_ON, "active", "confirmed", 4);
  deal(D5, U_OFF, "active", "confirmed", 5);
  for (const [cid, user, n] of [[C1, U_ON, 1], [C2, U_ON, 2], [C3, U_OFF, 3]] as const) {
    insert(db, "contacts", { id: cid, user_id: user, display_name: `Person ${n}`, company: "Example Co", source: "manual" });
    insert(db, "contact_emails", { id: id(5, n), contact_id: cid, email: `person${n}@example.test`, is_primary: 1 });
    insert(db, "contact_phones", { id: id(6, n), contact_id: cid, phone_e164: `+121255501${n}0`, phone_display: `212-555-01${n}0`, is_primary: 1 });
    insert(db, "contact_source_links", {
      id: id(7, n),
      user_id: user,
      contact_id: cid,
      source_type: "manual",
      source_record_id: `rec-${n}`,
      match_method: "manual",
    });
  }
  insert(db, "transaction_contacts", { id: id(8, 1), transaction_id: D1, contact_id: C1, role: "buyer", role_category: "client" });
  insert(db, "transaction_contacts", { id: id(8, 2), transaction_id: D4, contact_id: C2, role: "seller", role_category: "client" });
  insert(db, "transaction_contacts", { id: id(8, 3), transaction_id: D5, contact_id: C3, role: "buyer", role_category: "client" });
  insert(db, "transaction_checklists", { id: CL1, transaction_id: D1, template_id: "tpl-1", template_name: "List", sort_order: 0 });
  insert(db, "transaction_checklists", { id: CL2, transaction_id: D4, template_id: "tpl-1", template_name: "List", sort_order: 0 });
  insert(db, "transaction_checklists", { id: CL_PRIVATE, transaction_id: D1, template_id: "keepr:my-items", template_name: "My items", sort_order: 1 });
  insert(db, "transaction_checklist_items", { id: I1, checklist_id: CL1, title: "Inspection", sort_order: 0 });
  insert(db, "transaction_checklist_items", { id: I2, checklist_id: CL1, title: "Appraisal", sort_order: 1 });
  insert(db, "transaction_checklist_items", { id: I3, checklist_id: CL2, title: "Disclosure", sort_order: 0 });
  insert(db, "transaction_checklist_items", { id: I_PRIVATE, checklist_id: CL_PRIVATE, title: "Call lender", sort_order: 0 });
  // v80 backfill inputs: an answered row whose message is cached, an unanswered row, an answered row with no cached message.
  insert(db, "emails", { id: id(9, 1), user_id: U_ON, external_id: "ext-1", source: "gmail", subject: "Weekly digest", sender: "News Desk <news@example.test>" });
  insert(db, "emails", { id: id(9, 2), user_id: U_ON, external_id: "ext-2", source: "gmail", subject: "Offer", sender: "agent-two@example.test" });
  const answer = (n: number, ext: string, ans: string | null) =>
    insert(db, "learn_bulk_answers", {
      id: id(10, n),
      user_id: U_ON,
      source: "gmail",
      external_id: ext,
      sampled_at: now,
      answer: ans,
      answered_at: ans ? now : null,
      rule_version: 1,
      created_at: now,
      updated_at: now,
    });
  answer(1, "ext-1", "newsletter_spam");
  answer(2, "ext-2", null);
  answer(3, "ext-gone", "real_estate");
  insert(db, "learn_mode_settings", { id: id(11, 1), user_id: U_ON, enabled: 1, created_at: now, updated_at: now });
  for (let n = 1; n <= 3; n++) {
    insert(db, "messages", { id: id(12, n), user_id: U_ON, channel: "sms", direction: "inbound", body_text: `Text ${n}`, transaction_id: D1, sent_at: now });
  }
  insert(db, "attachments", { id: id(13, 1), message_id: id(12, 1), filename: "contract.pdf" });
}

/** Every table seedV79 writes: each must be non-empty in the starting file. */
const SEEDED_TABLES = [
  "users_local",
  "transactions",
  "contacts",
  "contact_emails",
  "contact_phones",
  "contact_source_links",
  "transaction_contacts",
  "transaction_checklists",
  "transaction_checklist_items",
  "emails",
  "learn_bulk_answers",
  "learn_mode_settings",
  "messages",
  "attachments",
];
const WATCHED_TABLES = [...new Set(CLOUD_SYNC_TRIGGERS.map((t) => t.table))].sort();

function openKeyed(file: string): DatabaseType {
  const db = new RealDatabase(file);
  // The open path's own pragmas (databaseService.ts _openDatabase; the v2.48.0 tag's :1001-1003).
  db.pragma(`key = "x'${KEY}'"`);
  db.pragma("cipher_compatibility = 4");
  db.pragma("foreign_keys = ON");
  return db;
}

function tables(db: DatabaseType): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]).map(
    (r) => r.name as string,
  );
}
function columns(db: DatabaseType, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Row[]).map((c) => c.name as string);
}
function names(db: DatabaseType, type: "table" | "trigger", like: string): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ? ORDER BY name").all(type, like) as Row[]).map(
    (r) => r.name as string,
  );
}
const ALL_TRIGGERS = CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort();
const versionOf = (db: DatabaseType) => (db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }).version;
const count = (db: DatabaseType, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
const dirty = (db: DatabaseType) =>
  db.prepare("SELECT transaction_id, generation FROM cloud_sync_dirty ORDER BY transaction_id").all() as Array<{ transaction_id: string; generation: number }>;
const dirtyIds = (db: DatabaseType) => dirty(db).map((r) => r.transaction_id);
const generationSum = (db: DatabaseType) => (db.prepare("SELECT COALESCE(SUM(generation), 0) AS n FROM cloud_sync_dirty").get() as { n: number }).n;

/** Every row, every listed column (default: all), as sorted JSON lines. Row-for-row, not a count. */
function digest(db: DatabaseType, table: string, cols: string[] = columns(db, table)): string[] {
  return (db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${table}"`).all() as Row[])
    .map((r) => JSON.stringify(cols.map((c) => (Buffer.isBuffer(r[c]) ? (r[c] as Buffer).toString("hex") : r[c]))))
    .sort();
}
type Snapshot = Map<string, { cols: string[]; rows: string[] }>;
function snapshot(db: DatabaseType, only?: string[]): Snapshot {
  const out: Snapshot = new Map();
  for (const t of only ?? tables(db)) {
    const cols = columns(db, t);
    out.set(t, { cols, rows: digest(db, t, cols) });
  }
  return out;
}
/** Tables whose rows differ from `before` (compared on before's columns only). */
function changedTables(db: DatabaseType, before: Snapshot, skip: string[] = []): string[] {
  const changed: string[] = [];
  for (const [t, { cols, rows }] of before) {
    if (skip.includes(t)) continue;
    if (JSON.stringify(digest(db, t, cols)) !== JSON.stringify(rows)) changed.push(t);
  }
  return changed;
}

/** Builds mad.db in `dir` exactly as profile-v79.sql records it, seeds it, and returns its snapshot. */
function buildV79Profile(dir: string): { before: Snapshot; file: string } {
  const file = path.join(dir, "mad.db");
  const db = openKeyed(file);
  db.exec(PROFILE_V79_SQL);
  seedV79(db);
  const before = snapshot(db);
  db.close();
  return { before, file };
}

async function openWithThisBuild(): Promise<{ svc: AnyService; db: DatabaseType }> {
  const svc = loadService();
  await expect(svc.initialize()).resolves.toBe(true);
  return { svc, db: svc.db as DatabaseType };
}

/** The local half of turning Keepr Cloud on: the engine's own writer (flag, triggers and marks in one transaction). */
function enable(db: DatabaseType, userId = U_ON): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { enableForUser } = require("../db/cloudSyncDbService") as typeof import("../db/cloudSyncDbService");
  enableForUser(db as never, PROJECT, userId, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" });
}

function eligibleDeals(db: DatabaseType, userId: string): string[] {
  return (db.prepare(`SELECT t.id FROM transactions t WHERE t.user_id = ? AND ${ELIGIBLE_DEAL_WHERE} ORDER BY t.id`).all(userId) as Row[]).map(
    (r) => r.id as string,
  );
}

function makeEngineOn(db: DatabaseType, server?: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeEngine } = require("../cloudSync/__tests__/helpers/engine") as typeof import("../cloudSync/__tests__/helpers/engine");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { FakeServer } = require("../cloudSync/__tests__/helpers/fakeServer") as typeof import("../cloudSync/__tests__/helpers/fakeServer");
  return makeEngine(db as never, { user: U_ON, server: (server as InstanceType<typeof FakeServer>) ?? new FakeServer(U_ON) });
}

// ------------------------------------------------------------------ what a v2.48.0 build does to the file

/**
 * A v2.48.0 connection: the tag's pragmas (databaseService.ts:1001-1003 key / cipher_compatibility /
 * foreign_keys = ON, :1022 journal_mode = WAL, :1029 synchronous = NORMAL), then the tag's every-open
 * `currentDb.exec(schemaSql)` (databaseService.ts:1897). Its chain runs nothing on a v80 file:
 * `pendingMigrations = migrations.filter((m) => m.version > currentVersion)` (:2311) is empty.
 */
function openAs248(file: string): DatabaseType {
  const db = openKeyed(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(TAG_SCHEMA_SQL);
  return db;
}

interface Write248 {
  /** Where the statement is in the v2.48.0 tag. */
  at: string;
  kind: "insert" | "update" | "delete" | "bulk insert" | "cascade";
  table: string;
  /** Deal(s) this write must mark when Keepr Cloud is on for U_ON (empty: marks nothing by design). */
  marks: string[];
  run: (db: DatabaseType) => void;
}

/**
 * The common writes of a v2.48.0 build, statement text transcribed from the tag (git show v2.48.0:<file>).
 * Dynamic column lists are the tag's template with the columns named here. Order matters: later writes
 * use rows earlier ones made. D4 is deleted last (the cascade).
 */
const NEW_DEAL = id(1, 9);
const NEW_PARTY = id(8, 9);
const NEW_CHECKLIST = id(3, 9);
const NEW_ITEM = id(4, 9);
const NEW_EMAIL = id(5, 9);
const NEW_PHONE = id(6, 9);
const NEW_LINK = id(7, 9);
const WRITES_248: Write248[] = [
  {
    at: "electron/services/db/transactionDbService.ts:650-653 (createTransaction)",
    kind: "insert",
    table: "transactions",
    marks: [NEW_DEAL],
    run: (db) =>
      db
        .prepare(`
    INSERT INTO transactions (id, user_id, property_address, status, detection_status)
    VALUES (?, ?, ?, ?, ?)
  `)
        .run(NEW_DEAL, U_ON, "9 Example Ave, Testville", "active", "confirmed"),
  },
  {
    at: "electron/services/db/transactionDbService.ts:1187 (updateTransaction)",
    kind: "update",
    table: "transactions",
    marks: [D1],
    run: (db) => db.prepare("UPDATE transactions SET property_city = ?, listing_price = ? WHERE id = ?").run("Newtown", 123456, D1),
  },
  {
    at: "electron/services/db/transactionContactDbService.ts:369-373 (assignContactToTransaction)",
    kind: "insert",
    table: "transaction_contacts",
    marks: [D1],
    run: (db) =>
      db
        .prepare(`
    INSERT INTO transaction_contacts (
      id, transaction_id, contact_id, role, role_category, specific_role, is_primary, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
        .run(NEW_PARTY, D1, C2, "seller", "client", null, 0, null),
  },
  {
    at: "electron/services/db/transactionContactDbService.ts:509-513 (removeContactFromTransaction: a tombstone, not a DELETE)",
    kind: "update",
    table: "transaction_contacts",
    marks: [D1],
    run: (db) =>
      db
        .prepare(`
    UPDATE transaction_contacts
    SET removed_at = CURRENT_TIMESTAMP, removed_reason = ?
    WHERE transaction_id = ? AND contact_id = ? AND removed_at IS NULL
  `)
        .run("user_removed", D1, C2),
  },
  {
    at: "electron/services/db/transactionContactDbService.ts:614-618 (restoreContactToTransactionSync)",
    kind: "update",
    table: "transaction_contacts",
    marks: [D1],
    run: (db) =>
      db
        .prepare(`
    UPDATE transaction_contacts
    SET removed_at = NULL, removed_reason = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE transaction_id = ? AND contact_id = ? AND removed_at IS NOT NULL
  `)
        .run(D1, C2),
  },
  {
    at: "electron/services/db/checklistSql.ts:106-109 (INSERT_CHECKLIST_SQL)",
    kind: "insert",
    table: "transaction_checklists",
    marks: [D1],
    run: (db) =>
      db
        .prepare(`
  INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order)
  VALUES (?, ?, ?, ?, ?)
`)
        .run(NEW_CHECKLIST, D1, "tpl-2", "Second list", 2),
  },
  {
    at: "electron/services/db/checklistSql.ts:118-122 (INSERT_CHECKLIST_ITEM_SQL)",
    kind: "insert",
    table: "transaction_checklist_items",
    marks: [D1],
    run: (db) =>
      db
        .prepare(`
  INSERT INTO transaction_checklist_items
    (id, checklist_id, title, description, is_required, expected_document_type, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)
        .run(NEW_ITEM, NEW_CHECKLIST, "Walkthrough", null, 0, null, 0),
  },
  {
    at: "electron/services/db/checklistSql.ts:321-326 (SET_CHECKLIST_ITEM_CHECKED_SQL: check an item)",
    kind: "update",
    table: "transaction_checklist_items",
    marks: [D1],
    run: (db) =>
      db
        .prepare(`
  UPDATE transaction_checklist_items
  SET is_checked = ?,
      checked_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
  WHERE id = ?
`)
        .run(1, 1, I1),
  },
  {
    at: "electron/services/db/checklistSql.ts:329-331 (SET_CHECKLIST_ITEM_NOTE_SQL)",
    kind: "update",
    table: "transaction_checklist_items",
    marks: [D1],
    run: (db) => db.prepare("\n  UPDATE transaction_checklist_items SET note = ? WHERE id = ?\n").run("Booked", I2),
  },
  {
    at: "electron/services/db/checklistSql.ts:213-215 (SET_ITEM_SORT_ORDER_SQL)",
    kind: "update",
    table: "transaction_checklist_items",
    marks: [D1],
    run: (db) => db.prepare("\n  UPDATE transaction_checklist_items SET sort_order = ? WHERE id = ? AND checklist_id = ?\n").run(5, I2, CL1),
  },
  {
    at: "electron/services/db/checklistSql.ts:175-181 (RENAME_PRIVATE_ITEM_SQL; reserved id checklistPrivacy.ts:27)",
    kind: "update",
    table: "transaction_checklist_items",
    marks: [D1],
    run: (db) =>
      db
        .prepare(`
  UPDATE transaction_checklist_items SET title = ?
  WHERE id = ?
    AND checklist_id IN (
      SELECT id FROM transaction_checklists WHERE transaction_id = ? AND template_id = ?
    )
`)
        .run("Call the lender", I_PRIVATE, D1, "keepr:my-items"),
  },
  {
    at: "electron/services/db/checklistSql.ts:189-195 (DELETE_PRIVATE_ITEM_SQL)",
    kind: "delete",
    table: "transaction_checklist_items",
    marks: [D1],
    run: (db) =>
      db
        .prepare(`
  DELETE FROM transaction_checklist_items
  WHERE id = ?
    AND checklist_id IN (
      SELECT id FROM transaction_checklists WHERE transaction_id = ? AND template_id = ?
    )
`)
        .run(I_PRIVATE, D1, "keepr:my-items"),
  },
  {
    at: "electron/services/db/checklistSql.ts:138-141 + checklistPrivacy.ts:43 (DELETE_CHECKLIST_IN_TRANSACTION_SQL; its items follow by cascade)",
    kind: "cascade",
    table: "transaction_checklists",
    marks: [D1],
    run: (db) =>
      db
        .prepare(`
  DELETE FROM transaction_checklists AS cl
  WHERE cl.id = ? AND cl.transaction_id = ? AND cl.template_id <> 'keepr:my-items'
`)
        .run(NEW_CHECKLIST, D1),
  },
  {
    at: "electron/services/db/contactDbService.ts:1869 (updateContact)",
    kind: "update",
    table: "contacts",
    marks: [D1],
    run: (db) => db.prepare("UPDATE contacts SET display_name = ?, company = ? WHERE id = ?").run("Person One Renamed", "Other Co", C1),
  },
  {
    at: "electron/services/db/contactDbService.ts:3012-3014 (contact email insert)",
    kind: "insert",
    table: "contact_emails",
    marks: [D1],
    run: (db) =>
      db
        .prepare("INSERT INTO contact_emails (id, contact_id, email, is_primary, source, created_at) VALUES (?, ?, ?, ?, 'manual', CURRENT_TIMESTAMP)")
        .run(NEW_EMAIL, C1, "person1-work@example.test", 0),
  },
  {
    at: "electron/services/db/contactDbService.ts:3007-3009 (contact email update)",
    kind: "update",
    table: "contact_emails",
    marks: [D1],
    run: (db) => db.prepare("UPDATE contact_emails SET email = ?, is_primary = ? WHERE id = ?").run("person1-home@example.test", 0, NEW_EMAIL),
  },
  {
    at: "electron/services/db/contactDbService.ts:3000 (contact email delete)",
    kind: "delete",
    table: "contact_emails",
    marks: [D1],
    run: (db) => db.prepare("DELETE FROM contact_emails WHERE id = ?").run(NEW_EMAIL),
  },
  {
    at: "electron/services/db/contactDbService.ts:3108-3110 (contact phone insert)",
    kind: "insert",
    table: "contact_phones",
    marks: [D1],
    run: (db) =>
      db
        .prepare(
          "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source, created_at) VALUES (?, ?, ?, ?, ?, 'manual', CURRENT_TIMESTAMP)",
        )
        .run(NEW_PHONE, C1, "+12125550198", "2125550198", 0),
  },
  {
    at: "electron/services/db/contactDbService.ts:3103-3105 (contact phone update)",
    kind: "update",
    table: "contact_phones",
    marks: [D1],
    run: (db) =>
      db.prepare("UPDATE contact_phones SET phone_e164 = ?, phone_normalized = ?, is_primary = ? WHERE id = ?").run("+12125550197", "2125550197", 0, NEW_PHONE),
  },
  {
    at: "electron/services/db/contactDbService.ts:3096 (contact phone delete)",
    kind: "delete",
    table: "contact_phones",
    marks: [D1],
    run: (db) => db.prepare("DELETE FROM contact_phones WHERE id = ?").run(NEW_PHONE),
  },
  {
    at: "electron/services/db/contactSourceLinkDbService.ts:391-396 (link insert)",
    kind: "insert",
    table: "contact_source_links",
    marks: [D1],
    run: (db) =>
      db
        .prepare(`INSERT INTO contact_source_links
       (id, user_id, contact_id, source_type, source_record_id,
        external_uuid, match_method, confidence, evidence_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(NEW_LINK, U_ON, C1, "macos", "rec-mac-1", null, "source_id", null, null),
  },
  {
    at: "electron/services/db/contactSourceLinkDbService.ts:378-384 (link upgrade; sets no column the trigger watches)",
    kind: "update",
    table: "contact_source_links",
    marks: [],
    run: (db) =>
      db
        .prepare(`UPDATE contact_source_links
            SET external_uuid = COALESCE(external_uuid, ?),
                match_method = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`)
        .run("uuid-mac-1", "email", NEW_LINK),
  },
  {
    at: "electron/services/db/contactSourceLinkDbService.ts:413-416 (deleteLinkBySourceRecord)",
    kind: "delete",
    table: "contact_source_links",
    marks: [D1],
    run: (db) =>
      db
        .prepare(`DELETE FROM contact_source_links
      WHERE user_id = ? AND source_type = ? AND source_record_id = ?`)
        .run(U_ON, "macos", "rec-mac-1"),
  },
  {
    at: "electron/services/db/contactDbService.ts:2381-2387 (deleteContact: a tombstone UPDATE, not a DELETE)",
    kind: "update",
    table: "contacts",
    marks: [D1, D4], // C2 is on D4, and on D1 since the party insert above
    run: (db) =>
      db
        .prepare(`UPDATE contacts
        SET removed_at = datetime('now'),
            removed_reason = ?
      WHERE id = ? AND removed_at IS NULL`)
        .run("user_deleted", C2),
  },
  {
    at: "electron/services/db/syncDbService.ts:168-173 + :192 (batchInsertMessages: 500 rows in one transaction)",
    kind: "bulk insert",
    table: "messages",
    marks: [],
    run: (db) => {
      const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO messages (
      id, user_id, channel, external_id, direction,
      body_text, participants, participants_flat, thread_id, sent_at,
      has_attachments, message_type, metadata, sync_session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
      db.transaction(() => {
        for (let n = 0; n < 500; n++) {
          insertStmt.run(id(14, n), U_ON, "sms", `ext-sms-${n}`, "inbound", `Bulk ${n}`, null, null, "thread-1", "2026-11-02T00:00:00.000Z", 0, "text", null, null);
        }
      })();
    },
  },
  {
    at: "electron/services/db/transactionDbService.ts:1312 + :1327-1329 (deleteTransactionSync: reads the texts naming the deal, then the DELETE; parties, checklists and items follow by cascade)",
    kind: "cascade",
    table: "transactions",
    marks: [D4],
    run: (db) =>
      db.transaction(() => {
        db.prepare("SELECT id FROM messages WHERE transaction_id = ?").all(D4);
        db.prepare("DELETE FROM transactions WHERE id = ?").run(D4);
      })(),
  },
];

/** Runs every v2.48.0 write; each must succeed. Returns the marks each one added (by statement). */
function runWrites248(db: DatabaseType): Array<{ at: string; added: string[]; bumped: number }> {
  const out: Array<{ at: string; added: string[]; bumped: number }> = [];
  for (const w of WRITES_248) {
    const before = new Map(dirty(db).map((r) => [r.transaction_id, r.generation]));
    const sumBefore = generationSum(db);
    expect(() => w.run(db)).not.toThrow();
    const after = dirty(db);
    out.push({
      at: w.at,
      added: after.filter((r) => (before.get(r.transaction_id) ?? 0) < r.generation).map((r) => r.transaction_id).sort(),
      bumped: generationSum(db) - sumBefore,
    });
  }
  return out;
}

describe("Keepr Cloud across 2.48.0 and 2.49 (real driver, real open path)", () => {
  jest.setTimeout(120000);
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-4243-248-"));
    userDataDir = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("FIXTURE: the vendored schema.sql is byte-for-byte v2.48.0's, and the profile is a v79 file without any Keepr Cloud object", () => {
    const bytes = fs.readFileSync(path.join(FIXTURES, "schema.sql"));
    const blob = crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    expect(blob).toBe(TAG_SCHEMA_BLOB);
    expect(PROFILE_V79_SQL).toContain(`schema.sql blob ${TAG_SCHEMA_BLOB}`);
    const { file } = buildV79Profile(dir);
    const db = openKeyed(file);
    expect(versionOf(db)).toBe(79);
    expect(names(db, "table", "cloud_sync_%")).toEqual([]);
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual([]);
    expect(columns(db, "learn_bulk_answers")).not.toContain("sender_key");
    expect(names(db, "table", "learn_sender_overrides")).toEqual([]);
    for (const t of [...SEEDED_TABLES, ...WATCHED_TABLES]) expect([t, count(db, t) > 0]).toEqual([t, true]);
    db.close();
  });

  it("1a NEVER ON: a real v79 (2.48.0) profile opened by this build ends at v80 with the five cloud tables, no cloud trigger, no mark, and every pre-existing row unchanged", async () => {
    const { before } = buildV79Profile(dir);
    const { svc, db } = await openWithThisBuild();
    expect(versionOf(db)).toBe(80);
    expect(names(db, "table", "cloud_sync_%")).toEqual([...CLOUD_SYNC_TABLES].sort());
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual([]);
    for (const t of CLOUD_SYNC_TABLES) expect([t, count(db, t)]).toEqual([t, 0]);
    // Row for row, every column the table had before, every table the file had before.
    expect(changedTables(db, before)).toEqual(["schema_version"]);
    expect(versionOf(db)).toBe(80);
    // v80's documented writes: the new column, backfilled from the cached message only.
    const keys = db.prepare("SELECT id, sender_key FROM learn_bulk_answers ORDER BY id").all();
    expect(keys).toEqual([
      { id: id(10, 1), sender_key: "news@example.test" },
      { id: id(10, 2), sender_key: null },
      { id: id(10, 3), sender_key: null },
    ]);
    expect(count(db, "learn_sender_overrides")).toBe(0);
    await svc.close();
  });

  it("1c SAME OPEN: one open of the v79 profile both creates the cloud tables (absent before) and runs v80 (79 -> 80); the next open changes nothing", async () => {
    const { before } = buildV79Profile(dir);
    expect(before.has("cloud_sync_dirty")).toBe(false);
    expect(before.get("schema_version")!.rows[0]).toContain("79");
    const { svc, db } = await openWithThisBuild();
    expect(versionOf(db)).toBe(80);
    // The tables are exactly the declared shape (schema.sql, mirrored by CLOUD_SYNC_TABLES_DDL).
    const shape = new RealDatabase(":memory:");
    shape.exec(CLOUD_SYNC_TABLES_DDL);
    for (const t of CLOUD_SYNC_TABLES) {
      expect([t, db.prepare(`PRAGMA table_info(${t})`).all()]).toEqual([t, shape.prepare(`PRAGMA table_info(${t})`).all()]);
    }
    shape.close();
    // The migration ran (a pre-migration backup of the v79 file was taken), and with no Keepr Cloud user nothing was marked.
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith("mad-backup-") && f.endsWith(".db"));
    expect(backups).toHaveLength(1);
    expect(count(db, "cloud_sync_dirty")).toBe(0);
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual([]);
    const cookie = db.pragma("schema_version", { simple: true });
    const after = snapshot(db);
    await svc.close();
    const again = await openWithThisBuild();
    expect(again.db.pragma("schema_version", { simple: true })).toBe(cookie);
    expect(changedTables(again.db, after)).toEqual([]);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("mad-backup-"))).toHaveLength(1);
    await again.svc.close();
  });

  it("1b TURNED ON after the upgrade: the engine's enable path adds all 22 triggers and marks exactly the user's eligible deals in one transaction; a failed enable leaves nothing; no other row changes; the next pass uploads those deals", async () => {
    buildV79Profile(dir);
    const { svc, db } = await openWithThisBuild();
    const afterOpen = snapshot(db);
    // A failure inside the enable transaction (creating one trigger) rolls back the flag, every trigger and every mark.
    const realPrepare = db.prepare.bind(db);
    (db as { prepare: unknown }).prepare = (sql: string) => {
      if (sql.startsWith("CREATE TRIGGER trg_cloud_sync_item_insert")) throw Object.assign(new Error("disk"), { code: "SQLITE_FULL" });
      return realPrepare(sql);
    };
    expect(() => enable(db)).toThrow();
    (db as { prepare: unknown }).prepare = realPrepare;
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual([]);
    expect(changedTables(db, afterOpen)).toEqual([]);

    enable(db);
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(ALL_TRIGGERS);
    expect(eligibleDeals(db, U_ON)).toEqual([D1, D4]);
    expect(dirtyIds(db)).toEqual([D1, D4]);
    expect(db.prepare("SELECT user_id, enabled FROM cloud_sync_settings").all()).toEqual([{ user_id: U_ON, enabled: 1 }]);
    // What enabling writes is cloud_sync_settings and cloud_sync_dirty; every other row is as the open left it.
    expect(changedTables(db, afterOpen, ["cloud_sync_settings", "cloud_sync_dirty"])).toEqual([]);

    const e = makeEngineOn(db);
    e.service.refreshSchedule();
    await e.service.runner!.whenIdle();
    expect(e.server.callsTo("cloud_upsert_deal")).toHaveLength(2);
    expect(e.server.deals).toHaveLength(2);
    expect(dirtyIds(db)).toEqual([]);
    expect(
      db.prepare("SELECT local_id, last_status FROM cloud_sync_state WHERE entity = 'deal' ORDER BY local_id").all(),
    ).toEqual([
      { local_id: D1, last_status: "synced" },
      { local_id: D4, last_status: "synced" },
    ]);
    await svc.close();
  });

  it("2a GOING BACK, never on: on a profile this build upgraded, 2.48.0's own open and common writes all succeed, no cloud trigger exists, and the cloud tables stay empty", async () => {
    buildV79Profile(dir);
    const first = await openWithThisBuild();
    await first.svc.close();
    const db = openAs248(path.join(dir, "mad.db"));
    expect(versionOf(db)).toBe(80);
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual([]);
    const results = runWrites248(db);
    expect(results.every((r) => r.added.length === 0 && r.bumped === 0)).toBe(true);
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual([]);
    for (const t of CLOUD_SYNC_TABLES) expect([t, count(db, t)]).toEqual([t, 0]);
    expect(count(db, "transactions")).toBe(5); // one created, D4 deleted
    expect(db.prepare("SELECT COUNT(*) AS n FROM transaction_checklist_items WHERE checklist_id = ?").get(CL2)).toEqual({ n: 0 });
    db.close();
  });

  it("2b GOING BACK, Keepr Cloud on: with all 22 triggers present, every common 2.48.0 write succeeds, none raises, and each marks the deal it touched", async () => {
    buildV79Profile(dir);
    const first = await openWithThisBuild();
    enable(first.db);
    first.db.exec("DELETE FROM cloud_sync_dirty");
    await first.svc.close();
    const db = openAs248(path.join(dir, "mad.db"));
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(ALL_TRIGGERS);
    const results = runWrites248(db);
    expect(results.map((r) => [r.at, r.added])).toEqual(WRITES_248.map((w) => [w.at, w.marks]));
    expect(dirtyIds(db)).toEqual([D1, D4, NEW_DEAL].sort());
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(ALL_TRIGGERS);
    db.close();
  });

  it("2b TRIGGER SWEEP, Keepr Cloud on: every one of the 22 triggers fires (a mark's generation moves) on its own event, and no insert, update of any watched column, delete, bulk insert or cascade raises", async () => {
    buildV79Profile(dir);
    const first = await openWithThisBuild();
    enable(first.db);
    await first.svc.close();
    const db = openAs248(path.join(dir, "mad.db"));
    const fired = new Set<string>();
    const step = (trigger: string, run: () => void) => {
      const before = generationSum(db);
      expect(run).not.toThrow();
      if (generationSum(db) > before) fired.add(trigger);
    };
    const rowOf = (table: string, where: string, ...p: unknown[]) => db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...p) as Row;
    const copyRow = (table: string, src: Row, over: Row) => insert(db, table, { ...src, ...over });
    // INSERT and DELETE on each watched table, from a seeded row of that table.
    const sources: Record<string, { where: string; arg: string; over: Row }> = {
      transactions: { where: "id = ?", arg: D1, over: { id: id(1, 20) } },
      transaction_contacts: { where: "id = ?", arg: id(8, 1), over: { id: id(8, 20), contact_id: C2 } },
      transaction_checklists: { where: "id = ?", arg: CL1, over: { id: id(3, 20), template_id: "tpl-sweep" } },
      transaction_checklist_items: { where: "id = ?", arg: I1, over: { id: id(4, 20) } },
      contact_emails: { where: "id = ?", arg: id(5, 1), over: { id: id(5, 20), email: "sweep@example.test" } },
      contact_phones: { where: "id = ?", arg: id(6, 1), over: { id: id(6, 20), phone_e164: "+12125550196" } },
      contact_source_links: { where: "id = ?", arg: id(7, 1), over: { id: id(7, 20), source_record_id: "rec-sweep" } },
    };
    for (const spec of CLOUD_SYNC_TRIGGERS) {
      const src = sources[spec.table];
      const event = / INSERT ON | DELETE ON | UPDATE /.exec(` ${spec.sql.split("\n")[1]} `)?.[0].trim().split(" ")[0];
      if (event === "INSERT") {
        step(spec.name, () => copyRow(spec.table, rowOf(spec.table, src.where, src.arg), src.over));
      } else if (event === "UPDATE") {
        const cols = /UPDATE OF ([^\n]+) ON/.exec(spec.sql)![1].split(", ");
        for (const c of cols) {
          if (spec.table === "contacts") {
            // The person trigger fires only on a real change of the column.
            const v = c === "removed_at" ? "2026-11-03 00:00:00" : c === "source" ? "email" : `${c}-changed`;
            step(spec.name, () => db.prepare(`UPDATE contacts SET ${c} = ? WHERE id = ?`).run(v, C1));
          } else {
            const key = spec.table === "transactions" ? D1 : (src.arg as string);
            step(spec.name, () => db.prepare(`UPDATE ${spec.table} SET ${c} = ${c} WHERE id = ?`).run(key));
          }
        }
      }
    }
    for (const spec of CLOUD_SYNC_TRIGGERS.filter((s) => s.sql.includes(" DELETE ON "))) {
      const src = sources[spec.table];
      step(spec.name, () => db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(src.over.id));
    }
    // A bulk insert of parties in one transaction, then cascades: a hard contact delete (emails, phones,
    // links and parties follow) and a deal delete (parties, checklists, items follow).
    step("bulk", () =>
      db.transaction(() => {
        for (let n = 0; n < 300; n++) {
          insert(db, "transactions", { id: id(16, n), user_id: U_ON, property_address: `${n} Bulk St`, status: "active", detection_status: "confirmed" });
          insert(db, "contacts", { id: id(17, n), user_id: U_ON, display_name: `Bulk ${n}`, source: "manual" });
          insert(db, "transaction_contacts", { id: id(15, n), transaction_id: id(16, n), contact_id: id(17, n), role: "other" });
        }
      })(),
    );
    step("cascade-contact", () => db.prepare("DELETE FROM contacts WHERE id = ?").run(C1));
    step("cascade-deal", () => db.prepare("DELETE FROM transactions WHERE id = ?").run(D1));
    expect([...fired].filter((n) => n.startsWith("trg_")).sort()).toEqual(ALL_TRIGGERS);
    expect(fired.has("bulk") && fired.has("cascade-contact") && fired.has("cascade-deal")).toBe(true);
    expect(count(db, "transaction_contacts")).toBe(302); // D4's, D5's and the 300 bulk parties remain
    expect(dirty(db).filter((r) => r.transaction_id.includes("-0016-"))).toHaveLength(300);
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(ALL_TRIGGERS);
    db.close();
  });

  it("2c RETURN: after 2.48.0 wrote to a Keepr Cloud profile, this build opens it cleanly; the next pass uploads the changed deals, deletes online the deal deleted under 2.48.0, and marks nothing synced before the server confirmed", async () => {
    buildV79Profile(dir);
    const first = await openWithThisBuild();
    enable(first.db);
    const e1 = makeEngineOn(first.db);
    e1.service.refreshSchedule();
    await e1.service.runner!.whenIdle();
    expect(dirtyIds(first.db)).toEqual([]);
    const server = e1.server;
    const cloudIdOf = (db: DatabaseType, local: string) =>
      (db.prepare("SELECT cloud_id FROM cloud_sync_state WHERE entity = 'deal' AND local_id = ?").get(local) as { cloud_id: string } | undefined)?.cloud_id;
    const d4Cloud = cloudIdOf(first.db, D4);
    expect(d4Cloud).toBeTruthy();
    await first.svc.close();

    const old = openAs248(path.join(dir, "mad.db"));
    runWrites248(old);
    expect(dirtyIds(old)).toEqual([D1, D4, NEW_DEAL].sort());
    old.close();

    const { svc, db } = await openWithThisBuild();
    expect(versionOf(db)).toBe(80);
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(ALL_TRIGGERS);
    expect(dirtyIds(db)).toEqual([D1, D4, NEW_DEAL].sort());

    // Nothing is marked synced before the server confirmed: the server refuses the final mark call.
    const e = makeEngineOn(db, server);
    const statusOf = (local: string) =>
      (db.prepare("SELECT last_status FROM cloud_sync_state WHERE entity = 'deal' AND local_id = ?").get(local) as { last_status: string | null } | undefined)
        ?.last_status ?? null;
    server.override = (fn) => (fn === "cloud_mark_deal_synced" ? new Error("offline") : undefined);
    e.service.refreshSchedule();
    await e.service.runner!.whenIdle();
    expect(server.callsTo("cloud_mark_deal_synced").length).toBeGreaterThan(0);
    expect(dirtyIds(db)).toEqual(expect.arrayContaining([D1, NEW_DEAL]));
    expect([statusOf(D1), statusOf(NEW_DEAL)]).not.toContain("synced");

    // A write landing while the pass is confirming D1 survives the pass (the generation-guarded clear).
    const d1Cloud = cloudIdOf(db, D1) as string;
    const genBefore = dirty(db).find((r) => r.transaction_id === D1)!.generation;
    let injected = false;
    server.override = (fn, args) => {
      if (fn === "cloud_mark_deal_synced" && JSON.stringify(args).includes(d1Cloud) && !injected) {
        injected = true;
        db.prepare("UPDATE transactions SET property_city = 'During pass' WHERE id = ?").run(D1);
      }
      return undefined;
    };
    db.exec("UPDATE cloud_sync_dirty SET attempts = 0, next_attempt_at = NULL");
    await e.service.runner!.runPass();
    expect(injected).toBe(true);
    expect(dirty(db).find((r) => r.transaction_id === D1)?.generation).toBeGreaterThan(genBefore);
    server.override = null;
    db.exec("UPDATE cloud_sync_dirty SET attempts = 0, next_attempt_at = NULL");
    await e.service.runner!.runPass();
    expect(dirtyIds(db)).toEqual([]);
    // The deal deleted under 2.48.0 was deleted online (runner.ts:430-440) and its records forgotten.
    expect(server.callsTo("cloud_delete_deal").map((c) => JSON.stringify(c))).toEqual([expect.stringContaining(d4Cloud as string)]);
    expect(server.deals.map((d) => (d as unknown as { id: string }).id)).not.toContain(d4Cloud);
    expect(count(db, "cloud_sync_state") > 0 && cloudIdOf(db, D4) === undefined).toBe(true);
    expect(db.prepare("SELECT local_id, last_status FROM cloud_sync_state WHERE entity = 'deal' ORDER BY local_id").all()).toEqual(
      [D1, NEW_DEAL].sort().map((l) => ({ local_id: l, last_status: "synced" })),
    );
    await svc.close();
  });

  it("2d 2.48.0's schema.sql re-run on a Keepr Cloud profile: it succeeds, drops or rebuilds nothing, keeps all 22 triggers, creates no mark, and changes no row", async () => {
    buildV79Profile(dir);
    const first = await openWithThisBuild();
    enable(first.db);
    const triggerSql = first.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_cloud_sync_%' ORDER BY name").all();
    const objects = first.db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const before = snapshot(first.db);
    await first.svc.close();
    const db = openKeyed(path.join(dir, "mad.db"));
    expect(() => db.exec(TAG_SCHEMA_SQL)).not.toThrow();
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_cloud_sync_%' ORDER BY name").all()).toEqual(triggerSql);
    expect(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(objects);
    expect(changedTables(db, before)).toEqual([]);
    db.close();
  });
});

it("FIXTURE provenance: profile-v79.sql names the v2.48.0 tag commit and the generator that wrote it", () => {
  expect(PROFILE_V79_SQL.split("\n").slice(0, 4).join("\n")).toMatch(/generateProfileV79\.gen\.ts\.txt at tag commit 52afbd8aee45c63c2333a8e712f29a581010cdde/);
  expect(fs.existsSync(path.join(FIXTURES, "generateProfileV79.gen.ts.txt"))).toBe(true);
});
