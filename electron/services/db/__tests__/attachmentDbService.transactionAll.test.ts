/**
 * @jest-environment node
 *
 * BACKLOG-322 Phase A — integration tests for getTransactionAllAttachments, the
 * unified email + text attachment query behind the transaction Attachments tab.
 *
 * Uses a REAL in-memory better-sqlite3 database (a minimal subset of the
 * production schema) injected through a mocked `ensureDb`, so the actual JOIN/
 * fallback SQL is exercised — while bypassing the Electron init chain.
 */

import path from "path";

const mockEnsureDb = jest.fn();
jest.mock("../core/dbConnection", () => ({
  ensureDb: () => mockEnsureDb(),
}));

// Require the REAL native driver (the default Jest moduleNameMapper rewrites it
// to a stub — escape that with an explicit node_modules path).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import { getTransactionAllAttachments } from "../attachmentDbService";

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      sent_at DATETIME,
      direction TEXT,
      subject TEXT,
      sender TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      external_id TEXT,
      sent_at DATETIME,
      direction TEXT,
      participants_flat TEXT
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      email_id TEXT,
      external_message_id TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT,
      file_size_bytes INTEGER,
      storage_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE communications (
      id TEXT PRIMARY KEY,
      transaction_id TEXT,
      message_id TEXT,
      email_id TEXT,
      thread_id TEXT
    );
  `);
}

function seed(db: DatabaseType): void {
  const email = db.prepare(
    `INSERT INTO emails (id, sent_at, direction, subject, sender) VALUES (?, ?, ?, ?, ?)`,
  );
  const message = db.prepare(
    `INSERT INTO messages (id, thread_id, external_id, sent_at, direction, participants_flat) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const att = db.prepare(
    `INSERT INTO attachments (id, message_id, email_id, external_message_id, filename, mime_type, file_size_bytes, storage_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const comm = db.prepare(
    `INSERT INTO communications (id, transaction_id, message_id, email_id, thread_id) VALUES (?, ?, ?, ?, ?)`,
  );

  // --- Emails linked to T1 ---
  email.run("E1", "2026-06-10T12:00:00.000Z", "inbound", "Purchase Agreement", "buyer@example.com");
  comm.run("c-e1", "T1", null, "E1", null);
  //   downloaded PDF
  att.run("A_e1", null, "E1", null, "contract.pdf", "application/pdf", 2048, "/data/contract.pdf");
  //   metadata-only image (storage_path NULL — must still be returned)
  att.run("A_e2", null, "E1", null, "photo.jpg", "image/jpeg", 1024, null);

  // E3 (outside audit window) linked to T1 — used for the date-window test
  email.run("E3", "2020-01-01T00:00:00.000Z", "outbound", "Old thread", "agent@example.com");
  comm.run("c-e3", "T1", null, "E3", null);
  att.run("A_e4", null, "E3", null, "old.pdf", "application/pdf", 10, "/data/old.pdf");

  // --- Texts linked to T1 ---
  // M1: direct message_id link
  message.run("M1", "TH1", "guid-m1", "2026-06-11T09:00:00.000Z", "inbound", "+15551230000");
  comm.run("c-m1", "T1", "M1", null, "TH1");
  att.run("A_t1", "M1", null, "guid-m1", "IMG_001.heic", "image/heic", 4096, "/data/img001.heic");

  // M2: linked via thread_id only (communications.message_id NULL)
  message.run("M2", "TH2", "guid-m2", "2026-06-12T09:00:00.000Z", "outbound", "+15555550120");
  comm.run("c-m2", "T1", null, null, "TH2");
  att.run("A_t2", "M2", null, "guid-m2", "clip.mov", "video/quicktime", 8192, "/data/clip.mov");

  // M3: attachment linked ONLY by external_message_id (message_id NULL) — fallback
  message.run("M3", "TH3", "guid-m3", "2026-06-13T09:00:00.000Z", "inbound", "+15555550104");
  comm.run("c-m3", "T1", "M3", null, "TH3");
  att.run("A_t3", null, null, "guid-m3", "voice.caf", "audio/x-caf", 512, "/data/voice.caf");

  // --- A different transaction T2 (must never leak into T1 results) ---
  email.run("E2", "2026-06-10T12:00:00.000Z", "inbound", "Other deal", "other@example.com");
  comm.run("c-e2", "T2", null, "E2", null);
  att.run("A_e3", null, "E2", null, "other.pdf", "application/pdf", 100, "/data/other.pdf");
}

describe("BACKLOG-322 getTransactionAllAttachments", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    seed(db);
    mockEnsureDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    jest.clearAllMocks();
  });

  it("returns the EXACT set of email + text attachments for the transaction", () => {
    const rows = getTransactionAllAttachments("T1");
    const ids = new Set(rows.map((r) => r.id));
    // A_e4 belongs to T1 too (no date window here) — included.
    expect(ids).toEqual(new Set(["A_e1", "A_e2", "A_e4", "A_t1", "A_t2", "A_t3"]));
    // T2's attachment must NOT appear.
    expect(ids.has("A_e3")).toBe(false);
  });

  it("labels each row with the correct source", () => {
    const rows = getTransactionAllAttachments("T1");
    const bySource = new Map(rows.map((r) => [r.id, r.source]));
    expect(bySource.get("A_e1")).toBe("email");
    expect(bySource.get("A_e2")).toBe("email");
    expect(bySource.get("A_t1")).toBe("text");
    expect(bySource.get("A_t2")).toBe("text");
    expect(bySource.get("A_t3")).toBe("text");
  });

  it("includes metadata-only rows (storage_path NULL) rather than filtering them out", () => {
    const rows = getTransactionAllAttachments("T1");
    const meta = rows.find((r) => r.id === "A_e2");
    expect(meta).toBeDefined();
    expect(meta?.storage_path).toBeNull();
  });

  it("resolves text attachments linked only by external_message_id (fallback)", () => {
    const rows = getTransactionAllAttachments("T1");
    const fallback = rows.find((r) => r.id === "A_t3");
    expect(fallback).toBeDefined();
    expect(fallback?.source).toBe("text");
  });

  it("resolves text attachments linked via thread_id (communications.message_id NULL)", () => {
    const rows = getTransactionAllAttachments("T1");
    expect(rows.some((r) => r.id === "A_t2")).toBe(true);
  });

  it("carries display context (email subject/sender, text participants)", () => {
    const rows = getTransactionAllAttachments("T1");
    const e1 = rows.find((r) => r.id === "A_e1");
    expect(e1?.context_subject).toBe("Purchase Agreement");
    expect(e1?.context_sender).toBe("buyer@example.com");
    const t1 = rows.find((r) => r.id === "A_t1");
    expect(t1?.context_subject).toBeNull();
    expect(t1?.context_sender).toBe("+15551230000");
  });

  it("respects the audit date window on the owning email/message sent_at", () => {
    // Window that excludes E3 (2020) but keeps the June-2026 items.
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-12-31T00:00:00.000Z");
    const rows = getTransactionAllAttachments("T1", start, end);
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has("A_e4")).toBe(false); // 2020 email excluded
    expect(ids).toEqual(new Set(["A_e1", "A_e2", "A_t1", "A_t2", "A_t3"]));
  });

  it("returns an empty list for a transaction with no linked attachments", () => {
    expect(getTransactionAllAttachments("T-none")).toEqual([]);
  });
});
