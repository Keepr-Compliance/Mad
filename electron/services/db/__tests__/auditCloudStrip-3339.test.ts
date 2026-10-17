/**
 * @jest-environment node
 *
 * BACKLOG-3339 PR 0 release gate — raw free text does not reach the cloud.
 *
 * REAL driver, REAL shipped schema, REAL `auditLogDbService`, REAL
 * `auditService`. Only the cloud is faked; it records exactly the entries
 * `batchInsertAuditLogs` would map and send.
 *
 *   S1  live send: a failed entry is uploaded without error_message or the
 *       raw `metadata.error`; the local row keeps both.
 *   S2  backfill (the BACKLOG-3987 table fallback): a row left unsynced by a
 *       previous run is uploaded without error_message.
 *   S3  backfill: the same, for metadata.error.
 *
 * Mutation run at adoption (proven applied, see the item's pm_comment):
 *   remove "errorMessage" from AUDIT_FREE_TEXT_FIELDS        -> S1, S2 red
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/jest/bin/jest.js \
 *     electron/services/db/__tests__/auditCloudStrip-3339.test.ts
 */

import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));

import { auditService, type AuditLogEntry } from "../../auditService";
import {
  PROBE_USER,
  auditRows,
  openAuditProbeDb,
  realAuditDb,
  settle,
} from "./fixtures/auditTxProbe";

const RAW_ERROR = 'Contact "Wilhelmina Quakenbush" at 742 Evergreen Terrace could not be saved';

let db: DatabaseType;
let uploads: AuditLogEntry[][];

const fakeCloud = {
  getAuthSession: async () => ({ userId: PROBE_USER }),
  async batchInsertAuditLogs(entries: AuditLogEntry[]): Promise<void> {
    uploads.push(entries.map((e) => ({ ...e })));
  },
};

beforeEach(() => {
  db = openAuditProbeDb();
  uploads = [];
  const svc = auditService as unknown as Record<string, unknown>;
  svc.pendingSyncQueue = [];
  svc.syncInProgress = false;
  svc.currentSync = null;
  svc.cloudSyncFailing = false;
  svc.initialized = false;
  svc.pendingLocalWrites = [];
  auditService.setSupportAccessGate(null);
  auditService.initialize(realAuditDb as never, fakeCloud as never);
  auditService.stopSyncInterval();
});

afterEach(async () => {
  auditService.stopSyncInterval();
  await settle();
  db.close();
});

test("R0 the real driver is under test", () => {
  const row = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  expect(row.v).toMatch(/^3\.\d+/);
  expect(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'prevent_audit_update'").get(),
  ).toEqual({ n: 1 });
});

describe("free text does not reach the cloud (BACKLOG-3339 release gate)", () => {
  test("S1 live send: the failed entry is uploaded without error_message", async () => {
    await auditService.log({
      userId: PROBE_USER,
      action: "LOGIN_FAILED",
      resourceType: "SESSION",
      metadata: { provider: "microsoft", error: RAW_ERROR },
      success: false,
      errorMessage: RAW_ERROR,
    });
    await settle();
    const sent = uploads.flat();
    expect(sent.map((e) => e.action)).toEqual(["LOGIN_FAILED"]);
    expect(sent[0].success).toBe(false);
    expect(sent[0].errorMessage).toBeUndefined();
    expect(sent[0].metadata).toEqual({ provider: "microsoft" });
    expect(JSON.stringify(sent)).not.toContain("Quakenbush");
    // The local row keeps it.
    expect(auditRows(db).map((r) => r.error_message)).toEqual([RAW_ERROR]);
  });

  test("S2 backfill: a row left unsynced by a previous run is uploaded without error_message", async () => {
    db.prepare(
      "INSERT INTO audit_logs (id, user_id, action, resource_type, success, error_message, timestamp) " +
        "VALUES ('prev-err', ?, 'CONTACT_CREATE', 'CONTACT', 0, ?, '2026-10-01T00:00:00.000Z')",
    ).run(PROBE_USER, RAW_ERROR);
    expect(auditService.getPendingSyncCount()).toBe(0);

    await auditService.syncToCloud();

    const sent = uploads.flat();
    expect(sent.map((e) => e.id)).toEqual(["prev-err"]);
    expect(sent[0].success).toBe(false);
    expect(sent[0].errorMessage).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("Quakenbush");
    expect(auditRows(db).map((r) => r.error_message)).toEqual([RAW_ERROR]);
  });

  test("S3 backfill: metadata.error of a left-over row is stripped, the other keys are sent", async () => {
    db.prepare(
      "INSERT INTO audit_logs (id, user_id, action, resource_type, success, metadata, timestamp) " +
        "VALUES ('prev-meta', ?, 'LOGIN_FAILED', 'SESSION', 0, ?, '2026-10-01T00:00:00.000Z')",
    ).run(PROBE_USER, JSON.stringify({ provider: "microsoft", error: RAW_ERROR }));
    expect(auditService.getPendingSyncCount()).toBe(0);

    await auditService.syncToCloud();

    const sent = uploads.flat();
    expect(sent.map((e) => e.id)).toEqual(["prev-meta"]);
    expect(sent[0].metadata).toEqual({ provider: "microsoft" });
    expect(JSON.stringify(sent)).not.toContain("Quakenbush");
    // The local row keeps it.
    const local = db.prepare("SELECT metadata FROM audit_logs WHERE id = 'prev-meta'").get() as {
      metadata: string;
    };
    expect(JSON.parse(local.metadata)).toEqual({ provider: "microsoft", error: RAW_ERROR });
  });
});
