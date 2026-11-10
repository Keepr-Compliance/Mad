/**
 * @jest-environment node
 *
 * BACKLOG-3023 — a database whose `prevent_audit_update` trigger a pre-2548 sync
 * weakened is repaired at startup, through the REAL `initialize()` and the REAL
 * driver, with no sync involved.
 *
 * The weakened trigger is produced the way the pre-2548 code produced it:
 * DROP, UPDATE synced_at, then CREATE with the drifted text, transcribed from
 * `git show 71c0eee9f^:electron/services/db/auditLogDbService.ts` lines 74-89
 * (71c0eee9f is the BACKLOG-2548 fix; its parent is the last code that wrote it).
 *
 * "Untouched" is asserted with SQLite's schema cookie (`PRAGMA schema_version`),
 * which moves on ANY DDL. Byte-equality alone cannot tell "did nothing" from
 * "dropped and recreated with the same text".
 *
 * Controls: C1 repair + tamper refused + reported off-device; C2 never-synced DB
 * untouched; C3 idempotent; C4 dormant DB repaired with no sync; C6 a trigger
 * the 2548 code wrote is left alone (catches an exact-text compare); C7 a
 * failing repair is reported and never fails, restores or shows a dialog; C8
 * strict by db-ready; C9 runs after the migration chain; C10 a rejecting log
 * write in the failure path cannot escape. Mutations: BACKLOG-3023 pm_comments.
 *
 * Run under Electron's node locally (the shared native module is Electron-ABI):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/__tests__/auditTriggerRepair-3023.test.ts --bail=0
 *
 * EVERY FIXTURE ROW IS SYNTHETIC.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

let userDataDir = "/tmp/unset-3023";
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
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
const mockLog = {
  info: jest.fn().mockResolvedValue(undefined),
  debug: jest.fn().mockResolvedValue(undefined),
  warn: jest.fn().mockResolvedValue(undefined),
  error: jest.fn().mockResolvedValue(undefined),
};
jest.mock("../logService", () => ({ __esModule: true, default: mockLog, logService: mockLog }));
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
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

function loadService(): AnyService {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../tests/helpers/installTestCapabilities").installTestCapabilities();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../databaseService").default;
}

// Transcribed verbatim from 71c0eee9f^:electron/services/db/auditLogDbService.ts:82-89.
const PRE_2548_WEAK_DDL = `
      CREATE TRIGGER IF NOT EXISTS prevent_audit_update
      BEFORE UPDATE ON audit_logs
      WHEN NEW.synced_at IS NULL OR OLD.synced_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'Audit logs cannot be modified');
      END
    `;

/** What the pre-2548 markAuditLogsSynced did (:74-89), on a raw handle. */
function pre2548Sync(db: DatabaseType, ids: string[]): void {
  db.exec("DROP TRIGGER IF EXISTS prevent_audit_update");
  db.prepare(`UPDATE audit_logs SET synced_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`).run(
    "2026-08-30T10:51:16.000Z",
    ...ids,
  );
  db.exec(PRE_2548_WEAK_DDL);
}

const triggerSql = (db: DatabaseType): string | null =>
  (
    db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='prevent_audit_update'").get() as
      | { sql: string }
      | undefined
  )?.sql ?? null;
const cookie = (db: DatabaseType): number => db.pragma("schema_version", { simple: true }) as number;

function seedUser(db: DatabaseType): void {
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u-3023', 'agent@example.test', 'google', 'oa-3023')",
  ).run();
}
function insertLog(db: DatabaseType, id: string): void {
  db.prepare(
    "INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, metadata, timestamp) " +
      "VALUES (?, 'u-3023', 'LOGIN', 'session', 'res', '{}', '2026-08-30T10:51:00.000Z')",
  ).run(id);
}
/** The hole: rewrite `action` on an unsynced row by also setting synced_at. */
function tamper(db: DatabaseType, id: string): void {
  db.prepare("UPDATE audit_logs SET action = 'DATA_DELETE', resource_id = 'rewritten', synced_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(id);
}
const repairedLine = (): unknown[][] =>
  mockLog.warn.mock.calls.filter((c) => String(c[0]).startsWith("Audit-log update trigger is not strict"));

// The mocks in the CURRENT module registry (loadService resets it, and jest
// re-runs each factory, so these must be read after the load they belong to).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sentry = (): { captureException: jest.Mock; captureMessage: jest.Mock } => require("@sentry/electron/main");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dialog = (): { showMessageBox: jest.Mock } => require("electron").dialog;
const repairTagged = (calls: unknown[][]): unknown[][] =>
  calls.filter((c) => (c[1] as { tags?: { operation?: string } } | undefined)?.tags?.operation === "auditTriggerRepair");

describe("BACKLOG-3023 — startup repairs a weakened audit-log trigger", () => {
  jest.setTimeout(120000);
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3023-"));
    userDataDir = dir;
    jest.clearAllMocks();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("C1: weakened trigger (a past non-empty sync) -> next launch -> tampering UPDATE is refused", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const d1 = first.db as DatabaseType;
    seedUser(d1);
    insertLog(d1, "a-synced");
    pre2548Sync(d1, ["a-synced"]);
    insertLog(d1, "a-pending");
    // PRECONDITION: the fixture really is weak — the tamper goes through.
    expect(triggerSql(d1)).toContain("WHEN NEW.synced_at IS NULL");
    insertLog(d1, "a-probe");
    expect(() => tamper(d1, "a-probe")).not.toThrow();
    await first.close();

    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const d2 = second.db as DatabaseType;
    expect(() => tamper(d2, "a-pending")).toThrow(/Audit logs cannot be modified/);
    expect((d2.prepare("SELECT action FROM audit_logs WHERE id='a-pending'").get() as { action: string }).action).toBe(
      "LOGIN",
    );
    // Before the DROP: the prior definition, normalised, is logged.
    expect(repairedLine()).toHaveLength(1);
    expect(String((repairedLine()[0][2] as { previousDefinition: string }).previousDefinition)).toContain(
      "WHEN NEW.synced_at IS NULL OR OLD.synced_at IS NOT NULL",
    );
    // Off-device: one tagged message carrying the same definition, no exception.
    const msgs = repairTagged(sentry().captureMessage.mock.calls);
    expect(msgs).toHaveLength(1);
    expect(String((msgs[0][1] as { extra: { previousDefinition: string } }).extra.previousDefinition)).toContain(
      "WHEN NEW.synced_at IS NULL",
    );
    expect(repairTagged(sentry().captureException.mock.calls)).toHaveLength(0);
    expect(dialog().showMessageBox).not.toHaveBeenCalled();
    await second.close();
  });

  it("C2: a never-synced database is untouched — trigger byte-identical and no DDL ran", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const d1 = first.db as DatabaseType;
    const before = triggerSql(d1);
    const cookieBefore = cookie(d1);
    await first.close();

    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const d2 = second.db as DatabaseType;
    expect(triggerSql(d2)).toBe(before);
    expect(cookie(d2)).toBe(cookieBefore);
    expect(repairedLine()).toHaveLength(0);
    expect(repairTagged(sentry().captureMessage.mock.calls)).toHaveLength(0);
    await second.close();
  });

  it("C3: idempotent — the launch after a repair changes nothing", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const d1 = first.db as DatabaseType;
    seedUser(d1);
    insertLog(d1, "b-1");
    pre2548Sync(d1, ["b-1"]);
    await first.close();

    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const d2 = second.db as DatabaseType;
    const afterRepair = triggerSql(d2);
    const cookieAfterRepair = cookie(d2);
    expect(afterRepair).not.toContain("WHEN");
    await second.close();
    mockLog.warn.mockClear();

    const third = loadService();
    await expect(third.initialize()).resolves.toBe(true);
    const d3 = third.db as DatabaseType;
    expect(triggerSql(d3)).toBe(afterRepair);
    expect(cookie(d3)).toBe(cookieAfterRepair);
    expect(repairedLine()).toHaveLength(0);
    await third.close();
  });

  it("C4: dormant — fully synced, ZERO pending rows, repaired with no sync; a later row cannot be tampered", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const d1 = first.db as DatabaseType;
    seedUser(d1);
    insertLog(d1, "c-1");
    insertLog(d1, "c-2");
    pre2548Sync(d1, ["c-1", "c-2"]);
    expect((d1.prepare("SELECT COUNT(*) n FROM audit_logs WHERE synced_at IS NULL").get() as { n: number }).n).toBe(0);
    await first.close();

    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const d2 = second.db as DatabaseType;
    // No sync happened: every synced_at is still the one the old sync wrote.
    expect(d2.prepare("SELECT DISTINCT synced_at FROM audit_logs").all()).toEqual([
      { synced_at: "2026-08-30T10:51:16.000Z" },
    ]);
    insertLog(d2, "c-later");
    expect(() => tamper(d2, "c-later")).toThrow(/Audit logs cannot be modified/);
    await second.close();
  });

  it("C6: a trigger the 2548 code wrote (same rule, different whitespace) is left alone", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const d1 = first.db as DatabaseType;
    const schemaBuilt = triggerSql(d1);
    seedUser(d1);
    insertLog(d1, "d-1");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    await require("../db/auditLogDbService").markAuditLogsSynced(["d-1"]);
    const written2548 = triggerSql(d1);
    expect(written2548).not.toBe(schemaBuilt); // PRECONDITION: not byte-equal to schema.sql's
    const cookieBefore = cookie(d1);
    await first.close();

    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const d2 = second.db as DatabaseType;
    expect(triggerSql(d2)).toBe(written2548);
    expect(cookie(d2)).toBe(cookieBefore);
    expect(repairedLine()).toHaveLength(0);
    await second.close();
  });

  it("C8: the trigger is already strict when db-ready is broadcast", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const d1 = first.db as DatabaseType;
    seedUser(d1);
    insertLog(d1, "e-1");
    pre2548Sync(d1, ["e-1"]);
    await first.close();

    const second = loadService();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initializationBroadcaster } = require("../initializationBroadcaster");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const conn = require("../db/core/dbConnection");
    let atReady: string | null | undefined;
    const orig = initializationBroadcaster.broadcast.bind(initializationBroadcaster);
    jest.spyOn(initializationBroadcaster, "broadcast").mockImplementation((e: unknown) => {
      if ((e as { stage: string }).stage === "db-ready") atReady = triggerSql(conn.getRawDatabase());
      return orig(e);
    });
    await expect(second.initialize()).resolves.toBe(true);
    expect(atReady).toBeDefined();
    expect(atReady).not.toContain("WHEN");
    await second.close();
  });

  it("C7: a repair that throws is logged and does not fail or restore the launch", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    await first.close();

    jest.doMock("../db/auditLogDbService", () => ({
      ...jest.requireActual("../db/auditLogDbService"),
      repairAuditUpdateTrigger: () => {
        throw new Error("forced-3023");
      },
    }));
    try {
      const second = loadService();
      await expect(second.initialize()).resolves.toBe(true);
      expect(
        mockLog.warn.mock.calls.some((c) => String(c[0]).startsWith("Audit-log trigger check failed")),
      ).toBe(true);
      const caught = repairTagged(sentry().captureException.mock.calls);
      expect(caught).toHaveLength(1);
      expect((caught[0][0] as Error).message).toBe("forced-3023");
      expect(dialog().showMessageBox).not.toHaveBeenCalled();
      expect(fs.readdirSync(dir).filter((f) => f.startsWith("mad-pre-restore-"))).toEqual([]);
      expect(mockLog.error.mock.calls.filter((c) => String(c[0]).includes("Failed to run migrations"))).toEqual([]);
      await second.close();
    } finally {
      jest.dontMock("../db/auditLogDbService");
    }
  });

  it("C9: a migration that leaves the weak trigger is healed in the SAME launch (repair runs after the chain)", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    await first.close();

    const second = loadService();
    const klass = second.constructor as {
      MIGRATIONS: Array<{ version: number; description: string; migrate: (d: DatabaseType) => void }>;
    };
    const last = klass.MIGRATIONS[klass.MIGRATIONS.length - 1].version;
    klass.MIGRATIONS = [
      ...klass.MIGRATIONS,
      {
        version: last + 1,
        description: "BACKLOG-3023 C9 test-only",
        migrate: (d) => {
          d.exec("DROP TRIGGER IF EXISTS prevent_audit_update");
          d.exec(PRE_2548_WEAK_DDL);
        },
      },
    ];
    await expect(second.initialize()).resolves.toBe(true);
    const d2 = second.db as DatabaseType;
    // PRECONDITION: the armed migration ran.
    expect((d2.prepare("SELECT version v FROM schema_version WHERE id = 1").get() as { v: number }).v).toBe(last + 1);
    seedUser(d2);
    insertLog(d2, "z-1");
    expect(() => tamper(d2, "z-1")).toThrow(/Audit logs cannot be modified/);
    await second.close();
  });

  it("C10: a repair that throws AND a log write that rejects still cannot fail or restore the launch", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    await first.close();

    jest.doMock("../db/auditLogDbService", () => ({
      ...jest.requireActual("../db/auditLogDbService"),
      repairAuditUpdateTrigger: () => {
        throw new Error("forced-3023-c10");
      },
    }));
    mockLog.warn.mockImplementation((message: unknown) =>
      String(message).startsWith("Audit-log trigger check failed")
        ? Promise.reject(new Error("log write failed"))
        : Promise.resolve(undefined),
    );
    try {
      const second = loadService();
      await expect(second.initialize()).resolves.toBe(true);
      expect(
        mockLog.warn.mock.calls.some((c) => String(c[0]).startsWith("Audit-log trigger check failed")),
      ).toBe(true); // PRECONDITION: the rejecting write was reached
      expect(fs.readdirSync(dir).filter((f) => f.startsWith("mad-pre-restore-"))).toEqual([]);
      expect(dialog().showMessageBox).not.toHaveBeenCalled();
      await second.close();
    } finally {
      mockLog.warn.mockImplementation(() => Promise.resolve(undefined));
      jest.dontMock("../db/auditLogDbService");
    }
  });
});
