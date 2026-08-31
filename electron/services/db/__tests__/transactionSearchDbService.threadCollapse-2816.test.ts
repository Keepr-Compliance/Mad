/**
 * @jest-environment node
 *
 * BACKLOG-2816 (founder test, 2026-08-23) — a group-name match is ONE result.
 *
 * ===========================================================================
 * WHAT WENT WRONG, AND WHY THE FIX IS SHAPED THIS WAY
 * ===========================================================================
 * The group-name predicate matched at THREAD level while the result set was at
 * MESSAGE level, so one named conversation with 546 messages produced 546 rows,
 * each headed by a raw phone number. Measured on this branch's base: a
 * phone-number search floods identically, so the over-listing is PRE-EXISTING —
 * but the group name is the first human-readable thread-level match target, so
 * it is what made the defect reachable.
 *
 * Founder's rulings, all three of which this suite pins:
 *   1. Only the GROUP-NAME case collapses. A body-word match keeps its
 *      per-message rows ("for now don't bother"). Two row shapes in one list is
 *      the accepted outcome, so it is asserted here rather than left to chance.
 *   2. A group-name row shows the group NAME and "a few of the members ... with
 *      name not numbers" — and NOTHING from any message body.
 *   3. The count badge is unchanged: a text total still counts MESSAGES.
 *
 * Every group name, person name and handle below is invented.
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
`;

const USER = "u-collapse";
const TXN = "t-collapse";
const GROUP_NAME = "Kingfisher Lane Closing";
const NAME_QUERY = "kingfisher";

/** The named group's members — invented handles. */
const MEMBERS = ["+14155550100", "+14155550101", "+14155550102", "+14155550103"];
/** How many messages the named thread holds. The founder's real case was 546. */
const N = 25;

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  db.exec(V56);
  db.prepare(
    "INSERT INTO users_local (id,email,oauth_provider,oauth_id) VALUES (?,?,'google',?)",
  ).run(USER, "me@example.test", "o-me");
  db.prepare(
    `INSERT INTO transactions (id,user_id,property_address,started_at,closed_at)
     VALUES (?,?,?,?,?)`,
  ).run(TXN, USER, "1 Test St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");

  const ins = db.prepare(
    `INSERT INTO messages (id,user_id,channel,direction,body_text,participants,
                           participants_flat,thread_id,sent_at,created_at)
     VALUES (?,?,'imessage','inbound',?,?,?,?,?,CURRENT_TIMESTAMP)`,
  );
  const link = db.prepare(
    `INSERT INTO communications (id,user_id,transaction_id,message_id,thread_id,link_source)
     VALUES (?,?,?,?,NULL,'manual')`,
  );
  const add = (
    id: string, thread: string, body: string, members: string[], sentAt: string,
    linked: boolean,
  ): void => {
    ins.run(id, USER, body,
      JSON.stringify({ from: members[0], to: ["me"], chat_members: members }),
      members.join(","), thread, sentAt);
    if (linked) link.run(`c-${id}`, USER, TXN, id);
  };

  // The named group. NOTHING in any body matches NAME_QUERY.
  for (let i = 0; i < N; i++) {
    add(`m-named-${i}`, "th-named", `routine message ${i}`, MEMBERS,
      `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`, true);
  }
  // A body-word thread: three messages, all containing "walkthrough".
  for (let i = 0; i < 3; i++) {
    add(`m-body-${i}`, "th-body", `walkthrough at noon ${i}`, ["+14155550190"],
      `2026-05-0${i + 1}T00:00:00.000Z`, true);
  }
  // An UNATTACHED named group.
  for (let i = 0; i < 4; i++) {
    add(`m-un-${i}`, "th-un-named", `routine ${i}`, MEMBERS,
      `2026-04-0${i + 1}T00:00:00.000Z`, false);
  }

  const insName = db.prepare(
    "INSERT INTO message_thread_names (user_id,thread_id,display_name) VALUES (?,?,?)",
  );
  insName.run(USER, "th-named", GROUP_NAME);
  insName.run(USER, "th-un-named", GROUP_NAME);
}

describe("BACKLOG-2816 — a group-name match collapses to one conversation", () => {
  let db: DatabaseType;
  beforeEach(() => { db = new Database(":memory:"); seed(db); });
  afterEach(() => { db.close(); });

  const sdb = (): SearchableDb => db as unknown as SearchableDb;
  const scoped = (q: string, limit?: number) =>
    searchLinkedContent(sdb(), TXN, q, limit ? { limit } : {});
  const global = (q: string, limit?: number) =>
    searchGlobalContent(sdb(), USER, q, limit ? { limit } : {});

  describe("transaction-scoped search", () => {
    it("returns exactly ONE row for a named group of many messages", () => {
      const items = scoped(NAME_QUERY).groupChats.items;
      expect(items).toHaveLength(1);
      // By identity, not count: the row is the thread's NEWEST message.
      expect(items[0].id).toBe("m-named-24");
      expect(items[0].threadDisplayName).toBe(GROUP_NAME);
    });

    it("carries NO body text on that row — nothing in a body matched", () => {
      const hit = scoped(NAME_QUERY).groupChats.items[0];
      expect(hit.snippet).toBeNull();
      expect(hit.sender).toBeNull();
      // Assert ABSENCE explicitly so a future snippet cannot creep back in.
      expect(JSON.stringify(hit)).not.toContain("routine message");
    });

    it("offers a few members BY HANDLE for the caller to resolve, capped", () => {
      const hit = scoped(NAME_QUERY).groupChats.items[0];
      expect(hit.memberHandles).toEqual(MEMBERS.slice(0, 3));
      expect(hit.memberHandles).not.toContain("me");
    });

    it("leaves a body-word match as one row PER MESSAGE (founder's choice)", () => {
      const items = scoped("walkthrough").texts.items;
      expect(items.map((t) => t.id).sort()).toEqual(["m-body-0", "m-body-1", "m-body-2"]);
      // Message rows keep their body and sender; they are the other shape.
      expect(items.every((t) => t.snippet !== null)).toBe(true);
      expect(items.every((t) => t.threadDisplayName === undefined)).toBe(true);
    });

    /**
     * SUPERSEDED BY BACKLOG-2858, deliberately.
     *
     * The founder chose "don't bother changing that" while ONE bucket held both
     * row shapes: 25 message rows had been collapsed to one, and the badge kept
     * reporting the 25 messages that were really there. Splitting the buckets
     * makes that number indefensible — the Group chats badge sits over a list of
     * CONVERSATIONS, and the messages it used to count are not in it.
     *
     * Both numbers are asserted here, on ONE fixture where they DIFFER (1 vs 25).
     * Equal numbers would let a badge wired to the wrong source pass.
     */
    it("puts ONE CONVERSATION under Group chats and the MESSAGES under Texts", () => {
      // BACKLOG-2863 removed the badges these assertions used to read, so the
      // claim is now made against the ROWS. It is the same claim: before
      // BACKLOG-2858 this fixture put 25 message rows and a 25 badge under a
      // heading whose list held one conversation.
      const res = scoped(NAME_QUERY);
      expect(res.groupChats.items).toHaveLength(1);
      // Nothing in any of the 25 bodies matched "kingfisher", so Texts is empty.
      expect(res.texts.items).toEqual([]);
      // The 25 messages are real and still findable; only the ROUTE changed. The
      // limit is raised past 25 so this names all of them rather than a page.
      expect(scoped("routine message", 50).texts.items).toHaveLength(N);
    });

    it("does not leave the conversation row in Texts as well", () => {
      // The whole point of the split, asserted by IDENTITY in BOTH directions —
      // "it appears in Group chats" alone passes while the row is duplicated.
      const res = scoped(NAME_QUERY);
      expect(res.groupChats.items.map((t) => t.id)).toEqual(["m-named-24"]);
      expect(res.texts.items.map((t) => t.id)).not.toContain("m-named-24");
    });
  });

  describe("global search", () => {
    it("returns exactly ONE row for the named group, with attribution", () => {
      const items = global(NAME_QUERY).groupChats.items;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("m-named-24");
      expect(items[0].threadDisplayName).toBe(GROUP_NAME);
      expect(items[0].attribution).toEqual({
        transactionId: TXN,
        propertyAddress: "1 Test St",
      });
    });

    it("carries no body text, and yields conversations rather than messages", () => {
      const res = global(NAME_QUERY);
      expect(res.groupChats.items[0].snippet).toBeNull();
      expect(res.groupChats.items).toHaveLength(1);
      expect(res.texts.items).toEqual([]);
      expect(res.texts.items.map((t) => t.id)).not.toContain("m-named-24");
    });

    it("leaves a body-word match as one row per message", () => {
      expect(global("walkthrough").texts.items.map((t) => t.id).sort())
        .toEqual(["m-body-0", "m-body-1", "m-body-2"]);
    });

    it("collapses an UNATTACHED named group to one row too", () => {
      const texts = global(NAME_QUERY).unattached.items.filter((u) => u.kind === "text");
      expect(texts).toHaveLength(1);
      expect(texts[0].id).toBe("m-un-3");
      expect(texts[0].threadDisplayName).toBe(GROUP_NAME);
      expect(texts[0].snippet).toBeNull();
    });
  });

  it("a query matching nothing still returns nothing", () => {
    expect(scoped("nothingmatchesthis").texts.items).toEqual([]);
    expect(scoped("nothingmatchesthis").texts.hasMore).toBe(false);
    expect(scoped("nothingmatchesthis").groupChats.items).toEqual([]);
    expect(scoped("nothingmatchesthis").groupChats.hasMore).toBe(false);
  });

  it("leaves Group chats EMPTY for a body-only match, so its heading never renders", () => {
    // The other half of the empty-state rule: a section that has nothing to show
    // must report nothing, and BACKLOG-2863 gates the heading on exactly this —
    // the rows. "walkthrough" appears in three BODIES and in no group name.
    const res = scoped("walkthrough");
    expect(res.groupChats.items).toEqual([]);
    expect(res.groupChats.hasMore).toBe(false);
    expect(res.texts.items).toHaveLength(3);
  });
});
