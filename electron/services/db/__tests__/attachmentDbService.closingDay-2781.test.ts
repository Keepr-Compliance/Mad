/**
 * @jest-environment node
 *
 * BACKLOG-2781 — the closing-day end bound on the transaction Attachments tab.
 *
 * LATENT, like the attachmentHandlers site: the tab's only caller
 * (`TransactionDetails.tsx:247`) calls `useTransactionAllAttachments(transaction.id)`
 * with no audit window, deliberately — the tab shows all linked content, matching
 * the Emails/Texts tabs. Fixed and pinned anyway so the next caller that supplies
 * a window does not inherit the wrong closing day. These tests drive the windowed
 * branch directly.
 *
 * `getTransactionAllAttachments` had its own copy of
 * `endOfDay.setHours(23, 59, 59, 999)` inside the shared `buildDateFilter`
 * closure (attachmentDbService.ts:451) — LOCAL hours applied to the UTC-midnight
 * instant `new Date(closed_at)` produces, so the bound landed early on the
 * closing day itself. It now consumes the canonical `auditWindowEnd()`.
 *
 * Unlike submissionDbService's four independent copies, this site has ONE
 * `buildDateFilter` serving all three queries (email, text-by-message_id, and
 * the external_message_id fallback), so reverting it reds all three branches
 * together by construction. All three are asserted anyway: the closure is shared
 * today, and an assertion per branch is what keeps a future un-sharing honest.
 *
 * The sweep, not the founder's single data point, is the control — see the
 * header of `submissionDbService.closingDay-2781.test.ts` for why (under TZ=UTC
 * the old bound already admitted the 05:30Z row, so asserting only that row
 * would stay green in CI when the fix is reverted).
 *
 * Real in-memory better-sqlite3 through a mocked `ensureDb`, following
 * `attachmentDbService.transactionAll.test.ts`. `sent_at` is stored as the real
 * producer writes it (`sentAt.toISOString()`, macOSMessagesImportService.ts:1132).
 */

import path from "path";

const mockEnsureDb = jest.fn();
jest.mock("../core/dbConnection", () => ({
  ensureDb: () => mockEnsureDb(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import { getTransactionAllAttachments } from "../attachmentDbService";

const CLOSED_AT = "2026-07-29";
const STARTED_AT = "2026-01-01";
const auditStart = new Date(STARTED_AT);
const auditEnd = new Date(CLOSED_AT);

const EARLY_OUT = "2025-12-31T23:59:59.999Z";
const MID_IN = "2026-06-15T12:00:00.000Z";
const S1 = "2026-07-29T05:30:00.000Z"; // 12:30am local on the closing day (Chicago)
const S2 = "2026-07-29T23:59:59.999Z";
const S3 = "2026-07-30T00:00:00.000Z"; // exactly the bound (inclusive)
const S4 = "2026-07-30T00:00:00.001Z"; // 1ms past the bound

const SWEEP: ReadonlyArray<readonly [string, string]> = [
  ["early", EARLY_OUT],
  ["mid", MID_IN],
  ["s1", S1],
  ["s2", S2],
  ["s3", S3],
  ["s4", S4],
];

const IN_WINDOW = ["mid", "s1", "s2", "s3"];

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

  for (const [key, sentAt] of SWEEP) {
    // --- email branch
    email.run(`E_${key}`, sentAt, "inbound", `Closing ${key}`, "buyer@example.com");
    comm.run(`ce_${key}`, "T1", null, `E_${key}`, null);
    att.run(`AE_${key}`, null, `E_${key}`, null, `email-${key}.pdf`, "application/pdf", 2048, `/data/e-${key}.pdf`);

    // --- text branch (direct message_id link)
    message.run(`M_${key}`, `TH_${key}`, `guid-${key}`, sentAt, "inbound", "+15555550100");
    comm.run(`cm_${key}`, "T1", `M_${key}`, null, `TH_${key}`);
    att.run(`AT_${key}`, `M_${key}`, null, `guid-${key}`, `text-${key}.heic`, "image/heic", 4096, `/data/t-${key}.heic`);

    // --- text fallback branch (message_id NULL, matched via external_message_id)
    message.run(`MF_${key}`, `THF_${key}`, `guidf-${key}`, sentAt, "inbound", "+15555550101");
    comm.run(`cmf_${key}`, "T1", `MF_${key}`, null, `THF_${key}`);
    att.run(`AF_${key}`, null, null, `guidf-${key}`, `fallback-${key}.caf`, "audio/x-caf", 512, null);
  }
}

describe("getTransactionAllAttachments — closing-day audit window (BACKLOG-2781)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as DatabaseType;
    createSchema(db);
    seed(db);
    mockEnsureDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    jest.clearAllMocks();
  });

  const idsWithPrefix = (prefix: string): Set<string> =>
    new Set(
      getTransactionAllAttachments("T1", auditStart, auditEnd)
        .map((r) => r.id)
        .filter((id) => id.startsWith(prefix)),
    );

  it("sweeps the bound on the EMAIL attachment branch", () => {
    const ids = idsWithPrefix("AE_");
    expect(ids).toEqual(new Set(IN_WINDOW.map((k) => `AE_${k}`)));
    expect(ids.has("AE_s1")).toBe(true); // 12:30am local on the closing day
    expect(ids.has("AE_s3")).toBe(true); // exactly the bound
    expect(ids.has("AE_s4")).toBe(false); // 1ms past
    expect(ids.has("AE_early")).toBe(false);
  });

  it("sweeps the bound on the TEXT attachment branch", () => {
    const ids = idsWithPrefix("AT_");
    expect(ids).toEqual(new Set(IN_WINDOW.map((k) => `AT_${k}`)));
    expect(ids.has("AT_s1")).toBe(true);
    expect(ids.has("AT_s3")).toBe(true);
    expect(ids.has("AT_s4")).toBe(false);
  });

  it("sweeps the bound on the external_message_id FALLBACK branch", () => {
    const ids = idsWithPrefix("AF_");
    expect(ids).toEqual(new Set(IN_WINDOW.map((k) => `AF_${k}`)));
    expect(ids.has("AF_s1")).toBe(true);
    expect(ids.has("AF_s3")).toBe(true);
    expect(ids.has("AF_s4")).toBe(false);
  });

  it("still returns metadata-only rows (storage_path NULL) inside the window", () => {
    // The fallback fixtures carry storage_path NULL — this function deliberately
    // does NOT filter on storage_path (unlike the submission/export path), so the
    // window fix must not quietly start dropping undownloaded rows.
    const rows = getTransactionAllAttachments("T1", auditStart, auditEnd);
    const meta = rows.find((r) => r.id === "AF_s3");
    expect(meta).toBeDefined();
    expect(meta?.storage_path).toBeNull();
  });
});
