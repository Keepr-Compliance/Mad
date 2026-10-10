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
import { threadlessTextKey } from "../../db/threadlessTextKey";

export const USER = "u-3884";
export const TXN = "t-3884";
/** A second deal sharing thr-a (thread link) and one thr-b text, plus its own thread thr-z. */
export const TXN2 = "t-3884-other";
/** Audit window (local calendar days are the renderer's business; ms here are UTC). */
export const WINDOW_START_ISO = "2026-03-01T00:00:00.000Z";
export const WINDOW_END_ISO = "2026-06-30T23:59:59.999Z";

export interface TextPagingFixture {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  dir: string;
  threadIds: string[];
  /** Every id the EXPORT reader returns for the deal's texts (global dedup, reactions included). */
  expectedAll: Set<string>;
  /** Union over conversations of what each conversation's pages return (all history). */
  expectedUnion: Set<string>;
  /** Same, inside the window. */
  expectedInWindow: Set<string>;
  /** Per conversation key: what its pages return (all history). */
  expectedByThread: Map<string, Set<string>>;
  /** Per conversation key: what its pages return inside the window. */
  expectedInWindowByThread: Map<string, Set<string>>;
  /** Per conversation key: every message id linked to THIS deal (all copies, all history). */
  linkedIdsByThread: Map<string, Set<string>>;
  /** Conversation keys: the named threads plus one per person with thread-less texts. */
  conversationKeys: string[];
  /** The cross-thread duplicate pair: the unhidden copy (thr-b) and the hidden copy (thr-c). */
  crossDup: { visible: string; hidden: string };
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
  const expectedUnion = new Set<string>();
  const expectedInWindow = new Set<string>();
  const expectedByThread = new Map<string, Set<string>>();
  const expectedInWindowByThread = new Map<string, Set<string>>();
  const linkedIdsByThread = new Map<string, Set<string>>();
  const realCounts = new Map<string, { total: number; inWindow: number }>();
  const ensure = (k: string): void => {
    if (expectedByThread.has(k)) return;
    expectedByThread.set(k, new Set());
    expectedInWindowByThread.set(k, new Set());
    linkedIdsByThread.set(k, new Set());
    realCounts.set(k, { total: 0, inWindow: 0 });
  };
  for (const t of threadIds) ensure(t);
  const linked = (id: string, thread: string): void => {
    ensure(thread);
    linkedIdsByThread.get(thread)!.add(id);
  };

  /** A row the pages of `thread` return; `exported` false = the export's global dedup drops it. */
  const expect = (id: string, thread: string, ts: number, real: boolean, exported = true): void => {
    ensure(thread);
    if (exported) expectedAll.add(id);
    expectedUnion.add(id);
    expectedByThread.get(thread)!.add(id);
    const inWin = ts >= start && ts <= end;
    if (inWin) {
      expectedInWindow.add(id);
      expectedInWindowByThread.get(thread)!.add(id);
    }
    if (real) {
      const c = realCounts.get(thread)!;
      c.total += 1;
      if (inWin) c.inWindow += 1;
    }
  };

  let seq = 0;
  let crossVisible = "";
  let crossHidden = "";
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
      linked(id, thread);
      // Intra-thread content duplicate (another import of the same text), every 97th
      // real row; the duplicate copy is hidden, so it is the copy the dedup keeps.
      if (!reaction && i % 97 === 5) {
        const dup = `m${seq++}`;
        insMsg.run(
          dup, USER, "imessage", outbound ? "outbound" : "inbound", body, iso, iso, thread, participants, participants, null, null,
          `ext-${dup}`, JSON.stringify({ source: "iphone_sync" }),
        );
        insHidden.run(TXN, dup, `ext-${dup}`, USER);
        linked(dup, thread);
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
    // Window edges (SR): texts exactly on the first and the last instant of the
    // window are in it; one millisecond outside either edge is not. And a text with
    // no sent_at whose received_at is in the window.
    const edge = (iso: string | null, received: string, body: string): void => {
      const id = `m${seq++}`;
      const p = JSON.stringify({ from: handles[0], to: [me] });
      insMsg.run(id, USER, "imessage", "inbound", body, iso, received, "thr-a", p, p, null, null, `ext-${id}`, JSON.stringify({ source: "iphone_sync" }));
      linked(id, "thr-a");
      expect(id, "thr-a", Date.parse(iso ?? received), true);
    };
    edge(new Date(start).toISOString(), new Date(start).toISOString(), "edge: first instant");
    edge(new Date(end).toISOString(), new Date(end).toISOString(), "edge: last instant");
    edge(new Date(start - 1).toISOString(), new Date(start - 1).toISOString(), "edge: 1 ms before");
    edge(new Date(end + 1).toISOString(), new Date(end + 1).toISOString(), "edge: 1 ms after");
    edge(null, new Date(start + 5 * 86400000).toISOString(), "no sent_at, received in window");

    // A cross-thread duplicate (SR B3): the same text in thr-b and thr-c (one person's
    // SMS and iMessage threads, which the tab merges into one card); the thr-c copy is
    // hidden. Each thread's own pages show its copy; the merged card and the export
    // show it once, the hidden copy.
    const crossIso = new Date(start + 10 * 86400000).toISOString();
    crossVisible = `m${seq++}`;
    crossHidden = `m${seq++}`;
    const pb = JSON.stringify({ from: handles[1], to: [me] });
    insMsg.run(crossVisible, USER, "sms", "inbound", "same text in two threads", crossIso, crossIso, "thr-b", pb, pb, null, null, `ext-${crossVisible}`, null);
    insMsg.run(crossHidden, USER, "imessage", "inbound", "same text in two threads", crossIso, crossIso, "thr-c", pb, pb, null, null, `ext-${crossHidden}`, null);
    insHidden.run(TXN, crossHidden, `ext-${crossHidden}`, USER);
    linked(crossVisible, "thr-b");
    linked(crossHidden, "thr-c");
    expect(crossVisible, "thr-b", start + 10 * 86400000, true, false);
    expect(crossHidden, "thr-c", start + 10 * 86400000, true, true);

    // Thread-less texts of two different people, linked per message (SR B4): one
    // conversation per person, as the tab always grouped them.
    const looseText = (from: string, body: string, ts: number): void => {
      const id = `m${seq++}`;
      const iso = new Date(ts).toISOString();
      const lp = JSON.stringify({ from, to: [me] });
      insMsg.run(id, USER, "sms", "inbound", body, iso, iso, null, lp, lp, null, null, `ext-${id}`, null);
      insComm.run(`comm-pm-${id}`, USER, TXN, id, null);
      const key = threadlessTextKey(lp, id);
      linked(id, key);
      expect(id, key, ts, true);
    };
    looseText(handles[1], "a threadless text", start + 86400000);
    looseText(handles[1], "another threadless text", start + 2 * 86400000);
    looseText(handles[2], "someone else's threadless text", start + 3 * 86400000);

    // A second deal: links thr-a by thread, one thr-b text by message, and its own
    // thread thr-z. None of it may be collected for THIS deal.
    db.prepare(
      "INSERT INTO transactions (id, user_id, property_address, transaction_type, status, started_at, closed_at) VALUES (?, ?, '2 Other St', 'sale', 'active', ?, ?)",
    ).run(TXN2, USER, "2026-01-01", "2026-12-31");
    insComm.run("comm-t2-thr-a", USER, TXN2, null, "thr-a");
    const zIso = new Date(start + 86400000).toISOString();
    const pz = JSON.stringify({ from: handles[5], to: [me] });
    const z = `m${seq++}`;
    insMsg.run(z, USER, "sms", "inbound", "only on the other deal", zIso, zIso, "thr-z", pz, pz, null, null, `ext-${z}`, null);
    insComm.run("comm-t2-thr-z", USER, TXN2, null, "thr-z");
    const someB = [...linkedIdsByThread.get("thr-b")!][0];
    insComm.run(`comm-t2-pm-${someB}`, USER, TXN2, someB, null);
  })();

  const big = [...realCounts.entries()].filter(([k]) => threadIds.includes(k)).sort((a, b) => b[1].inWindow - a[1].inWindow)[0][0];
  return {
    db,
    dir,
    threadIds,
    expectedAll,
    expectedUnion,
    expectedInWindow,
    expectedByThread,
    expectedInWindowByThread,
    linkedIdsByThread,
    conversationKeys: [...expectedByThread.keys()],
    crossDup: { visible: crossVisible, hidden: crossHidden },
    realCounts,
    bigThread: big,
    bigThreadOldestInWindowId: bigOldest ? (bigOldest as { id: string }).id : "",
    rows: seq,
  };
}
