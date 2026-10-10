/**
 * @jest-environment node
 *
 * BACKLOG-3837 follow-up — opening Attach Messages never runs the message-derived scan on
 * the main process.
 *
 * `transactions:get-message-contacts` → transactionService.getMessageContacts →
 * _getContactNameMapFromAppContacts called the SYNC getImportedContactsByUserId, which
 * runs MESSAGE_DERIVED_CONTACTS_SQL (every message of the user) on main every time the
 * modal opened. It now reads that half through messageDerivedContactsCache (dedicated
 * worker only); while it is not ready the roster is returned complete with
 * `messageDerivedPending: true`.
 *
 * NOT covered here, by design: the roster itself (messageDbService.getMessageContacts,
 * two GROUP BY reads over the user's unlinked texts) still runs on main. It is a
 * different read; its main-thread cost is PRINTED below so it can be decided separately.
 *
 * REAL worker (compiled from contactQueryWorker.ts) on a REAL encrypted database built
 * from schema.sql. The gate is structural: the scan statement is never prepared on the
 * main connection. Stalls are printed, not asserted (the #2915 rule).
 *
 * Size: KEEPR_3837_MESSAGES (default 20000; the PC corpus is ~668000) and
 * KEEPR_3837_CONTACTS (default 40; the PC has ~1186). Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 * Under plain node the driver cannot load and the suite is skipped with a warning.
 *
 * Fixture shapes as in contactsNeverOnMain-3837.test.ts (1:1 texts transcribed from
 * iPhoneSyncStorageService.storeMessages). Reserved 555-01xx numbers only.
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import { monitorEventLoopDelay } from "perf_hooks";
import { build } from "esbuild";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3837e"), isPackaged: true } }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../permissionService", () => ({
  __esModule: true,
  default: { checkFullDiskAccess: jest.fn().mockResolvedValue({ hasPermission: false }) },
}));
// The macOS address book is not this test's subject: an empty map.
jest.mock("../contactsService", () => ({
  getContactNames: async () => ({ contactMap: {}, phoneToContactInfo: {}, contacts: [] }),
}));

import * as pool from "../../workers/contactWorkerPool";
import { DedicatedWorkerError, initializePool, isPoolReady, setContactWorkerPathForTests, shutdownPool } from "../../workers/contactWorkerPool";
import type { DedicatedQueryFailure } from "../../workers/contactWorkerPool";
import { setDb } from "../db/core/dbConnection";
import { getImportedContactsByUserId } from "../db/contactDbService";
import { getMessageContacts as rosterOnMain } from "../db/messageDbService";
import { MESSAGE_DERIVED_CONTACTS_SQL } from "../db/wizardMessageScansDb";
import { resetMessageDerivedCacheForTests, setMessageDerivedWaitMsForTests } from "../db/messageDerivedContactsCache";
import transactionService from "../transactionService/transactionService";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const KEY_HEX = "3837".repeat(16);
const USER = "user-3837e";
const MESSAGES = Number(process.env.KEEPR_3837_MESSAGES || 20_000);
const SAVED = Number(process.env.KEEPR_3837_CONTACTS || 40);
/** Named senders (kept by the message-derived read) and two numbers of saved contacts. */
const NAMED = ["Alex Rivera", "Jordan Lee", "Casey Morgan"];
const SAVED_NUMBERS = ["+12005550100", "+12005550101"];
const FIRST_SENT_MS = 1_600_000_000_000;

function loadDriver(): (new (file: string, opts?: object) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    process.stderr.write(`[3837e] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}

const Database = loadDriver();
const maybe = Database ? describe : describe.skip;
const ROSTER = [...NAMED, ...SAVED_NUMBERS].sort();

maybe("BACKLOG-3837: Attach Messages never scans messages on main for names (real worker, encrypted DB)", () => {
  let dir: string;
  let dbPath: string;
  let main: DatabaseType;
  let prepared: string[] = [];
  let recording = false;

  function open(): DatabaseType {
    const db = new (Database as NonNullable<typeof Database>)(dbPath);
    db.pragma(`key = "x'${KEY_HEX}'"`);
    db.pragma("cipher_compatibility = 4");
    db.pragma("journal_mode = WAL");
    return db;
  }

  const scanOnMain = (): boolean => prepared.some((s) => s === (MESSAGE_DERIVED_CONTACTS_SQL as unknown as string));

  async function maxStallDuring<T>(work: () => Promise<T>): Promise<{ value: T; maxMs: number; ms: number }> {
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    const value = await work();
    const ms = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 50));
    h.disable();
    return { value, maxMs: Math.round(h.max / 1e6), ms };
  }

  beforeAll(async () => {
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3837e-"));
    dbPath = nodePath.join(dir, "mad.db");
    const db = open();
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      USER,
      "u3837e@example.test",
      "oauth-3837e",
    );
    const addContact = db.prepare(
      "INSERT INTO contacts (id, user_id, display_name, is_imported, source, last_inbound_at) VALUES (?, ?, ?, 1, 'contacts_app', ?)",
    );
    const addPhone = db.prepare(
      "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source) VALUES (?, ?, ?, ?, ?, 1, 'import')",
    );
    const add = db.prepare(`INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, participants_flat,
         thread_id, sent_at, metadata, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const handles = [...NAMED, ...SAVED_NUMBERS];
    db.transaction(() => {
      for (let i = 0; i < SAVED; i++) {
        addContact.run(`saved-${i}`, USER, `Saved Person ${i}`, i === 0 ? new Date(FIRST_SENT_MS).toISOString() : null);
        const e164 = `+1200555${String(100 + i).padStart(4, "0")}`;
        addPhone.run(`ph-${i}`, `saved-${i}`, e164, e164, e164.replace(/\D/g, ""));
      }
      for (let i = 0; i < MESSAGES; i++) {
        const from = handles[i % handles.length];
        add.run(
          `m${i}`, USER, "imessage", `g${i}`, "inbound", `body ${i}`,
          JSON.stringify({ from, to: ["me"] }), from.replace(/\D/g, "") || null, `chat-${i % handles.length}`,
          new Date(FIRST_SENT_MS + i * 60_000).toISOString(),
          JSON.stringify({ source: "iphone_sync", originalId: i, dateRead: null, dateDelivered: null, attachmentCount: 0 }),
          null,
        );
      }
    })();
    db.close();

    main = open();
    const realPrepare = main.prepare.bind(main);
    (main as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
      if (recording) prepared.push(s);
      return realPrepare(s);
    };
    setDb(main);

    const workerScript = nodePath.join(dir, "contactQueryWorker.js");
    await build({
      entryPoints: [nodePath.join(__dirname, "..", "..", "workers", "contactQueryWorker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: workerScript,
      plugins: [
        {
          name: "driver-from-repo",
          setup(b) {
            b.onResolve({ filter: /^better-sqlite3-multiple-ciphers$/ }, () => ({ path: DRIVER, external: true }));
          },
        },
      ],
      logLevel: "silent",
    });
    setContactWorkerPathForTests(workerScript);
    await initializePool(dbPath, KEY_HEX);
    for (let i = 0; i < 200 && !isPoolReady(); i++) await new Promise((r) => setTimeout(r, 25));
  }, 900_000);

  beforeEach(() => {
    prepared = [];
    recording = true;
    resetMessageDerivedCacheForTests();
    setMessageDerivedWaitMsForTests(600_000);
  });

  afterEach(() => {
    recording = false;
    jest.restoreAllMocks();
    setMessageDerivedWaitMsForTests(null);
  });

  afterAll(async () => {
    await shutdownPool();
    setContactWorkerPathForTests(null);
    main?.close();
    nodeFs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const nameOf = (rows: Array<{ contact: string; contactName: string | null }>, handle: string): string | null | undefined =>
    rows.find((r) => r.contact === handle)?.contactName;

  it("known answer: full roster, saved numbers named, message-derived names applied; the scan ran on a dedicated worker", async () => {
    expect(isPoolReady()).toBe(true);
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker");
    const { value: r, maxMs, ms } = await maxStallDuring(() => transactionService.getMessageContactsWithStatus(USER));
    expect(scanOnMain()).toBe(false);
    expect(r.messageDerivedPending).toBe(false);
    expect(r.contacts.map((c) => c.contact).sort()).toEqual(ROSTER);
    expect(nameOf(r.contacts, "+12005550100")).toBe("Saved Person 0");
    expect(nameOf(r.contacts, "Jordan Lee")).toBe("Jordan Lee"); // from the message-derived half
    expect(spy.mock.calls.filter((c) => c[0] === "messageDerived")).toHaveLength(1);

    // Positive control for the detector: the OLD name source (sync producer) IS seen on main.
    const { maxMs: oldMs, ms: oldWall } = await maxStallDuring(async () => getImportedContactsByUserId(USER));
    expect(scanOnMain()).toBe(true);
    recording = false;

    // The roster itself (a different read, still on main): measured, not changed here.
    const { value: roster, maxMs: rosterMs, ms: rosterWall } = await maxStallDuring(async () => rosterOnMain(USER));
    expect(roster.map((c) => c.contact).sort()).toEqual(ROSTER);
    process.stderr.write(
      `[3837e] ${MESSAGES} msgs / ${SAVED} saved: get-message-contacts names maxEventLoopDelay=${maxMs}ms (wall ${ms}ms); ` +
        `OLD sync name source on main ${oldMs}ms (wall ${oldWall}ms); roster read on main (unchanged) ${rosterMs}ms (wall ${rosterWall}ms)\n`,
    );
  }, 900_000);

  const FAILURES: DedicatedQueryFailure[] = ["timeout", "start_failed", "unavailable", "stopped", "failed"];
  it.each(FAILURES)(
    "the dedicated read fails (%s): nothing scanned on main; full roster, flagged pending",
    async (code) => {
      jest.spyOn(pool, "queryOnDedicatedWorker").mockRejectedValue(new DedicatedWorkerError(`simulated ${code}`, code));
      const r = await transactionService.getMessageContactsWithStatus(USER);
      expect(scanOnMain()).toBe(false);
      expect(r.messageDerivedPending).toBe(true);
      expect(r.contacts.map((c) => c.contact).sort()).toEqual(ROSTER);
      expect(nameOf(r.contacts, "+12005550100")).toBe("Saved Person 0"); // saved names never wait
      expect(nameOf(r.contacts, "Jordan Lee")).toBeNull(); // the message-derived half is what is pending
    },
    60_000,
  );

  it("the pool is not ready (worker unavailable): still nothing on main", async () => {
    jest.spyOn(pool, "isPoolReady").mockReturnValue(false);
    jest
      .spyOn(pool, "queryOnDedicatedWorker")
      .mockRejectedValue(new DedicatedWorkerError("simulated unavailable", "unavailable"));
    const r = await transactionService.getMessageContactsWithStatus(USER);
    expect(scanOnMain()).toBe(false);
    expect(r.messageDerivedPending).toBe(true);
    expect(r.contacts.map((c) => c.contact).sort()).toEqual(ROSTER);
  }, 60_000);

  it("the SHARED pool is held by a long job: names still resolved via the dedicated worker", async () => {
    const realQuery = pool.queryContacts;
    const shared = jest.spyOn(pool, "queryContacts").mockImplementation((type, userId, timeoutMs, payload) =>
      type === "imported" ? realQuery(type, userId, timeoutMs, payload) : new Promise<unknown[]>(() => undefined),
    );
    const { value: r, maxMs, ms } = await maxStallDuring(() => transactionService.getMessageContactsWithStatus(USER));
    expect(r.messageDerivedPending).toBe(false);
    expect(nameOf(r.contacts, "Jordan Lee")).toBe("Jordan Lee");
    expect(shared.mock.calls.filter((c) => c[0] === "messageDerived")).toHaveLength(0);
    expect(scanOnMain()).toBe(false);
    process.stderr.write(`[3837e] ${MESSAGES} msgs, SHARED pool held, cold: names maxEventLoopDelay=${maxMs}ms (wall ${ms}ms)\n`);
  }, 900_000);
});
