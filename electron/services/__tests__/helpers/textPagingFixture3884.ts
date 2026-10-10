/**
 * BACKLOG-3884: a deal whose linked text threads carry a whole phone history
 * (the PC: 183,043 linked text rows on one deal, iPhone source, thread links).
 *
 * Shape, transcribed from what the readers produce and the PC log reports:
 *  - thread links (`communications.thread_id`, message_id NULL), one per thread —
 *    what auto-link writes for a texts thread (`createThreadCommunicationReference`);
 *  - a few per-message links too, two of them to messages whose thread is ALSO
 *    thread-linked (the same message reaches the reader twice: the id dedup), and one
 *    to a threadless message;
 *  - bursts of rows sharing one sent_at (the paging boundary), reactions (2000-band,
 *    empty body), intra-thread content duplicates (same body and sent_at, different
 *    id) where one copy is hidden from export (the hidden copy survives the dedup),
 *    and history outside the audit window.
 *
 * The generator records which ids every reader must return, computed from what it
 * inserted, not from a reader.
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";

export const USER = "u-3884";
export const TXN = "t-3884";
/** Audit window (local calendar days are the renderer's business; ms here are UTC). */
export const WINDOW_START_ISO = "2026-03-01T00:00:00.000Z";
export const WINDOW_END_ISO = "2026-06-30T23:59:59.999Z";

export interface TextPagingFixture {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  dir: string;
  threadIds: string[];
  /** Every id the deduplicated reader returns for the deal's texts (reactions included). */
  expectedAll: Set<string>;
  /** Same, inside the window. */
  expectedInWindow: Set<string>;
  /** Per thread key: expected ids (all history). */
  expectedByThread: Map<string, Set<string>>;
  /** Per thread key: non-reaction expected counts {total, inWindow}. */
  realCounts: Map<string, { total: number; inWindow: number }>;
  /** The thread with the most in-window rows. */
  bigThread: string;
  /** Oldest in-window real message of bigThread. */
  bigThreadOldestInWindowId: string;
  rows: number;
}

const KEY_HEX = "3884".repeat(16);

export function buildTextPagingFixture(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Database: any,
  rows: number,
): TextPagingFixture {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3884-texts-"));
  const db = new Database(nodePath.join(dir, "mad.db"));
  db.pragma(`key = "x'${KEY_HEX}'"`);
  db.pragma("cipher_compatibility = 4");
  db.pragma("journal_mode = WAL");
  db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql"), "utf8"));
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(USER, "t@example.test", "o-t");
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address, transaction_type, status, started_at, closed_at) VALUES (?, ?, '1 Test St', 'purchase', 'active', ?, ?)",
  ).run(TXN, USER, "2026-03-01", "2026-06-30");

  const threadIds = ["thr-a", "thr-b", "thr-c", "thr-d", "thr-e", "thr-f", "thr-g", "thr-group"];
  // Weighted: thr-a carries most of the history, like a spouse/partner thread.
  const weights = [0.45, 0.2, 0.1, 0.08, 0.06, 0.05, 0.03, 0.03];
  const handles = ["+12065550101", "+12065550102", "+12065550103", "+12065550104", "+12065550105", "+12065550106", "a@example.test"];
  const me = "+12065550199";

  const insMsg = db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, sent_at, received_at, thread_id, participants, participants_flat,
                           associated_message_type, associated_message_guid, external_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insComm = db.prepare(
    "INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id, link_source) VALUES (?, ?, ?, ?, ?, 'auto')",
  );
  const insHidden = db.prepare(
    "INSERT INTO transaction_hidden_texts (transaction_id, message_id, message_external_id, hidden_by) VALUES (?, ?, ?, ?)",
  );

  const start = Date.parse(WINDOW_START_ISO);
  const end = Date.parse(WINDOW_END_ISO);
  // History: 2018-01-01 .. 2026-09-30, so roughly 4/104 of rows fall in the window.
  const histStart = Date.parse("2018-01-01T00:00:00.000Z");
  const histEnd = Date.parse("2026-09-30T00:00:00.000Z");

  const expectedAll = new Set<string>();
  const expectedInWindow = new Set<string>();
  const expectedByThread = new Map<string, Set<string>>();
  const realCounts = new Map<string, { total: number; inWindow: number }>();
  for (const t of threadIds) {
    expectedByThread.set(t, new Set());
    realCounts.set(t, { total: 0, inWindow: 0 });
  }
  expectedByThread.set("__unthreaded__", new Set());
  realCounts.set("__unthreaded__", { total: 0, inWindow: 0 });

  const expect = (id: string, thread: string, ts: number, real: boolean): void => {
    expectedAll.add(id);
    expectedByThread.get(thread)!.add(id);
    const inWin = ts >= start && ts <= end;
    if (inWin) expectedInWindow.add(id);
    if (real) {
      const c = realCounts.get(thread)!;
      c.total += 1;
      if (inWin) c.inWindow += 1;
    }
  };

  let seq = 0;
  let bigOldest: { id: string; ts: number } | null = null;
  db.transaction(() => {
    for (const t of threadIds) {
      insComm.run(`comm-${t}`, USER, TXN, null, t);
    }
    let ts = histStart;
    const step = Math.max(1, Math.floor((histEnd - histStart) / rows));
    let lastGuid = "";
    for (let i = 0; i < rows; i++) {
      // Bursts: every 50th row starts a group of 4 sharing one sent_at.
      if (i % 50 !== 1 && i % 50 !== 2 && i % 50 !== 3) ts += step;
      const r = (i * 2654435761) % 1000 / 1000;
      let acc = 0;
      let ti = 0;
      for (; ti < weights.length - 1; ti++) {
        acc += weights[ti];
        if (r < acc) break;
      }
      const thread = threadIds[ti];
      const isGroup = thread === "thr-group";
      const other = isGroup ? handles[0] : handles[ti % handles.length];
      const outbound = i % 3 === 0;
      const participants = isGroup
        ? JSON.stringify({ from: outbound ? me : handles[i % 3], to: outbound ? handles.slice(0, 3) : [me], chat_members: handles.slice(0, 3) })
        : JSON.stringify({ from: outbound ? me : other, to: [outbound ? other : me] });
      const iso = new Date(ts).toISOString();
      const id = `m${seq++}`;
      const reaction = i % 20 === 7 && lastGuid !== "";
      const body = reaction ? "" : `message ${i} ${"x".repeat(40 + (i % 900))}`;
      insMsg.run(
        id, USER, i % 5 === 0 ? "sms" : "imessage", outbound ? "outbound" : "inbound", body, iso, iso, thread, participants,
        participants, reaction ? 2000 : null, reaction ? lastGuid : null, `ext-${id}`, JSON.stringify({ source: "iphone_sync" }),
      );
      if (!reaction) lastGuid = `ext-${id}`;
      // Intra-thread content duplicate (another import of the same text), every 97th
      // real row; the duplicate copy is hidden, so it is the copy the dedup keeps.
      if (!reaction && i % 97 === 5) {
        const dup = `m${seq++}`;
        insMsg.run(
          dup, USER, "imessage", outbound ? "outbound" : "inbound", body, iso, iso, thread, participants, participants, null, null,
          `ext-${dup}`, JSON.stringify({ source: "iphone_sync" }),
        );
        insHidden.run(TXN, dup, `ext-${dup}`, USER);
        expect(dup, thread, ts, true);
      } else {
        expect(id, thread, ts, !reaction);
      }
      if (thread === "thr-a" && !reaction && ts >= start && ts <= end && (!bigOldest || ts < bigOldest.ts)) {
        bigOldest = { id: expectedByThread.get("thr-a")!.has(id) ? id : `m${seq - 1}`, ts };
      }
      // Two messages reach the reader twice: a per-message link on a thread-linked thread.
      if (i === Math.floor(rows / 2) || i === Math.floor(rows / 2) + 10) {
        insComm.run(`comm-pm-${id}`, USER, TXN, id, null);
      }
    }
    // One threadless message, linked per message.
    const loose = `m${seq++}`;
    const looseIso = new Date(start + 86400000).toISOString();
    const lp = JSON.stringify({ from: handles[1], to: [me] });
    insMsg.run(loose, USER, "sms", "inbound", "a threadless text", looseIso, looseIso, null, lp, lp, null, null, `ext-${loose}`, null);
    insComm.run(`comm-pm-${loose}`, USER, TXN, loose, null);
    expect(loose, "__unthreaded__", start + 86400000, true);
  })();

  const big = [...realCounts.entries()].filter(([k]) => k !== "__unthreaded__").sort((a, b) => b[1].inWindow - a[1].inWindow)[0][0];
  return {
    db,
    dir,
    threadIds,
    expectedAll,
    expectedInWindow,
    expectedByThread,
    realCounts,
    bigThread: big,
    bigThreadOldestInWindowId: bigOldest ? (bigOldest as { id: string }).id : "",
    rows: seq,
  };
}
