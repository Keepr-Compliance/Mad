/**
 * @jest-environment node
 *
 * BACKLOG-3837 — "Continue" in step 1 of a new transaction froze the main process
 * (9 s Not Responding on the PC, ~668k messages, 1186 contacts). Three message scans
 * ran on the main thread on that click:
 *   1. the audit coverage check's per-source floors (MESSAGES_FLOOR_BY_SOURCE_SQL);
 *   2. the activity-sorted contact list's message-derived people
 *      (MESSAGE_DERIVED_CONTACTS_SQL), also behind contacts:get-all;
 *   3. for a user whose contacts have no last-message date yet, the date backfill
 *      (a LIKE '%digits%' join of every phone against every text: 505 s at 200k
 *      messages in the measurement), which the list awaited.
 * All three now run on the contact query worker.
 *
 * This suite starts the REAL worker (compiled from contactQueryWorker.ts) on a REAL
 * encrypted database built from schema.sql. The gates are structural: with the worker
 * up, none of the scan statements is prepared on the main connection, and the worker
 * answers equal the main-thread answers (non-empty sets). Event-loop stalls are
 * printed, not asserted (runner speed varies — the #2915 rule).
 *
 * Size: KEEPR_3837_MESSAGES (default 20000) and KEEPR_3837_CONTACTS (default 300).
 * The PC corpus is ~668000 / 1186. Real driver: run under Electron —
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 * Under plain node the binary cannot load and the suite is skipped with a warning.
 *
 * Fixture shapes are transcribed from their producers:
 *   1:1 texts  — iPhoneSyncStorageService.ts storeMessages (participants {from: handle|"me",
 *                to: ["me"]|[handle]}, participants_flat = the handle's digits,
 *                metadata.source "iphone_sync")
 *   group texts — rcsImportStore.ts participantsJson (inbound from = the shown name when it
 *                does not resolve to one number; chat_members), metadata.source "gmweb-cache"
 *   reactions  — associated_message_type in the tapback band (reactionExclusion.ts)
 * Reserved 555-01xx numbers only (public repo).
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import { monitorEventLoopDelay } from "perf_hooks";
import { build } from "esbuild";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3837"), isPackaged: true } }));
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
import { initializePool, isPoolReady, setContactWorkerPathForTests, shutdownPool } from "../../workers/contactWorkerPool";
import { setDb } from "../db/core/dbConnection";
import { getAuditCoverage, getSourceCoverage, getSourceCoverageAsync, setSourceFloorsWaitMsForTests } from "../auditCoverageService";
import {
  backfillContactCommunicationDates,
  getContactsSortedByActivity,
  getImportedContactsByUserIdAsync,
  getMessageDerivedContacts,
  getMessageDerivedContactsAsync,
  resetCommunicationDatesBackfillForTests,
} from "../db/contactDbService";
import {
  BACKFILL_CONTACT_PHONE_KEYS_SQL,
  BACKFILL_TEXT_FLATS_SQL,
  MESSAGE_DERIVED_CONTACTS_SQL,
  planCommunicationDatesOn,
} from "../db/wizardMessageScansDb";
import { MESSAGES_FLOOR_BY_SOURCE_SQL } from "../db/auditCoverageSql";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const KEY_HEX = "3837".repeat(16);
const USER = "user-3837";
const MESSAGES = Number(process.env.KEEPR_3837_MESSAGES || 20_000);
const CONTACTS = Number(process.env.KEEPR_3837_CONTACTS || 300);
const AUDIT_START = "2020-01-01T00:00:00.000Z";
/** The old LIKE join is the oracle; it is O(messages x phones) and too slow for a PC-sized run. */
const ORACLE = MESSAGES <= 50_000;

/** Every statement that reads every text message of the user. None may run on main. */
const SCANS: Array<[string, string]> = [
  ["MESSAGES_FLOOR_BY_SOURCE_SQL", MESSAGES_FLOOR_BY_SOURCE_SQL],
  ["MESSAGE_DERIVED_CONTACTS_SQL", MESSAGE_DERIVED_CONTACTS_SQL],
  ["BACKFILL_TEXT_FLATS_SQL", BACKFILL_TEXT_FLATS_SQL],
  ["BACKFILL_CONTACT_PHONE_KEYS_SQL", BACKFILL_CONTACT_PHONE_KEYS_SQL],
];

/**
 * The backfill join this item replaced, verbatim (contactDbService.ts before
 * BACKLOG-3837, reaction fragment expanded). The ORACLE for the new plan.
 */
const OLD_BACKFILL_JOIN = `
    SELECT
      SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10) as normalized_phone,
      cp.contact_id,
      MAX(m.sent_at) as last_msg_date
    FROM contact_phones cp
    JOIN contacts c ON cp.contact_id = c.id AND c.user_id = ? AND c.is_imported = 1
    JOIN messages m ON (
      m.user_id = ?
      AND (m.channel = 'sms' OR m.channel = 'imessage')
      AND (m.associated_message_type IS NULL OR m.associated_message_type NOT BETWEEN 2000 AND 3005)
      AND m.participants_flat LIKE '%' || SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10) || '%'
    )
    WHERE LENGTH(SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)) >= 7
    GROUP BY cp.contact_id
  `;

function loadDriver(): (new (file: string, opts?: object) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    process.stderr.write(`[3837] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}

const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

function phoneFor(c: number): string {
  return `+1${200 + Math.floor(c / 100)}5550${100 + (c % 100)}`;
}

maybe("BACKLOG-3837: step-1 Continue scans run on the contact query worker (real worker, encrypted DB)", () => {
  let dir: string;
  let dbPath: string;
  let main: DatabaseType;
  /** Text of every statement prepared on the MAIN connection while recording. */
  let prepared: string[] = [];
  let recording = false;

  function open(readonly = false): DatabaseType {
    const db = new (Database as NonNullable<typeof Database>)(dbPath, readonly ? { readonly: true } : undefined);
    db.pragma(`key = "x'${KEY_HEX}'"`);
    db.pragma("cipher_compatibility = 4");
    if (!readonly) db.pragma("journal_mode = WAL");
    return db;
  }

  function scansOnMain(): string[] {
    return SCANS.filter(([, text]) => prepared.includes(text)).map(([name]) => name);
  }

  async function maxStallDuring<T>(work: () => Promise<T>): Promise<{ value: T; maxMs: number }> {
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    await new Promise((r) => setTimeout(r, 50)); // the histogram records nothing before its first tick
    const value = await work();
    await new Promise((r) => setTimeout(r, 50));
    h.disable();
    return { value, maxMs: Math.round(h.max / 1e6) };
  }

  beforeAll(async () => {
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3837-continue-"));
    dbPath = nodePath.join(dir, "mad.db");
    const db = open();
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      USER,
      "u3837@example.test",
      "oauth-3837",
    );
    const addContact = db.prepare(
      "INSERT INTO contacts (id, user_id, display_name, is_imported, source) VALUES (?, ?, ?, 1, 'contacts_app')",
    );
    const addPhone = db.prepare(
      "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source) VALUES (?, ?, ?, ?, ?, 1, 'import')",
    );
    const addMessage = db.prepare(
      `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, participants_flat,
         thread_id, sent_at, metadata, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (let c = 0; c < CONTACTS; c++) {
        addContact.run(`c${c}`, USER, `Person ${c}`);
        addPhone.run(`p${c}`, `c${c}`, phoneFor(c), phoneFor(c), phoneFor(c).slice(-10));
      }
      // Backfill edge cases.
      addContact.run("c-short", USER, "Short Code"); // key shorter than 7: never matched
      addPhone.run("p-short", "c-short", "+55501", "55501", "55501");
      addContact.run("c-group-only", USER, "Group Only"); // appears only inside a group's comma list
      addPhone.run("p-group-only", "c-group-only", "+19985550150", "+19985550150", "9985550150");
      addContact.run("c-reaction-only", USER, "Reaction Only"); // only a tapback: no date
      addPhone.run("p-reaction-only", "c-reaction-only", "+19975550160", "+19975550160", "9975550160");
      addContact.run("c-silent", USER, "Never Texted"); // no messages at all
      addPhone.run("p-silent", "c-silent", "+19965550170", "+19965550170", "9965550170");

      const groupNames = ["Alex Rivera", "Jordan Lee", "Person 3", "Sam Okafor"];
      for (let i = 0; i < MESSAGES; i++) {
        const sentAt = new Date(1_600_000_000_000 + i * 60_000).toISOString();
        if (i % 50 === 0) {
          // Group inbound (rcsImportStore.participantsJson): from = the shown name.
          const name = groupNames[(i / 50) % groupNames.length];
          const members = [phoneFor(i % CONTACTS), "+19985550150"];
          addMessage.run(
            `m${i}`, USER, "sms", `g${i}`, "inbound", `group ${i}`,
            JSON.stringify({ from: name, to: ["me", ...members], chat_members: members }),
            members.join(","), `gmweb2-${i % 7}`, sentAt,
            JSON.stringify({ source: "gmweb-cache" }), null,
          );
          continue;
        }
        if (i % 97 === 0) {
          // A tapback from c-reaction-only's number: excluded everywhere.
          addMessage.run(
            `m${i}`, USER, "imessage", `g${i}`, "inbound", "Liked a message",
            JSON.stringify({ from: "+19975550160", to: ["me"] }), "19975550160", "ios-chat-r", sentAt,
            JSON.stringify({ source: "iphone_sync", originalId: i, dateRead: null, dateDelivered: null, attachmentCount: 0 }),
            2000,
          );
          continue;
        }
        // 1:1 (iPhoneSyncStorageService.storeMessages).
        const c = i % CONTACTS;
        const handle = phoneFor(c);
        const out = i % 2 === 0;
        addMessage.run(
          `m${i}`, USER, i % 4 === 1 ? "sms" : "imessage", `g${i}`, out ? "outbound" : "inbound", `body ${i}`,
          JSON.stringify({ from: out ? "me" : handle, to: out ? [handle] : ["me"] }),
          handle.replace(/\D/g, ""), `ios-chat-${c}`, sentAt,
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
  }, 600_000);

  beforeEach(() => {
    prepared = [];
    recording = false;
    resetCommunicationDatesBackfillForTests();
    main.prepare("UPDATE contacts SET last_inbound_at = NULL WHERE user_id = ?").run(USER);
  });

  afterAll(async () => {
    await shutdownPool();
    setContactWorkerPathForTests(null);
    main?.close();
    nodeFs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("coverage check: the per-source floors are read on the worker, same answer as the main-thread read", async () => {
    expect(isPoolReady()).toBe(true);
    setSourceFloorsWaitMsForTests(600_000); // follow-up: a slow read reports pending; here it must finish
    recording = true;
    const { value: result, maxMs } = await maxStallDuring(() => getAuditCoverage(USER, AUDIT_START));
    const worker = await getSourceCoverageAsync(USER);
    recording = false;
    expect(scansOnMain()).toEqual([]);

    // Main-thread control: the read this item moved, timed where it used to run.
    const { value: onMain, maxMs: mainMs } = await maxStallDuring(async () => getSourceCoverage(USER));
    expect(onMain.map((c) => c.source).sort()).toEqual(["google_messages", "iphone"]);
    expect(worker).toEqual(onMain);
    expect(result.success).toBe(true);
    setSourceFloorsWaitMsForTests(null);
    process.stderr.write(
      `[3837] coverage check over ${MESSAGES} msgs: maxEventLoopDelay=${maxMs}ms (main-thread control ${mainMs}ms) sources=${onMain.map((c) => c.source).join(",")}\n`,
    );
  }, 300_000);

  it("message-derived people: the worker read equals the main-thread read on a non-empty set, saved-name twin dropped", async () => {
    recording = true;
    const viaWorker = await getMessageDerivedContactsAsync(USER);
    recording = false;
    expect(scansOnMain()).toEqual([]);

    const { value: onMain, maxMs: mainMs } = await maxStallDuring(async () => getMessageDerivedContacts(USER));
    process.stderr.write(`[3837] message-derived over ${MESSAGES} msgs: main-thread control maxEventLoopDelay=${mainMs}ms\n`);
    const names = (rows: Array<{ display_name: string }>) => rows.map((r) => r.display_name).sort();
    expect(viaWorker).not.toBeNull(); // null = pending (BACKLOG-3837 follow-up: no main fallback)
    expect(names(viaWorker ?? [])).toEqual(["Alex Rivera", "Jordan Lee", "Sam Okafor"]);
    // "Person 3" is a saved contact with no crosswalk row: its name is all it is, so its twin is dropped.
    expect(viaWorker).toEqual(onMain);
  }, 300_000);

  it("contacts:get-all producer: the message-derived scan is not run on main either", async () => {
    recording = true;
    const all = await getImportedContactsByUserIdAsync(USER);
    recording = false;
    expect(scansOnMain()).toEqual([]);
    expect(all.filter((c) => c.is_message_derived).map((c) => c.display_name).sort()).toEqual([
      "Alex Rivera",
      "Jordan Lee",
      "Sam Okafor",
    ]);
  }, 300_000);

  (ORACLE ? it : it.skip)("the backfill plan matches the old LIKE join contact for contact", async () => {
    const reader = open(true);
    try {
      const oracle = new Map(
        (reader.prepare(OLD_BACKFILL_JOIN).all(USER, USER) as Array<{ contact_id: string; last_msg_date: string }>).map(
          (r) => [r.contact_id, r.last_msg_date],
        ),
      );
      const plan = new Map(planCommunicationDatesOn(reader, USER).map((r) => [r.contact_id, r.last_msg_date]));
      expect(plan).toEqual(oracle);
      expect(plan.size).toBe(CONTACTS + 1); // every numbered contact + c-group-only
      expect(plan.has("c-group-only")).toBe(true);
      expect(plan.has("c-short")).toBe(false);
      expect(plan.has("c-reaction-only")).toBe(false);
      expect(plan.has("c-silent")).toBe(false);
    } finally {
      reader.close();
    }
  }, 600_000);

  it("activity list: returns without waiting for the backfill; no scan on main; dates land once it finishes", async () => {
    recording = true;
    const { value: list, maxMs } = await maxStallDuring(() => getContactsSortedByActivity(USER, "1 Main St"));
    // The list's own background backfill: wait for its dates to land.
    const datedCount = (): number =>
      (
        main
          .prepare("SELECT COUNT(*) AS n FROM contacts WHERE user_id = ? AND last_inbound_at IS NOT NULL")
          .get(USER) as { n: number }
      ).n;
    for (let i = 0; i < 2400 && datedCount() < CONTACTS + 1; i++) await new Promise((r) => setTimeout(r, 50));
    recording = false;
    expect(scansOnMain()).toEqual([]);
    expect(prepared.some((s) => s.includes("participants_flat LIKE"))).toBe(false);

    expect(list.filter((c) => !c.is_message_derived)).toHaveLength(CONTACTS + 4);
    expect(datedCount()).toBe(CONTACTS + 1);
    process.stderr.write(
      `[3837] activity list over ${MESSAGES} msgs / ${CONTACTS} contacts: maxEventLoopDelay=${maxMs}ms (backfill on a dedicated worker)\n`,
    );
    // Every date is the one the old join computed.
    if (!ORACLE) return;
    const reader = open(true);
    try {
      const oracle = reader.prepare(OLD_BACKFILL_JOIN).all(USER, USER) as Array<{ contact_id: string; last_msg_date: string }>;
      const stored = new Map(
        (main.prepare("SELECT id, last_inbound_at FROM contacts WHERE user_id = ? AND last_inbound_at IS NOT NULL").all(USER) as Array<{
          id: string;
          last_inbound_at: string;
        }>).map((r) => [r.id, r.last_inbound_at]),
      );
      expect(stored).toEqual(new Map(oracle.map((r) => [r.contact_id, r.last_msg_date])));
    } finally {
      reader.close();
    }
  }, 600_000);

  it("the list does not await a backfill that never finishes, and two reads start one backfill", async () => {
    let release: (rows: unknown[]) => void = () => undefined;
    const spy = jest
      .spyOn(pool, "queryOnDedicatedWorker")
      .mockImplementation(() => new Promise<unknown[]>((resolve) => (release = resolve)));
    try {
      const both = Promise.all([
        getContactsSortedByActivity(USER, "1 Main St"),
        getContactsSortedByActivity(USER, "1 Main St"),
      ]);
      const settled = await Promise.race([
        both.then(() => "lists returned"),
        new Promise((r) => setTimeout(() => r("lists waited"), 20_000)),
      ]);
      expect(settled).toBe("lists returned");
      expect(spy.mock.calls.filter((c) => c[0] === "commDatesPlan")).toHaveLength(1);
      // A direct caller (the post-import path) while it runs shares the same run.
      const shared = [backfillContactCommunicationDates(USER), backfillContactCommunicationDates(USER)];
      expect(shared[0]).toBe(shared[1]);
      expect(spy.mock.calls.filter((c) => c[0] === "commDatesPlan")).toHaveLength(1);
    } finally {
      release([]);
      await backfillContactCommunicationDates(USER);
      spy.mockRestore();
    }
  }, 60_000);

  it("a failed or empty backfill is retried by a later list open (no once-per-session lock)", async () => {
    const planCalls = (spy: jest.SpyInstance): number => spy.mock.calls.filter((c) => c[0] === "commDatesPlan").length;
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    const spy = jest
      .spyOn(pool, "queryOnDedicatedWorker")
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "timeout" }))
      .mockResolvedValueOnce([]);
    try {
      await getContactsSortedByActivity(USER, "1 Main St");
      await settle();
      expect(planCalls(spy)).toBe(1); // first open: the worker times out
      await getContactsSortedByActivity(USER, "1 Main St");
      await settle();
      expect(planCalls(spy)).toBe(2); // retried; the run finds no texts yet (before the first sync)
      await getContactsSortedByActivity(USER, "1 Main St");
      await settle();
      expect(planCalls(spy)).toBe(3); // still undated -> still retried
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});
