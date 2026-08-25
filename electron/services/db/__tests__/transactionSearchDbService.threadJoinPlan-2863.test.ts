/**
 * @jest-environment node
 *
 * BACKLOG-2863 — the global group-chat-name query drives `tn -> messages`.
 *
 * ===========================================================================
 * WHAT BROKE
 * ===========================================================================
 * Founder: *"it doesn't wait enough time to let a user type the next character so
 * it gets stuck — if you type m for modern it starts search just for the m which
 * gets the app stuck."*
 *
 * `buildGlobalTextThreadNameQuery` JOINed a materialized `link` table — every
 * transaction-linked message in the database, ROW_NUMBER-ranked — and SQLite
 * chose to DRIVE the query through it:
 *
 *     SCAN tn
 *     SEARCH rankedLink USING AUTOMATIC PARTIAL COVERING INDEX (rn=?)
 *     SEARCH m USING INDEX sqlite_autoindex_messages_1 (id=?)
 *
 * One probe per message inside every matching named thread. At ONE character
 * nearly every named group chat matches, so a single keystroke walked every
 * message in every named conversation.
 *
 * ===========================================================================
 * WHAT THIS FILE IS FOR: IDENTITY IS THE DELIVERABLE
 * ===========================================================================
 * A faster search that returns different results is not the fix. So the OLD
 * query is FROZEN below, character for character, and run beside the live
 * builder on one fixture across a corpus of terms. The assertions are on the
 * ORDERED id list and on the attribution of every id — not on counts, which two
 * different result sets can agree on.
 *
 * THE FROZEN COPY DOES NOT IMPORT THE LIVE CONSTANTS, and that is the point
 * (precedent: `contactSourceLinkSql.frozenCopy-2664.test.ts`). `reactionExclusion`
 * and the group-roster predicate are inlined as literal text, so a future edit to
 * either one turns this file red and someone has to decide whether the behaviour
 * change was intended, rather than having both sides of the comparison move
 * together and agree about nothing.
 *
 * ===========================================================================
 * THE BOUNDARIES THIS FIXTURE IS BUILT AROUND
 * ===========================================================================
 * Every one of these is a way a plausible rewrite goes wrong while still looking
 * faster, and each is named in `THREADS` below:
 *
 *   1. **A thread whose NEWEST message is not linked** (`T2`). The old ROW_NUMBER
 *      ranked only link-joined rows, so the representative is the newest LINKED
 *      message, not the newest message. A rewrite that ranks first and filters
 *      afterwards loses the whole conversation.
 *   2. **A message with BOTH a direct and a thread-batch link** (`T3`), whose
 *      earliest-linked one is the direct link to the OTHER transaction. Picks up
 *      an attribution that reads from the wrong UNION branch.
 *   3. **A link row with a NULL `transaction_id`** (`T4`). `createCommunication`
 *      writes `transaction_id || null` — content can be linked before its
 *      transaction exists — and the old query excluded such rows twice over
 *      (`transaction_id IS NOT NULL`, then an INNER `JOIN transactions`). This is
 *      the case that makes the `JOIN transactions` inside the new EXISTS
 *      load-bearing rather than decorative, and it is the mutation the red
 *      control below removes.
 *   4. A named 1:1 (`T5`), a reaction-only thread (`T6`), and an unlinked named
 *      group (`T7`) — each excluded for its own reason.
 *   5. Two Apple chat rows for one conversation (`T8a`/`T8b`, BACKLOG-2854). Both
 *      must come back RAW; collapsing them is the JS caller's job, and a query
 *      that merged them here would hide the defect that motivated the collapse.
 *
 * Every group name, handle and address is INVENTED; numbers are in the 555-01xx
 * range reserved for fiction. No founder data appears.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";

import {
  buildGlobalTextThreadNameQuery,
  buildThreadNameAttributionQuery,
  buildTextThreadNameQuery,
  buildUnattachedTextThreadNameQuery,
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

const USER = "u-2863";
const TXN_A = "txn-alderman";
const TXN_B = "txn-bramble";
const ADDR_A = "12 Alderman Way";
const ADDR_B = "34 Bramble Court";

// ---------------------------------------------------------------------------
// THE FROZEN QUERY — `buildGlobalTextThreadNameQuery` as it stood at
// int/ui-polish-e @ c730f605a, before BACKLOG-2863. Transcribed, not rewritten.
// ---------------------------------------------------------------------------
const FROZEN_REACTION_EXCLUSION =
  "(m.associated_message_type IS NULL OR m.associated_message_type NOT BETWEEN 2000 AND 3005)";
const FROZEN_GROUP_THREAD_PREDICATE = `json_valid(m.participants)
      AND json_array_length(json_extract(m.participants, '$.chat_members')) >= 2`;

function frozenGlobalThreadNameQuery(
  userId: string,
  rawQuery: string,
): { sql: string; params: unknown[] } {
  const pat = `%${rawQuery.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  const ranked = `
    SELECT m.id AS id, m.participants AS participants, m.sent_at AS sentAt,
           tn.display_name AS threadDisplayName,
           link.attrTxnId AS attrTxnId, link.attrAddress AS attrAddress,
           ROW_NUMBER() OVER (
             PARTITION BY m.thread_id
             ORDER BY m.sent_at DESC, m.id ASC
           ) AS rn
    FROM messages m
    JOIN message_thread_names tn
      ON tn.thread_id = m.thread_id AND tn.user_id = m.user_id
    JOIN (
      SELECT msg_id, transaction_id AS attrTxnId, property_address AS attrAddress
      FROM (
        SELECT ml.msg_id AS msg_id, ml.transaction_id AS transaction_id,
               t.property_address AS property_address,
               ROW_NUMBER() OVER (
                 PARTITION BY ml.msg_id
                 ORDER BY ml.linked_at ASC, ml.comm_id ASC
               ) AS rn
        FROM (
          SELECT comm.message_id AS msg_id, comm.transaction_id AS transaction_id,
                 comm.linked_at AS linked_at, comm.id AS comm_id
          FROM communications comm
          WHERE comm.message_id IS NOT NULL AND comm.transaction_id IS NOT NULL
          UNION ALL
          SELECT m3.id AS msg_id, comm3.transaction_id AS transaction_id,
                 comm3.linked_at AS linked_at, comm3.id AS comm_id
          FROM messages m3
          JOIN communications comm3 ON comm3.thread_id = m3.thread_id
          WHERE comm3.message_id IS NULL
            AND comm3.email_id IS NULL
            AND comm3.thread_id IS NOT NULL
            AND comm3.transaction_id IS NOT NULL
        ) ml
        JOIN transactions t ON t.id = ml.transaction_id
      ) rankedLink
      WHERE rankedLink.rn = 1
    ) link ON link.msg_id = m.id
    WHERE m.user_id = ?
      AND m.channel IN ('sms', 'imessage')
      AND ${FROZEN_REACTION_EXCLUSION}
      AND ${FROZEN_GROUP_THREAD_PREDICATE}
      AND tn.display_name LIKE ? ESCAPE '\\'`;

  return {
    sql: `
    SELECT id, participants, sentAt, threadDisplayName, attrTxnId, attrAddress
    FROM (${ranked})
    WHERE rn = 1
    ORDER BY sentAt DESC`,
    params: [userId, pat],
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  sentAt: string | null;
  threadDisplayName: string | null;
  attrTxnId: string | null;
  attrAddress: string | null;
}

const ROSTER_1 = ["+14155550101", "+14155550102", "+14155550103"];
const ROSTER_2 = ["+14155550111", "+14155550112", "+14155550113"];
const ROSTER_3 = ["+14155550121", "+14155550122", "+14155550123"];
const ROSTER_4 = ["+14155550131", "+14155550132", "+14155550133"];
const ROSTER_6 = ["+14155550151", "+14155550152", "+14155550153"];
const ROSTER_7 = ["+14155550161", "+14155550162", "+14155550163"];
/** T8a and T8b are ONE conversation across two Apple chat rows. */
const ROSTER_8 = ["+14155550171", "+14155550172", "+14155550173"];
const ROSTER_9 = ["+14155550181", "+14155550182", "+14155550183"];

function groupParticipants(members: string[]): string {
  return JSON.stringify({ from: members[0], to: members.slice(1), chat_members: members });
}
function soloParticipants(peer: string): string {
  return JSON.stringify({ from: peer, to: ["me"] });
}

let db: DatabaseType;

beforeAll(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = ON"); // as production opens it (databaseService.ts)
  db.exec(SCHEMA);
  db.exec(V56);

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'oauth-2863')`,
  ).run(USER, "agent@example.invalid");
  const insTxn = db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, status) VALUES (?, ?, ?, 'active')`,
  );
  insTxn.run(TXN_A, USER, ADDR_A);
  insTxn.run(TXN_B, USER, ADDR_B);

  const insName = db.prepare(
    `INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?, ?, ?)`,
  );
  const insMsg = db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants,
       participants_flat, thread_id, sent_at, associated_message_type)
     VALUES (?, ?, 'imessage', 'inbound', ?, ?, ?, ?, ?, ?)`,
  );
  const insComm = db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, email_id, thread_id,
       link_source, linked_at) VALUES (?, ?, ?, ?, ?, ?, 'auto', ?)`,
  );

  /** A body carrying no term this file searches for — a hit can only be the NAME. */
  const INERT = "status update";

  // T1 — plain case: thread-level link, newest message represents.
  insName.run(USER, "macos-chat-2101", "Alderman Way Closing");
  insMsg.run("m-101", USER, INERT, groupParticipants(ROSTER_1), ROSTER_1.join(", "), "macos-chat-2101", "2026-06-01T00:00:00.000Z", null);
  insMsg.run("m-102", USER, INERT, groupParticipants(ROSTER_1), ROSTER_1.join(", "), "macos-chat-2101", "2026-06-02T00:00:00.000Z", null);
  insComm.run("c-101", USER, TXN_A, null, null, "macos-chat-2101", "2026-01-01T00:00:00.000Z");

  // T2 — the NEWEST message is NOT linked. Representative must be the older,
  // LINKED one. No thread-level row: only m-111 carries a direct link.
  insName.run(USER, "macos-chat-2102", "Bramble Court Punch List");
  insMsg.run("m-111", USER, INERT, groupParticipants(ROSTER_2), ROSTER_2.join(", "), "macos-chat-2102", "2026-05-01T00:00:00.000Z", null);
  insMsg.run("m-112", USER, INERT, groupParticipants(ROSTER_2), ROSTER_2.join(", "), "macos-chat-2102", "2026-05-02T00:00:00.000Z", null);
  insComm.run("c-111", USER, TXN_B, "m-111", null, null, "2026-01-02T00:00:00.000Z");

  // T3 — the representative has BOTH links. The DIRECT one to TXN_A is earlier,
  // so TXN_A wins; a rewrite reading the wrong branch reports TXN_B.
  insName.run(USER, "macos-chat-2103", "Cobblestone Way Escrow");
  insMsg.run("m-121", USER, INERT, groupParticipants(ROSTER_3), ROSTER_3.join(", "), "macos-chat-2103", "2026-04-01T00:00:00.000Z", null);
  insComm.run("c-121", USER, TXN_A, "m-121", null, null, "2026-01-03T00:00:00.000Z");
  insComm.run("c-122", USER, TXN_B, null, null, "macos-chat-2103", "2026-02-01T00:00:00.000Z");

  // T4 — linked, but to NOTHING: `transaction_id` is NULL. Must never surface.
  insName.run(USER, "macos-chat-2104", "Dovetail Lane Repairs");
  insMsg.run("m-131", USER, INERT, groupParticipants(ROSTER_4), ROSTER_4.join(", "), "macos-chat-2104", "2026-03-01T00:00:00.000Z", null);
  insComm.run("c-131", USER, null, "m-131", null, null, "2026-01-04T00:00:00.000Z");

  // T5 — a NAMED 1:1. No `chat_members`, so not a group chat.
  insName.run(USER, "macos-chat-2105", "Everly Terrace Sync");
  insMsg.run("m-141", USER, INERT, soloParticipants("+14155550141"), "+14155550141", "macos-chat-2105", "2026-03-02T00:00:00.000Z", null);
  insComm.run("c-141", USER, TXN_A, null, null, "macos-chat-2105", "2026-01-05T00:00:00.000Z");

  // T6 — every message is a tapback (BACKLOG-2280 band).
  insName.run(USER, "macos-chat-2106", "Foxglove Walk Review");
  insMsg.run("m-151", USER, INERT, groupParticipants(ROSTER_6), ROSTER_6.join(", "), "macos-chat-2106", "2026-03-03T00:00:00.000Z", 2000);
  insComm.run("c-151", USER, TXN_A, null, null, "macos-chat-2106", "2026-01-06T00:00:00.000Z");

  // T7 — a named group with NO link at all: belongs to the unattached bucket.
  insName.run(USER, "macos-chat-2107", "Granite Way Meetup");
  insMsg.run("m-161", USER, INERT, groupParticipants(ROSTER_7), ROSTER_7.join(", "), "macos-chat-2107", "2026-03-04T00:00:00.000Z", null);

  // T8a / T8b — one conversation, two Apple chat rows. BOTH must come back raw.
  insName.run(USER, "macos-chat-2108", "Harbor Point Closing");
  insMsg.run("m-171", USER, INERT, groupParticipants(ROSTER_8), ROSTER_8.join(", "), "macos-chat-2108", "2026-02-10T00:00:00.000Z", null);
  insComm.run("c-171", USER, TXN_A, null, null, "macos-chat-2108", "2026-01-07T00:00:00.000Z");
  insName.run(USER, "macos-chat-2109", "Harbor Point Closing");
  insMsg.run("m-181", USER, INERT, groupParticipants([ROSTER_8[2], ROSTER_8[0], ROSTER_8[1]]), ROSTER_8.join(", "), "macos-chat-2109", "2026-02-11T00:00:00.000Z", null);
  insComm.run("c-181", USER, TXN_B, null, null, "macos-chat-2109", "2026-01-08T00:00:00.000Z");

  // T9 — the rare-term case.
  insName.run(USER, "macos-chat-2110", "Quillon Bend Closing");
  insMsg.run("m-191", USER, INERT, groupParticipants(ROSTER_9), ROSTER_9.join(", "), "macos-chat-2110", "2026-01-20T00:00:00.000Z", null);
  insComm.run("c-191", USER, TXN_A, null, null, "macos-chat-2110", "2026-01-09T00:00:00.000Z");
});

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

function runFrozen(term: string): Row[] {
  const q = frozenGlobalThreadNameQuery(USER, term);
  return db.prepare(q.sql).all(...(q.params as never[])) as Row[];
}

/**
 * The live path, assembled exactly as `searchGlobalContent` assembles it: the row
 * query, then one attribution lookup per row.
 */
function runLive(term: string): Row[] {
  const q = buildGlobalTextThreadNameQuery(USER, term);
  const rows = db.prepare(q.sql).all(...(q.params as never[])) as Omit<
    Row,
    "attrTxnId" | "attrAddress"
  >[];
  return rows.map((r) => {
    const a = buildThreadNameAttributionQuery(r.id);
    const attr = db.prepare(a.sql).get(...(a.params as never[])) as
      | { attrTxnId: string | null; attrAddress: string | null }
      | undefined;
    return {
      ...r,
      attrTxnId: attr?.attrTxnId ?? null,
      attrAddress: attr?.attrAddress ?? null,
    };
  });
}

/**
 * Compare in JS, never by piping sorted lists through `comm`: JS `.sort()` orders
 * by UTF-16 code unit and `comm` under a non-C locale emits differences that are
 * not there.
 */
function idList(rows: Row[]): string[] {
  return rows.map((r) => r.id);
}
function attributionMap(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) out[r.id] = `${r.attrTxnId ?? "∅"}|${r.attrAddress ?? "∅"}`;
  return out;
}

/**
 * The corpus: the 1-character term that froze the app, a 2- and 3-character
 * prefix of a real name, a term matching exactly one thread, and a term matching
 * nothing.
 */
const TERMS = ["a", "cl", "clo", "quillon", "zzq"];

describe("BACKLOG-2863: rewritten global group-chat query is identical to the frozen one", () => {
  it.each(TERMS)("term %p returns the same ids in the same order", (term) => {
    const frozen = runFrozen(term);
    const live = runLive(term);
    expect(idList(live)).toEqual(idList(frozen));
    // Same SET too, stated separately: an ordered comparison of two lists that
    // are both empty passes without ever proving the fixture matched anything.
    expect(new Set(idList(live))).toEqual(new Set(idList(frozen)));
  });

  it.each(TERMS)("term %p attributes every row to the same transaction", (term) => {
    expect(attributionMap(runLive(term))).toEqual(attributionMap(runFrozen(term)));
  });

  it("the corpus is not vacuous — the 1-character term matches several threads", () => {
    // Without this, every assertion above would pass on an empty fixture.
    expect(runFrozen("a").length).toBeGreaterThanOrEqual(4);
    expect(runFrozen("quillon")).toHaveLength(1);
    expect(runFrozen("zzq")).toHaveLength(0);
  });
});

describe("BACKLOG-2863: the boundaries, asserted absolutely and not only against the frozen copy", () => {
  // Two identically-broken queries agree with each other perfectly. These name
  // the answer.
  it("a thread whose newest message is unlinked is represented by its newest LINKED message", () => {
    const row = runLive("Bramble").find((r) => r.threadDisplayName === "Bramble Court Punch List");
    expect(row?.id).toBe("m-111"); // NOT m-112, which is newer and unlinked
    expect(row?.attrTxnId).toBe(TXN_B);
  });

  it("a message with both link kinds takes the EARLIEST-linked transaction", () => {
    const row = runLive("Cobblestone")[0];
    expect(row.id).toBe("m-121");
    expect(row.attrTxnId).toBe(TXN_A); // the direct link, linked_at 2026-01-03
    expect(row.attrAddress).toBe(ADDR_A);
  });

  it("a link row with a NULL transaction_id does not attach a conversation", () => {
    // The red control for the `JOIN transactions` inside the linkage EXISTS:
    // remove that join and this thread surfaces with a null attribution.
    expect(idList(runLive("Dovetail"))).toEqual([]);
    expect(idList(runLive("a"))).not.toContain("m-131");
  });

  it("excludes a named 1:1, a reaction-only thread, and an unlinked group", () => {
    const ids = idList(runLive("a"));
    expect(ids).not.toContain("m-141"); // named 1:1 — no chat_members
    expect(ids).not.toContain("m-151"); // tapback only
    expect(ids).not.toContain("m-161"); // no communications row at all
  });

  it("returns BOTH Apple chat rows of one conversation, uncollapsed", () => {
    // The collapse is the caller's (BACKLOG-2854). A query that merged them here
    // would conceal the very rows that defect is about.
    const ids = idList(runLive("Harbor"));
    expect(new Set(ids)).toEqual(new Set(["m-171", "m-181"]));
  });
});

describe("BACKLOG-2863: the query plan, pinned", () => {
  /**
   * A SECOND, SCALED fixture, and it needs to be both scaled AND `ANALYZE`d.
   *
   * The plan that regressed is not visible on the fixture above. SQLite only
   * builds an AUTOMATIC index over a derived table once it believes the table is
   * big enough to be worth indexing, and it only drives `tn -> messages` once
   * `sqlite_stat1` tells it `message_thread_names` is the small side. A pin
   * written against a 13-message fixture would assert the ABSENCE of a plan that
   * was never going to appear, pass identically against the old query, and prove
   * nothing.
   *
   * 12 named group threads x 20 messages, all linked and all matching, is the
   * smallest shape measured to provoke the real signature — a few milliseconds
   * to build.
   *
   * WHY `ANALYZE` IS THE RIGHT STATE TO PIN. The app runs `ANALYZE` inside
   * `maintenanceDbService.reindexDatabase()`, which the renderer's
   * `SyncOrchestratorService` registers as its `reindex` job, so a database that
   * has been reindexed carries statistics and one that never has does not. The
   * measurements on a 150k-message corpus say that distinction is the whole
   * cliff: the OLD query costs 211 ms without statistics and 6,185 ms with them,
   * because the statistics are what convince the planner to drive through the
   * link table. The rewritten query costs 51 ms without and 49 ms with — it does
   * not have a cliff to fall off. This block pins the state where the bug bites.
   */
  let big: DatabaseType;

  beforeAll(() => {
    big = new Database(":memory:") as unknown as DatabaseType;
    big.pragma("foreign_keys = ON");
    big.exec(SCHEMA);
    big.exec(V56);
    big.prepare(
      `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'oauth-plan')`,
    ).run(USER, "plan@example.invalid");
    big.prepare(
      `INSERT INTO transactions (id, user_id, property_address, status) VALUES (?, ?, ?, 'active')`,
    ).run(TXN_A, USER, ADDR_A);

    const insName = big.prepare(
      `INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?, ?, ?)`,
    );
    const insMsg = big.prepare(
      `INSERT INTO messages (id, user_id, channel, direction, body_text, participants,
         participants_flat, thread_id, sent_at)
       VALUES (?, ?, 'imessage', 'inbound', 'status update', ?, ?, ?, ?)`,
    );
    const insComm = big.prepare(
      `INSERT INTO communications (id, user_id, transaction_id, message_id, email_id, thread_id,
         link_source, linked_at) VALUES (?, ?, ?, NULL, NULL, ?, 'auto', ?)`,
    );

    const load = big.transaction(() => {
      let n = 0;
      for (let g = 0; g < 12; g++) {
        const thread = `macos-chat-plan-${g}`;
        insName.run(USER, thread, `Alderman Way Closing ${g}`);
        const members = [
          `+1415555${1200 + g * 3}`,
          `+1415555${1201 + g * 3}`,
          `+1415555${1202 + g * 3}`,
        ];
        insComm.run(`c-plan-${g}`, USER, TXN_A, thread, "2026-01-01T00:00:00.000Z");
        for (let i = 0; i < 20; i++) {
          insMsg.run(
            `m-plan-${n}`,
            USER,
            groupParticipants(members),
            members.join(", "),
            thread,
            new Date(Date.UTC(2025, 0, 1) + n * 60_000).toISOString(),
          );
          n++;
        }
      }
    });
    load();
    big.exec("ANALYZE");
  });

  afterAll(() => {
    big.close();
  });

  function planOf(sql: string, params: unknown[]): string {
    return (big.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
      detail: string;
    }[])
      .map((r) => r.detail)
      .join("\n");
  }

  it("the FROZEN query drives through the link table — the plan that regressed", () => {
    // Half of the claim, and the half that makes the next test mean something:
    // if this ever stops holding, the assertion below is no longer distinguishing
    // the new plan from the old one, it is just describing a fixture.
    const q = frozenGlobalThreadNameQuery(USER, "a");
    expect(planOf(q.sql, q.params)).toContain("AUTOMATIC PARTIAL COVERING INDEX");
  });

  it("the rewritten query drives tn -> messages through idx_messages_thread_id", () => {
    const q = buildGlobalTextThreadNameQuery(USER, "a");
    const detail = planOf(q.sql, q.params);
    expect(detail).toContain("SEARCH m USING INDEX idx_messages_thread_id");
    expect(detail).not.toContain("AUTOMATIC PARTIAL COVERING INDEX");
    // `m` is never reached by rowid either: that is what the link-table join
    // forced, one probe per linked message.
    expect(detail).not.toContain("sqlite_autoindex_messages_1");
  });

  it("the attribution lookup is indexed on both link branches", () => {
    // It runs once per displayed row, so a full scan here would hand back the
    // cost the row query just gave up.
    const q = buildThreadNameAttributionQuery("m-plan-1");
    const detail = planOf(q.sql, q.params);
    expect(detail).toContain("SEARCH comm USING");
    expect(detail).toContain("SEARCH comm3 USING");
    expect(detail).not.toContain("SCAN comm");
    expect(detail).not.toContain("SCAN messages");
  });
});

describe("BACKLOG-2858 regression guard: no LIMIT in the thread-row builders", () => {
  // BACKLOG-2858 removed the LIMIT because it ran BEFORE the JS sibling collapse
  // and truncated conversations out of the results. A rewrite reaching for a LIMIT
  // to claw back performance would reintroduce it silently, so it is asserted
  // here rather than remembered.
  it.each([
    ["scoped", buildTextThreadNameQuery("t-1", "a").sql],
    ["global", buildGlobalTextThreadNameQuery(USER, "a").sql],
    ["unattached", buildUnattachedTextThreadNameQuery(USER, "a").sql],
  ])("%s thread-row query has no LIMIT", (_label, sql) => {
    expect(sql.toUpperCase()).not.toContain("LIMIT");
  });
});
