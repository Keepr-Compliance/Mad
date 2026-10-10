/**
 * @jest-environment node
 *
 * BACKLOG-3884 — transactions:get-all-attachments no longer reads every linked text.
 *
 * On the PC the Attachments/Checklist reader ran 3.5-5 s on main per refresh: it
 * collected every text linked to the deal (105k) to find the ~150 with
 * attachments. `selectTextAttachmentsForTransaction` reads from the attachments
 * side; a messages row is read only for an attachment hit.
 *
 * C1 equality oracle: the OLD reader (its text query, verbatim, plus the shared
 *    `selectTextAttachmentsForMessages`) against the shipped reader, full row
 *    objects, every window below, two deals. Shapes: direct rows; Apple-id rows
 *    (attachment whose message_id is another / a deleted message, BACKLOG-3731);
 *    another user's texts in a linked thread (BACKLOG-3733); a per-message link
 *    to the other user's text; email attachments, one carrying a text's Apple id;
 *    an email link whose thread_id equals a text thread; hidden texts; a removed
 *    link; metadata-only rows; window edges on hit timestamps.
 * C2 plan + count (env-sized, KEEPR_3884A_TEXTS, default 20000): every statement
 *    the reader prepares is planned with no statistics; no messages SCAN, no
 *    search by user_id, every thread search index-only; rows handed to JS stay
 *    near the attachment count, never near the linked-text count. Counts, not
 *    clocks (#2915). Timings are printed.
 */
import { readFileSync } from "fs";
import path from "path";
import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";

let realDb: TestDb | null = null;
let recording = false;
const prepared: string[] = [];
let rowsToJs = 0;

const wrapper = {
  prepare(sql: string) {
    const stmt = realDb!.prepare(sql);
    if (!recording) return stmt;
    prepared.push(sql);
    return {
      run: (...p: unknown[]) => stmt.run(...p),
      get: (...p: unknown[]) => stmt.get(...p),
      all: (...p: unknown[]) => {
        const rows = stmt.all(...p);
        rowsToJs += rows.length;
        return rows;
      },
    };
  },
  exec: (sql: string) => realDb!.exec(sql),
  transaction: <T,>(fn: () => T) => realDb!.transaction(fn),
};

jest.mock("../core/dbConnection", () => ({
  ensureDb: () => wrapper,
  dbAll: (sql: string, params: unknown[] = []) => wrapper.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) => wrapper.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => wrapper.prepare(sql).run(...(params as never[])),
  dbTransaction: <T,>(fn: () => T): T => wrapper.transaction(fn)(),
  dbExec: (sql: string) => wrapper.exec(sql),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));
jest.mock("../../logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { getTransactionAllAttachments, type TransactionAttachmentRow } from "../attachmentDbService";
import { selectTextAttachmentsForMessages } from "../textAttachmentLookupSql";
import { auditWindowEnd } from "../../exportPlan";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const U1 = "u1-3884a";
const U2 = "u2-3884a";
const TX = "tx-3884a";
const TX2 = "tx-3884a-other";
const SCALE = Number(process.env.KEEPR_3884A_TEXTS || 20_000);
const PER_THREAD = 160;
const T0 = Date.parse("2025-01-01T00:00:00.000Z");
const at = (i: number): string => new Date(T0 + i * 60_000).toISOString();

/**
 * The reader as it was before BACKLOG-3884 (attachmentDbService.ts @ b065f9a81),
 * text and email arms verbatim, reading the same database.
 */
function oldReader(transactionId: string, start?: Date | null, end?: Date | null): TransactionAttachmentRow[] {
  const db = realDb!;
  const buildDateFilter = (column: string): { clause: string; params: string[] } => {
    let clause = "";
    const params: string[] = [];
    if (start) {
      clause += ` AND ${column} >= ?`;
      params.push(start.toISOString());
    }
    const e = auditWindowEnd(end);
    if (e) {
      clause += ` AND ${column} <= ?`;
      params.push(e.toISOString());
    }
    return { clause, params };
  };
  type RawRow = Omit<TransactionAttachmentRow, "source">;
  const emailFilter = buildDateFilter("e.sent_at");
  const emailRows = db
    .prepare(
      `SELECT DISTINCT
         a.id, a.filename, a.mime_type, a.file_size_bytes, a.storage_path,
         a.created_at, a.email_id, a.message_id,
         e.sent_at   AS source_date,
         e.direction AS direction,
         e.subject   AS context_subject,
         e.sender    AS context_sender
       FROM attachments a
       INNER JOIN emails e ON a.email_id = e.id
       INNER JOIN communications c ON c.email_id = e.id
       WHERE c.transaction_id = ?
         AND a.email_id IS NOT NULL
         ${emailFilter.clause}`,
    )
    .all(transactionId, ...emailFilter.params) as RawRow[];
  const textFilter = buildDateFilter("m.sent_at");
  const textMessages = db
    .prepare(
      `SELECT DISTINCT
         m.id                AS id,
         m.sent_at           AS source_date,
         m.direction         AS direction,
         m.participants_flat AS context_sender
       FROM messages m
       INNER JOIN communications c ON (
         (c.message_id IS NOT NULL AND c.message_id = m.id)
         OR
         (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id AND +m.user_id = c.user_id)
       )
       WHERE c.transaction_id = ?
         ${textFilter.clause}`,
    )
    .all(transactionId, ...textFilter.params) as {
    id: string;
    source_date: string | null;
    direction: string | null;
    context_sender: string | null;
  }[];
  const byMessage = new Map(textMessages.map((m) => [m.id, m]));
  const textRows: RawRow[] = selectTextAttachmentsForMessages<RawRow & { id: string; message_id: string | null }>(
    db as never,
    textMessages.map((m) => m.id),
  ).map(({ row, resolved_message_id }) => {
    const m = byMessage.get(resolved_message_id);
    return {
      id: row.id,
      filename: row.filename,
      mime_type: row.mime_type,
      file_size_bytes: row.file_size_bytes,
      storage_path: row.storage_path,
      created_at: row.created_at,
      email_id: row.email_id,
      message_id: resolved_message_id,
      source_date: m?.source_date ?? null,
      direction: m?.direction ?? null,
      context_subject: null,
      context_sender: m?.context_sender ?? null,
    } as RawRow;
  });
  const byId = new Map<string, TransactionAttachmentRow>();
  for (const r of emailRows) if (!byId.has(r.id)) byId.set(r.id, { ...r, source: "email" });
  for (const r of textRows) if (!byId.has(r.id)) byId.set(r.id, { ...r, source: "text" });
  return Array.from(byId.values());
}

const byId = (rows: TransactionAttachmentRow[]): TransactionAttachmentRow[] =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Linked texts of a deal, by the display join (the count the old reader materialised). */
function linkedTextCount(transactionId: string): number {
  return (
    realDb!
      .prepare(
        `SELECT COUNT(DISTINCT m.id) AS n FROM messages m JOIN communications c ON (
           (c.message_id IS NOT NULL AND c.message_id = m.id)
           OR (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id AND +m.user_id = c.user_id))
         WHERE c.transaction_id = ?`,
      )
      .get(transactionId) as { n: number }
  ).n;
}

function seed(db: TestDb): void {
  db.exec(readFileSync(SCHEMA, "utf8"));
  db.exec("PRAGMA foreign_keys = OFF");
  // Deliberately NO `ANALYZE`: production databases have no sqlite_stat1.
  for (const u of [U1, U2]) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(u, `${u}@example.test`, u);
  }
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '1 Test St')").run(TX, U1);
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '2 Test St')").run(TX2, U1);
  const addM = db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, participants_flat, thread_id, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const addA = db.prepare(
    `INSERT INTO attachments (id, message_id, email_id, external_message_id, filename, mime_type, file_size_bytes, storage_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const addC = db.prepare(
    "INSERT INTO communications (id, user_id, transaction_id, message_id, email_id, thread_id, link_source) VALUES (?, ?, ?, ?, ?, ?, 'manual')",
  );
  const addE = db.prepare(
    "INSERT INTO emails (id, user_id, external_id, source, direction, subject, sender, thread_id, sent_at) VALUES (?, ?, ?, 'gmail', ?, ?, ?, ?, ?)",
  );
  const text = (id: string, user: string, thread: string | null, i: number): void => {
    addM.run(id, user, i % 3 ? "imessage" : "sms", `g-${id}`, i % 2 ? "inbound" : "outbound", `body ${id}`,
      JSON.stringify({ from: "+12005550100", to: ["me"] }), `+1200555${String(100 + (i % 90)).padStart(4, "0")}`, thread, at(i));
  };
  const att = (id: string, messageId: string | null, emailId: string | null, ext: string | null, i: number): void => {
    addA.run(id, messageId, emailId, ext, `${id}.jpg`, "image/jpeg", 1000 + i, i % 2 ? `/att/${id}.jpg` : null, at(i + 1));
  };

  db.transaction(() => {
    // ---- bulk: SCALE texts of U1 in threads, every 33rd with an attachment ----
    const threads = Math.ceil(SCALE / PER_THREAD);
    for (let i = 0; i < SCALE; i++) {
      const thread = i % 50 === 7 ? null : `thr-${Math.floor(i / PER_THREAD)}`;
      text(`m-${i}`, U1, thread, i);
      if (i % 33 === 5) att(`a-${i}`, `m-${i}`, null, `g-m-${i}`, i);
    }
    const dealThreads = Math.floor(threads * 0.16);
    const otherThreads = Math.floor(threads * 0.12);
    for (let t = 0; t < dealThreads; t++) addC.run(`c-t${t}`, U1, TX, null, null, `thr-${t}`);
    for (let t = dealThreads; t < dealThreads + otherThreads; t++) addC.run(`c-t${t}`, U1, TX2, null, null, `thr-${t}`);
    // per-message links to thread-less texts, some with attachments
    for (let i = 7; i < SCALE; i += 50) {
      if (Math.floor(i / PER_THREAD) < dealThreads || i % 7 === 0) addC.run(`c-m${i}`, U1, TX, `m-${i}`, null, null);
      if (i % 350 === 7) att(`at-${i}`, `m-${i}`, null, `g-m-${i}`, i);
    }

    // ---- shapes (all in thread thr-0, which TX links, unless stated) ----
    // BACKLOG-3733: U2 texts in a thread U1 linked — never U1's deal.
    text("u2-in-thr0", U2, "thr-0", 3);
    att("a-u2-in-thr0", "u2-in-thr0", null, "g-u2-in-thr0", 3);
    // A per-message link to U2's text (the message arm has no user check).
    text("u2-msg-linked", U2, "thr-u2", 40);
    att("a-u2-msg-linked", "u2-msg-linked", null, "g-u2-msg-linked", 40);
    addC.run("c-u2-msg", U1, TX, "u2-msg-linked", null, null);
    // BACKLOG-3731: an attachment whose message_id is a DELETED message; its Apple id is
    // a linked text with no direct row -> resolves to that text.
    att("a-fallback-deleted", "m-deleted-gone", null, "g-m-1", 1);
    // ... whose message_id is an UNLINKED text (thr-unlinked) -> resolves to the linked one.
    text("m-unlinked-own", U1, "thr-unlinked", 2);
    att("a-fallback-other", "m-unlinked-own", null, "g-m-2", 2);
    // ... pointing at a linked text that HAS a direct row -> no fallback (stays unlinked).
    att("a-fallback-blocked", "m-unlinked-own", null, "g-m-5", 4);
    // ... whose own message is linked too -> step 1 wins (owner = own message).
    att("a-fallback-own-linked", "m-3", null, "g-m-4", 5);
    // ... with an email_id: an email attachment never resolves to a text.
    addE.run("e-carrier", U1, "prov-carrier", "inbound", "Carrier", "c@example.test", "et-1", at(9));
    att("a-email-with-text-id", null, "e-carrier", "g-m-6", 9);
    // Cross-user Apple id: U2 text, per-message linked, with no direct row, same Apple id
    // as U1's own linked text m-10's attachment... own message linked but early.
    text("u2-same-apple", U2, "thr-u2b", 12);
    addC.run("c-u2-apple", U1, TX, "u2-same-apple", null, null);
    db.prepare("UPDATE messages SET external_id = 'g-shared-apple' WHERE id = 'u2-same-apple'").run();
    att("a-shared-apple", "m-8", null, "g-shared-apple", 8);
    // Emails: linked (with metadata-only and downloaded rows), unlinked, other deal.
    for (let e = 0; e < 12; e++) {
      addE.run(`e-${e}`, U1, `prov-${e}`, e % 2 ? "inbound" : "outbound", `Subject ${e}`, `s${e}@example.test`, `et-${e}`, at(e * 97));
      att(`ae-${e}`, null, `e-${e}`, `prov-${e}`, e * 97);
      if (e % 3 === 0) addC.run(`ce-${e}`, U1, TX, null, `e-${e}`, `et-${e}`);
      else if (e % 3 === 1) addC.run(`ce-${e}`, U1, TX2, null, `e-${e}`, `et-${e}`);
    }
    // An email link whose thread_id equals a text thread: the display join reads that
    // thread's texts as linked, so the reader must too.
    addC.run("ce-collide", U1, TX, null, "e-carrier", `thr-${dealThreads + 1}`);
    // Hidden from export (not read by this reader; present anyway).
    db.prepare("INSERT INTO transaction_hidden_texts (transaction_id, message_id, message_external_id, hidden_by) VALUES (?, ?, ?, ?)")
      .run(TX, "m-5", "g-m-5", U1);
    // Removed: a thread the user unlinked (ignored row, no communications row).
    text("m-removed", U1, "thr-removed", 30);
    att("a-removed", "m-removed", null, "g-m-removed", 30);
    db.prepare("INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id) VALUES ('ig-1', ?, ?, 'thr-removed')").run(U1, TX);
  })();
}

/** Windows: none, open-ended, and edges exactly on hit timestamps (inclusive both ends). */
function windows(): Array<[Date | null, Date | null]> {
  return [
    [null, null],
    [new Date(at(5)), null],
    [null, new Date(at(500))],
    [new Date(at(38)), new Date(at(2000))],
    [new Date(at(39)), new Date(at(1999))],
    [new Date(at(13)), new Date(at(13))],
  ];
}

function planOf(sqlText: string): string[] {
  const stmt = realDb!.prepare(`EXPLAIN QUERY PLAN ${sqlText}`);
  for (let n = (sqlText.match(/\?/g) ?? []).length; n >= 0; n--) {
    try {
      return (stmt.all(...new Array(n).fill("x")) as Array<{ detail: string }>).map((r) => r.detail);
    } catch {
      /* wrong parameter count — try one fewer */
    }
  }
  throw new Error("could not EXPLAIN the captured statement");
}

beforeAll(() => {
  realDb = openTestDb();
  seed(realDb);
});
afterAll(() => {
  realDb?.close();
  realDb = null;
});

describe("BACKLOG-3884: all-attachments reader, equality with the old reader", () => {
  it("the fixture holds every shape", () => {
    const old = oldReader(TX).map((r) => r.id);
    for (const id of ["a-fallback-deleted", "a-fallback-other", "a-fallback-own-linked", "a-u2-msg-linked", "a-shared-apple", "at-7", "ae-0"]) {
      expect(old).toContain(id);
    }
    for (const id of ["a-u2-in-thr0", "a-fallback-blocked", "a-removed", "ae-1"]) {
      expect(old).not.toContain(id);
    }
    // an email attachment carrying a text's Apple id is listed as the email's, never a text's
    expect(oldReader(TX).find((r) => r.id === "a-email-with-text-id")?.source).toBe("email");
    // the colliding email link pulls its text thread in
    const collideThread = realDb!.prepare("SELECT thread_id FROM communications WHERE id = 'ce-collide'").get() as { thread_id: string };
    const collideHits = realDb!.prepare("SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ?").all(collideThread.thread_id) as { id: string }[];
    expect(collideHits.length).toBeGreaterThan(0);
    for (const h of collideHits) expect(old).toContain(h.id);
    expect(old.length).toBeGreaterThan(20);
  });

  for (const tx of [TX, TX2]) {
    it(`identical rows for ${tx} in every window`, () => {
      const sizes: number[] = [];
      for (const [s, e] of windows()) {
        const expected = byId(oldReader(tx, s, e));
        const actual = byId(getTransactionAllAttachments(tx, s, e));
        sizes.push(expected.length);
        expect(actual).toEqual(expected);
      }
      // the windows actually differ (an all-equal sweep proves nothing about the edges)
      expect(new Set(sizes).size).toBeGreaterThan(2);
    });
  }

  it("cross-user Apple id: full list keeps the own message, a window excluding it resolves to the other user's linked text", () => {
    const full = getTransactionAllAttachments(TX).find((r) => r.id === "a-shared-apple");
    expect(full?.message_id).toBe("m-8");
    const win = getTransactionAllAttachments(TX, new Date(at(10)), new Date(at(20))).find((r) => r.id === "a-shared-apple");
    expect(win?.message_id).toBe("u2-same-apple");
  });
});

describe("BACKLOG-3884: plan and row counts (no sqlite_stat1)", () => {
  it("never scans messages, never searches by user, reads thread indexes index-only, and hands JS rows near the attachment count", () => {
    prepared.length = 0;
    rowsToJs = 0;
    recording = true;
    const started = Date.now();
    const rows = getTransactionAllAttachments(TX);
    const ms = Date.now() - started;
    recording = false;
    const linked = linkedTextCount(TX);
    const textAttachments = (realDb!.prepare("SELECT COUNT(*) AS n FROM attachments WHERE message_id IS NOT NULL").get() as { n: number }).n;

    const plans = prepared.flatMap(planOf);
    const messagesAliases = /\b(?:SCAN|SEARCH) (m|tm|x|messages)\b/;
    expect(plans.some((d) => messagesAliases.test(d))).toBe(true);
    expect(plans.filter((d) => /^SCAN (m|tm|x|messages)\b/.test(d))).toEqual([]);
    expect(plans.filter((d) => /\(user_id=\?/.test(d))).toEqual([]);
    const threadSearches = plans.filter((d) => /idx_messages_thread_(id|sent) \(thread_id=\?/.test(d));
    expect(threadSearches.length).toBeGreaterThan(0);
    expect(threadSearches.filter((d) => !d.includes("COVERING INDEX"))).toEqual([]);
    // Driven by thread, then the attachment-owner list is a membership test. If the
    // planner drives from that list instead it plans `(thread_id=? AND rowid=?)`:
    // every thread probed for every attachment (4 s at 668k texts).
    expect(threadSearches.filter((d) => !/\(thread_id=\?\)$/.test(d))).toEqual([]);

    // The old reader handed every linked text to JS; this one hands the text
    // attachments (twice: own-message map + Apple-id pairs) and the hits.
    const ceiling = 2 * textAttachments + 2 * rows.length + 10;
    process.stderr.write(
      `[3884a] texts=${SCALE} linked=${linked} textAttachments=${textAttachments} rows=${rows.length} rowsToJs=${rowsToJs} ceiling=${ceiling} statements=${prepared.length} ms=${ms}\n`,
    );
    expect(linked).toBeGreaterThan(ceiling);
    expect(rowsToJs).toBeGreaterThan(0);
    expect(rowsToJs).toBeLessThanOrEqual(ceiling);

    const oldStarted = Date.now();
    oldReader(TX);
    process.stderr.write(`[3884a] old reader ms=${Date.now() - oldStarted} (printed, not asserted)\n`);
  });
});
