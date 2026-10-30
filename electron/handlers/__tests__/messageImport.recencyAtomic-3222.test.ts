/**
 * @jest-environment node
 *
 * BACKLOG-3222: after a successful Mac Messages import, three writes refresh
 * message recency:
 *   contacts.last_inbound_at, phone_last_message, external_contacts.last_message_at
 * They must commit together or not at all.
 *
 * Runs the REAL `messages:import-macos` handler and the REAL writers on the
 * REAL driver, against the shipped schema.sql, in a file DB in WAL mode. The
 * worker plan is the real `planCommunicationDatesOn` read on the same DB (only
 * the thread hop is replaced). Every INSERT/UPDATE on the three tables is
 * instrumented: it records `db.inTransaction`, and at write k either reads the
 * COMMITTED state through a second connection (CRASH: what a process death at
 * that instant leaves) or throws (ERROR).
 *
 * Assertions are on id sets per table: each table is all at the old value or
 * all at the new value, and the three tables agree.
 *
 * Which control catches which wrong fix (each mutation run, BACKLOG-3222 pm_comments):
 * - per-step try/catch inside the transaction body: ONLY the ERROR sweep.
 *   That is why it sweeps every write and never samples.
 * - a catch around the phone aggregation READ: ONLY the read-fault case.
 * - external_contacts left outside the transaction: every-write, CRASH, ERROR.
 * - contacts left on the sliced path: CRASH and ERROR.
 * - worker failure swallowed into an empty plan: ONLY the worker-failure case.
 *
 * Run on the real driver:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <this file>
 */
import * as os from "os";
import * as fs from "fs";
import * as nodePath from "path";
import type { IpcMainInvokeEvent } from "electron";
import type { Database as DatabaseType } from "better-sqlite3-multiple-ciphers";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const mockIpcHandle = jest.fn();
jest.mock("electron", () => ({
  ipcMain: { handle: (...args: unknown[]) => mockIpcHandle(...args), on: jest.fn() },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: () => "/tmp/keepr-3222-test" },
}));
const mockCaptureException = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: (...a: unknown[]) => mockCaptureException(...a),
}));
const mockLogWarn = jest.fn();
jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: (...a: unknown[]) => {
      mockLogWarn(...a);
      return Promise.resolve();
    },
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../services/sessionSecurityService", () => ({
  __esModule: true,
  default: { runBusy: (_c: string, fn: () => unknown) => fn() },
}));

let rawDb: DatabaseType;
let workerFailure: string | null = null;
jest.mock("../../workers/contactWorkerPool", () => {
  class DedicatedWorkerError extends Error {
    constructor(message: string, readonly code: string) {
      super(message);
      this.name = "DedicatedWorkerError";
    }
  }
  return {
    DedicatedWorkerError,
    queryContacts: jest.fn(),
    isPoolReady: () => false,
    queryOnDedicatedWorker: async (_kind: string, userId: string) => {
      if (workerFailure) throw new DedicatedWorkerError("Dedicated contact worker could not start", workerFailure);
      const { planCommunicationDatesOn } = jest.requireActual("../../services/db/wizardMessageScansDb");
      // The real worker answers on a later turn of the event loop.
      await new Promise((r) => setImmediate(r));
      return planCommunicationDatesOn(rawDb, userId);
    },
  };
});
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    getUserById: async (id: string) => rawDb.prepare("SELECT id FROM users_local WHERE id = ?").get(id) ?? null,
    getRawDatabase: () => rawDb,
  },
}));
jest.mock("../../services/macOSMessagesImportService", () => ({
  __esModule: true,
  default: {
    importMessages: async () => ({
      success: true,
      messagesImported: 0,
      messagesSkipped: 0,
      attachmentsImported: 0,
      attachmentsUpdated: 0,
      attachmentsSkipped: 0,
      duration: 1,
    }),
  },
}));
jest.mock("../../services/autoLinkService", () => ({
  autoLinkNewMessagesForUser: jest.fn().mockResolvedValue(undefined),
  expandAttachedThreadsForUser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/importPlanInputs", () => ({
  resolveImportPlanForUser: async () => ({
    mode: "delta",
    fetchStartISO: null,
    effectiveCap: null,
    protectedSpans: [],
    fetchAttachments: false,
    overrides: [],
  }),
  loadStoredImportFilters: jest.fn().mockResolvedValue({}),
}));
jest.mock("../../services/macImportMarker", () => ({ recordMacImportRun: jest.fn() }));

import { setDb } from "../../services/db/core/dbConnection";
import { toLookupKey } from "../../utils/phoneNormalization";
import { registerMessageImportHandlers } from "../messageImportHandlers";

const U = "00000000-0000-4000-8000-000000003222"; // pii-allow-uuid: invented test user id
/** One more than COMM_DATES_APPLY_SLICE (100), so a sliced apply is visible. */
const N_CONTACTS = 101;
const OLD = "2026-01-01T00:00:00.000Z";
const NEW = "2026-06-01T00:00:00.000Z";
const SCHEMA = fs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b[\s\S]*?\b(contacts|phone_last_message|external_contacts)\b/i;
/** The phone aggregation read inside the transaction (messageDbService backfillPhoneLastMessageTableSync). */
const PHONE_AGG_READ_RE = /SELECT\s+participants_flat,\s*MAX\(sent_at\)[\s\S]*GROUP BY participants_flat/i;

type Handler = (e: IpcMainInvokeEvent, ...a: unknown[]) => Promise<{ success: boolean }>;
let handler: Handler;
beforeAll(() => {
  registerMessageImportHandlers({ isDestroyed: () => false, webContents: { send: jest.fn() } } as never);
  for (const [ch, h] of mockIpcHandle.mock.calls) if (ch === "messages:import-macos") handler = h as Handler;
  expect(handler).toBeDefined();
});
beforeEach(() => {
  mockCaptureException.mockClear();
  mockLogWarn.mockClear();
  workerFailure = null;
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function phoneOf(i: number): string {
  return `1415555${String(1000 + i).padStart(4, "0")}`;
}

/** Every contact has one text newer than every stored date. */
function freshDbFile(): string {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3222-"));
  dirs.push(dir);
  const file = nodePath.join(dir, "t.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'p@example.com', 'google', 'o3222')",
  ).run(U);
  const ic = db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, is_imported, source, last_inbound_at) VALUES (?, ?, ?, 1, 'contacts_app', ?)",
  );
  const ip = db.prepare(
    "INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary, source) VALUES (?, ?, ?, 1, 'import')",
  );
  const im = db.prepare(
    "INSERT INTO messages (id, user_id, channel, external_id, direction, participants_flat, sent_at) VALUES (?, ?, 'sms', ?, 'inbound', ?, ?)",
  );
  const iplm = db.prepare("INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)");
  const iec = db.prepare(
    "INSERT INTO external_contacts (id, user_id, name, phones_json, phones_normalized_json, emails_json, last_message_at, external_record_id) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)",
  );
  db.transaction(() => {
    for (let i = 0; i < N_CONTACTS; i++) {
      const ph = phoneOf(i);
      ic.run(`c${i}`, U, `C${i}`, OLD);
      ip.run(`p${i}`, `c${i}`, `+1${ph.slice(1)}`);
      im.run(`m${i}`, U, `e${i}`, ph, NEW);
      iplm.run(toLookupKey(ph), U, OLD);
      iec.run(`x${i}`, U, `X${i}`, JSON.stringify([`+${ph}`]), JSON.stringify([toLookupKey(ph)]), OLD, `r${i}`);
    }
  })();
  db.close();
  return file;
}

type State = { contacts: Set<string>; plm: Set<string>; ext: Set<string> };
/** Ids at the NEW value, per table, read through a separate connection. */
function committed(file: string): State {
  const r = new Database(file, { readonly: true });
  const ids = (q: string) => new Set((r.prepare(q).all() as Array<{ k: string }>).map((x) => x.k));
  const s = {
    contacts: ids(`SELECT id k FROM contacts WHERE last_inbound_at = '${NEW}'`),
    plm: ids(`SELECT phone_normalized k FROM phone_last_message WHERE last_message_at = '${NEW}'`),
    ext: ids(`SELECT id k FROM external_contacts WHERE last_message_at = '${NEW}'`),
  };
  r.close();
  return s;
}
function shape(s: State): string {
  const t = (n: number) => (n === 0 ? "old" : n === N_CONTACTS ? "new" : `part(${n})`);
  return `contacts=${t(s.contacts.size)} plm=${t(s.plm.size)} ext=${t(s.ext.size)}`;
}
const ALL_OLD = "contacts=old plm=old ext=old";
const ALL_NEW = "contacts=new plm=new ext=new";

type Mode = "none" | "crash" | "error" | "read-error";
async function run(mode: Mode, k: number) {
  const file = freshDbFile();
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  let writes = 0;
  let phoneAggReads = 0;
  const inTx: boolean[] = [];
  let crashState: State | null = null;
  const prep = db.prepare.bind(db);
  (db as unknown as { prepare: (s: string) => unknown }).prepare = (sqlText: string) => {
    const st = prep(sqlText) as unknown as Record<string, (...a: unknown[]) => unknown>;
    if (PHONE_AGG_READ_RE.test(sqlText)) {
      const origAll = st.all.bind(st);
      st.all = (...a: unknown[]) => {
        phoneAggReads += 1;
        if (mode === "read-error") throw new Error("INJECTED in the phone aggregation read");
        return origAll(...a);
      };
      return st;
    }
    if (!WRITE_RE.test(sqlText)) return st;
    const origRun = st.run.bind(st);
    st.run = (...a: unknown[]) => {
      writes += 1;
      inTx.push(db.inTransaction);
      if (writes === k && mode === "crash") crashState = committed(file);
      if (writes === k && mode === "error") throw new Error(`INJECTED at write ${k}`);
      return origRun(...a);
    };
    return st;
  };
  rawDb = db;
  setDb(db as never);
  const res = await handler({} as IpcMainInvokeEvent, U, false);
  const after = committed(file);
  db.close();
  return { res, writes, phoneAggReads, inTx, crashState: crashState as State | null, after };
}

jest.setTimeout(600_000);

describe("BACKLOG-3222: the post-import recency writes commit together or not at all", () => {
  let totalWrites = 0;

  it("baseline: no fault -> all three tables new, import succeeds", async () => {
    const r = await run("none", 0);
    totalWrites = r.writes;
    expect(r.res.success).toBe(true);
    // 101 contact UPDATEs + 101 phone_last_message INSERTs + 1 external UPDATE.
    expect(r.writes).toBe(2 * N_CONTACTS + 1);
    expect(r.phoneAggReads).toBe(1);
    expect(shape(r.after)).toBe(ALL_NEW);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("every write runs inside a transaction", async () => {
    const r = await run("none", 0);
    expect(r.inTx.length).toBe(totalWrites);
    expect(r.inTx.filter((x) => !x).length).toBe(0);
  });

  it("CRASH sweep k=1..N: committed state at every write is all-old or all-new", async () => {
    expect(totalWrites).toBeGreaterThan(0);
    const bad: string[] = [];
    for (let k = 1; k <= totalWrites; k++) {
      const r = await run("crash", k);
      const s = shape(r.crashState!);
      if (s !== ALL_OLD && s !== ALL_NEW) bad.push(`k=${k}: ${s}`);
    }
    expect(bad).toEqual([]);
  });

  it("ERROR sweep k=1..N: a throw at ANY write commits nothing", async () => {
    expect(totalWrites).toBeGreaterThan(0);
    const bad: string[] = [];
    for (let k = 1; k <= totalWrites; k++) {
      const r = await run("error", k);
      const s = shape(r.after);
      if (s !== ALL_OLD || !r.res.success) bad.push(`k=${k}: ${s} success=${r.res.success}`);
    }
    expect(bad).toEqual([]);
  });

  it("a throw in the phone aggregation READ commits nothing", async () => {
    const r = await run("read-error", 0);
    expect(r.phoneAggReads).toBe(1);
    expect(r.res.success).toBe(true);
    expect(shape(r.after)).toBe(ALL_OLD);
  });

  it("worker plan failure: nothing committed, and the failure is searchable in Sentry and the log", async () => {
    workerFailure = "start_failed";
    const r = await run("none", 0);
    expect(r.res.success).toBe(true);
    expect(r.writes).toBe(0);
    expect(shape(r.after)).toBe(ALL_OLD);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [, ctx] = mockCaptureException.mock.calls[0] as [unknown, { tags: Record<string, string>; level: string }];
    expect(ctx.level).toBe("warning");
    expect(ctx.tags).toEqual({
      sync_type: "message_import",
      operation: "message-recency-refresh",
      worker_failure: "start_failed",
    });
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to refresh message recency after import"),
      "MessageImportHandlers",
      { workerFailure: "start_failed" },
    );
  });

  it("a non-worker failure is tagged without worker_failure", async () => {
    const r = await run("error", 1);
    expect(shape(r.after)).toBe(ALL_OLD);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [, ctx] = mockCaptureException.mock.calls[0] as [unknown, { tags: Record<string, string> }];
    expect(ctx.tags).toEqual({ sync_type: "message_import", operation: "message-recency-refresh" });
  });
});
