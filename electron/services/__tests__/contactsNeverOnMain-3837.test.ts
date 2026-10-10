/**
 * @jest-environment node
 *
 * BACKLOG-3837 follow-up — the contact lists never run the message-derived scan on the
 * main process.
 *
 * On the PC (668k messages, encrypted, Windows) `contacts:get-sorted-by-activity` and
 * `contacts:get-all` read the message-derived people (MESSAGE_DERIVED_CONTACTS_SQL) on the
 * SHARED contact worker with a 30 s timeout. Right after a sync that worker was busy, the
 * read timed out, and the same scan ran on MAIN for ~25 s while the new-transaction
 * wizard waited. Now the read runs only on a dedicated worker, cached per user against a
 * token of the messages writes, one read per user at a time; a list waits a short budget
 * and otherwise returns the saved contacts with `messageDerivedPending: true`.
 *
 * REAL worker (compiled from contactQueryWorker.ts) on a REAL encrypted database built
 * from schema.sql. The gate is structural: the scan statement is never prepared on the
 * main connection. Event-loop stalls are printed, not asserted (the #2915 rule).
 *
 * Size: KEEPR_3837_MESSAGES (default 20000). The PC corpus is ~668000. Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 * Under plain node the driver cannot load and the suite is skipped with a warning.
 *
 * Fixture shapes as in wizardContinueOffMain-3837.test.ts (1:1 texts transcribed from
 * iPhoneSyncStorageService.storeMessages: participants {from, to}, metadata.source
 * "iphone_sync"). A named sender is what MESSAGE_DERIVED_CONTACTS_SQL keeps (it drops
 * handles that are numbers or addresses). Reserved 555-01xx numbers only.
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import { monitorEventLoopDelay } from "perf_hooks";
import { build } from "esbuild";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3837d"), isPackaged: true } }));
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
jest.mock("../contactsService", () => ({ getContactNames: () => new Map() }));

import * as pool from "../../workers/contactWorkerPool";
import { DedicatedWorkerError, initializePool, isPoolReady, setContactWorkerPathForTests, shutdownPool } from "../../workers/contactWorkerPool";
import type { DedicatedQueryFailure } from "../../workers/contactWorkerPool";
import { setDb } from "../db/core/dbConnection";
import {
  backfillContactCommunicationDates,
  getContactsSortedByActivityWithStatus,
  getImportedContactsWithStatusAsync,
  getMessageDerivedContacts,
  resetCommunicationDatesBackfillForTests,
} from "../db/contactDbService";
import { BACKFILL_TEXT_FLATS_SQL, MESSAGE_DERIVED_CONTACTS_SQL } from "../db/wizardMessageScansDb";
import {
  resetMessageDerivedCacheForTests,
  setMessageDerivedWaitMsForTests,
} from "../db/messageDerivedContactsCache";
import { autoLinkNewMessagesForUser } from "../autoLinkService";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const KEY_HEX = "3837".repeat(16);
const USER = "user-3837d";
const MESSAGES = Number(process.env.KEEPR_3837_MESSAGES || 20_000);
const SAVED = 40;
const SENDERS = ["Alex Rivera", "Jordan Lee", "Casey Morgan", "Taylor Quinn", "Morgan Blake", "Drew Ellis"];
const FIRST_SENT_MS = 1_600_000_000_000;

function loadDriver(): (new (file: string, opts?: object) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    process.stderr.write(`[3837d] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}

const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

function msgDerivedCalls(spy: jest.SpyInstance): number {
  return spy.mock.calls.filter((c) => c[0] === "messageDerived").length;
}

const SAVED_IDS = Array.from({ length: SAVED }, (_, i) => `saved-${i}`).sort();
const SENDER_IDS = SENDERS.map((n) => `msg_${n.toLowerCase()}`).sort();
const idsOf = (rows: Array<{ id: string }>, prefix: string): string[] =>
  rows.map((r) => r.id).filter((id) => id.startsWith(prefix)).sort();

maybe("BACKLOG-3837: contact lists never scan messages on main (real worker, encrypted DB)", () => {
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
  const commDatesScanOnMain = (): boolean => prepared.some((s) => s === (BACKFILL_TEXT_FLATS_SQL as unknown as string));

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

  const addMessageSql = `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, participants_flat,
         thread_id, sent_at, metadata, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  function textRow(id: string, from: string, sentAt: string): unknown[] {
    return [
      id, USER, "imessage", `g-${id}`, "inbound", `body ${id}`,
      JSON.stringify({ from, to: ["me"] }), "12005550123", "ios-chat-1", sentAt,
      JSON.stringify({ source: "iphone_sync", originalId: 1, dateRead: null, dateDelivered: null, attachmentCount: 0 }),
      null,
    ];
  }

  beforeAll(async () => {
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3837d-"));
    dbPath = nodePath.join(dir, "mad.db");
    const db = open();
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      USER,
      "u3837d@example.test",
      "oauth-3837d",
    );
    const addContact = db.prepare(
      "INSERT INTO contacts (id, user_id, display_name, is_imported, source, last_inbound_at) VALUES (?, ?, ?, 1, 'contacts_app', ?)",
    );
    const addPhone = db.prepare(
      "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source) VALUES (?, ?, ?, ?, ?, 1, 'import')",
    );
    const add = db.prepare(addMessageSql);
    db.transaction(() => {
      for (let i = 0; i < SAVED; i++) {
        // One dated contact: the activity list does not start the one-time dates backfill.
        addContact.run(`saved-${i}`, USER, `Saved Person ${i}`, i === 0 ? new Date(FIRST_SENT_MS).toISOString() : null);
        const e164 = `+1200555${String(100 + i).padStart(4, "0")}`;
        addPhone.run(`ph-${i}`, `saved-${i}`, e164, e164, e164.replace(/\D/g, ""));
      }
      for (let i = 0; i < MESSAGES; i++) {
        const sentAt = new Date(FIRST_SENT_MS + i * 60_000).toISOString();
        add.run(...textRow(`m${i}`, SENDERS[i % SENDERS.length], sentAt));
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
    resetCommunicationDatesBackfillForTests();
    setMessageDerivedWaitMsForTests(600_000); // the real read always finishes unless a case says otherwise
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

  it("known answer: both lists carry every saved contact AND the message-derived people, read on a dedicated worker", async () => {
    expect(isPoolReady()).toBe(true);
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker");
    const { value: sorted, maxMs: sortedMs, ms: sortedWall } = await maxStallDuring(() => getContactsSortedByActivityWithStatus(USER));
    expect(scanOnMain()).toBe(false);
    expect(sorted.messageDerivedPending).toBe(false);
    expect(idsOf(sorted.contacts, "saved-")).toEqual(SAVED_IDS);
    expect(idsOf(sorted.contacts, "msg_")).toEqual(SENDER_IDS);
    expect(msgDerivedCalls(spy)).toBe(1);

    const { value: all, maxMs: allMs } = await maxStallDuring(() => getImportedContactsWithStatusAsync(USER));
    expect(all.messageDerivedPending).toBe(false);
    expect(idsOf(all.contacts, "saved-")).toEqual(SAVED_IDS);
    expect(idsOf(all.contacts, "msg_")).toEqual(SENDER_IDS);
    expect(msgDerivedCalls(spy)).toBe(1); // cache hit
    expect(scanOnMain()).toBe(false);

    // Positive control for the detector: the old main-thread read IS seen, same people.
    const { value: onMain, maxMs: mainMs } = await maxStallDuring(async () => getMessageDerivedContacts(USER));
    expect(scanOnMain()).toBe(true);
    recording = false;
    expect(onMain.map((c) => c.id).sort()).toEqual(SENDER_IDS);
    process.stderr.write(
      `[3837d] ${MESSAGES} msgs: get-sorted-by-activity producer maxEventLoopDelay=${sortedMs}ms (wall ${sortedWall}ms), ` +
        `get-all producer maxEventLoopDelay=${allMs}ms; main-thread scan control ${mainMs}ms\n`,
    );
  }, 900_000);

  const FAILURES: DedicatedQueryFailure[] = ["timeout", "start_failed", "unavailable", "stopped", "failed"];
  it.each(FAILURES)(
    "the dedicated read fails (%s): nothing read on main; every saved contact is returned, flagged pending",
    async (code) => {
      const spy = jest
        .spyOn(pool, "queryOnDedicatedWorker")
        .mockRejectedValue(new DedicatedWorkerError(`simulated ${code}`, code));
      const sorted = await getContactsSortedByActivityWithStatus(USER);
      expect(msgDerivedCalls(spy)).toBe(1);
      expect(scanOnMain()).toBe(false);
      expect(sorted.messageDerivedPending).toBe(true);
      // Never an empty list standing for "not loaded" (BACKLOG-3832): the saved half is all there.
      expect(idsOf(sorted.contacts, "saved-")).toEqual(SAVED_IDS);
      expect(idsOf(sorted.contacts, "msg_")).toEqual([]);

      const all = await getImportedContactsWithStatusAsync(USER);
      expect(scanOnMain()).toBe(false);
      expect(all.messageDerivedPending).toBe(true);
      expect(idsOf(all.contacts, "saved-")).toEqual(SAVED_IDS);
    },
    60_000,
  );

  it("the dedicated read never answers: the list returns within the budget, pending, nothing on main; the read is not restarted", async () => {
    setMessageDerivedWaitMsForTests(300);
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker").mockImplementation(() => new Promise<unknown[]>(() => undefined));
    const t0 = Date.now();
    const sorted = await getContactsSortedByActivityWithStatus(USER);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(sorted.messageDerivedPending).toBe(true);
    expect(idsOf(sorted.contacts, "saved-")).toEqual(SAVED_IDS);
    await getImportedContactsWithStatusAsync(USER); // a second list joins the running read
    expect(msgDerivedCalls(spy)).toBe(1);
    expect(scanOnMain()).toBe(false);
  }, 60_000);

  it("the SHARED pool is held by a long job: the message-derived people are still served (never via the shared worker)", async () => {
    const realQuery = pool.queryContacts;
    const shared = jest.spyOn(pool, "queryContacts").mockImplementation((type, userId, timeoutMs, payload) =>
      type === "imported" ? realQuery(type, userId, timeoutMs, payload) : new Promise<unknown[]>(() => undefined),
    );
    const { value: sorted, maxMs: sortedMs, ms: sortedWall } = await maxStallDuring(() => getContactsSortedByActivityWithStatus(USER));
    expect(sorted.messageDerivedPending).toBe(false);
    expect(idsOf(sorted.contacts, "msg_")).toEqual(SENDER_IDS);
    const { value: all, maxMs: allMs, ms: allWall } = await maxStallDuring(() => getImportedContactsWithStatusAsync(USER));
    expect(all.messageDerivedPending).toBe(false);
    process.stderr.write(
      `[3837d] ${MESSAGES} msgs, SHARED pool held: get-sorted-by-activity producer maxEventLoopDelay=${sortedMs}ms (wall ${sortedWall}ms, cold dedicated read), ` +
        `get-all producer maxEventLoopDelay=${allMs}ms (wall ${allWall}ms)\n`,
    );
    expect(idsOf(all.contacts, "msg_")).toEqual(SENDER_IDS);
    expect(shared.mock.calls.filter((c) => c[0] === "messageDerived")).toHaveLength(0);
    expect(scanOnMain()).toBe(false);
  }, 900_000);

  it("production budget, cold cache, SHARED pool held: the list answers within the budget (pending if the read is slower); main stall printed", async () => {
    setMessageDerivedWaitMsForTests(null);
    const realQuery = pool.queryContacts;
    jest.spyOn(pool, "queryContacts").mockImplementation((type, userId, timeoutMs, payload) =>
      type === "imported" ? realQuery(type, userId, timeoutMs, payload) : new Promise<unknown[]>(() => undefined),
    );
    const { value: r, maxMs, ms } = await maxStallDuring(() => getContactsSortedByActivityWithStatus(USER));
    expect(ms).toBeLessThan(3_000 + 2_000);
    expect(idsOf(r.contacts, "saved-")).toEqual(SAVED_IDS);
    expect(scanOnMain()).toBe(false);
    process.stderr.write(
      `[3837d] ${MESSAGES} msgs, production 3 s budget, cold: get-sorted-by-activity answered in ${ms}ms, pending=${r.messageDerivedPending}, maxEventLoopDelay=${maxMs}ms\n`,
    );
    await new Promise((res) => setTimeout(res, 50));
  }, 900_000);

  it("three concurrent lists start ONE read; a later list with no relevant write reads nothing", async () => {
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker");
    const [a, b, c] = await Promise.all([
      getContactsSortedByActivityWithStatus(USER),
      getContactsSortedByActivityWithStatus(USER),
      getImportedContactsWithStatusAsync(USER),
    ]);
    expect(msgDerivedCalls(spy)).toBe(1);
    expect(idsOf(a.contacts, "msg_")).toEqual(SENDER_IDS);
    expect(idsOf(b.contacts, "msg_")).toEqual(SENDER_IDS);
    expect(idsOf(c.contacts, "msg_")).toEqual(SENDER_IDS);
    await getContactsSortedByActivityWithStatus(USER);
    expect(msgDerivedCalls(spy)).toBe(1); // cache hit
    main.prepare("UPDATE messages SET body_text = 'edited' WHERE id = 'm1'").run(); // a column the read does not use
    await getContactsSortedByActivityWithStatus(USER);
    expect(msgDerivedCalls(spy)).toBe(1);
    expect(scanOnMain()).toBe(false);
  }, 900_000);

  it("the cache is invalidated by a messages write (insert, participants update, row removal); a contacts write applies with no re-read", async () => {
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker");
    await getContactsSortedByActivityWithStatus(USER);
    expect(msgDerivedCalls(spy)).toBe(1);

    // Insert a text from a new sender: re-read, the sender appears.
    main.prepare(addMessageSql).run(...textRow("m-new", "Riley Brooks", new Date(FIRST_SENT_MS + MESSAGES * 60_000).toISOString()));
    let r = await getContactsSortedByActivityWithStatus(USER);
    expect(msgDerivedCalls(spy)).toBe(2);
    expect(idsOf(r.contacts, "msg_")).toEqual([...SENDER_IDS, "msg_riley brooks"].sort());

    // Change that text's sender (participants): re-read, the people move with it.
    main.prepare("UPDATE messages SET participants = ? WHERE id = 'm-new'").run(JSON.stringify({ from: "Avery Stone", to: ["me"] }));
    r = await getContactsSortedByActivityWithStatus(USER);
    expect(msgDerivedCalls(spy)).toBe(3);
    expect(idsOf(r.contacts, "msg_")).toEqual([...SENDER_IDS, "msg_avery stone"].sort());

    // Remove the row: re-read, back to the original people.
    main.prepare("DELETE FROM messages WHERE id = 'm-new'").run();
    r = await getContactsSortedByActivityWithStatus(USER);
    expect(msgDerivedCalls(spy)).toBe(4);
    expect(idsOf(r.contacts, "msg_")).toEqual(SENDER_IDS);

    // A contacts write: a saved contact whose only identity is the name "Casey Morgan"
    // (no crosswalk row) suppresses that sender's twin (BACKLOG-2618) — at once, no re-read.
    main
      .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported, source) VALUES ('saved-casey', ?, 'Casey Morgan', 1, 'manual')")
      .run(USER);
    r = await getContactsSortedByActivityWithStatus(USER);
    expect(msgDerivedCalls(spy)).toBe(4);
    expect(idsOf(r.contacts, "msg_")).toEqual(SENDER_IDS.filter((id) => id !== "msg_casey morgan"));
    expect(r.contacts.some((c) => c.id === "saved-casey")).toBe(true);
    main.prepare("DELETE FROM contacts WHERE id = 'saved-casey'").run();
    r = await getContactsSortedByActivityWithStatus(USER);
    expect(idsOf(r.contacts, "msg_")).toEqual(SENDER_IDS);
    expect(scanOnMain()).toBe(false);
  }, 900_000);

  it("a sync end warms the cache: the first list after it, within the 3 s budget, has the message-derived people", async () => {
    setMessageDerivedWaitMsForTests(null); // the production budget (3 s)
    const realQuery = pool.queryOnDedicatedWorker; // captured before the spy replaces it
    const spy = jest.spyOn(pool, "queryOnDedicatedWorker").mockImplementation(async (type, userId, timeoutMs, extras) => {
      if (type === "messageDerived") await new Promise((r) => setTimeout(r, SLOW_READ_MS));
      return realQuery(type, userId, timeoutMs, extras);
    });
    main.prepare(addMessageSql).run(...textRow("m-synced", "Jordan Lee", new Date(FIRST_SENT_MS + (MESSAGES + 1) * 60_000).toISOString()));
    await autoLinkNewMessagesForUser(USER);
    await new Promise((r) => setTimeout(r, SLOW_READ_MS + 1_000)); // the user opens the wizard
    const t0 = Date.now();
    const r = await getContactsSortedByActivityWithStatus(USER);
    const ms = Date.now() - t0;
    expect(r.messageDerivedPending).toBe(false);
    expect(idsOf(r.contacts, "msg_")).toEqual(SENDER_IDS);
    expect(msgDerivedCalls(spy)).toBe(1); // the warm read; the list was a cache hit
    expect(ms).toBeLessThan(3_000);
    expect(scanOnMain()).toBe(false);
    main.prepare("DELETE FROM messages WHERE id = 'm-synced'").run();
  }, 120_000);

  it("the dates backfill plan: a worker that cannot run it fails the run; nothing is read on main", async () => {
    const codes: DedicatedQueryFailure[] = ["unavailable", "start_failed"];
    for (const code of codes) {
      resetCommunicationDatesBackfillForTests();
      const spy = jest
        .spyOn(pool, "queryOnDedicatedWorker")
        .mockRejectedValue(new DedicatedWorkerError(`simulated ${code}`, code));
      await expect(backfillContactCommunicationDates(USER)).rejects.toThrow(`simulated ${code}`);
      expect(spy.mock.calls.filter((c) => c[0] === "commDatesPlan")).toHaveLength(1);
      expect(commDatesScanOnMain()).toBe(false);
      spy.mockRestore();
    }
  }, 60_000);
});

/** Slower than the 3 s list budget. */
const SLOW_READ_MS = 4_000;
