/**
 * @jest-environment node
 *
 * BACKLOG-3102 (PR 1) — the row limit is a BOUND PARAMETER, and `limit = 0`
 * still means "no limit".
 *
 * ===========================================================================
 * WHY THIS RUNS THE REAL SQL
 * ===========================================================================
 * The change under test moves a value out of SQL TEXT and into the params
 * array: `LIMIT ${Number(limit)}` became `LIMIT ?`. The obvious cheaper test —
 * assert the emitted statement contains "LIMIT ?" — proves only that a string
 * was edited. It passes with the parameter bound in the wrong ORDER, with the
 * clause emitted when it should be absent, and with `LIMIT 0` silently
 * returning nothing.
 *
 * So the query runs against a REAL in-memory SQLite database, injected with
 * `setDb`, over the REAL `electron/database/schema.sql`, and every assertion is
 * on the ROW IDS that come back.
 *
 * ===========================================================================
 * THE BOUNDARY THIS SUITE EXISTS FOR
 * ===========================================================================
 * Before this change the clause was emitted by a TRUTHINESS test:
 *
 *     ${limit ? `LIMIT ${Number(limit)}` : ""}
 *
 * so `limit = 0` emitted NO clause at all and returned every row. The naive
 * conversion — bind whenever `limit !== undefined` — turns that into `LIMIT 0`
 * and returns ZERO rows. That is a silent, total data loss for any caller that
 * ever passes 0, and it is the single reason this suite exists.
 *
 * `zero means no limit` and `negative means no limit` below are the tests that
 * fail under the naive bind. The rest of the suite passes without them.
 *
 * ===========================================================================
 * WHY PIN A PARAMETER NOTHING PASSES
 * ===========================================================================
 * Measured when this suite was written: NO production call site supplies a
 * limit. The `transactions:get-details` and `transactions:get-communications`
 * handlers forward only the transaction id (and the channel filter), the
 * preload bridge sends no third argument to either channel, and the
 * `DatabaseService` interface declares `getCommunicationsByTransaction` with a
 * single parameter. So the boundary is LATENT, not live.
 *
 * That is the reason to pin it, not a reason to skip it: the next caller to
 * pass a limit inherits whatever this function does with 0, and by then the
 * truthiness test will look like an accident someone should tidy up.
 *
 * It also means there is no IPC payload to transcribe as a fixture. The
 * producer of this value is the exported signature `limit?: number` on
 * `getCommunicationsWithMessages` itself, which is what these cases call.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  require("path").join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("../../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../core/dbConnection";
import { getCommunicationsWithMessages } from "../communicationDbService";

const USER = "user-3102";
const TXN = "txn-3102";
const THREAD = "macos-chat-3102";

/**
 * Five messages, NEWEST FIRST.
 *
 * `sent_at` is distinct per row because the statement orders by
 * `COALESCE(m.sent_at, e.sent_at) DESC` — ties would make "the newest 3" a
 * coin flip and a limit assertion meaningless. The bodies are distinct too:
 * the loader content-deduplicates text messages on `bodyText|sentAt`, so
 * repeated bodies would collapse rows AFTER the LIMIT and confound the count
 * this suite is measuring.
 */
const ROWS = [
  { id: "m-3102-e", sentAt: "2026-01-05T10:00:00Z" },
  { id: "m-3102-d", sentAt: "2026-01-04T10:00:00Z" },
  { id: "m-3102-c", sentAt: "2026-01-03T10:00:00Z" },
  { id: "m-3102-b", sentAt: "2026-01-02T10:00:00Z" },
  { id: "m-3102-a", sentAt: "2026-01-01T10:00:00Z" },
] as const;

/** Ids in the order the statement returns them: newest first. */
const NEWEST_FIRST = ROWS.map((r) => r.id);

let db: DatabaseType;

/**
 * The REAL schema, executed from `electron/database/schema.sql` — the same
 * choice, for the same reason, as `communicationDbService.threadNames-2814`:
 * a hand-written subset of `messages` / `emails` / `communications` is a guess
 * at what this 85-line SELECT projects, and a fixture that disagrees with the
 * shipped schema makes a passing test meaningless.
 */
function createSchema(d: DatabaseType): void {
  const schemaPath = require("path").join(
    __dirname, "..", "..", "..", "database", "schema.sql",
  );
  d.exec(require("fs").readFileSync(schemaPath, "utf8"));
}

function addMessage(id: string, sentAt: string): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text,
                           participants, thread_id, sent_at)
     VALUES (?, ?, 'imessage', ?, 'inbound', ?, ?, ?, ?)`,
  ).run(
    id,
    USER,
    `guid-${id}`,
    `body ${id}`,
    JSON.stringify({ from: "+15550100", to: ["+15550101"] }),
    THREAD,
    sentAt,
  );
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`comm-${id}`, USER, TXN, id, THREAD);
}

/**
 * The ids the loader returns, IN ORDER.
 *
 * Assertions below compare id sequences, never lengths. A length assertion
 * cannot tell "the newest 3" from "the oldest 3", and this statement's whole
 * contract is which rows the limit keeps.
 */
async function idsFor(limit?: number): Promise<string[]> {
  const rows = (await getCommunicationsWithMessages(TXN, "text", limit)) as unknown as Array<{
    id: string;
  }>;
  return rows.map((r) => r.id);
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  // schema.sql carries the real FOREIGN KEYs, so the user must exist first.
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, `${USER}@example.test`, `oauth-${USER}`);
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)`,
  ).run(TXN, USER, "1 Test St");
  for (const row of ROWS) addMessage(row.id, row.sentAt);
  setDb(db);
});

afterEach(() => {
  db?.close();
});

describe("BACKLOG-3102 — the row limit, swept across its boundary", () => {
  it("finds a corpus to limit (a limit test over zero rows always passes)", async () => {
    expect(await idsFor()).toEqual(NEWEST_FIRST);
    expect(NEWEST_FIRST).toHaveLength(5);
  });

  it("omitted (undefined) returns every row", async () => {
    expect(await idsFor(undefined)).toEqual(NEWEST_FIRST);
  });

  /**
   * THE CONTROL THAT MATTERS. Under the naive `limit !== undefined` bind this
   * emits `LIMIT 0` and returns []. Preserving the truthiness test is the
   * whole behavioural requirement of this PR.
   */
  it("ZERO means NO LIMIT, not zero rows", async () => {
    expect(await idsFor(0)).toEqual(NEWEST_FIRST);
  });

  /**
   * Truthy, and SQLite reads a negative LIMIT as "no limit" — so this returned
   * every row before the change and must still. Binding it changes nothing,
   * which is exactly what has to be shown rather than assumed.
   */
  it("NEGATIVE means no limit — same before and after binding", async () => {
    expect(await idsFor(-1)).toEqual(NEWEST_FIRST);
  });

  it("one returns the single NEWEST row", async () => {
    expect(await idsFor(1)).toEqual([NEWEST_FIRST[0]]);
  });

  it("three returns the three NEWEST rows, in order", async () => {
    expect(await idsFor(3)).toEqual(NEWEST_FIRST.slice(0, 3));
  });

  it("a limit larger than the table returns every row", async () => {
    expect(await idsFor(Number.MAX_SAFE_INTEGER)).toEqual(NEWEST_FIRST);
  });

  /**
   * A stringy limit behaves the same after the conversion as before it.
   *
   * The shipped text was `LIMIT ${Number(limit)}` — it COERCED — so this case
   * exists to show the conversion did not drop that. The parameter is typed
   * `number`, so the cast is deliberate: it exercises the path a caller with
   * an unvalidated payload would take.
   *
   * This case alone does NOT justify keeping `Number()`: drop it, bind `limit`
   * raw, and this stays green. SQLite converts the TEXT '3' to 3 for LIMIT
   * without loss. The case below is the one that discriminates.
   */
  it("a stringy limit behaves as it did before the conversion", async () => {
    const stringy = "3" as unknown as number;
    expect(await idsFor(stringy)).toEqual(NEWEST_FIRST.slice(0, 3));
  });

  /**
   * `Number()` IS load-bearing, and the reason is not the coercion of `'3'`.
   *
   * No input **of the declared type `number`** separates `Number(limit)` from a
   * raw bind. Two out-of-type TRUTHY inputs do, measured on the real driver:
   *
   *     true     ->  Number(): binds as 1, returns rows
   *                  raw:      THROWS "SQLite3 can only bind numbers, strings,
   *                                    bigints, buffers, and null"
   *     "0x2"    ->  Number(): binds as 2, returns rows
   *                  raw:      THROWS "datatype mismatch"
   *
   * `'1e1'` does NOT discriminate — both forms return every row, because
   * SQLite's own text-to-numeric conversion reaches 10 exactly as `Number()`
   * does. An earlier version of this comment named it as the discriminator and
   * was wrong; the two above were measured, it was not.
   *
   * So dropping `Number()` converts a RETURNED RESULT into an EXCEPTION for
   * inputs the shipped code accepted. That is a behaviour change, not a
   * simplification.
   *
   * WHAT THIS ASSERTS, and what it deliberately does not: only that the call
   * COMPLETES — that `Number()` leaves every truthy input in a shape the driver
   * can bind. It does NOT pin what `true` or `"0x2"` should mean as a row
   * limit. Pinning that would invent a contract for values outside the declared
   * type, which nobody has specified and nobody should rely on. This is a guard
   * on the implementation, in the same spirit as the escape ratchet — not a
   * product rule about booleans.
   */
  it("Number() keeps out-of-type truthy inputs BINDABLE — drop it and these throw", async () => {
    for (const outOfType of [true, "0x2"] as unknown[]) {
      // Awaited bare on purpose: without Number() this REJECTS, and the red
      // carries the driver's own message rather than a matcher's paraphrase.
      const rows = await idsFor(outOfType as number);
      expect(Array.isArray(rows)).toBe(true);
    }
  });
});
