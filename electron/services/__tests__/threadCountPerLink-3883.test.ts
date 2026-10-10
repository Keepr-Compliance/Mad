/**
 * @jest-environment node
 *
 * BACKLOG-3883 — the text-thread recount that runs after every link read every message
 * of every linked chat (one row per message) to produce one key per chat. It now reads
 * one row per link. This suite pins that the COUNT is unchanged, against the previous
 * statement and grouping run as an oracle, over every link shape and their combinations.
 *
 * Shapes (each a real row shape the writers produce):
 *   thread link -> chat with text messages / mixed channels / only email-channel rows / no rows
 * (Two thread links to one chat on one deal cannot exist: UNIQUE(thread_id, transaction_id).)
 *   message link -> text message with thread / text without thread (participants key) /
 *                   email-channel message / missing message with thread id / missing, no thread id
 * Every subset of up to 3 shapes, with a shared chat id so keys collide across shapes.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --runTestsByPath <this file>
 */
import path from "path";
import { readFileSync } from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import * as dbConnection from "../db/core/dbConnection";
import { setDb } from "../db/core/dbConnection";
import { countTextThreadsForTransaction } from "../db/communicationDbService";

const DRIVER = path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
function loadDriver(): (new (file: string) => DatabaseType) | null {
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
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;
const USER = "u-3883-count";

// The statement this item replaced, verbatim, and the grouping it fed (communicationDbService
// getThreadKey / normalizeParticipant, transcribed).
const ORACLE_SQL = `
    SELECT
      COALESCE(m.id, c.id) as id,
      m.thread_id as thread_id,
      m.participants as participants
    FROM communications c
    LEFT JOIN messages m ON (
      (c.message_id IS NOT NULL AND c.message_id = m.id)
      OR
      (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
    )
    WHERE c.transaction_id = ?
      AND (m.channel IN ('text', 'sms', 'imessage') OR (m.id IS NULL AND c.thread_id IS NOT NULL))
  `;
function normalizeParticipant(p: string): string {
  if (!p) return "";
  const digits = p.replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return p.toLowerCase().trim();
}
function oracleKey(msg: { id: string; thread_id: string | null; participants: string | null }): string {
  if (msg.thread_id) return msg.thread_id;
  try {
    if (msg.participants) {
      const parsed = JSON.parse(msg.participants);
      const all = new Set<string>();
      if (parsed.from) all.add(normalizeParticipant(parsed.from));
      if (parsed.to) (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).forEach((x: string) => all.add(normalizeParticipant(x)));
      all.delete("me");
      if (all.size > 0) return `participants-${Array.from(all).sort().join("|")}`;
    }
  } catch {
    /* fall through */
  }
  return `msg-${msg.id}`;
}
function oracleCount(db: DatabaseType, txn: string): number {
  const rows = db.prepare(ORACLE_SQL).all(txn) as Array<{ id: string; thread_id: string | null; participants: string | null }>;
  return new Set(rows.map(oracleKey)).size;
}

type Shape =
  | "thread-text"
  | "thread-mixed"
  | "thread-email-only"
  | "thread-empty"
  | "msg-text-thread"
  | "msg-text-nothread"
  | "msg-email"
  | "msg-missing-thread"
  | "msg-missing-nothread"
  | "thread-shared"
  | "msg-shared";
const SHAPES: Shape[] = [
  "thread-text",
  "thread-mixed",
  "thread-email-only",
  "thread-empty",
  "msg-text-thread",
  "msg-text-nothread",
  "msg-email",
  "msg-missing-thread",
  "msg-missing-nothread",
  "thread-shared",
  "msg-shared",
];

function subsets(max: number): Shape[][] {
  const out: Shape[][] = [[]];
  const rec = (start: number, cur: Shape[]): void => {
    if (cur.length) out.push([...cur]);
    if (cur.length === max) return;
    for (let i = start; i < SHAPES.length; i++) rec(i + 1, [...cur, SHAPES[i]]);
  };
  rec(0, []);
  return out;
}

maybe("BACKLOG-3883 — text-thread count reads one row per link, same count", () => {
  let db: DatabaseType;
  beforeAll(() => {
    db = new (Database as NonNullable<typeof Database>)(":memory:");
    db.exec(readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8"));
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o')").run(USER);
    const msg = db.prepare(
      `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type)
       VALUES (?, ?, ?, ?, 'inbound', ?, '', ?, '2025-01-01T00:00:00Z', 'text')`,
    );
    const P = JSON.stringify({ from: "+12065550123", to: ["me"] });
    for (let i = 0; i < 3; i++) msg.run(`tt-${i}`, USER, `x-tt-${i}`, "imessage", P, "chat-text");
    msg.run("tm-1", USER, "x-tm-1", "sms", P, "chat-mixed");
    msg.run("tm-2", USER, "x-tm-2", "email", P, "chat-mixed");
    msg.run("te-1", USER, "x-te-1", "email", P, "chat-email-only");
    msg.run("ts-1", USER, "x-ts-1", "imessage", P, "chat-shared");
    msg.run("mt-1", USER, "x-mt-1", "imessage", P, "chat-msg");
    msg.run("mn-1", USER, "x-mn-1", "sms", P, null);
    msg.run("me-1", USER, "x-me-1", "email", P, "chat-msg-email");
    msg.run("ms-1", USER, "x-ms-1", "imessage", P, "chat-shared");
    setDb(db);
  });
  afterAll(() => db.close());

  let n = 0;
  const link = (txn: string, shape: Shape): void => {
    const id = `l-${++n}`;
    const thread = (t: string) => db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id, link_source) VALUES (?, ?, ?, ?, 'auto')").run(id, USER, txn, t);
    const message = (m: string, t: string | null) =>
      db.prepare("INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id, link_source) VALUES (?, ?, ?, ?, ?, 'auto')").run(id, USER, txn, m, t);
    switch (shape) {
      case "thread-text": return void thread("chat-text");
      case "thread-mixed": return void thread("chat-mixed");
      case "thread-email-only": return void thread("chat-email-only");
      case "thread-empty": return void thread("chat-nobody");
      case "thread-shared": return void thread("chat-shared");
      case "msg-text-thread": return void message("mt-1", "chat-msg");
      case "msg-text-nothread": return void message("mn-1", null);
      case "msg-email": return void message("me-1", "chat-msg-email");
      case "msg-missing-thread": return void message("gone-1", "chat-gone");
      case "msg-missing-nothread": return void message("gone-2", null);
      case "msg-shared": return void message("ms-1", "chat-shared");
    }
  };

  const cases = subsets(3);
  it(`covers ${cases.length} link combinations (guards the sweep against matching nothing)`, () => {
    expect(cases.length).toBeGreaterThan(200);
  });

  it.each(cases.map((c, i) => [i, c.join("+") || "(none)", c] as const))("case %i %s: same count as the previous statement", async (i, _label, shapes) => {
    const txn = `txn-${i}`;
    for (const s of shapes) link(txn, s);
    const expected = oracleCount(db, txn);
    expect(await countTextThreadsForTransaction(txn)).toBe(expected);
  });

  it("reads one row per link however long the chat is (the freeze: one row per message, after every link)", async () => {
    const ins = db.prepare(
      `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type)
       VALUES (?, ?, ?, 'imessage', 'inbound', '{}', '', 'chat-long', '2025-01-01T00:00:00Z', 'text')`,
    );
    for (let i = 0; i < 2000; i++) ins.run(`long-${i}`, USER, `x-long-${i}`);
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id, link_source) VALUES ('l-long', ?, 'txn-long', 'chat-long', 'auto')").run(USER);
    const all = jest.spyOn(dbConnection, "dbAll");
    expect(await countTextThreadsForTransaction("txn-long")).toBe(1);
    const rowsRead = all.mock.results.map((r) => (r.value as unknown[]).length);
    all.mockRestore();
    expect(rowsRead).toEqual([1]);
  });

  it("the shapes are distinguishable: the oracle counts differ across single shapes", () => {
    const counts = SHAPES.map((s, i) => {
      const txn = `solo-${i}`;
      link(txn, s);
      return oracleCount(db, txn);
    });
    expect(new Set(counts).size).toBeGreaterThan(1); // 0 and 1 both occur
  });
});
