/**
 * @jest-environment node
 *
 * BACKLOG-2858 — Group chats is its own search category.
 *
 * ===========================================================================
 * WHAT WAS ASKED FOR
 * ===========================================================================
 * Founder, verbatim: "group chat in the search should show up as a separate
 * category called **Group chats**. (not under texts where it shows now)".
 *
 * BACKLOG-2816 had produced two row shapes and merged them into one `texts`
 * bucket — a THREAD row means "the conversation's NAME matched", a MESSAGE row
 * means "a body or participant matched". They shared a bucket only because
 * nothing had asked otherwise.
 *
 * ===========================================================================
 * THE TWO THINGS THIS FILE IS REALLY FOR
 * ===========================================================================
 * **1. Every "it moved" assertion is made in BOTH directions, by identity.**
 * "The row is in Group chats" passes perfectly well while the same row is ALSO
 * still sitting in Texts — which is not a split, it is a duplication, and it
 * would look like a success in a screenshot. So each of those tests also names
 * the id that must NOT be in the other bucket.
 *
 * **2. The two buckets are asserted on a fixture where their SIZES DIFFER.**
 * Group chats yields one row per CONVERSATION, Texts one per MESSAGE. On a group
 * of three messages those are 1 and 3. Had the fixture been built with one
 * message, both would hold one row and a bucket wired to the wrong source would
 * pass every assertion in this file.
 *
 * BACKLOG-2863 REMOVED THE BADGES these assertions were originally written
 * against — six uncapped `SELECT COUNT(*)` queries were what made a single
 * keystroke slow, and the founder chose "Show more" over a capped "200+". The
 * claims are now made against the ROWS, which is where they were always pinned
 * anyway: every one of them names the ids it expects.
 *
 * ===========================================================================
 * THE BOUNDARY A NAIVE IMPLEMENTATION GETS WRONG
 * ===========================================================================
 * A 1:1 CONVERSATION IS NOT A GROUP CHAT, and "has a display name" does not say
 * so. Apple lets a 1:1 chat carry a name and the importer's name pass does not
 * care: `syncMacChatThreadNames` is fed by `SELECT ROWID, display_name FROM chat
 * WHERE display_name IS NOT NULL` — every named chat, group or not.
 *
 * The roster is the honest test, and the fixtures below are shaped by what the
 * importer actually writes rather than by what would be convenient here:
 * `chat_members` goes into `participants` ONLY when the chat has more than one
 * member, and the list comes from `chat_handle_join JOIN handle`, which holds the
 * OTHER ends and never the account owner. So a 1:1 has NO `chat_members` key at
 * all — not an empty one, not a one-element one. Both of those shapes are swept
 * anyway, below, because a fixture or a future producer could write them.
 *
 * Every group name, person name and handle here is INVENTED, and every number is
 * in the 555-01xx range reserved for fiction. No founder data appears.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
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

const USER = "u-2858";
const TXN = "t-2858";
const ADDR = "18 Kingfisher Lane";

// --- Invented rosters -------------------------------------------------------
const ROSTER_NAMEONLY = ["+14155550110", "+14155550111", "+14155550112"];
const ROSTER_BODY = ["+14155550120", "+14155550121", "+14155550122"];
/** Exactly TWO other members — the smallest thing that is still a group. */
const ROSTER_PAIR = ["+14155550130", "+14155550131"];
const ROSTER_SIBLING = ["+14155550140", "+14155550141", "+14155550142"];
/** Two DIFFERENT groups that happen to share one name. */
const ROSTER_SAME_NAME_1 = ["+14155550150", "+14155550151", "+14155550152"];
const ROSTER_SAME_NAME_2 = ["+14155550160", "+14155550161", "+14155550162"];
const ROSTER_UNATT = ["+14155550170", "+14155550171", "+14155550172"];

// --- Invented group / conversation names ------------------------------------
const NAME_NAMEONLY = "Kingfisher Lane Closing";
const NAME_BODY = "Sandpiper Walk Punch List";
const NAME_PAIR = "Two Person Escrow";
const NAME_SIBLING = "Cedar Ridge Walkthrough";
const NAME_SAME = "Closing Team";
const NAME_SOLO = "Weekly Check In";
const NAME_SOLO_EMPTY = "Monthly Recap";
const NAME_SOLO_ONE = "Quarterly Sync";
const NAME_UNATT_GROUP = "Maple Court Repairs";
const NAME_UNATT_SOLO = "Daily Standup";
const NAME_MALFORMED = "Corrupt Blob Chat";

/**
 * A body that contains no query term used in this file, so a hit on a thread
 * whose messages carry it can ONLY have come from the thread's NAME.
 */
const INERT_BODY = "status update";

/**
 * The `participants` blob shapes, transcribed from the importer rather than
 * invented — see the file header.
 */
type Roster =
  | { kind: "group"; members: string[] }
  /** A real 1:1: `from`/`to` only, NO `chat_members` key. */
  | { kind: "solo"; peer: string }
  /** Shapes the importer does not write today, swept because a fixture could. */
  | { kind: "emptyMembers"; peer: string }
  | { kind: "oneMember"; peer: string }
  | { kind: "malformed"; peer: string };

interface ThreadSpec {
  thread: string;
  name: string | null;
  roster: Roster;
  /** One message per body. */
  bodies: string[];
  /** ISO dates, one per body. */
  sentAt: string[];
  linked: boolean;
}

const THREADS: ThreadSpec[] = [
  // --- The founder's primary case: the NAME matched, no body did.
  {
    thread: "macos-chat-101",
    name: NAME_NAMEONLY,
    roster: { kind: "group", members: ROSTER_NAMEONLY },
    bodies: [INERT_BODY, INERT_BODY],
    sentAt: ["2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z"],
    linked: true,
  },

  // --- The counts-differ case: ONE conversation, THREE matching message bodies.
  //     1 vs 3 is the whole reason this thread exists.
  {
    thread: "macos-chat-201",
    name: NAME_BODY,
    roster: { kind: "group", members: ROSTER_BODY },
    bodies: [
      "sandpiper paperwork is signed",
      "sandpiper keys handed over",
      "sandpiper final walk done",
    ],
    sentAt: [
      "2026-05-20T00:00:00.000Z",
      "2026-05-21T00:00:00.000Z",
      "2026-05-22T00:00:00.000Z",
    ],
    linked: true,
  },

  // --- The smallest real group: exactly two other members.
  {
    thread: "macos-chat-301",
    name: NAME_PAIR,
    roster: { kind: "group", members: ROSTER_PAIR },
    bodies: [INERT_BODY],
    sentAt: ["2026-04-10T00:00:00.000Z"],
    linked: true,
  },

  // --- One conversation, THREE Apple chat rows (BACKLOG-2854). The badge must
  //     say 1: a SQL COUNT over these rows would say 3.
  {
    thread: "macos-chat-401",
    name: NAME_SIBLING,
    roster: { kind: "group", members: ROSTER_SIBLING },
    bodies: [INERT_BODY],
    sentAt: ["2026-03-10T00:00:00.000Z"],
    linked: true,
  },
  {
    thread: "macos-chat-402",
    name: NAME_SIBLING,
    roster: { kind: "group", members: [ROSTER_SIBLING[2], ROSTER_SIBLING[0], ROSTER_SIBLING[1]] },
    bodies: [INERT_BODY],
    sentAt: ["2026-03-11T00:00:00.000Z"],
    linked: true,
  },
  {
    thread: "macos-chat-403",
    name: NAME_SIBLING,
    roster: { kind: "group", members: [ROSTER_SIBLING[1], ROSTER_SIBLING[2], ROSTER_SIBLING[0]] },
    bodies: [INERT_BODY],
    sentAt: ["2026-03-12T00:00:00.000Z"],
    linked: true,
  },

  // --- TWO genuinely different groups sharing one name. The badge must say 2:
  //     the guard against a count that collapses too much.
  {
    thread: "macos-chat-501",
    name: NAME_SAME,
    roster: { kind: "group", members: ROSTER_SAME_NAME_1 },
    bodies: [INERT_BODY],
    sentAt: ["2026-02-10T00:00:00.000Z"],
    linked: true,
  },
  {
    thread: "macos-chat-502",
    name: NAME_SAME,
    roster: { kind: "group", members: ROSTER_SAME_NAME_2 },
    bodies: [INERT_BODY],
    sentAt: ["2026-02-11T00:00:00.000Z"],
    linked: true,
  },

  // --- THE BOUNDARY. Three named 1:1 conversations, swept across all three
  //     roster shapes: none, empty, one. None is a group chat.
  {
    thread: "macos-chat-601",
    name: NAME_SOLO,
    roster: { kind: "solo", peer: "+14155550195" },
    bodies: [INERT_BODY],
    sentAt: ["2026-01-10T00:00:00.000Z"],
    linked: true,
  },
  {
    thread: "macos-chat-602",
    name: NAME_SOLO_EMPTY,
    roster: { kind: "emptyMembers", peer: "+14155550196" },
    bodies: [INERT_BODY],
    sentAt: ["2026-01-11T00:00:00.000Z"],
    linked: true,
  },
  {
    thread: "macos-chat-603",
    name: NAME_SOLO_ONE,
    roster: { kind: "oneMember", peer: "+14155550197" },
    bodies: [INERT_BODY],
    sentAt: ["2026-01-12T00:00:00.000Z"],
    linked: true,
  },

  // --- A malformed participants blob. `json_extract` THROWS on one of these
  //     without the `json_valid` guard, which would take the whole search down.
  {
    thread: "macos-chat-701",
    name: NAME_MALFORMED,
    roster: { kind: "malformed", peer: "+14155550198" },
    bodies: [INERT_BODY],
    sentAt: ["2026-01-05T00:00:00.000Z"],
    linked: true,
  },

  // --- UNATTACHED: a group, and a named 1:1. The 1:1 is the count control.
  {
    thread: "macos-chat-801",
    name: NAME_UNATT_GROUP,
    roster: { kind: "group", members: ROSTER_UNATT },
    bodies: [INERT_BODY, INERT_BODY],
    sentAt: ["2026-07-10T00:00:00.000Z", "2026-07-11T00:00:00.000Z"],
    linked: false,
  },
  {
    thread: "macos-chat-802",
    name: NAME_UNATT_SOLO,
    roster: { kind: "solo", peer: "+14155550199" },
    bodies: [INERT_BODY, INERT_BODY, INERT_BODY],
    sentAt: [
      "2026-07-12T00:00:00.000Z",
      "2026-07-13T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
    ],
    linked: false,
  },
];

/** Deterministic message id: `<thread>#<index>`. */
function msgId(thread: string, i: number): string {
  return `${thread}#${i}`;
}

function participantsBlob(roster: Roster): string {
  switch (roster.kind) {
    case "group":
      return JSON.stringify({
        from: roster.members[0],
        to: ["me"],
        chat_members: roster.members,
      });
    case "solo":
      // Exactly what the importer writes for a two-person chat.
      return JSON.stringify({ from: roster.peer, to: ["me"] });
    case "emptyMembers":
      return JSON.stringify({ from: roster.peer, to: ["me"], chat_members: [] });
    case "oneMember":
      return JSON.stringify({
        from: roster.peer,
        to: ["me"],
        chat_members: [roster.peer],
      });
    case "malformed":
      return '{"from":"' + roster.peer + '","chat_members":[';
  }
}

function rosterHandles(roster: Roster): string[] {
  return roster.kind === "group" ? roster.members : [roster.peer];
}

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  db.exec(V56);
  db.prepare(
    "INSERT INTO users_local (id,email,oauth_provider,oauth_id) VALUES (?,?,'google',?)",
  ).run(USER, "me@example.test", "o-me");
  db.prepare(
    `INSERT INTO transactions (id,user_id,property_address,started_at,closed_at)
     VALUES (?,?,?,?,?)`,
  ).run(TXN, USER, ADDR, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");

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
    const participants = participantsBlob(t.roster);
    const flat = rosterHandles(t.roster).join(",");
    t.bodies.forEach((body, i) => {
      const id = msgId(t.thread, i);
      ins.run(id, USER, body, participants, flat, t.thread, t.sentAt[i]);
      if (t.linked) link.run(`c-${id}`, USER, TXN, id);
    });
    if (t.name) insName.run(USER, t.thread, t.name);
  }
}

describe("BACKLOG-2858 — Group chats is its own category", () => {
  let db: DatabaseType;
  beforeEach(() => {
    db = new Database(":memory:");
    seed(db);
  });
  afterEach(() => {
    db.close();
  });

  const sdb = (): SearchableDb => db as unknown as SearchableDb;
  const scoped = (q: string) => searchLinkedContent(sdb(), TXN, q);
  const global = (q: string) => searchGlobalContent(sdb(), USER, q);
  const ids = <T extends { id: string }>(items: T[]): string[] =>
    items.map((i) => i.id).sort();

  // =========================================================================
  // THE SPLIT — asserted in both directions, because one direction is not a split
  // =========================================================================
  describe("a group-name match lands in Group chats and NOT in Texts", () => {
    it("scoped search: the conversation is in Group chats, by id", () => {
      const res = scoped("kingfisher");
      expect(ids(res.groupChats.items)).toEqual([msgId("macos-chat-101", 1)]);
      expect(res.groupChats.items[0].threadDisplayName).toBe(NAME_NAMEONLY);
    });

    it("scoped search: and that same id is NOT in Texts", () => {
      // The half that catches a duplication rather than a move. Asserting only
      // the presence above would pass while the row sat in both buckets.
      const res = scoped("kingfisher");
      expect(ids(res.texts.items)).not.toContain(msgId("macos-chat-101", 1));
      expect(res.texts.items).toEqual([]);
    });

    it("global search: same split, and the row keeps its attribution", () => {
      const res = global("kingfisher");
      expect(ids(res.groupChats.items)).toEqual([msgId("macos-chat-101", 1)]);
      expect(res.groupChats.items[0].attribution).toEqual({
        transactionId: TXN,
        propertyAddress: ADDR,
      });
      expect(ids(res.texts.items)).not.toContain(msgId("macos-chat-101", 1));
      expect(res.texts.items).toEqual([]);
    });

    it("carries no body content into the new category either", () => {
      const hit = scoped("kingfisher").groupChats.items[0];
      expect(hit.snippet).toBeNull();
      expect(hit.sender).toBeNull();
      expect(JSON.stringify(hit)).not.toContain(INERT_BODY);
    });
  });

  // =========================================================================
  // TEXTS KEEPS WHAT IS ACTUALLY A TEXT
  // =========================================================================
  describe("a body match inside a group chat is still a Texts row", () => {
    it("returns one MESSAGE row per matching body, in Texts", () => {
      const res = scoped("sandpiper");
      expect(ids(res.texts.items)).toEqual([
        msgId("macos-chat-201", 0),
        msgId("macos-chat-201", 1),
        msgId("macos-chat-201", 2),
      ]);
      // Message rows, not conversation rows: no thread name on any of them.
      expect(res.texts.items.every((t) => t.threadDisplayName === undefined)).toBe(true);
      expect(res.texts.items.every((t) => t.snippet !== null)).toBe(true);
    });

    it("and the conversation itself still appears once under Group chats", () => {
      // The same query legitimately hits BOTH buckets: the name matched AND
      // three bodies did. They are different answers to the same question.
      const res = scoped("sandpiper");
      expect(ids(res.groupChats.items)).toEqual([msgId("macos-chat-201", 2)]);
    });
  });

  // =========================================================================
  // THE TWO BUCKETS — on a fixture where their SIZES DIFFER
  // =========================================================================
  describe("each bucket holds the rows that belong to it", () => {
    it("Group chats holds ONE conversation while Texts holds THREE messages", () => {
      const res = scoped("sandpiper");
      expect(res.groupChats.items).toHaveLength(1);
      expect(res.texts.items).toHaveLength(3);
    });

    it("global search splits them the same way", () => {
      const res = global("sandpiper");
      expect(res.groupChats.items).toHaveLength(1);
      expect(res.texts.items).toHaveLength(3);
    });

    it("yields ONE row for a group split across three Apple chat rows", () => {
      // The query returns three — one per thread_id. Only the JS collapse knows
      // they are one conversation, which is why this group's size is decided
      // after the collapse and never in SQL.
      const res = scoped("cedar ridge");
      expect(ids(res.groupChats.items)).toEqual([msgId("macos-chat-403", 0)]);
      expect(res.groupChats.items).toHaveLength(1);
    });

    it("yields TWO rows for two different groups sharing a name", () => {
      // The guard on the other side: a collapse keyed on NAME alone would merge
      // these into one and hide a real conversation.
      const res = scoped("closing team");
      expect(ids(res.groupChats.items)).toEqual(
        [msgId("macos-chat-501", 0), msgId("macos-chat-502", 0)].sort(),
      );
      expect(res.groupChats.items).toHaveLength(2);
    });

    it("no longer puts a name-only match into Texts", () => {
      // Before BACKLOG-2858 every message in the name-matching thread landed
      // here, under a heading whose list was empty.
      expect(scoped("kingfisher").texts.items).toEqual([]);
      expect(global("kingfisher").texts.items).toEqual([]);
    });
  });

  // =========================================================================
  // THE BOUNDARY — a 1:1 is not a group chat, in any of its roster shapes
  // =========================================================================
  describe("a named 1:1 conversation is in NEITHER bucket", () => {
    const soloCases: Array<[string, string, string]> = [
      ["no chat_members key (what the importer writes)", "weekly check in", "macos-chat-601"],
      ["an EMPTY chat_members array", "monthly recap", "macos-chat-602"],
      ["a ONE-element chat_members array", "quarterly sync", "macos-chat-603"],
    ];

    it.each(soloCases)("%s", (_label, query, thread) => {
      const res = scoped(query);
      // Its name matched a thread name — it just is not a group.
      expect(res.groupChats.items).toEqual([]);
      // And it did not fall back into Texts: absence asserted by identity in
      // both buckets, since "not in Group chats" alone would also pass if the
      // row had simply gone back where it came from.
      const everywhere = [...res.groupChats.items, ...res.texts.items].map((r) => r.id);
      expect(everywhere).not.toContain(msgId(thread, 0));
      expect(res.texts.items).toEqual([]);
    });

    it("does not appear as a thread row in GLOBAL search either", () => {
      const res = global("weekly check in");
      expect(res.groupChats.items).toEqual([]);
      expect(res.texts.items).toEqual([]);
    });

    it("still finds that 1:1's MESSAGES when a body or participant matches", () => {
      // Dropping the thread row must not make the conversation unfindable.
      const res = scoped("5550195");
      expect(ids(res.texts.items)).toEqual([msgId("macos-chat-601", 0)]);
    });

    it("keeps a two-member group IN — the smallest thing that is still a group", () => {
      // Sweep the boundary from the other side: >= 2 must admit exactly 2.
      const res = scoped("two person escrow");
      expect(ids(res.groupChats.items)).toEqual([msgId("macos-chat-301", 0)]);
      expect(res.groupChats.items).toHaveLength(1);
    });
  });

  // =========================================================================
  // A MALFORMED BLOB MUST NOT TAKE THE SEARCH DOWN
  // =========================================================================
  it("survives a malformed participants blob instead of throwing", () => {
    // `json_extract` raises `malformed JSON` on this row; only the `json_valid`
    // guard in front of it keeps the whole query from failing. Without the
    // guard this test does not fail an assertion — it ERRORS.
    expect(() => scoped("corrupt blob")).not.toThrow();
    const res = scoped("corrupt blob");
    expect(res.groupChats.items).toEqual([]);
    // And it does not poison an unrelated search either.
    expect(() => scoped("kingfisher")).not.toThrow();
    expect(scoped("kingfisher").groupChats.items).toHaveLength(1);
  });

  // =========================================================================
  // EMPTY STATES — a heading over nothing is a dead control (BACKLOG-2791)
  // =========================================================================
  describe("a bucket with nothing in it reports nothing", () => {
    it("Group chats is empty for a body-only match", () => {
      // "sandpiper paperwork" is in a body and in no group name. BACKLOG-2863
      // gates the heading on `items.length`, so an empty list renders no heading.
      const res = scoped("paperwork");
      expect(res.groupChats.items).toEqual([]);
      expect(res.groupChats.hasMore).toBe(false);
      expect(res.texts.items).toHaveLength(1);
    });

    it("Texts is empty for a name-only match", () => {
      const res = scoped("kingfisher");
      expect(res.texts.items).toEqual([]);
      expect(res.texts.hasMore).toBe(false);
      expect(res.groupChats.items).toHaveLength(1);
    });

    it("both are empty for a query that matches nothing at all", () => {
      const res = scoped("nothingmatchesthisanywhere");
      expect(res.groupChats.items).toEqual([]);
      expect(res.texts.items).toEqual([]);
      // Neither may claim there is more behind an empty list — that would offer
      // "Show more" over nothing.
      expect(res.groupChats.hasMore).toBe(false);
      expect(res.texts.hasMore).toBe(false);
    });

    it("an empty query short-circuits to empty groups", () => {
      const res = scoped("   ");
      expect(res.groupChats).toEqual({ items: [], hasMore: false });
      expect(res.texts).toEqual({ items: [], hasMore: false });
    });
  });

  // =========================================================================
  // THE THIRD BUILDER — the unattached bucket
  // =========================================================================
  describe("the unattached bucket", () => {
    it("keeps an unattached GROUP's conversation row in this bucket", () => {
      // BACKLOG-2858 deliberately left these rows here rather than hoisting them
      // into Group chats: the founder asked group chats to stop appearing under
      // TEXTS, and this bucket is not Texts. Its rows are inert (no standalone
      // viewer), so a navigable Group chats section is the wrong home for them.
      const res = global("maple court");
      const rows = res.unattached.items.filter((u) => u.threadDisplayName !== undefined);
      expect(ids(rows)).toEqual([msgId("macos-chat-801", 1)]);
      expect(rows[0].threadDisplayName).toBe(NAME_UNATT_GROUP);
      // It is NOT also in the Group chats category.
      expect(ids(res.groupChats.items)).not.toContain(msgId("macos-chat-801", 1));
      expect(res.groupChats.items).toEqual([]);
    });

    it("applies the 1:1 rule here too — no row anywhere", () => {
      // Until BACKLOG-2863 this bucket's COUNT carried a thread-name clause the
      // rows did not, and the risk it guarded was a named 1:1 contributing all
      // three of its messages to a badge with nothing beneath it. The count is
      // gone and so is the asymmetry; what remains to assert is that the named
      // 1:1 produces no row on any surface.
      const res = global("daily standup");
      expect(res.unattached.items).toEqual([]);
      expect(res.unattached.hasMore).toBe(false);
      expect(res.groupChats.items).toEqual([]);
    });
  });
});
