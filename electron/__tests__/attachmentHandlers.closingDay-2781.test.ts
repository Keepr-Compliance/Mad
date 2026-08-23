/**
 * @jest-environment node
 *
 * BACKLOG-2781 — the closing-day end bound on `transactions:get-attachment-counts`.
 *
 * This handler's own comment says it "mirrors the query in
 * submissionService.loadTransactionAttachments" — and it mirrored the bug too:
 * `endDate.setHours(23, 59, 59, 999)` at attachmentHandlers.ts:502, LOCAL hours
 * on the UTC-midnight instant `new Date(auditEnd)` produces. It now consumes the
 * canonical `auditWindowEnd()`, so the count the UI shows and the set the
 * submission actually uploads agree on where the closing day ends.
 *
 * ## Status of this site: LATENT, not live (recorded deliberately)
 *
 * The only renderer caller today — `TransactionDetails.tsx:262` via
 * `useAttachmentCounts` — passes `undefined, undefined` for the audit window, so
 * the `if (auditEnd)` branch is unreached in the shipping app. It is fixed anyway
 * because the handler is a live IPC channel whose stated contract is parity with
 * the submission path; the next caller that passes a window would otherwise
 * inherit the same wrong day. These tests exercise the branch directly.
 *
 * The sweep, not a single row, is the control — see
 * `submissionDbService.closingDay-2781.test.ts` for the full derivation.
 *
 * BACKLOG-2788 moved the bound this suite sweeps: the founder settled
 * (2026-08-22) that the closing day ends at the user's LOCAL midnight — "they
 * work in their local time, so we need to show the transaction from their
 * eyes". The fixtures are therefore built from the closing day's LOCAL wall
 * clock, which makes one expectation table correct in every zone and keeps a
 * revert to the old UTC-midnight rule (or a naive +24h rule) detectable in
 * every zone. Every expectation that named an absolute UTC instant moved for
 * that reason, and for no other.
 */

import path from "path";
import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
} from "../../tests/support/ipcHandlerRegistry";
import type { IpcMainInvokeEvent } from "electron";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

const registeredHandlers: IpcHandlerRegistry = createIpcHandlerRegistry();
let mockDb: DatabaseType | null = null;

jest.mock("electron", () => ({
  ipcMain: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/tmp") },
  shell: { openPath: jest.fn() },
  net: { fetch: jest.fn() },
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: () => mockDb,
    isInitialized: jest.fn(() => true),
  },
}));

jest.mock("../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { logAction: jest.fn(), log: jest.fn() },
}));

jest.mock("../services/emailAttachmentService", () => ({
  __esModule: true,
  default: { getAttachmentsForEmail: jest.fn(() => Promise.resolve([])) },
}));

jest.mock("../services/emailAttachmentBackfillService", () => ({
  backfillAttachmentMetadata: jest.fn(),
}));

jest.mock("../services/attachmentTextExtractionBackfillService", () => ({
  backfillAttachmentTextContent: jest.fn(),
}));

jest.mock("../services/gmailFetchService", () => ({
  __esModule: true,
  default: { fetchAttachment: jest.fn() },
}));

jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: { fetchAttachment: jest.fn() },
}));

jest.mock("../services/featureGateService", () => ({
  __esModule: true,
  default: { canUseFeature: jest.fn(() => true) },
}));

jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: { getClient: jest.fn() },
}));

jest.mock("../services/db/emailDbService", () => ({
  getEmailById: jest.fn(),
}));

import { registerAttachmentHandlers } from "../handlers/attachmentHandlers";

const CLOSED_AT = "2026-07-29";
const STARTED_AT = "2026-01-01";

/** The closing day, as LOCAL wall-clock parts (2026-07-29). */
const CLOSING_DAY: readonly [number, number, number] = [2026, 6, 29];

/** An instant at a given LOCAL wall clock on the closing day (+ `dayOffset` days). */
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

const EARLY_OUT = "2025-12-31T23:59:59.999Z"; // before the audit start -> OUT
const MID_IN = "2026-06-15T12:00:00.000Z"; // comfortably inside -> IN
const DAWN = localInstant(0, 30, 0, 0); // 12:30am local ON the closing day (BACKLOG-2781) -> IN
const EVENING = localInstant(21, 0, 0, 0); // 9pm local on the closing day (BACKLOG-2788) -> IN
const LAST_IN = localInstant(23, 59, 59, 999); // its last local instant -> IN
const FIRST_OUT = localInstant(0, 0, 0, 0, 1); // local midnight: already the next day -> OUT

/**
 * The handler runs the REAL `validateTransactionId`, which requires a UUID — so
 * the fixture uses one rather than a short label. A made-up "T1" is rejected
 * before the date filter is ever reached, which would have made every assertion
 * below pass or fail for the wrong reason.
 */
const TXN_ID = "11111111-1111-4111-8111-111111111111";

const SWEEP: ReadonlyArray<readonly [string, string]> = [
  ["early", EARLY_OUT],
  ["mid", MID_IN],
  ["dawn", DAWN],
  ["evening", EVENING],
  ["lastin", LAST_IN],
  ["firstout", FIRST_OUT],
];

/** mid + dawn + evening + lastin — what the local-midnight bound admits. */
const EXPECTED_IN_WINDOW = 4;

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE emails (id TEXT PRIMARY KEY, sent_at DATETIME);
    CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT, sent_at DATETIME);
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      email_id TEXT,
      filename TEXT NOT NULL,
      file_size_bytes INTEGER,
      storage_path TEXT
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
  const email = db.prepare(`INSERT INTO emails (id, sent_at) VALUES (?, ?)`);
  const message = db.prepare(`INSERT INTO messages (id, thread_id, sent_at) VALUES (?, ?, ?)`);
  const att = db.prepare(
    `INSERT INTO attachments (id, message_id, email_id, filename, file_size_bytes, storage_path) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const comm = db.prepare(
    `INSERT INTO communications (id, transaction_id, message_id, email_id, thread_id) VALUES (?, ?, ?, ?, ?)`,
  );

  for (const [key, sentAt] of SWEEP) {
    message.run(`M_${key}`, `TH_${key}`, sentAt);
    comm.run(`cm_${key}`, TXN_ID, `M_${key}`, null, `TH_${key}`);
    att.run(`AT_${key}`, `M_${key}`, null, `text-${key}.heic`, 4096, `/data/t-${key}.heic`);

    email.run(`E_${key}`, sentAt);
    comm.run(`ce_${key}`, TXN_ID, null, `E_${key}`, null);
    att.run(`AE_${key}`, null, `E_${key}`, `email-${key}.pdf`, 2048, `/data/e-${key}.pdf`);
  }
}

interface CountsResponse {
  success: boolean;
  error?: string;
  data?: {
    textAttachments: number;
    emailAttachments: number;
    total: number;
    totalSizeBytes: number;
  };
}

describe("transactions:get-attachment-counts — closing-day window (BACKLOG-2781)", () => {
  /**
   * Invoke the channel and REQUIRE it to have succeeded. `wrapHandler` converts a
   * throw into `{ success: false, error }`, so asserting on `data` alone would
   * report "expected 4, received undefined" and hide the actual cause.
   */
  const invoke = async (auditStart?: string, auditEnd?: string) => {
    const handler = registeredHandlers.get("transactions:get-attachment-counts");
    const result = (await handler(
      {} as IpcMainInvokeEvent,
      TXN_ID,
      auditStart,
      auditEnd,
    )) as CountsResponse;
    if (!result.success || !result.data) {
      throw new Error(`handler failed: ${result.error ?? "no error message"}`);
    }
    return result.data;
  };

  beforeEach(() => {
    mockDb = new Database(":memory:") as unknown as DatabaseType;
    createSchema(mockDb);
    seed(mockDb);
    registeredHandlers.clear();
    registerAttachmentHandlers(null);
  });

  afterEach(() => {
    mockDb?.close();
    mockDb = null;
    jest.clearAllMocks();
  });

  it("counts TEXT attachments across both edges of the closing-day bound", async () => {
    // mid, dawn, evening, lastin — and NOT early or firstout.
    expect((await invoke(STARTED_AT, CLOSED_AT)).textAttachments).toBe(EXPECTED_IN_WINDOW);
  });

  it("counts EMAIL attachments across both edges of the closing-day bound", async () => {
    expect((await invoke(STARTED_AT, CLOSED_AT)).emailAttachments).toBe(EXPECTED_IN_WINDOW);
  });

  it("admits the row at exactly the bound and rejects the one 1ms past it", async () => {
    // The discriminating pair, post-BACKLOG-2788: `lastin` (the last local
    // instant of the closing day) is in and `firstout` (local midnight, already
    // the next day) is out. A revert to the UTC-midnight bound admits `firstout`
    // in UTC and drops `evening`/`lastin` west of it, so the count reds in
    // either zone.
    const windowed = await invoke(STARTED_AT, CLOSED_AT);
    const unwindowed = await invoke(undefined, undefined);

    expect(windowed.total).toBe(EXPECTED_IN_WINDOW * 2);
    // All 6 sweep instants exist on both sides; only the window removes any.
    expect(unwindowed.total).toBe(SWEEP.length * 2);
  });

  it("returns every attachment when no audit window is supplied (the live caller's path)", async () => {
    // TransactionDetails.tsx:262 passes undefined/undefined today, so this is the
    // only shape the shipping app actually exercises — pin it so the fix cannot
    // change the count the UI shows today.
    expect((await invoke(undefined, undefined)).total).toBe(SWEEP.length * 2);
  });
});
