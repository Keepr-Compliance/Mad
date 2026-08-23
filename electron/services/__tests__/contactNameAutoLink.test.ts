/**
 * @jest-environment node
 *
 * BACKLOG-2410 part 3 — auto-linking on a name that is unique on BOTH sides.
 *
 * The rule (founder, 2026-08-02, as clarified): count every record carrying
 * that exact first+last name across ALL sources AND all already-saved contacts.
 * Auto-link ONLY when that count is exactly two — one from an email source, one
 * from a phone source.
 *
 * ---------------------------------------------------------------------------
 * EXACT ID SETS, NEVER COUNTS
 * ---------------------------------------------------------------------------
 * `expect(summary.autoLinked).toBe(1)` is satisfied by linking the WRONG pair.
 * Every assertion names the exact links produced.
 *
 * ---------------------------------------------------------------------------
 * THE CONTROL THAT MATTERS MOST
 * ---------------------------------------------------------------------------
 * Add suffix stripping to `normalizeNameKey` and the Jr/Sr block must go red.
 * That is the credit-bureau mixed-file failure, and it is one `.replace()` away
 * at all times.
 */

import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

let mockDb: DatabaseType | null = null;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...params);
    return { lastInsertRowid: r.lastInsertRowid as number, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import {
  normalizeNameKey,
  evaluateNameGroup,
  runUniqueNameAutoLinkForMode,
  collectNameGroups,
  type NameGroup,
  type NameAutoLinkSummary,
  type AskPair,
} from "../contactNameAutoLink";
import type { LinkProposalReason } from "../db/contactLinkReviewDbService";

/**
 * BACKLOG-2668 — this suite drives the pass with the mode already decided.
 *
 * Every test below is about the RULE: which names group, which pairs qualify,
 * what a suffix does. None of them is about which tier the user is on. Reaching
 * them through the public `runUniqueNameAutoLink` would mean seeding a `users`
 * row in each one to say something none of them is asserting — and would make
 * the whole file go red the day the tier mapping changes, for a reason that has
 * nothing to do with names.
 *
 * The tier itself is asserted through the public entry, on real `users` rows,
 * in `contactNameAutoLink.tierGate-2668.test.ts`.
 */
function runInAutoMode(
  userId: string,
  onAsk?: (
    pair: AskPair,
    ctx: { reason: LinkProposalReason; holderCount: number; displayName: string },
  ) => void,
): NameAutoLinkSummary {
  return runUniqueNameAutoLinkForMode("auto", userId, onAsk);
}
import { createLink, getLinksForContact } from "../db/contactSourceLinkDbService";
import { recordVerdict } from "../db/contactLinkReviewDbService";

const USER = "user-name-2410";

// ---------------------------------------------------------------------------
// PURE NORMALISATION — no database needed
// ---------------------------------------------------------------------------
describe("normalizeNameKey", () => {
  it("folds case, whitespace, accents and punctuation", () => {
    expect(normalizeNameKey("  JOSÉ   O'Brien-Smith ")?.key).toBe("jose obriensmith");
    expect(normalizeNameKey("jose obriensmith")?.key).toBe("jose obriensmith");
  });

  /**
   * "Nothing that removes a token." A middle name or initial is a token, so
   * "John Smith" and "John A. Smith" are DIFFERENT names and never group.
   *
   * NEGATIVE CONTROL RUN: changed the key to `[tokens[0], tokens.at(-1)].join(" ")`
   * (the "first + last only" reading). Observed: this test fails on the second
   * assertion, and `does not auto-link a middle-initial variant` fails with a
   * link created — i.e. the looser reading silently merges.
   */
  it("keeps every token, so a middle name is a different name", () => {
    expect(normalizeNameKey("John Smith")?.key).toBe("john smith");
    expect(normalizeNameKey("John A. Smith")?.key).toBe("john a smith");
  });

  it("flags a generational suffix and never strips it", () => {
    const jr = normalizeNameKey("John Smith Jr.");
    expect(jr?.key).toBe("john smith jr");
    expect(jr?.hasGenerationalSuffix).toBe(true);

    const plain = normalizeNameKey("John Smith");
    expect(plain?.key).toBe("john smith");
    expect(plain?.hasGenerationalSuffix).toBe(false);

    // The two keys differ, which is the structural protection.
    expect(jr?.key).not.toBe(plain?.key);
  });

  it("reads a suffix only in the last position, so a middle initial is not one", () => {
    expect(normalizeNameKey("John V Smith")?.hasGenerationalSuffix).toBe(false);
    expect(normalizeNameKey("John Smith V")?.hasGenerationalSuffix).toBe(true);
    expect(normalizeNameKey("Mary Smith III")?.hasGenerationalSuffix).toBe(true);
  });

  it("refuses anything that cannot yield a first AND a last name", () => {
    expect(normalizeNameKey("Madonna")).toBeNull();
    expect(normalizeNameKey("   ")).toBeNull();
    expect(normalizeNameKey(null)).toBeNull();
    expect(normalizeNameKey("-")).toBeNull();
  });

  it("does not fold nicknames", () => {
    expect(normalizeNameKey("Mike Johnson")?.key).toBe("mike johnson");
    expect(normalizeNameKey("Michael Johnson")?.key).toBe("michael johnson");
    expect(normalizeNameKey("Mike Johnson")?.key).not.toBe(normalizeNameKey("Michael Johnson")?.key);
  });
});

// ---------------------------------------------------------------------------
// THE RULE — pure, so the composition table can be asserted directly
// ---------------------------------------------------------------------------
describe("evaluateNameGroup — the founder's table", () => {
  const group = (members: NameGroup["members"], hasSuffix = false): NameGroup => ({
    key: "john smith",
    displayName: "John Smith",
    hasGenerationalSuffix: hasSuffix,
    members,
  });

  it("2, one email source + one phone source -> AUTO-LINK", () => {
    const decision = evaluateNameGroup(
      group([
        { kind: "source", sourceType: "macos", sourceRecordId: "m1", name: "John Smith", ownerContactId: "c1" },
        { kind: "source", sourceType: "outlook", sourceRecordId: "o1", name: "John Smith", ownerContactId: null },
      ]),
    );
    expect(decision).toEqual({
      kind: "auto_link",
      action: { sourceType: "outlook", sourceRecordId: "o1", contactId: "c1" },
      holderCount: 2,
    });
  });

  it("2, both from the same source family -> ask", () => {
    const decision = evaluateNameGroup(
      group([
        { kind: "source", sourceType: "macos", sourceRecordId: "m1", name: "John Smith", ownerContactId: "c1" },
        { kind: "source", sourceType: "iphone", sourceRecordId: "i1", name: "John Smith", ownerContactId: null },
      ]),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error("unreachable");
    expect(decision.reason).toBe("name_same_source_family");
    expect(decision.pairs).toEqual([{ contactId: "c1", sourceType: "iphone", sourceRecordId: "i1" }]);
  });

  it("3+ -> ask, even when two of them look like the obvious pair", () => {
    const decision = evaluateNameGroup(
      group([
        { kind: "source", sourceType: "macos", sourceRecordId: "m1", name: "John Smith", ownerContactId: "c1" },
        { kind: "source", sourceType: "outlook", sourceRecordId: "o1", name: "John Smith", ownerContactId: null },
        { kind: "source", sourceType: "outlook", sourceRecordId: "o2", name: "John Smith", ownerContactId: null },
      ]),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error("unreachable");
    expect(decision.reason).toBe("name_not_unique");
    expect(decision.holderCount).toBe(3);
    expect(decision.pairs).toEqual([
      { contactId: "c1", sourceType: "outlook", sourceRecordId: "o1" },
      { contactId: "c1", sourceType: "outlook", sourceRecordId: "o2" },
    ]);
  });

  /**
   * An UNLINKED saved contact of the same name is a genuine third holder and
   * takes the group out of the auto-link band, exactly as the clarification
   * requires ("it counts toward the total — it cannot be excluded").
   */
  it("an unrelated saved contact of the same name counts, and blocks the auto-link", () => {
    const decision = evaluateNameGroup(
      group([
        { kind: "source", sourceType: "macos", sourceRecordId: "m1", name: "John Smith", ownerContactId: "c1" },
        { kind: "source", sourceType: "outlook", sourceRecordId: "o1", name: "John Smith", ownerContactId: null },
        { kind: "contact", contactId: "c-other", name: "John Smith" },
      ]),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error("unreachable");
    expect(decision.holderCount).toBe(3);
  });

  /**
   * THE COLLAPSE. A saved contact already crosswalked to one of the group's
   * records is that record's person counted twice, not a third holder. Without
   * this the rule can never fire once anything is imported.
   */
  it("a saved contact already linked to a member is the same holder, not a third", () => {
    const decision = evaluateNameGroup(
      group([
        { kind: "source", sourceType: "macos", sourceRecordId: "m1", name: "John Smith", ownerContactId: "c1" },
        { kind: "source", sourceType: "outlook", sourceRecordId: "o1", name: "John Smith", ownerContactId: null },
        { kind: "contact", contactId: "c1", name: "John Smith" },
      ]),
    );
    expect(decision.kind).toBe("auto_link");
    if (decision.kind !== "auto_link") throw new Error("unreachable");
    expect(decision.holderCount).toBe(2);
    expect(decision.action).toEqual({ sourceType: "outlook", sourceRecordId: "o1", contactId: "c1" });
  });

  it("a suffix blocks the auto-link even when BOTH sides carry it", () => {
    const decision = evaluateNameGroup(
      group(
        [
          { kind: "source", sourceType: "macos", sourceRecordId: "m1", name: "John Smith Jr", ownerContactId: "c1" },
          { kind: "source", sourceType: "outlook", sourceRecordId: "o1", name: "John Smith Jr", ownerContactId: null },
        ],
        true,
      ),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error("unreachable");
    expect(decision.reason).toBe("name_generational_suffix");
  });

  it("two saved people, one on each side, is a merge and is asked about", () => {
    const decision = evaluateNameGroup(
      group([
        { kind: "source", sourceType: "macos", sourceRecordId: "m1", name: "John Smith", ownerContactId: "c1" },
        { kind: "source", sourceType: "outlook", sourceRecordId: "o1", name: "John Smith", ownerContactId: "c2" },
      ]),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error("unreachable");
    expect(decision.reason).toBe("name_two_saved_contacts");
  });

  it("waits when the pair qualifies but neither side is imported", () => {
    const decision = evaluateNameGroup(
      group([
        { kind: "source", sourceType: "macos", sourceRecordId: "m1", name: "John Smith", ownerContactId: null },
        { kind: "source", sourceType: "outlook", sourceRecordId: "o1", name: "John Smith", ownerContactId: null },
      ]),
    );
    expect(decision).toEqual({ kind: "not_yet_imported", holderCount: 2 });
  });

  it("does nothing when both sides already point at the same contact", () => {
    const decision = evaluateNameGroup(
      group([
        { kind: "source", sourceType: "macos", sourceRecordId: "m1", name: "John Smith", ownerContactId: "c1" },
        { kind: "source", sourceType: "outlook", sourceRecordId: "o1", name: "John Smith", ownerContactId: "c1" },
      ]),
    );
    expect(decision).toEqual({ kind: "already_linked", holderCount: 2 });
  });

  it("asks nothing when there is nothing to link to", () => {
    const decision = evaluateNameGroup(
      group([
        { kind: "source", sourceType: "macos", sourceRecordId: "m1", name: "John Smith", ownerContactId: null },
        { kind: "source", sourceType: "macos", sourceRecordId: "m2", name: "John Smith", ownerContactId: null },
        { kind: "source", sourceType: "macos", sourceRecordId: "m3", name: "John Smith", ownerContactId: null },
      ]),
    );
    expect(decision).toEqual({ kind: "skip", holderCount: 3 });
  });
});

// ---------------------------------------------------------------------------
// THE PASS, END TO END, AGAINST A REAL DATABASE
// ---------------------------------------------------------------------------
function addContact(id: string, displayName: string, opts: { removed?: boolean } = {}): void {
  mockDb!
    .prepare(
      "INSERT INTO contacts (id, user_id, display_name, is_imported, removed_at) VALUES (?, ?, ?, 1, ?)",
    )
    .run(id, USER, displayName, opts.removed ? "2026-08-01" : null);
}

function addExternal(recordId: string, name: string, source: string): void {
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, emails_json, external_record_id, source, synced_at)
       VALUES (?, ?, ?, '[]', '[]', ?, ?, '2026-08-02T00:00:00.000Z')`,
    )
    .run(`ext-${source}-${recordId}`, USER, name, recordId, source);
}

function linkSet(contactId: string): string[] {
  return getLinksForContact(contactId)
    .map((l) => `${l.source_type}|${l.source_record_id}|${l.match_method}`)
    .sort();
}

describe("runUniqueNameAutoLinkForMode — the rule itself, driven in `auto`", () => {
  beforeEach(() => {
    mockDb = new RealDatabase(":memory:");
    mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  });

  afterEach(() => {
    mockDb?.close();
    mockDb = null;
  });

  /** One person in the Mac address book (imported) and in Outlook (not). */
  function seedCleanCrossFamilyPair(name = "Aurelio Featherstonehaugh"): void {
    addContact("c-a", name);
    addExternal("mac-1", name, "macos");
    addExternal("out-1", name, "outlook");
    createLink({
      userId: USER,
      contactId: "c-a",
      sourceType: "macos",
      sourceRecordId: "mac-1",
      matchMethod: "source_id",
    });
  }

  it("auto-links the exactly-two cross-family case, recorded as unique_name", () => {
    seedCleanCrossFamilyPair();

    const summary = runInAutoMode(USER);

    expect(summary.actions).toEqual([
      { sourceType: "outlook", sourceRecordId: "out-1", contactId: "c-a" },
    ]);
    expect(linkSet("c-a")).toEqual(["macos|mac-1|source_id", "outlook|out-1|unique_name"]);
    expect(summary.askPairs).toEqual([]);
  });

  /**
   * NEGATIVE CONTROL RUN: added `.filter(t => !SUFFIXES.has(t))` to
   * `normalizeNameKey`, i.e. suffix stripping. Observed: this test fails with
   * `outlook|out-jr|unique_name` on the father's contact — a father and son
   * merged without being asked. Reverted.
   */
  it("does NOT auto-link John Smith Jr to John Smith", () => {
    addContact("c-dad", "John Smith");
    addExternal("mac-dad", "John Smith", "macos");
    createLink({
      userId: USER,
      contactId: "c-dad",
      sourceType: "macos",
      sourceRecordId: "mac-dad",
      matchMethod: "source_id",
    });
    addExternal("out-jr", "John Smith Jr", "outlook");

    const summary = runInAutoMode(USER);

    expect(summary.actions).toEqual([]);
    expect(linkSet("c-dad")).toEqual(["macos|mac-dad|source_id"]);
    // And it is not even asked about — proposing it would be inviting the merge.
    expect(summary.askPairs).toEqual([]);
  });

  it("does NOT auto-link when both sides carry the same suffix", () => {
    addContact("c-jr", "John Smith Jr");
    addExternal("mac-jr", "John Smith Jr", "macos");
    createLink({
      userId: USER,
      contactId: "c-jr",
      sourceType: "macos",
      sourceRecordId: "mac-jr",
      matchMethod: "source_id",
    });
    addExternal("out-jr", "John Smith Jr", "outlook");

    const summary = runInAutoMode(USER);

    expect(summary.actions).toEqual([]);
    expect(linkSet("c-jr")).toEqual(["macos|mac-jr|source_id"]);
    expect(summary.askPairs.map((p) => `${p.contactId}|${p.sourceRecordId}|${p.reason}`)).toEqual([
      "c-jr|out-jr|name_generational_suffix",
    ]);
  });

  it("does NOT auto-link a nickname", () => {
    addContact("c-mike", "Mike Johnson");
    addExternal("mac-mike", "Mike Johnson", "macos");
    createLink({
      userId: USER,
      contactId: "c-mike",
      sourceType: "macos",
      sourceRecordId: "mac-mike",
      matchMethod: "source_id",
    });
    addExternal("out-michael", "Michael Johnson", "outlook");

    const summary = runInAutoMode(USER);

    expect(summary.actions).toEqual([]);
    expect(linkSet("c-mike")).toEqual(["macos|mac-mike|source_id"]);
  });

  it("does NOT auto-link a middle-initial variant", () => {
    addContact("c-john", "John Smith");
    addExternal("mac-john", "John Smith", "macos");
    createLink({
      userId: USER,
      contactId: "c-john",
      sourceType: "macos",
      sourceRecordId: "mac-john",
      matchMethod: "source_id",
    });
    addExternal("out-john", "John A. Smith", "outlook");

    expect(runInAutoMode(USER).actions).toEqual([]);
    expect(linkSet("c-john")).toEqual(["macos|mac-john|source_id"]);
  });

  it("does NOT auto-link when a third record shares the name", () => {
    seedCleanCrossFamilyPair("Mike Johnson");
    addExternal("goog-1", "Mike Johnson", "google_contacts");

    const summary = runInAutoMode(USER);

    expect(summary.actions).toEqual([]);
    expect(linkSet("c-a")).toEqual(["macos|mac-1|source_id"]);
    expect(summary.askPairs.map((p) => `${p.contactId}|${p.sourceRecordId}|${p.reason}`).sort()).toEqual([
      "c-a|goog-1|name_not_unique",
      "c-a|out-1|name_not_unique",
    ]);
  });

  it("does NOT auto-link two records from the same family", () => {
    addContact("c-a", "Aurelio Featherstonehaugh");
    addExternal("mac-1", "Aurelio Featherstonehaugh", "macos");
    addExternal("iph-1", "Aurelio Featherstonehaugh", "iphone");
    createLink({
      userId: USER,
      contactId: "c-a",
      sourceType: "macos",
      sourceRecordId: "mac-1",
      matchMethod: "source_id",
    });

    const summary = runInAutoMode(USER);

    expect(summary.actions).toEqual([]);
    expect(linkSet("c-a")).toEqual(["macos|mac-1|source_id"]);
    expect(summary.askPairs.map((p) => `${p.contactId}|${p.sourceRecordId}|${p.reason}`)).toEqual([
      "c-a|iph-1|name_same_source_family",
    ]);
  });

  it("does NOT auto-link when an unrelated saved contact carries the same name", () => {
    seedCleanCrossFamilyPair("Mike Johnson");
    addContact("c-other", "Mike Johnson"); // a different, unlinked person

    const summary = runInAutoMode(USER);

    expect(summary.actions).toEqual([]);
    expect(linkSet("c-a")).toEqual(["macos|mac-1|source_id"]);
  });

  it("ignores a tombstoned contact when counting holders", () => {
    seedCleanCrossFamilyPair("Mike Johnson");
    addContact("c-dead", "Mike Johnson", { removed: true });

    // A removed contact is not a person competing for the name; the auto-link
    // still fires. (Negative control: drop the `removed_at IS NULL` filter from
    // collectNameGroups and this goes red with actions === [].)
    expect(runInAutoMode(USER).actions).toEqual([
      { sourceType: "outlook", sourceRecordId: "out-1", contactId: "c-a" },
    ]);
  });

  it("honours a previous 'different people' answer over the name rule", () => {
    seedCleanCrossFamilyPair();
    recordVerdict({
      userId: USER,
      contactId: "c-a",
      sourceType: "outlook",
      sourceRecordId: "out-1",
      identityVerdict: "different_people",
      decidedBy: "review_queue",
    });

    const summary = runInAutoMode(USER);

    expect(summary.actions).toEqual([]);
    expect(summary.barredByVerdict).toBe(1);
    expect(linkSet("c-a")).toEqual(["macos|mac-1|source_id"]);
  });

  it("is idempotent — a second pass adds nothing", () => {
    seedCleanCrossFamilyPair();
    runInAutoMode(USER);
    const second = runInAutoMode(USER);

    expect(second.actions).toEqual([]);
    expect(second.alreadyLinked).toBe(1);
    expect(linkSet("c-a")).toEqual(["macos|mac-1|source_id", "outlook|out-1|unique_name"]);
  });

  it("collects groups in a stable key order regardless of insert order", () => {
    addExternal("z1", "Zoe Zephyr", "macos");
    addExternal("a1", "Aaron Aardvark", "macos");
    addExternal("m1", "Mid Person", "outlook");
    expect(collectNameGroups(USER).map((g) => g.key)).toEqual([
      "aaron aardvark",
      "mid person",
      "zoe zephyr",
    ]);
  });

  it("never links a name with only one token", () => {
    addContact("c-m", "Madonna");
    addExternal("mac-m", "Madonna", "macos");
    addExternal("out-m", "Madonna", "outlook");
    createLink({
      userId: USER,
      contactId: "c-m",
      sourceType: "macos",
      sourceRecordId: "mac-m",
      matchMethod: "source_id",
    });

    const summary = runInAutoMode(USER);
    expect(summary.groups).toBe(0);
    expect(linkSet("c-m")).toEqual(["macos|mac-m|source_id"]);
  });
});
