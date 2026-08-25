/**
 * @jest-environment node
 *
 * BACKLOG-2854 (founder test, 2026-08-23) — one group chat, listed twice.
 *
 * ===========================================================================
 * WHAT THE FOUNDER SAW, AND WHY THE SEARCH WAS NOT THE BUG
 * ===========================================================================
 * Searching a group chat's name returned the SAME conversation twice: same
 * name, same transaction, the same members listed in a DIFFERENT ORDER on each
 * row.
 *
 * `buildTextThreadNameQuery` is correct and stays untouched. It ranks a
 * thread's messages (`ROW_NUMBER() OVER (PARTITION BY m.thread_id ...)`) and
 * keeps `rn = 1` — one row per `thread_id`, guaranteed. **Two rows therefore
 * means two `thread_id` values**, not a collapse failure.
 *
 * The two ids are real. `macChatThreadId` keys thread identity on the Apple
 * `chat_id` (`macos-chat-{id}`) and its comment asserts "one chat row -> one
 * thread". That does not hold on a real `chat.db`: Apple keeps several chat
 * rows for one human conversation (an iMessage row and an SMS/MMS row, a new
 * row after a member's handle changes, service migration). Each gets its own
 * `chat_id` -> its own thread -> its own `message_thread_names` row carrying
 * THE SAME display name. The differing member order is the fingerprint:
 * `m.participants` is read off each thread's own representative message.
 *
 * ===========================================================================
 * WHY THE FIX IS AT THE QUERY LAYER AND WHAT IT REFUSES TO DO
 * ===========================================================================
 * `thread_id` is a stable join key — rewriting it is a migration with a far
 * larger blast radius. So sibling threads are collapsed when they share a
 * display name AND a normalized member set.
 *
 * **Name alone is never enough**, and the negative case below is the reason:
 * two genuinely different groups can share a name ("Closing Team"), and a
 * name-only collapse would hide one of them. That test is the most important
 * one in this file.
 *
 * Every group name, person name and handle below is INVENTED. All numbers are
 * in the 555-01xx range reserved for fiction. No founder data appears here.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";

import {
  searchLinkedContent,
  searchGlobalContent,
  type SearchableDb,
} from "../transactionSearchDbService";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "database", "schema.sql"),
  "utf8",
);
/** Migration v56 — schema.sql deliberately declares these on neither table. */
const V56 = `
  ALTER TABLE contacts ADD COLUMN removed_at DATETIME;
  ALTER TABLE contacts ADD COLUMN removed_reason TEXT;
  ALTER TABLE transaction_contacts ADD COLUMN removed_at DATETIME;
  ALTER TABLE transaction_contacts ADD COLUMN removed_reason TEXT;`;

const USER = "u-2854";
const TXN = "t-2854";
const TXN2 = "t-2854-other";
const ADDR = "10 Harbor Way";
const ADDR2 = "22 Sunset Terrace";

// --- Invented rosters -------------------------------------------------------
const ROSTER_A = ["+14155550110", "+14155550111", "+14155550112"];
const ROSTER_B = ["+14155550120", "+14155550121", "+14155550122"];
/** Case C's two DIFFERENT groups that happen to share one name. */
const ROSTER_C1 = ["+14155550130", "+14155550131", "+14155550132"];
const ROSTER_C2 = ["+14155550140", "+14155550141", "+14155550142"];
const ROSTER_D = ["+14155550150", "+14155550151", "+14155550152"];
/** Case E: the SAME three people, written two different ways. */
const ROSTER_E_PRETTY = ["+1 (415) 555-0160", "+1 (415) 555-0161", "+1 (415) 555-0162"];
const ROSTER_E_BARE = ["4155550160", "4155550161", "4155550162"];
const ROSTER_H = ["+14155550170", "+14155550171", "+14155550172"];
const ROSTER_I = ["+14155550180", "+14155550181", "+14155550182"];

// --- Invented group names ---------------------------------------------------
const NAME_A = "Harborview Close";
const NAME_B = "Cedar Ridge Walkthrough";
const NAME_B_OTHER = "Cedar Point Escrow";
const NAME_C = "Closing Team";
const NAME_D = "Lakeshore Punch List";
const NAME_E = "Birchwood Signing";
const NAME_F = "Weekly Check In";
const NAME_H = "Sunset Terrace Final";
const NAME_I = "Maple Court Repairs";

interface ThreadSpec {
  /** `macos-chat-N` — a distinct Apple chat row, which is the whole problem. */
  thread: string;
  name: string | null;
  /** Group roster. `null` = a 1:1, for which the importer writes NO chat_members. */
  members: string[] | null;
  /** The single other end of a 1:1. */
  peer?: string;
  /** ISO dates, one message per entry. */
  sentAt: string[];
  /** Transaction to link every message to, or null for the unattached bucket. */
  linkTo: string | null;
}

/**
 * Every thread in the fixture. Bodies never contain any query term, so a hit
 * can only have come from the thread NAME — which is what keeps these tests
 * about the thread-name path and not the body path.
 */
const THREADS: ThreadSpec[] = [
  // --- A: one group, two Apple chat rows, SAME members in DIFFERENT ORDER.
  //        The founder's exact case. A2 is newer, so A2's newest message wins.
  { thread: "macos-chat-101", name: NAME_A, members: ROSTER_A,
    sentAt: ["2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z"], linkTo: TXN },
  { thread: "macos-chat-102", name: NAME_A, members: [ROSTER_A[2], ROSTER_A[0], ROSTER_A[1]],
    sentAt: ["2026-06-09T00:00:00.000Z", "2026-06-10T00:00:00.000Z"], linkTo: TXN },

  // --- B: THREE chat rows on one name (sweep, don't sample), plus a DISTINCT
  //        older conversation that also matches "cedar" — the LIMIT control.
  { thread: "macos-chat-201", name: NAME_B, members: ROSTER_B,
    sentAt: ["2026-05-20T00:00:00.000Z"], linkTo: TXN },
  { thread: "macos-chat-202", name: NAME_B, members: [ROSTER_B[1], ROSTER_B[2], ROSTER_B[0]],
    sentAt: ["2026-05-21T00:00:00.000Z"], linkTo: TXN },
  { thread: "macos-chat-203", name: NAME_B, members: [ROSTER_B[2], ROSTER_B[1], ROSTER_B[0]],
    sentAt: ["2026-05-22T00:00:00.000Z"], linkTo: TXN },
  { thread: "macos-chat-204", name: NAME_B_OTHER, members: ROSTER_C2,
    sentAt: ["2026-05-01T00:00:00.000Z"], linkTo: TXN },

  // --- C: THE NEGATIVE. Same name, genuinely different people. Two rows, always.
  { thread: "macos-chat-301", name: NAME_C, members: ROSTER_C1,
    sentAt: ["2026-04-10T00:00:00.000Z"], linkTo: TXN },
  { thread: "macos-chat-302", name: NAME_C, members: ROSTER_C2,
    sentAt: ["2026-04-11T00:00:00.000Z"], linkTo: TXN },

  // --- D: a NAMED thread and an UNNAMED sibling carrying the same roster.
  //        The unnamed one has no `message_thread_names` row, so the name query
  //        cannot reach it however new its messages are.
  { thread: "macos-chat-401", name: NAME_D, members: ROSTER_D,
    sentAt: ["2026-03-10T00:00:00.000Z", "2026-03-11T00:00:00.000Z"], linkTo: TXN },
  { thread: "macos-chat-402", name: null, members: ROSTER_D,
    sentAt: ["2026-03-20T00:00:00.000Z"], linkTo: TXN },

  // --- E: handles that normalize equal but differ textually. Must merge.
  { thread: "macos-chat-501", name: NAME_E, members: ROSTER_E_PRETTY,
    sentAt: ["2026-02-10T00:00:00.000Z"], linkTo: TXN },
  { thread: "macos-chat-502", name: NAME_E, members: ROSTER_E_BARE,
    sentAt: ["2026-02-11T00:00:00.000Z"], linkTo: TXN },

  // --- F: two 1:1 threads sharing a name, different peers. NOT groups: the
  //        importer writes no chat_members, so there is no roster to agree on.
  { thread: "macos-chat-601", name: NAME_F, members: null, peer: "+14155550195",
    sentAt: ["2026-01-10T00:00:00.000Z"], linkTo: TXN },
  { thread: "macos-chat-602", name: NAME_F, members: null, peer: "+14155550196",
    sentAt: ["2026-01-11T00:00:00.000Z"], linkTo: TXN },

  // --- H: siblings linked to DIFFERENT transactions (global attribution).
  { thread: "macos-chat-701", name: NAME_H, members: ROSTER_H,
    sentAt: ["2026-07-01T00:00:00.000Z"], linkTo: TXN },
  { thread: "macos-chat-702", name: NAME_H, members: [ROSTER_H[1], ROSTER_H[0], ROSTER_H[2]],
    sentAt: ["2026-07-05T00:00:00.000Z"], linkTo: TXN2 },

  // --- I: siblings in the UNATTACHED bucket (the third builder).
  { thread: "macos-chat-801", name: NAME_I, members: ROSTER_I,
    sentAt: ["2026-07-10T00:00:00.000Z"], linkTo: null },
  { thread: "macos-chat-802", name: NAME_I, members: [ROSTER_I[2], ROSTER_I[1], ROSTER_I[0]],
    sentAt: ["2026-07-11T00:00:00.000Z"], linkTo: null },
];

/** Deterministic message id: `<thread>#<index>`. */
function msgId(thread: string, i: number): string {
  return `${thread}#${i}`;
}

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  db.exec(V56);
  db.prepare(
    "INSERT INTO users_local (id,email,oauth_provider,oauth_id) VALUES (?,?,'google',?)",
  ).run(USER, "me@example.test", "o-me");
  const insTxn = db.prepare(
    `INSERT INTO transactions (id,user_id,property_address,started_at,closed_at)
     VALUES (?,?,?,?,?)`,
  );
  insTxn.run(TXN, USER, ADDR, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  insTxn.run(TXN2, USER, ADDR2, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");

  const ins = db.prepare(
    `INSERT INTO messages (id,user_id,channel,direction,body_text,participants,
                           participants_flat,thread_id,sent_at,created_at)
     VALUES (?,?,'imessage','inbound',?,?,?,?,?,CURRENT_TIMESTAMP)`,
  );
  const link = db.prepare(
    `INSERT INTO communications (id,user_id,transaction_id,message_id,thread_id,link_source)
     VALUES (?,?,?,?,NULL,'manual')`,
  );
  const insName = db.prepare(
    "INSERT INTO message_thread_names (user_id,thread_id,display_name) VALUES (?,?,?)",
  );

  for (const t of THREADS) {
    const roster = t.members ?? [t.peer as string];
    // A group carries `chat_members`; a 1:1 carries only from/to — exactly what
    // the importer writes, and what makes the 1:1 case un-mergeable by design.
    const participants = t.members
      ? { from: roster[0], to: ["me"], chat_members: t.members }
      : { from: t.peer, to: ["me"] };

    t.sentAt.forEach((when, i) => {
      const id = msgId(t.thread, i);
      // Bodies are deliberately inert: no body contains any query term.
      ins.run(id, USER, `status update ${i}`, JSON.stringify(participants),
        roster.join(","), t.thread, when);
      if (t.linkTo) link.run(`c-${id}`, USER, t.linkTo, id);
    });

    if (t.name) insName.run(USER, t.thread, t.name);
  }
}

describe("BACKLOG-2854 — one conversation split across Apple chat rows is ONE row", () => {
  let db: DatabaseType;
  beforeEach(() => { db = new Database(":memory:"); seed(db); });
  afterEach(() => { db.close(); });

  const sdb = (): SearchableDb => db as unknown as SearchableDb;
  const scoped = (q: string, limit?: number) =>
    searchLinkedContent(sdb(), TXN, q, limit === undefined ? {} : { limit });
  const global = (q: string, limit?: number) =>
    searchGlobalContent(sdb(), USER, q, limit === undefined ? {} : { limit });
  /** Thread-name rows only: they are the ones carrying a display name. */
  const threadRows = <T extends { threadDisplayName?: string }>(items: T[]) =>
    items.filter((i) => i.threadDisplayName !== undefined);

  /**
   * A thread row's roster, ASSERTED present rather than defaulted to `[]` — the
   * hit types make `memberHandles` optional because message rows do not carry
   * one, and a silent `?? []` would let a row that lost its roster pass a
   * comparison against another empty list.
   */
  const members = (row: { memberHandles?: string[] }): string[] => {
    expect(row.memberHandles).toBeDefined();
    return row.memberHandles as string[];
  };

  // =========================================================================
  // THE REPORTED DEFECT
  // =========================================================================
  describe("the founder's case: two chat rows, one group, members in different order", () => {
    it("returns exactly ONE row, and it is the newest message ACROSS both threads", () => {
      const rows = threadRows(scoped("harborview").groupChats.items);
      expect(rows).toHaveLength(1);
      // Identity, not count. A bare length of 1 also passes if the query drops
      // both siblings and returns something unrelated, so pin WHICH row it is.
      expect(rows[0].id).toBe(msgId("macos-chat-102", 1));
      expect(rows[0].threadDisplayName).toBe(NAME_A);
      expect(rows[0].sentAt).toBe("2026-06-10T00:00:00.000Z");
    });

    it("carries the member SET, order-independently — the fingerprint of the bug", () => {
      const rows = threadRows(scoped("harborview").groupChats.items);
      // The winning thread stores the roster in ITS order; assert as a set so
      // the test pins membership rather than an incidental ordering.
      expect([...members(rows[0])].sort()).toEqual([...ROSTER_A].sort());
    });

    it("still shows no body content on the collapsed row", () => {
      const rows = threadRows(scoped("harborview").groupChats.items);
      expect(rows[0].snippet).toBeNull();
      expect(rows[0].sender).toBeNull();
      expect(JSON.stringify(rows[0])).not.toContain("status update");
    });
  });

  // =========================================================================
  // THE NEGATIVE — the case a naive name-only collapse destroys
  // =========================================================================
  describe("two DIFFERENT groups that share a name stay two rows", () => {
    it("keeps both conversations, identified by their distinct rosters", () => {
      const rows = threadRows(scoped("closing team").groupChats.items);
      expect(rows).toHaveLength(2);
      // Both rows carry the same NAME, so name cannot identify them — the
      // roster is what tells the founder these are two different groups.
      expect(rows.map((r) => r.threadDisplayName)).toEqual([NAME_C, NAME_C]);
      expect(rows.map((r) => r.id).sort()).toEqual(
        [msgId("macos-chat-301", 0), msgId("macos-chat-302", 0)].sort(),
      );
      const rosters = rows
        .map((r) => [...members(r)].sort().join("|"))
        .sort();
      expect(rosters).toEqual([[...ROSTER_C1].sort().join("|"), [...ROSTER_C2].sort().join("|")].sort());
    });
  });

  // =========================================================================
  // BOUNDARIES — swept, not sampled
  // =========================================================================
  describe("boundaries", () => {
    it("collapses THREE chat rows on one name to one row (not just two)", () => {
      const rows = threadRows(scoped("cedar ridge").groupChats.items);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(msgId("macos-chat-203", 0)); // newest of the three
      expect(rows[0].threadDisplayName).toBe(NAME_B);
    });

    it("merges handles that normalize equal but are written differently", () => {
      // "+1 (415) 555-0160" and "4155550160" are the same person.
      const rows = threadRows(scoped("birchwood").groupChats.items);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(msgId("macos-chat-502", 0)); // newer sibling wins
      // The winner stores the BARE form; the row shows what that thread stored.
      expect([...members(rows[0])].sort()).toEqual([...ROSTER_E_BARE].sort());
    });

    it("leaves a named thread alone when its unnamed sibling shares the roster", () => {
      // macos-chat-402 has the same people and NEWER messages, but no name row —
      // so the name query never sees it, and the named thread's own newest wins.
      const rows = threadRows(scoped("lakeshore").groupChats.items);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(msgId("macos-chat-401", 1));
      expect(rows[0].sentAt).toBe("2026-03-11T00:00:00.000Z");
    });

    /**
     * SUPERSEDED BY BACKLOG-2858, deliberately.
     *
     * This case used to assert that two named 1:1 threads come back as TWO rows
     * and never merge — correct while thread rows lived in Texts, because a 1:1
     * has no roster to agree on and empty must never match empty.
     *
     * BACKLOG-2858 gave group chats their own category and a 1:1 is not a group
     * chat, so these threads no longer produce a thread row AT ALL. The question
     * "do they merge?" no longer has a surface to be asked on, and the answer
     * this file used to give would now be wrong.
     *
     * `collapseThreadRows`' empty-token-set guard stays in place as defense in
     * depth and is still exercised by unit-level fixtures — this test now pins
     * the stronger property that replaced it.
     */
    it("returns NO row for a named 1:1 — it is not a group chat", () => {
      const res = scoped("weekly check in");
      expect(threadRows(res.groupChats.items)).toEqual([]);
      expect(res.groupChats.hasMore).toBe(false);
      // And it did not fall back into Texts either: assert the ABSENCE in both
      // buckets by identity, because "not in Group chats" alone would also pass
      // if the row had simply moved back where it came from.
      const ids = [...res.groupChats.items, ...res.texts.items].map((r) => r.id);
      expect(ids).not.toContain(msgId("macos-chat-601", 0));
      expect(ids).not.toContain(msgId("macos-chat-602", 0));
    });

    it("returns nothing for a query that matches no thread name", () => {
      expect(threadRows(scoped("nothingmatchesthisname").groupChats.items)).toEqual([]);
    });
  });

  // =========================================================================
  // THE LIMIT CONTROL — collapsing must not let siblings crowd out a
  // genuinely distinct conversation that the LIMIT would otherwise admit.
  // =========================================================================
  describe("sibling rows do not consume the result limit", () => {
    it("keeps a distinct older conversation visible at a limit of 2", () => {
      // "cedar" matches NAME_B (three NEWER sibling rows) and NAME_B_OTHER (one
      // OLDER row). Uncollapsed, SQL `ORDER BY sentAt DESC LIMIT 2` returns two
      // siblings of the same conversation and drops NAME_B_OTHER entirely.
      const rows = threadRows(scoped("cedar", 2).groupChats.items);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.threadDisplayName).sort()).toEqual(
        [NAME_B, NAME_B_OTHER].sort(),
      );
      expect(rows.map((r) => r.id).sort()).toEqual(
        [msgId("macos-chat-203", 0), msgId("macos-chat-204", 0)].sort(),
      );
    });
  });

  // =========================================================================
  // ALL THREE BUILDERS — scoped, global, unattached
  // =========================================================================
  describe("global search", () => {
    it("collapses siblings and carries the WINNER's attribution", () => {
      // The two chat rows are linked to different transactions. The merged row
      // is the newest message, so it must carry THAT message's transaction —
      // otherwise the row names a deal the shown activity did not happen in.
      const rows = threadRows(global("sunset terrace").groupChats.items);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(msgId("macos-chat-702", 0));
      expect((rows[0] as unknown as { attribution: unknown }).attribution).toEqual({
        transactionId: TXN2,
        propertyAddress: ADDR2,
      });
    });

    it("keeps two different groups sharing a name apart in global search too", () => {
      expect(threadRows(global("closing team").groupChats.items)).toHaveLength(2);
    });
  });

  describe("unattached bucket", () => {
    it("collapses siblings that are linked to no transaction at all", () => {
      // BACKLOG-2858 left these rows HERE: the founder asked group chats to stop
      // appearing under Texts, and this bucket is not Texts (its rows are inert).
      const texts = global("maple court").unattached.items.filter((u) => u.kind === "text");
      const rows = threadRows(texts);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(msgId("macos-chat-802", 0));
      expect(rows[0].threadDisplayName).toBe(NAME_I);
    });
  });
});
