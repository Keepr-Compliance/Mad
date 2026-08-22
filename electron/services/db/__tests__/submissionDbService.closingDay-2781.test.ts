/**
 * @jest-environment node
 *
 * BACKLOG-2781 — the broker submission window's closing-day end bound.
 *
 * `submissionService` builds the audit window as `new Date(transaction.closed_at)`
 * (submissionService.ts:272). `closed_at` is a DATE like "2026-07-29", which
 * `new Date()` parses as UTC midnight. Each query below then had its own copy of
 * `endOfDay.setHours(23, 59, 59, 999)` — LOCAL hours applied to a UTC-midnight
 * instant, so the bound landed EARLY on the closing day itself:
 *
 *     TZ=America/Chicago   2026-07-29T04:59:59.999Z   (nearly the whole day cut)
 *     TZ=UTC               2026-07-29T23:59:59.999Z   (still short of the export bound)
 *
 * All four now consume the canonical `auditWindowEnd()` the export surfaces use,
 * which yields 2026-07-30T00:00:00.000Z in every zone.
 *
 * ## Why these are SWEEPS and not the founder's single data point
 *
 * The founder-relevant case is a text at 2026-07-29T05:30Z — 12:30am local ON
 * the closing day in Chicago. Asserting only that row would be VACUOUS in CI:
 * under TZ=UTC the OLD bound (23:59:59.999Z) already admits it, so reverting the
 * fix would leave the test green. The row at exactly 2026-07-30T00:00:00.000Z is
 * what makes the mutation red in UTC too, because the old bound excludes it in
 * every zone. Both edges of the boundary are swept, so a revert reds this suite
 * under ambient TZ and under TZ=America/Chicago alike.
 *
 * Uses a REAL in-memory better-sqlite3 database injected through a mocked
 * `ensureDb` (the pattern established by `attachmentDbService.transactionAll.test.ts`),
 * so the actual SQL bound comparison runs. `sent_at` is stored exactly as the real
 * producer writes it — `sentAt.toISOString()` at
 * `macOSMessagesImportService.ts:1132`, i.e. ISO-8601 with `Z` and milliseconds —
 * because the `<= ?` comparison is lexicographic on that string.
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

import {
  getTransactionMessages,
  getTransactionEmails,
  getTransactionAttachments,
} from "../submissionDbService";
import { auditWindowEnd, resolveExportPlan } from "../../exportPlan";
import type { Communication } from "../../../types/models";

// ---------------------------------------------------------------------------
// The audit window under test: a transaction closed on 2026-07-29.
// ---------------------------------------------------------------------------
const CLOSED_AT = "2026-07-29";
const STARTED_AT = "2026-01-01";

/** What submissionService.ts:272 actually passes down. */
const auditStart = new Date(STARTED_AT);
const auditEnd = new Date(CLOSED_AT);

/**
 * The boundary sweep. Four instants around the end bound plus two far from it.
 *
 *   OLD bound, TZ=UTC     2026-07-29T23:59:59.999Z  -> admits S1,S2  rejects S3,S4
 *   OLD bound, TZ=Chicago 2026-07-29T04:59:59.999Z  -> admits none of S1..S4
 *   NEW bound, any zone   2026-07-30T00:00:00.000Z  -> admits S1,S2,S3  rejects S4
 */
const EARLY_OUT = "2025-12-31T23:59:59.999Z"; // before the audit start -> OUT
const MID_IN = "2026-06-15T12:00:00.000Z"; // comfortably inside -> IN
const S1 = "2026-07-29T05:30:00.000Z"; // 12:30am local on the closing day (Chicago) -> IN
const S2 = "2026-07-29T23:59:59.999Z"; // last instant of the closing day in UTC -> IN
const S3 = "2026-07-30T00:00:00.000Z"; // EXACTLY the bound, inclusive -> IN
const S4 = "2026-07-30T00:00:00.001Z"; // one millisecond past the bound -> OUT

/** Suffixes shared by the message, email and attachment fixtures. */
const SWEEP: ReadonlyArray<readonly [string, string]> = [
  ["early", EARLY_OUT],
  ["mid", MID_IN],
  ["s1", S1],
  ["s2", S2],
  ["s3", S3],
  ["s4", S4],
];

/** The instants the fixed bound must admit, by fixture suffix. */
const IN_WINDOW = ["mid", "s1", "s2", "s3"];

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      sent_at DATETIME,
      direction TEXT,
      participants_flat TEXT
    );
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      sent_at DATETIME,
      direction TEXT,
      subject TEXT,
      sender TEXT
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      email_id TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT,
      file_size_bytes INTEGER,
      storage_path TEXT,
      created_at DATETIME
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
  const message = db.prepare(
    `INSERT INTO messages (id, thread_id, sent_at, direction, participants_flat) VALUES (?, ?, ?, ?, ?)`,
  );
  const email = db.prepare(
    `INSERT INTO emails (id, sent_at, direction, subject, sender) VALUES (?, ?, ?, ?, ?)`,
  );
  const att = db.prepare(
    `INSERT INTO attachments (id, message_id, email_id, filename, mime_type, file_size_bytes, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const comm = db.prepare(
    `INSERT INTO communications (id, transaction_id, message_id, email_id, thread_id) VALUES (?, ?, ?, ?, ?)`,
  );

  for (const [key, sentAt] of SWEEP) {
    // --- text side: message + its linked communication + a downloaded attachment
    message.run(`M_${key}`, `TH_${key}`, sentAt, "inbound", "+15555550100");
    comm.run(`cm_${key}`, "T1", `M_${key}`, null, `TH_${key}`);
    att.run(`AT_${key}`, `M_${key}`, null, `text-${key}.heic`, "image/heic", 4096, `/data/t-${key}.heic`, sentAt);

    // --- email side: email + its linked communication + a downloaded attachment
    email.run(`E_${key}`, sentAt, "inbound", `Closing ${key}`, "buyer@example.com");
    comm.run(`ce_${key}`, "T1", null, `E_${key}`, null);
    att.run(`AE_${key}`, null, `E_${key}`, `email-${key}.pdf`, "application/pdf", 2048, `/data/e-${key}.pdf`, sentAt);
  }

  // A different transaction that must never leak into T1's window.
  message.run("M_other", "TH_other", S1, "inbound", "+15555550199");
  comm.run("cm_other", "T2", "M_other", null, "TH_other");
}

describe("submissionDbService — closing-day audit window (BACKLOG-2781)", () => {
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

  // -------------------------------------------------------------------------
  // Site 1 — getTransactionMessages (submissionDbService.ts:51)
  // -------------------------------------------------------------------------
  it("getTransactionMessages sweeps both edges of the closing-day bound", () => {
    const rows = getTransactionMessages("T1", auditStart, auditEnd);
    const ids = new Set(rows.map((r) => (r as unknown as { id: string }).id));

    expect(ids).toEqual(new Set(IN_WINDOW.map((k) => `M_${k}`)));

    // Named, so a failure says WHICH edge moved.
    expect(ids.has("M_s1")).toBe(true); // 12:30am local on the closing day
    expect(ids.has("M_s3")).toBe(true); // exactly the bound (inclusive)
    expect(ids.has("M_s4")).toBe(false); // 1ms past the bound
    expect(ids.has("M_early")).toBe(false); // before the audit start
    expect(ids.has("M_other")).toBe(false); // different transaction
  });

  // -------------------------------------------------------------------------
  // Site 2 — getTransactionEmails (submissionDbService.ts:85)
  // -------------------------------------------------------------------------
  it("getTransactionEmails sweeps both edges of the closing-day bound", () => {
    const rows = getTransactionEmails("T1", auditStart, auditEnd);
    const ids = new Set(rows.map((r) => r.id as string));

    expect(ids).toEqual(new Set(IN_WINDOW.map((k) => `E_${k}`)));
    expect(ids.has("E_s1")).toBe(true);
    expect(ids.has("E_s3")).toBe(true);
    expect(ids.has("E_s4")).toBe(false);
    expect(ids.has("E_early")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Site 3 — getTransactionAttachments, TEXT filter (submissionDbService.ts:114)
  //
  // Sites 3 and 4 are two INDEPENDENT copies inside one function, so they get
  // two independent assertions: reverting one must red only its own test.
  // -------------------------------------------------------------------------
  it("getTransactionAttachments sweeps the bound on the TEXT attachment filter", () => {
    const rows = getTransactionAttachments("T1", auditStart, auditEnd);
    const textIds = new Set(
      rows.map((r) => r.id as string).filter((id) => id.startsWith("AT_")),
    );

    expect(textIds).toEqual(new Set(IN_WINDOW.map((k) => `AT_${k}`)));
    expect(textIds.has("AT_s1")).toBe(true);
    expect(textIds.has("AT_s3")).toBe(true);
    expect(textIds.has("AT_s4")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Site 4 — getTransactionAttachments, EMAIL filter (submissionDbService.ts:146)
  // -------------------------------------------------------------------------
  it("getTransactionAttachments sweeps the bound on the EMAIL attachment filter", () => {
    const rows = getTransactionAttachments("T1", auditStart, auditEnd);
    const emailIds = new Set(
      rows.map((r) => r.id as string).filter((id) => id.startsWith("AE_")),
    );

    expect(emailIds).toEqual(new Set(IN_WINDOW.map((k) => `AE_${k}`)));
    expect(emailIds.has("AE_s1")).toBe(true);
    expect(emailIds.has("AE_s3")).toBe(true);
    expect(emailIds.has("AE_s4")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Cross-surface parity — the whole point of BACKLOG-2781.
  //
  // The direct `submissionBound === exportBound` equality below is TAUTOLOGICAL
  // under a mutation of `auditWindowEnd` (both sides move together), so it is
  // documentation, not the control. The control is that the absolute-instant
  // sweeps above and the export suite's own absolute assertions red TOGETHER
  // when the `+ 1` is removed from `auditWindowEnd`.
  // -------------------------------------------------------------------------
  it("admits exactly the same instants as the export path for the same transaction", () => {
    const comms = SWEEP.map(
      ([key, sentAt]) =>
        ({
          id: key,
          sent_at: sentAt,
          communication_type: "sms",
          channel: "sms",
        }) as unknown as Communication,
    );

    const exported = new Set(
      resolveExportPlan(
        {
          format: "folder",
          contentType: "both",
          attachmentType: "all",
          emailMode: "thread",
          startDate: STARTED_AT,
          endDate: CLOSED_AT,
        },
        comms,
      ).communications.map((c) => c.id as string),
    );

    const submitted = new Set(
      getTransactionMessages("T1", auditStart, auditEnd).map((r) =>
        (r as unknown as { id: string }).id.replace(/^M_/, ""),
      ),
    );

    expect(submitted).toEqual(exported);
    // ...and both are the set the fixed bound defines.
    expect(exported).toEqual(new Set(IN_WINDOW));
  });

  it("uses the canonical boundary instant, not a local end-of-day", () => {
    // Documents the concrete instant the fix pins. The OLD code produced
    // 2026-07-29T23:59:59.999Z under TZ=UTC and 2026-07-29T04:59:59.999Z under
    // TZ=America/Chicago — neither equals this, so this reds in either zone.
    expect(auditWindowEnd(CLOSED_AT)?.toISOString()).toBe("2026-07-30T00:00:00.000Z");
    // The widened signature: a Date and its source string agree.
    expect(auditWindowEnd(auditEnd)?.getTime()).toBe(auditWindowEnd(CLOSED_AT)?.getTime());
  });
});
