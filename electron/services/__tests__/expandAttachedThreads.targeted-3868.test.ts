/**
 * @jest-environment node
 *
 * BACKLOG-3868: the attached-thread expansion no longer reads every text message of the
 * user on every run. Three modes (autoLinkService.expandAttachedThreadsForUserOnce):
 *   targeted     attached threads + the threads that can hold their contacts
 *   incremental  only new messages arrived: only the threads that grew
 *   skipped      nothing it depends on changed: no message row read
 *
 * GATES
 *  1. Equivalence: a seeded sequence of the writes that change what the expansion links
 *     (new messages, attach, delete, unlink, suppress, restore) is applied to TWO
 *     databases. After each step one runs the expansion as shipped, the other runs the
 *     pre-3868 algorithm (setFullIndexOracleForTests: identity of every text thread,
 *     every attached thread's siblings, no skip). Their links must be identical.
 *  2. Targeted: rows read ≪ total, a no-change run reads nothing, a post-sync run reads
 *     only the threads that grew.
 *
 * FIXTURE SHAPES are transcribed from the three producers of text `participants`:
 *   macOS   macOSMessagesImportService.ts:1631-1637
 *           { from: is_from_me ? (userAccountLogin || "me") : handle,
 *             to:   is_from_me ? [handle] : [userAccountLogin || "me"],
 *             ...(chatMembers.length > 1 ? { chat_members } : {}) }   thread: chat id
 *   iPhone  iPhoneSyncStorageService.ts:574-577
 *           { from: isFromMe ? "me" : handle, to: isFromMe ? [handle] : ["me"] }
 *           thread: `ios-chat-${chatId}`
 *   Android localSyncService.ts:1179-1182
 *           { from: inbound ? normalizedSender : "me", to: inbound ? ["me"] : [normalizedSender] }
 *           thread: `android-thread-${threadId}`
 * Handles vary the way real ones do: E.164, national formatting, bare digits, an email in
 * two letter cases, and an email with a non-ASCII letter (the rows SQLite cannot filter).
 * Reserved 555-01xx numbers and .test domains only (public repo).
 *
 * Real driver: ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <file>
 */
import path from "path";
import { monitorEventLoopDelay } from "perf_hooks";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../db/core/dbConnection";
import {
  expandAttachedThreadsForUser,
  readCandidateMessageThreads,
  resetExpansionWatermarksForTests,
  setFullIndexOracleForTests,
} from "../autoLinkService";
import * as contactWorkerPool from "../../workers/contactWorkerPool";
import { candidateMessageThreadsSql } from "../db/autoLinkSql";

const DRIVER = path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const D = require(DRIVER);
    new D(":memory:").close();
    return D;
  } catch (error) {
    process.stderr.write(`[3868] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

const USER = "user-3868";
const TXNS = ["txn-a", "txn-b", "txn-c"];

const SCHEMA = `
  CREATE TABLE transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, started_at DATETIME, status TEXT,
    message_count INTEGER DEFAULT 0, text_thread_count INTEGER DEFAULT 0);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel TEXT, direction TEXT, subject TEXT, body_text TEXT,
    body_html TEXT, participants TEXT, participants_flat TEXT, thread_id TEXT, sent_at DATETIME,
    received_at DATETIME, has_attachments INTEGER DEFAULT 0, duplicate_of TEXT, transaction_id TEXT,
    associated_message_type INTEGER, associated_message_guid TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX idx_messages_user_id ON messages(user_id);
  CREATE INDEX idx_messages_thread_id ON messages(thread_id);
  CREATE INDEX idx_messages_transaction_id ON messages(transaction_id);
  CREATE TABLE communications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, transaction_id TEXT, message_id TEXT, email_id TEXT,
    thread_id TEXT, link_source TEXT, link_confidence REAL, linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE UNIQUE INDEX idx_comm_msg_txn ON communications(message_id, transaction_id) WHERE message_id IS NOT NULL;
  CREATE INDEX idx_comm_user ON communications(user_id);
  CREATE TABLE ignored_communications (
    id TEXT PRIMARY KEY, user_id TEXT, transaction_id TEXT, email_subject TEXT, email_sender TEXT,
    email_sent_at DATETIME, email_thread_id TEXT, email_id TEXT, thread_id TEXT,
    original_communication_id TEXT, reason TEXT, ignored_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`;

function newDb(): DatabaseType {
  const db = new (Database as NonNullable<typeof Database>)(":memory:");
  db.exec(SCHEMA);
  for (const t of TXNS) {
    db.prepare("INSERT INTO transactions (id, user_id, started_at, status) VALUES (?, ?, '2026-01-01', 'active')").run(t, USER);
  }
  return db;
}

// ---- producers (shapes cited in the header) --------------------------------------------

type Producer = "macos" | "iphone" | "android";
interface Contact {
  /** the handle as each producer writes it */
  macos: string;
  iphone: string;
  android: string;
}
const CONTACTS: Contact[] = [
  // same person, three spellings of one number
  { macos: "+12065550103", iphone: "(206) 555-0103", android: "+12065550103" },
  { macos: "+13105550111", iphone: "3105550111", android: "+13105550111" },
  { macos: "Kate.Agent@Example.test", iphone: "kate.agent@example.test", android: "+14155550122" },
  { macos: "josé.lender@example.test", iphone: "JOSÉ.Lender@example.test", android: "+15035550133" },
  { macos: "+16175550144", iphone: "+1 617-555-0144", android: "+16175550144" },
  { macos: "+17185550155", iphone: "718.555.0155", android: "+17185550155" },
];
const USER_LOGIN = "+19995550100";

function participants(producer: Producer, inbound: boolean, handle: string, members?: string[]): string {
  if (producer === "macos") {
    return JSON.stringify({
      from: inbound ? handle : USER_LOGIN,
      to: inbound ? [USER_LOGIN] : [handle],
      ...(members && members.length > 1 ? { chat_members: members } : {}),
    });
  }
  return JSON.stringify({ from: inbound ? handle : "me", to: inbound ? ["me"] : [handle] });
}

// ---- seeded operations ---------------------------------------------------------------------

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

interface ThreadDef {
  id: string;
  producer: Producer;
  contacts: number[]; // >1 = group (macOS writes chat_members)
}

/** A world: thread definitions shared by both databases, and a message counter. */
function makeThreads(r: () => number): ThreadDef[] {
  const threads: ThreadDef[] = [];
  let n = 0;
  for (let c = 0; c < CONTACTS.length; c++) {
    // each contact: 1:1 threads under several internal ids (macOS multi chat_id), per producer
    threads.push({ id: `chat-${n++}`, producer: "macos", contacts: [c] });
    threads.push({ id: `chat-${n++}`, producer: "macos", contacts: [c] });
    threads.push({ id: `ios-chat-${n++}`, producer: "iphone", contacts: [c] });
    threads.push({ id: `android-thread-${n++}`, producer: "android", contacts: [c] });
  }
  // groups that contain contacts. macOS writes chat_members on every row of a group; the
  // iPhone and Android producers do not, so there a thread is a group only once a second
  // member has spoken — and deleting that member's messages makes it a 1:1 again.
  for (let g = 0; g < 6; g++) {
    const a = Math.floor(r() * CONTACTS.length);
    const b = (a + 1 + Math.floor(r() * (CONTACTS.length - 1))) % CONTACTS.length;
    const producer: Producer = g < 2 ? "macos" : g < 4 ? "iphone" : "android";
    const id = producer === "macos" ? `chat-g${g}` : producer === "iphone" ? `ios-chat-g${g}` : `android-thread-g${g}`;
    threads.push({ id, producer, contacts: [a, b] });
  }
  return threads;
}

type Op =
  | { k: "insert"; id: string; thread: ThreadDef; inbound: boolean; reaction: boolean; speaker: number }
  | { k: "attach"; pick: number; txn: string }
  | { k: "delete"; pick: number }
  | { k: "unlink"; pick: number }
  | { k: "suppress"; pick: number; txn: string }
  | { k: "restore"; pick: number };

function applyOp(db: DatabaseType, op: Op): void {
  switch (op.k) {
    case "insert": {
      const t = op.thread;
      const members = t.contacts.map((c) => CONTACTS[c][t.producer]);
      // in a group the speaker is one of the members
      const handle = members[op.speaker % members.length];
      db.prepare(
        `INSERT INTO messages (id, user_id, channel, direction, participants, thread_id, sent_at,
           associated_message_type, associated_message_guid) VALUES (?, ?, ?, ?, ?, ?, '2025-01-01', ?, ?)`,
      ).run(
        op.id,
        USER,
        t.producer === "iphone" ? "imessage" : "sms",
        op.inbound ? "inbound" : "outbound",
        participants(t.producer, op.inbound, handle, t.producer === "macos" ? members : undefined),
        t.id,
        op.reaction ? 2000 : null,
        op.reaction ? "guid-x" : null,
      );
      return;
    }
    case "attach": {
      const rows = db.prepare("SELECT id FROM messages WHERE transaction_id IS NULL ORDER BY id").all() as Array<{ id: string }>;
      if (rows.length === 0) return;
      const id = rows[op.pick % rows.length].id;
      db.prepare("UPDATE messages SET transaction_id = ? WHERE id = ?").run(op.txn, id);
      db.prepare(
        "INSERT OR IGNORE INTO communications (id, user_id, transaction_id, message_id, link_source, link_confidence) VALUES (?, ?, ?, ?, 'manual', 1)",
      ).run(`c-${id}-${op.txn}`, USER, op.txn, id);
      return;
    }
    case "delete": {
      const rows = db.prepare("SELECT id FROM messages ORDER BY id").all() as Array<{ id: string }>;
      if (rows.length === 0) return;
      const id = rows[op.pick % rows.length].id;
      db.prepare("DELETE FROM communications WHERE message_id = ?").run(id);
      db.prepare("DELETE FROM messages WHERE id = ?").run(id);
      return;
    }
    case "unlink": {
      // transactionService.unlinkMessages without its suppression row: the case where a
      // message becomes a candidate again with nothing else changing.
      const rows = db.prepare("SELECT id FROM messages WHERE transaction_id IS NOT NULL ORDER BY id").all() as Array<{ id: string }>;
      if (rows.length === 0) return;
      const id = rows[op.pick % rows.length].id;
      db.prepare("DELETE FROM communications WHERE message_id = ?").run(id);
      db.prepare("UPDATE messages SET transaction_id = NULL WHERE id = ?").run(id);
      return;
    }
    case "suppress": {
      const rows = db.prepare("SELECT DISTINCT thread_id FROM messages ORDER BY thread_id").all() as Array<{ thread_id: string }>;
      if (rows.length === 0) return;
      const tid = rows[op.pick % rows.length].thread_id;
      db.prepare("INSERT OR IGNORE INTO ignored_communications (id, user_id, transaction_id, thread_id) VALUES (?, ?, ?, ?)").run(
        `ig-${op.txn}-${tid}`,
        USER,
        op.txn,
        tid,
      );
      return;
    }
    case "restore": {
      const rows = db.prepare("SELECT id FROM ignored_communications ORDER BY id").all() as Array<{ id: string }>;
      if (rows.length === 0) return;
      db.prepare("DELETE FROM ignored_communications WHERE id = ?").run(rows[op.pick % rows.length].id);
      return;
    }
  }
}

function makeOps(seed: number, steps: number): { threads: ThreadDef[]; batches: Op[][] } {
  const r = rng(seed);
  const threads = makeThreads(r);
  let msg = 0;
  const insert = (): Op => ({
    k: "insert",
    id: `m${String(msg++).padStart(5, "0")}`,
    thread: threads[Math.floor(r() * threads.length)],
    inbound: r() < 0.5,
    reaction: r() < 0.05,
    // mostly the first member, so a group thread is often a 1:1 until the other speaks
    speaker: r() < 0.8 ? 0 : 1,
  });
  const batches: Op[][] = [];
  // initial history and a few attaches
  const first: Op[] = [];
  for (let i = 0; i < 150; i++) first.push(insert());
  for (let i = 0; i < 4; i++) first.push({ k: "attach", pick: Math.floor(r() * 1e6), txn: TXNS[i % TXNS.length] });
  batches.push(first);
  for (let s = 0; s < steps; s++) {
    const batch: Op[] = [];
    const roll = r();
    if (roll < 0.45) {
      // a sync: only new messages (the incremental path)
      const n = 1 + Math.floor(r() * 6);
      for (let i = 0; i < n; i++) batch.push(insert());
    } else if (roll < 0.6) {
      batch.push({ k: "attach", pick: Math.floor(r() * 1e6), txn: TXNS[Math.floor(r() * TXNS.length)] });
    } else if (roll < 0.7) {
      batch.push({ k: "delete", pick: Math.floor(r() * 1e6) });
    } else if (roll < 0.78) {
      batch.push({ k: "unlink", pick: Math.floor(r() * 1e6) });
    } else if (roll < 0.86) {
      batch.push({ k: "suppress", pick: Math.floor(r() * 1e6), txn: TXNS[Math.floor(r() * TXNS.length)] });
    } else if (roll < 0.92) {
      batch.push({ k: "restore", pick: Math.floor(r() * 1e6) });
    }
    // else: nothing happens (the skip path)
    batches.push(batch);
  }
  return { threads, batches };
}

function links(db: DatabaseType): string[] {
  const comm = db
    .prepare("SELECT message_id || '>' || transaction_id AS k FROM communications WHERE message_id IS NOT NULL ORDER BY k")
    .all() as Array<{ k: string }>;
  const ptr = db
    .prepare("SELECT id || '=' || COALESCE(transaction_id, '-') AS k FROM messages ORDER BY id")
    .all() as Array<{ k: string }>;
  return [...comm.map((r) => `c:${r.k}`), ...ptr.map((r) => `m:${r.k}`)];
}

maybe("attached-thread expansion, targeted (BACKLOG-3868)", () => {
  afterEach(() => {
    setFullIndexOracleForTests(false);
    resetExpansionWatermarksForTests();
  });

  async function runShipped(db: DatabaseType) {
    setDb(db);
    setFullIndexOracleForTests(false);
    return expandAttachedThreadsForUser(USER);
  }
  async function runOracle(db: DatabaseType) {
    setDb(db);
    setFullIndexOracleForTests(true);
    try {
      return await expandAttachedThreadsForUser(USER);
    } finally {
      setFullIndexOracleForTests(false);
    }
  }

  it.each([1, 7, 42, 3868, 90210])("seed %i: same links as the full-index algorithm after every step", async (seed) => {
    resetExpansionWatermarksForTests();
    const shipped = newDb();
    const oracle = newDb();
    const { batches } = makeOps(seed, 60);
    const modes: Record<string, number> = {};
    const linkedByMode: Record<string, number> = {};
    let linkedTotal = 0;
    for (let step = 0; step < batches.length; step++) {
      for (const op of batches[step]) {
        applyOp(shipped, op);
        applyOp(oracle, op);
      }
      const a = await runShipped(shipped);
      const b = await runOracle(oracle);
      modes[a.mode ?? "?"] = (modes[a.mode ?? "?"] ?? 0) + 1;
      linkedTotal += b.messagesLinked;
      linkedByMode[a.mode ?? "?"] = (linkedByMode[a.mode ?? "?"] ?? 0) + a.messagesLinked;
      expect({ step, links: links(shipped) }).toEqual({ step, links: links(oracle) });
      expect({ step, linked: a.messagesLinked }).toEqual({ step, linked: b.messagesLinked });
    }
    process.stderr.write(
      `[3868] seed ${seed}: runs by mode ${JSON.stringify(modes)} links by mode ${JSON.stringify(linkedByMode)} oracle links ${linkedTotal}\n`,
    );
    // The sequence exercised every mode and actually linked things.
    expect(modes.skipped ?? 0).toBeGreaterThan(0);
    expect(modes.incremental ?? 0).toBeGreaterThan(0);
    expect(modes.targeted ?? 0).toBeGreaterThan(0);
    expect(linkedTotal).toBeGreaterThan(0);
    // ...and the incremental path itself linked messages (not only no-op runs).
    expect(linkedByMode.incremental ?? 0).toBeGreaterThan(0);
    shipped.close();
    oracle.close();
  });

  // Each write the change check must see, on its own, in the shape that makes it matter.
  describe("each tracked change, alone", () => {
    const A = CONTACTS[0];
    const B = CONTACTS[1];
    function ins(db: DatabaseType, id: string, thread: string, producer: Producer, handle: string, inbound = true): void {
      // a plain INSERT, like a sync: no UPDATE that the change check would also count
      db.prepare(
        "INSERT INTO messages (id, user_id, channel, direction, participants, thread_id, sent_at) VALUES (?, ?, 'imessage', ?, ?, ?, '2025-01-01')",
      ).run(id, USER, inbound ? "inbound" : "outbound", participants(producer, inbound, handle), thread);
    }
    function attach(db: DatabaseType, id: string, txn: string): void {
      db.prepare("UPDATE messages SET transaction_id = ? WHERE id = ?").run(txn, id);
      db.prepare(
        "INSERT INTO communications (id, user_id, transaction_id, message_id, link_source, link_confidence) VALUES (?, ?, ?, ?, 'manual', 1)",
      ).run(`c-${id}`, USER, txn, id);
    }
    async function bothAfter(dbs: DatabaseType[], step: (db: DatabaseType) => void): Promise<string[][]> {
      for (const db of dbs) step(db);
      await runShipped(dbs[0]);
      await runOracle(dbs[1]);
      return [links(dbs[0]), links(dbs[1])];
    }

    it("a deleted message that turns a group back into a 1:1 makes its thread a candidate", async () => {
      const dbs = [newDb(), newDb()];
      const [shippedLinks, oracleLinks] = await bothAfter(dbs, (db) => {
        ins(db, "a1", "ios-chat-1", "iphone", A.iphone);
        attach(db, "a1", "txn-a");
        // ios-chat-2: A and B have both spoken -> a group, not a candidate
        ins(db, "g1", "ios-chat-2", "iphone", A.iphone);
        ins(db, "g2", "ios-chat-2", "iphone", B.iphone);
      });
      expect(shippedLinks).toEqual(oracleLinks);
      const [after, expected] = await bothAfter(dbs, (db) => {
        db.prepare("DELETE FROM messages WHERE id = 'g2'").run();
      });
      expect(after).toEqual(expected);
      expect(after).toContain("c:g1>txn-a");
    });

    it("a cross-linked thread that later becomes a group still gets its new messages (it is attached now)", async () => {
      const dbs = [newDb(), newDb()];
      await bothAfter(dbs, (db) => {
        ins(db, "a1", "ios-chat-1", "iphone", A.iphone);
        attach(db, "a1", "txn-a");
        ins(db, "x1", "ios-chat-9", "iphone", A.iphone); // cross-linked by the first run
      });
      const [after, expected] = await bothAfter(dbs, (db) => {
        ins(db, "x2", "ios-chat-9", "iphone", B.iphone); // B speaks: now a group
      });
      expect(after).toEqual(expected);
      expect(after).toContain("c:x2>txn-a");
    });

    it("an unlinked message (no suppression) is linked again", async () => {
      const dbs = [newDb(), newDb()];
      await bothAfter(dbs, (db) => {
        ins(db, "a1", "ios-chat-1", "iphone", A.iphone);
        ins(db, "a2", "ios-chat-1", "iphone", A.iphone);
        attach(db, "a1", "txn-a");
      });
      const [after, expected] = await bothAfter(dbs, (db) => {
        db.prepare("DELETE FROM communications WHERE message_id = 'a2'").run();
        db.prepare("UPDATE messages SET transaction_id = NULL WHERE id = 'a2'").run();
      });
      expect(after).toEqual(expected);
      expect(after).toContain("c:a2>txn-a");
    });

    it("a restored suppression is honoured on the next run", async () => {
      const dbs = [newDb(), newDb()];
      await bothAfter(dbs, (db) => {
        ins(db, "a1", "ios-chat-1", "iphone", A.iphone);
        attach(db, "a1", "txn-a");
        ins(db, "x1", "ios-chat-9", "iphone", A.iphone);
        db.prepare("INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id) VALUES ('ig1', ?, 'txn-a', 'ios-chat-9')").run(USER);
      });
      const [after, expected] = await bothAfter(dbs, (db) => {
        db.prepare("DELETE FROM ignored_communications WHERE id = 'ig1'").run();
      });
      expect(after).toEqual(expected);
      expect(after).toContain("c:x1>txn-a");
    });

    it("a new attach is expanded on the next run", async () => {
      const dbs = [newDb(), newDb()];
      await bothAfter(dbs, (db) => {
        ins(db, "a1", "ios-chat-1", "iphone", A.iphone);
        ins(db, "a2", "ios-chat-1", "iphone", A.iphone);
        ins(db, "b1", "ios-chat-5", "iphone", B.iphone);
        ins(db, "b2", "ios-chat-5", "iphone", B.iphone);
        attach(db, "a1", "txn-a");
      });
      const [after, expected] = await bothAfter(dbs, (db) => attach(db, "b1", "txn-b"));
      expect(after).toEqual(expected);
      expect(after).toContain("c:b2>txn-b");
    });
  });

  describe("reads only what it needs (large fixture)", () => {
    const THREADS = 800;
    const PER_THREAD = 50; // 40,000 text messages
    let db: DatabaseType;
    let total = 0;

    function seedLarge(): void {
      db = newDb();
      const ins = db.prepare(
        "INSERT INTO messages (id, user_id, channel, direction, participants, thread_id, sent_at) VALUES (?, ?, 'imessage', ?, ?, ?, '2025-01-01')",
      );
      db.transaction(() => {
        for (let t = 0; t < THREADS; t++) {
          // reserved 555-01xx numbers: area code varies per hundred threads
          const phone = `+1${200 + Math.floor(t / 100)}5550${100 + (t % 100)}`;
          for (let i = 0; i < PER_THREAD; i++) {
            const inbound = i % 2 === 0;
            ins.run(`L${t}-${i}`, USER, inbound ? "inbound" : "outbound", participants("macos", inbound, phone), `T${t}`);
          }
        }
        // a second, unattached 1:1 thread for the contact of T0 (cross-thread backfill)
        const phone0 = "+12005550100";
        for (let i = 0; i < 5; i++) ins.run(`X${i}`, USER, "inbound", participants("macos", true, phone0), "T0-other");
      })();
      total = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
      // attach one message of T0 and one of T1 to a deal
      for (const [mid, txn] of [["L0-0", "txn-a"], ["L1-0", "txn-b"]]) {
        db.prepare("UPDATE messages SET transaction_id = ? WHERE id = ?").run(txn, mid);
        db.prepare(
          "INSERT INTO communications (id, user_id, transaction_id, message_id, link_source, link_confidence) VALUES (?, ?, ?, ?, 'manual', 1)",
        ).run(`c-${mid}`, USER, txn, mid);
      }
      setDb(db);
    }

    function spyMessageReads(): { texts: string[] } {
      const seen = { texts: [] as string[] };
      const real = db.prepare.bind(db);
      jest.spyOn(db, "prepare").mockImplementation(((text: string) => {
        seen.texts.push(text);
        return real(text);
      }) as typeof db.prepare);
      return seen;
    }

    async function stallDuring<T>(work: () => Promise<T>): Promise<{ value: T; maxMs: number }> {
      const h = monitorEventLoopDelay({ resolution: 10 });
      h.enable();
      await new Promise((r) => setTimeout(r, 30));
      const value = await work();
      await new Promise((r) => setTimeout(r, 30));
      h.disable();
      return { value, maxMs: Math.round(h.max / 1e6) };
    }

    beforeEach(() => {
      resetExpansionWatermarksForTests();
      seedLarge();
    });
    afterEach(() => {
      jest.restoreAllMocks();
      db.close();
    });

    it("first run is targeted: links the same as the full algorithm and reads a small fraction of the rows", async () => {
      const first = await stallDuring(() => expandAttachedThreadsForUser(USER));
      const res = first.value;
      expect(res.mode).toBe("targeted");
      // 49 siblings in T0 + 49 in T1 + 5 cross-thread rows of T0's contact
      expect(res.messagesLinked).toBe(49 + 49 + 5);
      // T0, T1 (50 rows each), the superset thread ids (T0, T1, T0-other), T0-other (5 rows)
      expect(res.messageRowsRead).toBe(50 + 50 + 3 + 5);
      expect(res.messageRowsRead).toBeLessThan(total / 100);
      process.stderr.write(
        `[3868] targeted first run: rowsRead=${res.messageRowsRead} of ${total} durationMs=${res.durationMs} maxStallMs=${first.maxMs}\n`,
      );
    });

    it("a run with nothing changed reads no message row", async () => {
      await expandAttachedThreadsForUser(USER);
      const seen = spyMessageReads();
      const again = await stallDuring(() => expandAttachedThreadsForUser(USER));
      const res = again.value;
      expect(seen.texts.length).toBeGreaterThan(0); // the spy is live
      expect(res.mode).toBe("skipped");
      expect(res.messageRowsRead).toBe(0);
      expect(res.messagesLinked).toBe(0);
      // Only the change check ran: the counters and MAX(rowid). No participants read, no pairs read.
      expect(seen.texts.filter((t) => /participants|FROM communications c/.test(t))).toEqual([]);
      process.stderr.write(`[3868] skipped run: durationMs=${res.durationMs} maxStallMs=${again.maxMs}\n`);
    });

    it("after a sync, only the threads that received messages are read", async () => {
      await expandAttachedThreadsForUser(USER);
      // a sync stores 3 messages: one in attached T0, two in unattached T500
      const ins = db.prepare(
        "INSERT INTO messages (id, user_id, channel, direction, participants, thread_id, sent_at) VALUES (?, ?, 'imessage', 'inbound', ?, ?, '2026-01-01')",
      );
      ins.run("N1", USER, participants("macos", true, "+12005550100"), "T0");
      ins.run("N2", USER, participants("macos", true, "+12055550100"), "T500");
      ins.run("N3", USER, participants("macos", true, "+12055550100"), "T500");
      const after = await stallDuring(() => expandAttachedThreadsForUser(USER));
      const res = after.value;
      expect(res.mode).toBe("incremental");
      expect(res.messagesLinked).toBe(1); // N1 joins T0's deal; T500 is someone else
      // 2 thread ids (T0, T500) + all rows of those two threads (51 + 52)
      expect(res.messageRowsRead).toBe(2 + 51 + 52);
      const linked = db.prepare("SELECT id FROM messages WHERE transaction_id = 'txn-a' ORDER BY id").all() as Array<{ id: string }>;
      expect(linked.map((r) => r.id)).toContain("N1");
      process.stderr.write(
        `[3868] incremental run: rowsRead=${res.messageRowsRead} of ${total + 3} durationMs=${res.durationMs} maxStallMs=${after.maxMs}\n`,
      );
    });
  });

  // BACKLOG-3868 (create freeze): the auto-link candidate read scans every text of the user
  // in the deal's window (participants_flat LIKE '%digits%' has no index). It now runs on a
  // dedicated worker; the main thread only when no worker could start.
  describe("auto-link candidate read off the main thread", () => {
    let db: DatabaseType;
    const params = [USER, "txn-a", "txn-a", "txn-a", "%2065550103%", "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z"];
    beforeEach(() => {
      db = newDb();
      for (let i = 0; i < 4; i++) {
        db.prepare(
          "INSERT INTO messages (id, user_id, channel, direction, participants, participants_flat, thread_id, sent_at) VALUES (?, ?, 'sms', 'inbound', ?, ?, ?, '2025-01-01')",
        ).run(`c${i}`, USER, participants("android", true, "+12065550103"), "12065550103", `android-thread-${i % 2}`);
      }
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
    const isCandidateSql = (t: string) => /GROUP BY m\.thread_id/.test(t);

    it("pool up: the read runs on a dedicated worker with the same statement inputs; the main connection never runs it", async () => {
      const expected = db.prepare(candidateMessageThreadsSql(1)).all(...params);
      expect(expected).toHaveLength(2);
      jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(true);
      const query = jest.spyOn(contactWorkerPool, "queryOnDedicatedWorker").mockImplementation(async (_t, _u, _ms, extras) => {
        const e = extras as { phoneCount: number; params: unknown[] };
        // the worker runs the statement against its own connection; here: the same rows
        return db.prepare(candidateMessageThreadsSql(e.phoneCount)).all(...e.params);
      });
      const texts = spyPrepare();
      const rows = await readCandidateMessageThreads(USER, 1, params);
      expect(query).toHaveBeenCalledWith("candidateMessageThreads", USER, expect.any(Number), { phoneCount: 1, params });
      expect(rows).toEqual(expected);
      // the only prepare on the main connection was the mock's own stand-in
      expect(texts.filter(isCandidateSql)).toHaveLength(1);
    });

    it("worker could not start: the main thread reads, same rows", async () => {
      const expected = db.prepare(candidateMessageThreadsSql(1)).all(...params);
      jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(true);
      jest
        .spyOn(contactWorkerPool, "queryOnDedicatedWorker")
        .mockRejectedValue(new contactWorkerPool.DedicatedWorkerError("cannot start", "start_failed"));
      expect(await readCandidateMessageThreads(USER, 1, params)).toEqual(expected);
    });

    it.each(["timeout", "stopped", "failed", "unavailable"] as const)("worker %s: throws, no main-thread scan", async (code) => {
      jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(true);
      jest.spyOn(contactWorkerPool, "queryOnDedicatedWorker").mockRejectedValue(new contactWorkerPool.DedicatedWorkerError(code, code));
      const texts = spyPrepare();
      await expect(readCandidateMessageThreads(USER, 1, params)).rejects.toMatchObject({ code });
      expect(texts.filter(isCandidateSql)).toEqual([]);
    });
  });
});
