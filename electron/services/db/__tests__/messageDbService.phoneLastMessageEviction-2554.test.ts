/**
 * @jest-environment node
 *
 * BACKLOG-2554 — phone_last_message is a full recompute from `messages`, so a
 * phone whose texts are gone must lose its row.
 *
 * `backfillPhoneLastMessageTableSync` used to write with INSERT OR REPLACE
 * only. A phone that no longer had any text (a Force Re-import swap removes
 * messages that are no longer on the Mac) kept its old row forever, and the
 * contact readers kept showing that last-texted date. The recompute now
 * deletes the user's rows first, inside the caller's transaction.
 *
 * Harness: the REAL `refreshMessageRecencyAfterImport` (the live path after
 * `messages:import-macos`), the REAL writers, the REAL driver, the shipped
 * schema.sql in a WAL file DB. The worker plan is the real
 * `planCommunicationDatesOn` on the same DB (only the thread hop is replaced,
 * as in messageImport.recencyAtomic-3222). The stale row is produced by the
 * real writer itself: a first refresh writes it, then the phone's messages are
 * removed, then a second refresh runs.
 *
 * Which control catches which wrong fix (each mutation run on the real driver):
 * - no DELETE (fix absent):                         C10, C13, C14, "no texts left" red
 * - DELETE without the user filter:                 all red (C11; the seed's
 *                                                   U2 refresh already wipes U1)
 * - DELETE after the inserts:                       all red
 * - DELETE only in the async wrapper:               C10, "no texts left" red (C13 green)
 * - DELETE committed before the insert transaction: C12, C13 red
 * messageImport.recencyAtomic-3222 also reds on every one except the unscoped
 * DELETE (its write count / every-write-in-a-transaction checks).
 *
 * C14: external_contacts.last_message_at is recomputed from this table in the
 * same transaction, so a contact whose only phone vanished goes to NULL.
 *
 * Run on the real driver (Node-ABI build of the module, or):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file>
 */
import * as os from "os";
import * as fs from "fs";
import * as nodePath from "path";
import type { Database as DatabaseType } from "better-sqlite3-multiple-ciphers";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

jest.mock("electron", () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: () => "/tmp/keepr-2554-test" },
}));
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));
jest.mock("../../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

let rawDb: DatabaseType;
jest.mock("../../../workers/contactWorkerPool", () => {
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
      const { planCommunicationDatesOn } = jest.requireActual("../wizardMessageScansDb");
      await new Promise((r) => setImmediate(r));
      return planCommunicationDatesOn(rawDb, userId);
    },
  };
});

import { setDb } from "../core/dbConnection";
import { toLookupKey } from "../../../utils/phoneNormalization";
import { backfillPhoneLastMessageTable } from "../messageDbService";
import { refreshMessageRecencyAfterImport } from "../../messageRecencyRefresh";

const U1 = "00000000-0000-4000-8000-000000025541"; // pii-allow-uuid: invented test user id
const U2 = "00000000-0000-4000-8000-000000025542"; // pii-allow-uuid: invented test user id
const LIVE = "14155550101"; // U1 keeps texting this phone
const GONE = "14155550102"; // U1's texts with this phone vanish; U2 also texts it
const OTHER = "14155550103"; // U2 only
const T1 = "2026-03-01T00:00:00.000Z";
const T2 = "2026-04-01T00:00:00.000Z";
const SCHEMA = fs.readFileSync(nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql"), "utf8");
const PLM_INSERT_RE = /^\s*INSERT\b[\s\S]*\bphone_last_message\b/i;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

let injectAtFirstPlmInsert = false;

function openDb(): { db: DatabaseType; file: string } {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-2554-"));
  dirs.push(dir);
  const file = nodePath.join(dir, "t.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  const iu = db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  );
  iu.run(U1, "u1@example.com", "o25541");
  iu.run(U2, "u2@example.com", "o25542");
  const im = db.prepare(
    "INSERT INTO messages (id, user_id, channel, external_id, direction, participants_flat, sent_at) VALUES (?, ?, 'sms', ?, 'inbound', ?, ?)",
  );
  im.run("m1", U1, "e1", LIVE, T1);
  im.run("m2", U1, "e2", GONE, T2);
  im.run("m3", U2, "e3", GONE, T1);
  im.run("m4", U2, "e4", OTHER, T2);

  // Fault injector: throws at the first phone_last_message INSERT once armed.
  const prep = db.prepare.bind(db);
  (db as unknown as { prepare: (s: string) => unknown }).prepare = (sqlText: string) => {
    const st = prep(sqlText) as unknown as Record<string, (...a: unknown[]) => unknown>;
    if (!PLM_INSERT_RE.test(sqlText)) return st;
    const origRun = st.run.bind(st);
    st.run = (...a: unknown[]) => {
      if (injectAtFirstPlmInsert) {
        injectAtFirstPlmInsert = false;
        throw new Error("INJECTED at the first phone_last_message INSERT");
      }
      return origRun(...a);
    };
    return st;
  };
  rawDb = db;
  setDb(db as never);
  return { db, file };
}

/** Committed rows, read through a second connection. */
function committedPlm(file: string, userId: string): Record<string, string> {
  const r = new Database(file, { readonly: true });
  const rows = r
    .prepare("SELECT phone_normalized p, last_message_at t FROM phone_last_message WHERE user_id = ? ORDER BY p")
    .all(userId) as Array<{ p: string; t: string }>;
  r.close();
  return Object.fromEntries(rows.map((x) => [x.p, x.t]));
}

/** Both users refreshed once by the real writer, then U1's texts with GONE disappear. */
async function seedStaleRow(db: DatabaseType, file: string): Promise<void> {
  await refreshMessageRecencyAfterImport(U1);
  await refreshMessageRecencyAfterImport(U2);
  expect(committedPlm(file, U1)).toEqual({ [toLookupKey(LIVE)]: T1, [toLookupKey(GONE)]: T2 });
  expect(committedPlm(file, U2)).toEqual({ [toLookupKey(GONE)]: T1, [toLookupKey(OTHER)]: T2 });
  expect(db.prepare("DELETE FROM messages WHERE id = 'm2'").run().changes).toBe(1);
}

describe("BACKLOG-2554: phone_last_message drops phones that have no texts left", () => {
  let db: DatabaseType;
  let file: string;
  beforeEach(() => {
    injectAtFirstPlmInsert = false;
    ({ db, file } = openDb());
  });
  afterEach(() => db.close());

  it("C10: the post-import refresh removes the row for a phone with no texts and keeps the live one", async () => {
    await seedStaleRow(db, file);
    const counts = await refreshMessageRecencyAfterImport(U1);
    expect(counts.phones).toBe(1);
    expect(committedPlm(file, U1)).toEqual({ [toLookupKey(LIVE)]: T1 });
  });

  it("C11: another user's rows are untouched, including the same phone", async () => {
    await seedStaleRow(db, file);
    await refreshMessageRecencyAfterImport(U1);
    expect(committedPlm(file, U2)).toEqual({ [toLookupKey(GONE)]: T1, [toLookupKey(OTHER)]: T2 });
  });

  it("C12: a failure after the delete commits nothing — the old rows are all still there", async () => {
    await seedStaleRow(db, file);
    injectAtFirstPlmInsert = true;
    await expect(refreshMessageRecencyAfterImport(U1)).rejects.toThrow("INJECTED");
    expect(injectAtFirstPlmInsert).toBe(false); // the fault fired
    expect(committedPlm(file, U1)).toEqual({ [toLookupKey(LIVE)]: T1, [toLookupKey(GONE)]: T2 });
    expect(committedPlm(file, U2)).toEqual({ [toLookupKey(GONE)]: T1, [toLookupKey(OTHER)]: T2 });
  });

  it("C13: the promise sibling evicts the same way", async () => {
    await seedStaleRow(db, file);
    await expect(backfillPhoneLastMessageTable(U1)).resolves.toBe(1);
    expect(committedPlm(file, U1)).toEqual({ [toLookupKey(LIVE)]: T1 });
  });

  it("C14: external_contacts.last_message_at follows in the same refresh (it is recomputed from phone_last_message)", async () => {
    const iec = db.prepare(
      "INSERT INTO external_contacts (id, user_id, name, phones_json, phones_normalized_json, emails_json, external_record_id) VALUES (?, ?, ?, ?, ?, '[]', ?)",
    );
    iec.run("xl", U1, "Live", JSON.stringify([`+${LIVE}`]), JSON.stringify([toLookupKey(LIVE)]), "rl");
    iec.run("xg", U1, "Gone", JSON.stringify([`+${GONE}`]), JSON.stringify([toLookupKey(GONE)]), "rg");
    await seedStaleRow(db, file);
    const ext = () =>
      Object.fromEntries(
        (db.prepare("SELECT id, last_message_at t FROM external_contacts WHERE user_id = ? ORDER BY id").all(U1) as Array<{
          id: string;
          t: string | null;
        }>).map((x) => [x.id, x.t]),
      );
    expect(ext()).toEqual({ xg: T2, xl: T1 });
    await refreshMessageRecencyAfterImport(U1);
    expect(ext()).toEqual({ xg: null, xl: T1 });
  });

  it("a user with no texts left ends with no rows", async () => {
    await seedStaleRow(db, file);
    db.prepare("DELETE FROM messages WHERE user_id = ?").run(U1);
    const counts = await refreshMessageRecencyAfterImport(U1);
    expect(counts.phones).toBe(0);
    expect(committedPlm(file, U1)).toEqual({});
  });
});
