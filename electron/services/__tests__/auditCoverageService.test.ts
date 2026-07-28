/**
 * @jest-environment node
 *
 * BACKLOG-2292 unit test for auditCoverageService against a REAL in-memory
 * better-sqlite3 DB (setDb). TZ-agnostic — all dates are explicit ISO UTC and
 * compared by epoch-ms (SR-correction f). Cases:
 *   - messages floor = MIN(sent_at), reaction- + duplicate-excluded
 *   - email floor: MAX(oldest_cached_at) only when ALL active accounts bounded;
 *     an active account with NULL lower bound = automatic GAP (SR-correction c)
 *   - getAuditCoverage gap flags (needsMessagesImport / needsEmailBackfill)
 *   - checkExportCompleteness: floor reaches → complete; gap + no import → not
 *     complete; gap + import-has-run → complete (nothing older exists);
 *     expansionStale → not complete
 */
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

// Force the messages-importer-availability probe deterministically true so the
// floor/gap assertions are the only variable.
jest.mock("../permissionService", () => ({
  __esModule: true,
  default: { checkFullDiskAccess: jest.fn().mockResolvedValue({ hasPermission: true }) },
}));
jest.mock("os", () => {
  const actual = jest.requireActual<typeof import("os")>("os");
  return { ...actual, platform: jest.fn(() => "darwin") };
});

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../db/core/dbConnection";
import { recordImport, recordExpansionRun } from "../db/messageImportStateService";
import {
  getMessagesFloorISO,
  getEmailFloor,
  getAuditCoverage,
  checkExportCompleteness,
} from "../auditCoverageService";

const USER = "user-cov";
const ms = (iso: string) => new Date(iso).getTime();

function makeDb(): DatabaseType {
  const db = new Database(":memory:") as DatabaseType;
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      channel TEXT,
      sent_at DATETIME,
      duplicate_of TEXT,
      associated_message_type INTEGER
    );
    CREATE TABLE email_sync_state (
      user_id TEXT,
      account_id TEXT,
      provider TEXT,
      phase TEXT DEFAULT 'active',
      oldest_cached_at DATETIME,
      PRIMARY KEY (user_id, account_id)
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      started_at DATETIME,
      created_at DATETIME,
      closed_at DATETIME,
      status TEXT
    );
    CREATE TABLE message_import_state (
      user_id TEXT PRIMARY KEY,
      last_import_at DATETIME,
      last_expansion_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

let db: DatabaseType;
function insMsg(id: string, sentAt: string | null, opts: { channel?: string; dup?: string; reaction?: number } = {}) {
  db.prepare(
    "INSERT INTO messages (id, user_id, channel, sent_at, duplicate_of, associated_message_type) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, USER, opts.channel ?? "imessage", sentAt, opts.dup ?? null, opts.reaction ?? null);
}
function insEmailAccount(accountId: string, oldest: string | null, phase = "active") {
  db.prepare(
    "INSERT INTO email_sync_state (user_id, account_id, provider, phase, oldest_cached_at) VALUES (?, ?, 'google', ?, ?)",
  ).run(USER, accountId, phase, oldest);
}

beforeEach(() => {
  db = makeDb();
  setDb(db);
});
afterEach(() => db.close());

describe("getMessagesFloorISO (BACKLOG-2292)", () => {
  it("returns MIN(sent_at) over non-reaction, non-duplicate sms/imessage rows", () => {
    insMsg("m1", "2026-03-01T00:00:00.000Z");
    insMsg("m2", "2026-01-15T00:00:00.000Z"); // oldest real
    insMsg("m3", "2025-06-01T00:00:00.000Z", { reaction: 2000 }); // reaction — excluded
    insMsg("m4", "2025-01-01T00:00:00.000Z", { dup: "m1" }); // duplicate — excluded
    insMsg("m5", "2024-01-01T00:00:00.000Z", { channel: "email" }); // wrong channel — excluded
    expect(getMessagesFloorISO(USER)).toBe("2026-01-15T00:00:00.000Z");
  });

  it("returns null when no texts imported", () => {
    expect(getMessagesFloorISO(USER)).toBeNull();
  });
});

describe("getEmailFloor (BACKLOG-2292, SR-correction c)", () => {
  it("MAX(oldest_cached_at) when all active accounts are bounded", () => {
    insEmailAccount("a1", "2026-02-01T00:00:00.000Z");
    insEmailAccount("a2", "2026-04-01T00:00:00.000Z");
    const r = getEmailFloor(USER);
    expect(r.hasUnboundedActive).toBe(false);
    expect(r.floorISO).toBe("2026-04-01T00:00:00.000Z");
  });

  it("an active account with NULL oldest_cached_at is an automatic gap (null floor)", () => {
    insEmailAccount("a1", "2026-02-01T00:00:00.000Z");
    insEmailAccount("a2", null); // unbounded active → gap
    const r = getEmailFloor(USER);
    expect(r.hasUnboundedActive).toBe(true);
    expect(r.floorISO).toBeNull();
  });

  it("ignores non-active accounts", () => {
    insEmailAccount("a1", null, "cleared"); // cleared — ignored
    insEmailAccount("a2", "2026-05-01T00:00:00.000Z");
    const r = getEmailFloor(USER);
    expect(r.hasUnboundedActive).toBe(false);
    expect(r.floorISO).toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("getAuditCoverage (BACKLOG-2292)", () => {
  it("flags a messages gap when the proposed start predates the floor", async () => {
    insMsg("m1", "2026-03-01T00:00:00.000Z"); // floor
    const r = await getAuditCoverage(USER, "2026-01-01T00:00:00.000Z");
    expect(r.success).toBe(true);
    expect(ms(r.messagesFloorISO as string)).toBe(ms("2026-03-01T00:00:00.000Z"));
    expect(r.needsMessagesImport).toBe(true);
  });

  it("no messages gap when the proposed start is at/after the floor", async () => {
    insMsg("m1", "2026-01-01T00:00:00.000Z");
    const r = await getAuditCoverage(USER, "2026-03-01T00:00:00.000Z");
    expect(r.needsMessagesImport).toBe(false);
  });

  it("flags an email backfill when an active account is unbounded, regardless of proposed start", async () => {
    insEmailAccount("a1", null);
    const r = await getAuditCoverage(USER, "2026-03-01T00:00:00.000Z");
    expect(r.needsEmailBackfill).toBe(true);
    expect(r.emailFloorISO).toBeNull();
  });

  it("reports expansionStale after an import with no expansion", async () => {
    insMsg("m1", "2026-03-01T00:00:00.000Z");
    recordImport(USER);
    const r = await getAuditCoverage(USER, "2026-03-01T00:00:00.000Z");
    expect(r.expansionStale).toBe(true);
  });
});

describe("checkExportCompleteness (BACKLOG-2292, Layer 3)", () => {
  function insTxn(startedAt: string) {
    db.prepare(
      "INSERT INTO transactions (id, user_id, started_at, status) VALUES ('t1', ?, ?, 'active')",
    ).run(USER, startedAt);
  }

  it("complete when the floor already reaches the audit start", async () => {
    insTxn("2026-05-01T00:00:00.000Z");
    insMsg("m1", "2026-01-01T00:00:00.000Z"); // floor older than start → covered
    const r = await checkExportCompleteness("t1", USER);
    expect(r.complete).toBe(true);
    expect(r.needsMessagesImport).toBe(false);
  });

  it("NOT complete when audit start predates the floor and no import has run", async () => {
    insTxn("2026-01-01T00:00:00.000Z");
    insMsg("m1", "2026-05-01T00:00:00.000Z"); // floor newer than start → gap
    const r = await checkExportCompleteness("t1", USER);
    expect(r.needsMessagesImport).toBe(true);
    expect(r.complete).toBe(false);
  });

  it("complete once a targeted import has run + expansion (floor above start ⇒ nothing older exists)", async () => {
    insTxn("2026-01-01T00:00:00.000Z");
    insMsg("m1", "2026-05-01T00:00:00.000Z"); // still a raw gap by floor
    recordImport(USER);
    recordExpansionRun(USER);
    const r = await checkExportCompleteness("t1", USER);
    expect(r.needsMessagesImport).toBe(true); // raw floor gap remains
    expect(r.complete).toBe(true); // but an import ran + expansion fresh ⇒ complete
  });

  it("NOT complete when expansion is stale (import ran, expansion did not)", async () => {
    insTxn("2026-05-01T00:00:00.000Z");
    insMsg("m1", "2026-01-01T00:00:00.000Z"); // floor covers — but expansion stale
    recordImport(USER); // import ran, no expansion → stale
    const r = await checkExportCompleteness("t1", USER);
    expect(r.expansionStale).toBe(true);
    expect(r.complete).toBe(false);
  });
});
