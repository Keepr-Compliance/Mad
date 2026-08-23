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
 * All four now consume the canonical `auditWindowEnd()` the export surfaces use.
 *
 * ## BACKLOG-2788 moved that bound, and this suite with it
 *
 * BACKLOG-2781 pointed all four sites at one helper whose answer was UTC
 * midnight of the next day. The founder then settled what that answer should be
 * (2026-08-22): "they work in their local time, so we need to show the
 * transaction from their eyes" — the closing day ends at the user's LOCAL
 * midnight. Every expectation below that named an absolute UTC instant moved
 * for that reason, and for no other.
 *
 * ## Why these are SWEEPS, and why the fixtures are LOCAL-relative
 *
 * The instants are built from the closing day's LOCAL wall clock
 * (`new Date(2026, 6, 29, h, m, s, ms)`), not from hardcoded UTC strings,
 * because the bound they sweep is a local-day boundary: a fixed UTC string is a
 * different time of day in every zone, so it can only assert something true in
 * one. Local-relative instants make one expectation table correct in EVERY zone
 * AND keep the mutation detectable in every zone:
 *
 *   - reverting `auditWindowEnd` to the UTC-midnight rule reds `firstout` in UTC
 *     and east of it (the old bound admitted that instant), and reds `evening` +
 *     `lastin` west of it (the old bound cut the closing evening) — the hours
 *     BACKLOG-2788 exists to restore;
 *   - a naive "+24 hours" bound reds `firstout` in every zone, because local
 *     midnight of the next day is the first EXCLUDED instant, not the last
 *     included one.
 *
 * Uses a REAL in-memory better-sqlite3 database injected through a mocked
 * `ensureDb` (the pattern established by `attachmentDbService.transactionAll.test.ts`),
 * so the actual SQL bound comparison runs. `sent_at` is stored exactly as the real
 * producer writes it — `sentAt.toISOString()` at
 * `electron/services/macOSMessagesImportService/macOSMessagesImportService.ts:1592`,
 * i.e. ISO-8601 with `Z` and milliseconds — because the `<= ?` comparison is
 * lexicographic on that string. (Path corrected per the BACKLOG-2781 SR
 * addendum; the pre-refactor citation no longer resolved.)
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

/** The closing day, as LOCAL wall-clock parts (2026-07-29). */
const CLOSING_DAY: readonly [number, number, number] = [2026, 6, 29];

/**
 * An instant at a given LOCAL wall clock on the closing day (or `dayOffset`
 * days after it), written the way the real producer writes `sent_at`.
 */
function localInstant(
  hours: number,
  minutes: number,
  seconds: number,
  ms: number,
  dayOffset = 0,
): string {
  const [y, m, d] = CLOSING_DAY;
  return new Date(y, m, d + dayOffset, hours, minutes, seconds, ms).toISOString();
}

/**
 * The boundary sweep: four instants around the end bound plus two far from it.
 * These expectations hold in EVERY timezone (see the header).
 */
const EARLY_OUT = "2025-12-31T23:59:59.999Z"; // before the audit start -> OUT
const MID_IN = "2026-06-15T12:00:00.000Z"; // comfortably inside -> IN
const DAWN = localInstant(0, 30, 0, 0); // 12:30am local ON the closing day (BACKLOG-2781's case) -> IN
const EVENING = localInstant(21, 0, 0, 0); // 9pm local on the closing day (BACKLOG-2788's case) -> IN
const LAST_IN = localInstant(23, 59, 59, 999); // the last instant of the local closing day -> IN
const FIRST_OUT = localInstant(0, 0, 0, 0, 1); // local midnight: already the next day -> OUT

/** Suffixes shared by the message, email and attachment fixtures. */
const SWEEP: ReadonlyArray<readonly [string, string]> = [
  ["early", EARLY_OUT],
  ["mid", MID_IN],
  ["dawn", DAWN],
  ["evening", EVENING],
  ["lastin", LAST_IN],
  ["firstout", FIRST_OUT],
];

/** The instants the fixed bound must admit, by fixture suffix. */
const IN_WINDOW = ["mid", "dawn", "evening", "lastin"];

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
  message.run("M_other", "TH_other", DAWN, "inbound", "+15555550199");
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
    expect(ids.has("M_dawn")).toBe(true); // 12:30am local on the closing day
    expect(ids.has("M_evening")).toBe(true); // 9pm local on the closing day
    expect(ids.has("M_lastin")).toBe(true); // its last local instant
    expect(ids.has("M_firstout")).toBe(false); // local midnight -> the next day
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
    expect(ids.has("E_dawn")).toBe(true);
    expect(ids.has("E_evening")).toBe(true);
    expect(ids.has("E_lastin")).toBe(true);
    expect(ids.has("E_firstout")).toBe(false);
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
    expect(textIds.has("AT_dawn")).toBe(true);
    expect(textIds.has("AT_evening")).toBe(true);
    expect(textIds.has("AT_lastin")).toBe(true);
    expect(textIds.has("AT_firstout")).toBe(false);
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
    expect(emailIds.has("AE_dawn")).toBe(true);
    expect(emailIds.has("AE_evening")).toBe(true);
    expect(emailIds.has("AE_lastin")).toBe(true);
    expect(emailIds.has("AE_firstout")).toBe(false);
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

  it("pins the bound to the last instant before LOCAL midnight (BACKLOG-2788)", () => {
    const bound = auditWindowEnd(CLOSED_AT)!;

    // The property is asserted on the local clock rather than on a UTC literal:
    // true in every zone, and false for both the pre-2788 UTC-midnight rule and
    // a naive +24h rule. Founder decision, 2026-08-22 (BACKLOG-2788).
    expect([bound.getFullYear(), bound.getMonth(), bound.getDate()]).toEqual([2026, 6, 29]);
    expect([
      bound.getHours(),
      bound.getMinutes(),
      bound.getSeconds(),
      bound.getMilliseconds(),
    ]).toEqual([23, 59, 59, 999]);

    // ...and one millisecond later is local midnight of the NEXT day, which is
    // where the closing day stops.
    const nextInstant = new Date(bound.getTime() + 1);
    expect([
      nextInstant.getHours(),
      nextInstant.getMinutes(),
      nextInstant.getSeconds(),
      nextInstant.getMilliseconds(),
    ]).toEqual([0, 0, 0, 0]);
    expect(nextInstant.getDate()).toBe(30);

    // The widened signature: a Date and its source string agree.
    expect(auditWindowEnd(auditEnd)?.getTime()).toBe(auditWindowEnd(CLOSED_AT)?.getTime());
  });
});
