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
 * The roster itself (messageRosterDb.ts: two GROUP BY reads over the user's unlinked
 * texts, 2.7 s on main at 668k on a Mac) is read only on a dedicated worker too
 * (messageRosterCache.ts); while it is not ready the answer is empty with
 * `rosterPending: true`. Its result must equal the old main-thread roster: the oracle
 * below is runMessageRosterOn on main (recording off), compared as an exact set of
 * (contact, count, last, group names) over a fixture that exercises every roster
 * filter: linked texts, email channel, reactions, outbound (to[0]) handles, sender-name
 * handles, and a named group.
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
import { MESSAGE_ROSTER_NAMES_SQL, MESSAGE_ROSTER_SQL, type MessageContactRow } from "../db/messageRosterDb";
import { MESSAGE_DERIVED_CONTACTS_SQL } from "../db/wizardMessageScansDb";
import { resetMessageDerivedCacheForTests, setMessageDerivedWaitMsForTests } from "../db/messageDerivedContactsCache";
import { resetMessageRosterCacheForTests, setMessageRosterWaitMsForTests } from "../db/messageRosterCache";
import transactionService from "../transactionService/transactionService";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const KEY_HEX = "3837".repeat(16);
const USER = "user-3837e";
const MESSAGES = Number(process.env.KEEPR_3837_MESSAGES || 20_000);
const SAVED = Number(process.env.KEEPR_3837_CONTACTS || 40);
/** Named senders (kept by the message-derived read; roster handles that are names) and numbers of saved contacts. */
const NAMED = ["Alex Rivera", "Jordan Lee", "Casey Morgan"];
const SAVED_NUMBERS = ["+12005550100", "+12005550101"];
/** Only ever on an OUTBOUND text (to[0]) — the roster's other handle branch. */
const OUTBOUND_ONLY = "+12005550160";
/** Only ever on LINKED texts — must not be in the roster. */
const LINKED_ONLY = "+12005550170";
/** Only ever by EMAIL channel — must not be in the roster. */
const EMAIL_ONLY = "+12005550180";
/** Only ever as reactions — must not be in the roster. */
const REACTION_ONLY = "+12005550190";
const GROUP_THREAD = "chat-0";
const GROUP_NAME = "Kingfisher Lane Closing";
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
const ROSTER_HANDLES = [...NAMED, ...SAVED_NUMBERS, OUTBOUND_ONLY].sort();

/** An exact, order-free identity of a roster: contact | count | last | group names. */
function rosterIds(rows: Array<Pick<MessageContactRow, "contact" | "messageCount" | "lastMessageAt" | "threadNames">>): string[] {
  return rows.map((r) => `${r.contact}|${r.messageCount}|${r.lastMessageAt}|${[...r.threadNames].sort().join("+")}`).sort();
}

maybe("BACKLOG-3837: Attach Messages never reads on main (real worker, encrypted DB)", () => {
  let dir: string;
  let dbPath: string;
  let main: DatabaseType;
  let prepared: string[] = [];
  let recording = false;
  let oracle: string[] = [];

  function open(): DatabaseType {
    const db = new (Database as NonNullable<typeof Database>)(dbPath);
    db.pragma(`key = "x'${KEY_HEX}'"`);
    db.pragma("cipher_compatibility = 4");
    db.pragma("journal_mode = WAL");
    return db;
  }

  const has = (sqlText: unknown): boolean => prepared.some((s) => s === (sqlText as string));
  const derivedOnMain = (): boolean => has(MESSAGE_DERIVED_CONTACTS_SQL);
  const rosterOnMainSeen = (): boolean => has(MESSAGE_ROSTER_SQL) || has(MESSAGE_ROSTER_NAMES_SQL);
  const nothingOnMain = (): void => {
    expect(derivedOnMain()).toBe(false);
    expect(rosterOnMainSeen()).toBe(false);
  };
  const rosterCalls = (spy: jest.SpyInstance): number => spy.mock.calls.filter((c) => c[0] === "messageRoster").length;

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

  const ADD_SQL = `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, participants_flat,
         thread_id, sent_at, metadata, associated_message_type, transaction_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  function textRow(
    id: string, handle: string, i: number,
    o: { direction?: string; channel?: string; tx?: string | null; reaction?: number | null; thread?: string } = {},
  ): unknown[] {
    const direction = o.direction ?? "inbound";
    const participants = direction === "inbound" ? { from: handle, to: ["me"] } : { from: "me", to: [handle] };
    return [
      id, USER, o.channel ?? "imessage", `g-${id}`, direction, `body ${id}`,
      JSON.stringify(participants), handle.replace(/\D/g, "") || null, o.thread ?? `chat-${handle}`,
      new Date(FIRST_SENT_MS + i * 60_000).toISOString(),
      JSON.stringify({ source: "iphone_sync", originalId: i, dateRead: null, dateDelivered: null, attachmentCount: 0 }),
      o.reaction ?? null, o.tx ?? null,
    ];
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
    db.prepare("INSERT INTO transactions (id, user_id, property_address, started_at, status) VALUES ('tx-1', ?, '1 Test St', '2020-01-01T00:00:00.000Z', 'active')").run(USER);
    db.prepare("INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?, ?, ?)").run(USER, GROUP_THREAD, GROUP_NAME);
    const addContact = db.prepare(
      "INSERT INTO contacts (id, user_id, display_name, is_imported, source, last_inbound_at) VALUES (?, ?, ?, 1, 'contacts_app', ?)",
    );
    const addPhone = db.prepare(
      "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source) VALUES (?, ?, ?, ?, ?, 1, 'import')",
    );
    const add = db.prepare(ADD_SQL);
    const handles = [...NAMED, ...SAVED_NUMBERS];
    db.transaction(() => {
      for (let i = 0; i < SAVED; i++) {
        addContact.run(`saved-${i}`, USER, `Saved Person ${i}`, i === 0 ? new Date(FIRST_SENT_MS).toISOString() : null);
        const e164 = `+1200555${String(100 + i).padStart(4, "0")}`;
        addPhone.run(`ph-${i}`, `saved-${i}`, e164, e164, e164.replace(/\D/g, ""));
      }
      for (let i = 0; i < MESSAGES; i++) {
        const h = handles[i % handles.length];
        // "Alex Rivera" talks in the named group thread; everyone else 1:1.
        add.run(...textRow(`m${i}`, h, i, h === "Alex Rivera" ? { thread: GROUP_THREAD } : {}));
      }
      // The filters, one shape each (several rows so counts are not trivially 1).
      for (let k = 0; k < 5; k++) {
        add.run(...textRow(`out${k}`, OUTBOUND_ONLY, MESSAGES + k, { direction: "outbound" }));
        add.run(...textRow(`lnk${k}`, LINKED_ONLY, MESSAGES + 10 + k, { tx: "tx-1" }));
        add.run(...textRow(`eml${k}`, EMAIL_ONLY, MESSAGES + 20 + k, { channel: "email" }));
        add.run(...textRow(`rct${k}`, REACTION_ONLY, MESSAGES + 30 + k, { reaction: 2000 }));
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
    // The ORACLE: the old main-thread roster, read once before anything is recorded.
    oracle = rosterIds(rosterOnMain(USER));

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
    resetMessageRosterCacheForTests();
    setMessageDerivedWaitMsForTests(600_000);
    setMessageRosterWaitMsForTests(600_000);
  });

  afterEach(() => {
    recording = false;
    jest.restoreAllMocks();
    setMessageDerivedWaitMsForTests(null);
    setMessageRosterWaitMsForTests(null);
    // A case that went red mid-way must not leave its rows for the next one.
    main.prepare("DELETE FROM messages WHERE id LIKE 'x-%'").run();
    main.prepare("UPDATE messages SET transaction_id = NULL WHERE id LIKE 'm%' AND transaction_id = 'tx-1'").run();
    main.prepare("DELETE FROM message_thread_names WHERE thread_id = 'chat-Jordan Lee'").run();
  });

  afterAll(async () => {
    await shutdownPool();
    setContactWorkerPathForTests(null);
    main?.close();
    nodeFs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const nameOf = (rows: Array<{ contact: string; contactName: string | null }>, handle: string): string | null | undefined =>
    rows.find((r) => r.contact === handle)?.contactName;

  it("the oracle exercises every filter: linked, email and reaction-only handles are out; outbound and sender-name handles are in; the group name is carried", () => {
    expect(oracle.map((id) => id.split("|")[0]).sort()).toEqual(ROSTER_HANDLES);
    expect(oracle.some((id) => id.startsWith("Alex Rivera|") && id.endsWith(`|${GROUP_NAME}`))).toBe(true);
  });

  it("known answer: the roster equals the old main-thread roster exactly; names resolved; nothing read on main", async () => {
    expect(isPoolReady()).toBe(true);
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker");
    const { value: r, maxMs, ms } = await maxStallDuring(() => transactionService.getMessageContactsWithStatus(USER));
    nothingOnMain();
    expect(r.rosterPending).toBe(false);
    expect(r.messageDerivedPending).toBe(false);
    expect(rosterIds(r.contacts)).toEqual(oracle);
    expect(nameOf(r.contacts, "+12005550100")).toBe("Saved Person 0");
    expect(nameOf(r.contacts, "Jordan Lee")).toBe("Jordan Lee"); // from the message-derived half
    expect(rosterCalls(spy)).toBe(1);
    expect(spy.mock.calls.filter((c) => c[0] === "messageDerived")).toHaveLength(1);

    // Positive controls for the detectors: the OLD reads ARE seen on main.
    const { maxMs: oldNamesMs } = await maxStallDuring(async () => getImportedContactsByUserId(USER));
    expect(derivedOnMain()).toBe(true);
    const { maxMs: oldRosterMs } = await maxStallDuring(async () => rosterOnMain(USER));
    expect(rosterOnMainSeen()).toBe(true);
    recording = false;
    process.stderr.write(
      `[3837e] ${MESSAGES} msgs / ${SAVED} saved: WHOLE get-message-contacts call maxEventLoopDelay=${maxMs}ms (wall ${ms}ms, cold); ` +
        `old main-thread reads: names ${oldNamesMs}ms, roster ${oldRosterMs}ms\n`,
    );
  }, 900_000);

  const FAILURES: DedicatedQueryFailure[] = ["timeout", "start_failed", "unavailable", "stopped", "failed"];
  it.each(FAILURES)(
    "every dedicated read fails (%s): nothing read on main; the answer is roster-PENDING (empty), never a roster read on main",
    async (code) => {
      jest.spyOn(pool, "queryOnDedicatedWorker").mockRejectedValue(new DedicatedWorkerError(`simulated ${code}`, code));
      const r = await transactionService.getMessageContactsWithStatus(USER);
      nothingOnMain();
      expect(r.rosterPending).toBe(true);
      expect(r.contacts).toEqual([]);
      expect(r.messageDerivedPending).toBe(true);
    },
    60_000,
  );

  it.each(FAILURES)(
    "only the message-derived read fails (%s): the full roster, names from saved contacts, flagged messageDerivedPending",
    async (code) => {
      const realQuery = pool.queryOnDedicatedWorker;
      jest.spyOn(pool, "queryOnDedicatedWorker").mockImplementation((type, userId, timeoutMs, extras) =>
        type === "messageDerived"
          ? Promise.reject(new DedicatedWorkerError(`simulated ${code}`, code))
          : realQuery(type, userId, timeoutMs, extras),
      );
      const r = await transactionService.getMessageContactsWithStatus(USER);
      nothingOnMain();
      expect(r.rosterPending).toBe(false);
      expect(r.messageDerivedPending).toBe(true);
      expect(rosterIds(r.contacts)).toEqual(oracle);
      expect(nameOf(r.contacts, "+12005550100")).toBe("Saved Person 0");
      expect(nameOf(r.contacts, "Jordan Lee")).toBeNull();
    },
    120_000,
  );

  it("the roster read never answers: the call returns within the budget, roster-pending, nothing on main; not restarted", async () => {
    setMessageRosterWaitMsForTests(300);
    const realQuery = pool.queryOnDedicatedWorker;
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker").mockImplementation((type, userId, timeoutMs, extras) =>
      type === "messageRoster" ? new Promise<unknown[]>(() => undefined) : realQuery(type, userId, timeoutMs, extras),
    );
    const t0 = Date.now();
    const r = await transactionService.getMessageContactsWithStatus(USER);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(r.rosterPending).toBe(true);
    expect(r.contacts).toEqual([]);
    await transactionService.getMessageContactsWithStatus(USER);
    expect(rosterCalls(spy)).toBe(1);
    nothingOnMain();
  }, 120_000);

  it("the pool is not ready: still nothing on main", async () => {
    jest.spyOn(pool, "isPoolReady").mockReturnValue(false);
    jest.spyOn(pool, "queryOnDedicatedWorker").mockRejectedValue(new DedicatedWorkerError("simulated unavailable", "unavailable"));
    const r = await transactionService.getMessageContactsWithStatus(USER);
    nothingOnMain();
    expect(r.rosterPending).toBe(true);
  }, 60_000);

  it("the SHARED pool is held by a long job: the roster and names are still served; main stall printed", async () => {
    const realQuery = pool.queryContacts;
    const shared = jest.spyOn(pool, "queryContacts").mockImplementation((type, userId, timeoutMs, payload) =>
      type === "imported" ? realQuery(type, userId, timeoutMs, payload) : new Promise<unknown[]>(() => undefined),
    );
    const { value: r, maxMs, ms } = await maxStallDuring(() => transactionService.getMessageContactsWithStatus(USER));
    expect(r.rosterPending).toBe(false);
    expect(rosterIds(r.contacts)).toEqual(oracle);
    expect(nameOf(r.contacts, "Jordan Lee")).toBe("Jordan Lee");
    expect(shared.mock.calls.filter((c) => c[0] === "messageRoster" || c[0] === "messageDerived")).toHaveLength(0);
    nothingOnMain();
    process.stderr.write(`[3837e] ${MESSAGES} msgs, SHARED pool held, cold: WHOLE call maxEventLoopDelay=${maxMs}ms (wall ${ms}ms)\n`);
  }, 900_000);

  it("production budget, cold: the whole call answers within the budget (roster pending if slower); main stall printed", async () => {
    setMessageRosterWaitMsForTests(null);
    setMessageDerivedWaitMsForTests(null);
    const { value: r, maxMs, ms } = await maxStallDuring(() => transactionService.getMessageContactsWithStatus(USER));
    nothingOnMain();
    if (!r.rosterPending) expect(rosterIds(r.contacts)).toEqual(oracle);
    process.stderr.write(
      `[3837e] ${MESSAGES} msgs, production 3 s budget, cold: WHOLE call ${ms}ms, rosterPending=${r.rosterPending}, maxEventLoopDelay=${maxMs}ms\n`,
    );
    await new Promise((res) => setTimeout(res, 50));
  }, 900_000);

  it("three concurrent calls start ONE roster read; a later call with no relevant write reads nothing", async () => {
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker");
    const [a, b, c] = await Promise.all([
      transactionService.getMessageContactsWithStatus(USER),
      transactionService.getMessageContactsWithStatus(USER),
      transactionService.getMessageContactsWithStatus(USER),
    ]);
    expect(rosterCalls(spy)).toBe(1);
    for (const r of [a, b, c]) expect(rosterIds(r.contacts)).toEqual(oracle);
    await transactionService.getMessageContactsWithStatus(USER);
    expect(rosterCalls(spy)).toBe(1);
    main.prepare("UPDATE messages SET body_text = 'edited' WHERE id = 'm1'").run(); // a column the roster does not read
    await transactionService.getMessageContactsWithStatus(USER);
    expect(rosterCalls(spy)).toBe(1);
    nothingOnMain();
  }, 900_000);

  it("the cache is invalidated by a roster write: insert, attaching texts (transaction_id), a group name; each answer equals the main-thread roster", async () => {
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker");
    await transactionService.getMessageContactsWithStatus(USER);
    expect(rosterCalls(spy)).toBe(1);
    const check = async (calls: number): Promise<void> => {
      const r = await transactionService.getMessageContactsWithStatus(USER);
      expect(rosterCalls(spy)).toBe(calls);
      recording = false;
      const now = rosterIds(rosterOnMain(USER));
      recording = true;
      expect(rosterIds(r.contacts)).toEqual(now);
    };
    // A text from a new sender.
    main.prepare(ADD_SQL).run(...textRow("x-new", "Riley Brooks", MESSAGES + 100));
    await check(2);
    // Attach every text of one handle to the deal: that handle leaves the roster.
    main.prepare("UPDATE messages SET transaction_id = 'tx-1' WHERE thread_id = 'chat-+12005550101'").run();
    await check(3);
    // A group name for another chat.
    main.prepare("INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?, 'chat-Jordan Lee', 'Offer Review')").run(USER);
    await check(4);
    nothingOnMain();
  }, 900_000);
});
