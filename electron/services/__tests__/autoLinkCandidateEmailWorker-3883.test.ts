/**
 * @jest-environment node
 *
 * BACKLOG-3883 — one contact's auto-link held the main process for seconds on the
 * founder's PC (~668k texts). BACKLOG-3868 moved the candidate-THREAD read to a dedicated
 * contact query worker; the candidate-EMAIL read (every email of the user in the deal's
 * window, joined to its participants, bodies included) still ran on the main thread, and
 * the classify/link loop over those bodies never gave the event loop a turn.
 *
 * Part A — dispatch: with the pool up the email read goes to a dedicated worker with the
 * same statement inputs, and the main connection never runs it; `start_failed` reads on
 * the main thread; any other worker failure is a failed run, not a main-thread rescan.
 *
 * Part B — a large on-disk store, the dedicated worker played by a REAL worker thread
 * on its own connection. Asserted deterministically (BACKLOG-3915): neither candidate
 * statement is prepared on the main connection, and the email loops yield at their
 * sites. monitorEventLoopDelay's max is printed for information only — a tail max on a
 * shared runner is not a pass/fail signal. Size: KEEPR_3883_TEXTS / KEEPR_3883_EMAILS.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --runTestsByPath <this file>
 * Reserved 555-01xx numbers, .test addresses, invented ids.
 */
import path from "path";
import os from "os";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { monitorEventLoopDelay } from "perf_hooks";
import { Worker } from "worker_threads";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../db/core/dbConnection";
import * as contactWorkerPool from "../../workers/contactWorkerPool";
import { candidateEmailsSql, candidateMessageThreadsSql } from "../db/autoLinkSql";
import { AUTO_LINK_EMAILS_PER_TURN, autoLinkCommunicationsForContact, readCandidateEmails } from "../autoLinkService";

const DRIVER = path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
function loadDriver(): (new (file: string, opts?: object) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const D = require(DRIVER);
    new D(":memory:").close();
    return D;
  } catch (error) {
    process.stderr.write(`[3883] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}
/**
 * BACKLOG-3915: the full stack of the current call. tests/setup.js sets
 * Error.stackTraceLimit = 3 when CI is set, which cuts the stack inside jest-mock's
 * own frames, before the service frame — every yield then counts as 0. Raise the
 * limit for this one capture only.
 */
function fullStack(): string {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  try {
    return new Error().stack ?? "";
  } finally {
    Error.stackTraceLimit = limit;
  }
}
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

const USER = "38830000-0000-4000-8000-0000000000cc"; // pii-allow-uuid: invented, not from any live row
const TXN = "38830000-0000-4000-8000-0000000000dd"; // pii-allow-uuid: invented, not from any live row
const PHONE = "+12065550142";
const ADDRESS = "party@example.test";
const TEXTS = Number(process.env.KEEPR_3883_TEXTS || 150_000);
const EMAILS = Number(process.env.KEEPR_3883_EMAILS || 30_000);
const PARTY_EMAILS = 60;

function seed(db: DatabaseType): void {
  db.exec(readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8"));
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o')").run(USER);
  db.prepare("INSERT INTO transactions (id, user_id, property_address, status, started_at) VALUES (?, ?, '12 Probe Lane, Testville, WA 98000', 'active', '2024-01-01T00:00:00Z')").run(TXN, USER);
  db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES ('c1', ?, 'Party', 'manual')").run(USER);
  db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES ('cp1', 'c1', ?, ?)").run(PHONE, PHONE.replace(/\D/g, ""));
  db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES ('ce1', 'c1', ?)").run(ADDRESS);
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES ('tc1', ?, 'c1')").run(TXN);
  const insMsg = db.prepare(
    `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type, body_text)
     VALUES (?, ?, ?, 'imessage', 'inbound', '{}', ?, ?, ?, 'text', 'lorem ipsum dolor')`,
  );
  const insEmail = db.prepare("INSERT INTO emails (id, user_id, subject, body_plain, sent_at) VALUES (?, ?, ?, ?, ?)");
  const insEp = db.prepare("INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, 'from', 0, ?, ?)");
  const at = (i: number): string => new Date(Date.parse("2024-02-01T00:00:00Z") + (i % 4000) * 3_600_000).toISOString();
  const bigBody = "Following up on the paperwork and the schedule for next week. ".repeat(800); // ~50 KB
  db.transaction(() => {
    for (let i = 0; i < TEXTS; i++) {
      const party = i % 500 === 0;
      const flat = party ? "12065550142,19995550100" : `1425555${String(i % 9000).padStart(4, "0")},19995550100`;
      insMsg.run(`m${i}`, USER, `g${i}`, flat, party ? `chat-party-${i % 7}` : `chat-${i % 9000}`, at(i));
    }
    for (let i = 0; i < EMAILS; i++) {
      const party = i < PARTY_EMAILS;
      insEmail.run(`e${i}`, USER, `Subject ${i}`, party ? bigBody : "short body", at(i));
      insEp.run(`e${i}`, `h${i}`, party ? ADDRESS : `other${i % 3000}@example.test`);
    }
  })();
}

maybe("BACKLOG-3883 — the candidate-email read runs off the main thread", () => {
  describe("A: dispatch", () => {
    let db: DatabaseType;
    const params = [TXN, ADDRESS, USER, "2024-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"];
    beforeEach(() => {
      db = new (Database as NonNullable<typeof Database>)(":memory:");
      db.exec(readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8"));
      db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o')").run(USER);
      db.prepare("INSERT INTO emails (id, user_id, subject, body_plain, sent_at) VALUES ('e1', ?, 's', 'b', '2025-01-01T00:00:00Z')").run(USER);
      db.prepare("INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES ('e1', 'from', 0, 'h', ?)").run(ADDRESS);
      setDb(db);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      db.close();
    });
    function spyPrepare(): string[] {
      const texts: string[] = [];
      const real = db.prepare.bind(db);
      jest.spyOn(db, "prepare").mockImplementation(((t: string) => {
        texts.push(t);
        return real(t);
      }) as typeof db.prepare);
      return texts;
    }
    const isEmailSql = (t: string): boolean => /FROM email_participants ep/.test(t);

    it("pool up: the worker runs it with the same inputs; the main connection never does", async () => {
      const expected = db.prepare(candidateEmailsSql(1)).all(...params);
      expect(expected).toHaveLength(1);
      jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(true);
      const query = jest.spyOn(contactWorkerPool, "queryOnDedicatedWorker").mockResolvedValue(expected as unknown[]);
      const texts = spyPrepare();
      expect(await readCandidateEmails(USER, 1, params)).toEqual(expected);
      expect(query).toHaveBeenCalledWith("candidateEmails", USER, expect.any(Number), { addressCount: 1, params });
      expect(texts.filter(isEmailSql)).toEqual([]);
    });

    it("worker could not start: the main thread reads, same rows", async () => {
      const expected = db.prepare(candidateEmailsSql(1)).all(...params);
      jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(true);
      jest.spyOn(contactWorkerPool, "queryOnDedicatedWorker").mockRejectedValue(new contactWorkerPool.DedicatedWorkerError("x", "start_failed"));
      expect(await readCandidateEmails(USER, 1, params)).toEqual(expected);
    });

    it.each(["timeout", "stopped", "failed", "unavailable"] as const)("worker %s: throws, no main-thread scan", async (code) => {
      jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(true);
      jest.spyOn(contactWorkerPool, "queryOnDedicatedWorker").mockRejectedValue(new contactWorkerPool.DedicatedWorkerError(code, code));
      const texts = spyPrepare();
      await expect(readCandidateEmails(USER, 1, params)).rejects.toMatchObject({ code });
      expect(texts.filter(isEmailSql)).toEqual([]);
    });
  });

  describe("B: large store, no long main-thread block", () => {
    let dir: string;
    let db: DatabaseType;
    let worker: Worker;
    let seq = 0;
    const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();

    beforeAll(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), "keepr-3883-"));
      const file = path.join(dir, "mad.db");
      db = new (Database as NonNullable<typeof Database>)(file);
      db.pragma("journal_mode = WAL");
      seed(db);
      setDb(db);
      // A REAL thread with its own read-only connection plays the dedicated worker.
      worker = new Worker(
        `const { parentPort, workerData } = require("worker_threads");
         const D = require(workerData.driver);
         const db = new D(workerData.file, { readonly: true });
         parentPort.on("message", (m) => {
           try { parentPort.postMessage({ id: m.id, rows: db.prepare(m.sql).all(...m.params) }); }
           catch (e) { parentPort.postMessage({ id: m.id, error: String(e) }); }
         });`,
        { eval: true, workerData: { driver: DRIVER, file } },
      );
      worker.on("message", (m: { id: number; rows?: unknown[]; error?: string }) => {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p?.reject(new Error(m.error));
        else p?.resolve(m.rows ?? []);
      });
    }, 300_000);
    afterAll(async () => {
      await worker?.terminate();
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    });
    afterEach(() => jest.restoreAllMocks());

    function routeDedicatedQueriesToTheThread(): jest.SpyInstance {
      return jest.spyOn(contactWorkerPool, "queryOnDedicatedWorker").mockImplementation(async (type, _u, _ms, extras) => {
        const e = extras as { addressCount?: number; phoneCount?: number; params: unknown[] };
        const text = type === "candidateEmails" ? candidateEmailsSql(e.addressCount as number) : candidateMessageThreadsSql(e.phoneCount as number);
        const id = ++seq;
        return new Promise<unknown[]>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, sql: String(text), params: e.params });
        });
      });
    }

    async function maxMainBlockMs(run: () => Promise<unknown>): Promise<number> {
      const h = monitorEventLoopDelay({ resolution: 5 });
      h.enable();
      await run();
      h.disable();
      return h.max / 1e6;
    }

    /**
     * BACKLOG-3915: this used to compare the MAX of the event-loop delay with one
     * timing of the two reads on the main thread. A tail statistic on a shared CI
     * runner spiked on GC / de-scheduling while the reads timed normally, and the
     * bound caught neither a read routed back to main (the worker-call check did)
     * nor a removed yield (60 bodies block for less than the bound). It now
     * asserts the two mechanisms directly, deterministically:
     *  - neither candidate statement is prepared on the main connection;
     *  - the email classify and link loops give the event loop a turn every
     *    AUTO_LINK_EMAILS_PER_TURN emails (counted at the yield sites).
     * The event-loop max is still printed, as information only.
     */
    it("one contact's auto-link: correct result, candidate reads never on the main connection, email loops yield", async () => {
      const candidateSql = new Set([String(candidateEmailsSql(1)), String(candidateMessageThreadsSql(1))]);
      const mainTexts: string[] = [];
      const realPrepare = db.prepare.bind(db);
      jest.spyOn(db, "prepare").mockImplementation(((t: string) => {
        mainTexts.push(String(t));
        return realPrepare(t);
      }) as typeof db.prepare);
      // Yields counted where they happen: setImmediate calls made from autoLinkService.
      let serviceYields = 0;
      const realSetImmediate = global.setImmediate;
      jest.spyOn(global, "setImmediate").mockImplementation(((fn: (...a: unknown[]) => void, ...a: unknown[]) => {
        if (/autoLinkService\.ts/.test(fullStack())) serviceYields++;
        return realSetImmediate(fn, ...a);
      }) as typeof setImmediate);

      jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(true);
      const query = routeDedicatedQueriesToTheThread();
      let result: Awaited<ReturnType<typeof autoLinkCommunicationsForContact>> | undefined;
      const blockMs = await maxMainBlockMs(async () => {
        result = await autoLinkCommunicationsForContact({ contactId: "c1", transactionId: TXN, queueAmbiguousInsteadOfLinking: true });
      });
      process.stderr.write(`[3883] texts=${TEXTS} emails=${EMAILS} service-yields=${serviceYields} max-main-block=${blockMs.toFixed(0)}ms (info only)\n`);

      expect(query.mock.calls.map((c) => c[0]).sort()).toEqual(["candidateEmails", "candidateMessageThreads"]);
      expect(result).toMatchObject({ messagesLinked: 7, queuedForReview: PARTY_EMAILS, errors: 0 });
      expect(mainTexts.filter((t) => candidateSql.has(t))).toEqual([]);
      // Classify loop yields at i = 10, 20, … (< PARTY_EMAILS); link loop after every
      // AUTO_LINK_EMAILS_PER_TURN handled. Measured 12 with the one thread-loop yield;
      // removing either email site drops it to 7 or 6.
      const emailYields =
        Math.floor((PARTY_EMAILS - 1) / AUTO_LINK_EMAILS_PER_TURN) + Math.floor(PARTY_EMAILS / AUTO_LINK_EMAILS_PER_TURN);
      expect(serviceYields).toBeGreaterThanOrEqual(emailYields);
    }, 300_000);
  });
});
