/**
 * @jest-environment node
 *
 * BACKLOG-2668 — the automatic name-based linker, and the tier that is supposed
 * to decide nothing.
 *
 * ===========================================================================
 * WHAT IS BEING PINNED
 * ===========================================================================
 * Founder, 11 Aug: "`runUniqueNameAutoLink` does not run on the basic tier. The
 * basic tier decides nothing about whether two records are the same person, and
 * a frequency-gated unique-name match is still a guess." Records sharing no
 * email and no phone stay "unlinked and UNPROPOSED" on basic.
 *
 * Founder, 13 Aug (BACKLOG-2616): on the AI tier a settings toggle chooses
 * between suggesting and linking. Three states, not two.
 *
 * ===========================================================================
 * ASSERTED BY EXACT ID SET, NEVER BY A COUNTER AND NEVER BY AN EARLY RETURN
 * ===========================================================================
 * `expect(summary.autoLinked).toBe(0)` is satisfied by a function that returned
 * early AND by a function that linked the wrong pair and forgot to count it.
 * Every case below reads `contact_source_links` and `contact_link_proposals`
 * back OUT OF THE DATABASE and compares the whole set. The summary is checked
 * too, but only after the tables have already answered.
 *
 * ===========================================================================
 * THE BOUNDARY IS SWEPT, NOT SAMPLED
 * ===========================================================================
 * Five tier states x the three modes. `'free'` and `'pro'` alone would leave
 * `'enterprise'`, a NULL tier and a missing user row untested — and those three
 * are where a fail-OPEN default would hide, because they are the states a real
 * database reaches by accident rather than by subscription.
 *
 * ===========================================================================
 * FIXTURE PROVENANCE
 * ===========================================================================
 * `Robin Marsh` is already in `FICTIONAL_NAMES` (`scripts/ci/check-fixture-pii.mjs`)
 * — this repo's established invented name. Addresses are RFC 2606; phone
 * numbers are in the NANP reserved 555-0100..0199 range. Nothing here is
 * derived from any real record.
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
  runUniqueNameAutoLink,
  runUniqueNameAutoLinkForMode,
  type AskPair,
} from "../contactNameAutoLink";
import {
  resolveContactAutoLinkMode,
  type ContactAutoLinkMode,
} from "../contactAutoLinkPolicy";
import { buildEvidence } from "../contactLinkEvidence";
import { createLink, getLinksForContact } from "../db/contactSourceLinkDbService";
import {
  listPendingProposals,
  proposeLink,
  recordVerdict,
  type LinkProposalReason,
} from "../db/contactLinkReviewDbService";
import type { ExternalContactSource } from "../db/externalContactDbService";

const USER = "user-tier-gate-2668";

const PERSON = "Robin Marsh";
const MAC_EMAIL = "robin.marsh@example.com";
const MAC_PHONE = "+15035550151";
const OUT_EMAIL = "r.marsh@example.net";
const OUT_PHONE = "+15035550152";

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * The tier as the app actually stores it.
 *
 * `undefined` writes a row with the column left to its schema DEFAULT rather
 * than writing the string "undefined"; `null` writes a real NULL. The three
 * cases are distinct on purpose — the default, an explicit absence and no row
 * at all are three different database states and the gate must answer for each.
 */
function setTier(tier: string | null | undefined): void {
  if (tier === undefined) {
    mockDb!.prepare("INSERT INTO users (id) VALUES (?)").run(USER);
    return;
  }
  mockDb!
    .prepare("INSERT INTO users (id, subscription_tier) VALUES (?, ?)")
    .run(USER, tier);
}

function addContact(id: string, displayName: string): void {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, USER, displayName);
}

function addExternal(
  recordId: string,
  name: string,
  source: ExternalContactSource,
  emails: string[],
  phones: string[],
): void {
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, emails_json, external_record_id, source, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-08-11T00:00:00.000Z')`,
    )
    .run(
      `ext-${source}-${recordId}`,
      USER,
      name,
      JSON.stringify(phones),
      JSON.stringify(emails),
      recordId,
      source,
    );
}

function freezeContact(contactId: string, transactionId: string): void {
  mockDb!
    .prepare(
      `INSERT INTO transactions (id, user_id, property_address, first_exported_at, buyer_agent_id)
       VALUES (?, ?, '117 Ashgrove Terrace', '2026-08-05T00:00:00.000Z', ?)`,
    )
    .run(transactionId, USER, contactId);
}

/**
 * The shape the rule fires on: one saved contact holding the Mac record, the
 * same name in Outlook and unclaimed, nobody else called that. In `auto` this
 * links; in `suggest` it asks; on basic it does neither.
 */
function seedQualifyingPair(): void {
  addContact("c-robin", PERSON);
  addExternal("mac-1", PERSON, "macos", [MAC_EMAIL], [MAC_PHONE]);
  addExternal("out-1", PERSON, "outlook", [OUT_EMAIL], [OUT_PHONE]);
  createLink({
    userId: USER,
    contactId: "c-robin",
    sourceType: "macos",
    sourceRecordId: "mac-1",
    matchMethod: "source_id",
  });
}

/** A third holder of the same name — the ask band, which the gate must not move. */
function addThirdHolder(): void {
  addExternal("out-2", PERSON, "outlook", ["marsh.r@example.org"], ["+15035550153"]);
}

// ---------------------------------------------------------------------------
// Readers — SORTED EXACT SETS, read back out of the database
// ---------------------------------------------------------------------------
function linkSet(contactId: string): string[] {
  return getLinksForContact(contactId)
    .map((l) => `${l.source_type}|${l.source_record_id}|${l.match_method}`)
    .sort();
}

function proposalSet(): string[] {
  return listPendingProposals(USER)
    .map((p) => `${p.contact_id}|${p.source_type}|${p.source_record_id}|${p.reason}`)
    .sort();
}

/** `contactHandlers.fileNameQuestion`, transcribed — see the 2666 suite. */
function fileNameQuestion(
  pair: AskPair,
  ctx: { reason: LinkProposalReason; holderCount: number; displayName: string },
): void {
  const built = buildEvidence({
    userId: USER,
    contactId: pair.contactId,
    sourceType: pair.sourceType,
    sourceRecordId: pair.sourceRecordId,
    reason: ctx.reason,
    matchedOn: "name",
    matchedValues: [ctx.displayName],
    nameHolderCount: ctx.holderCount,
    nameText: ctx.displayName,
  });
  proposeLink({
    userId: USER,
    contactId: pair.contactId,
    sourceType: pair.sourceType,
    sourceRecordId: pair.sourceRecordId,
    reason: ctx.reason,
    matchedOn: "name",
    identityAssessment: built.identityAssessment,
    relationshipAssessment: built.relationshipAssessment,
    clusterKey: `name:${ctx.displayName.trim().toLowerCase()}`,
    evidence: built.evidence,
  });
}

/** What the crosswalk holds before the pass. Nothing below may add to it silently. */
const UNTOUCHED = ["macos|mac-1|source_id"];
const LINKED = ["macos|mac-1|source_id", "outlook|out-1|unique_name"].sort();
const SUGGESTED = [`c-robin|outlook|out-1|name_unique_suggestion`];

// ---------------------------------------------------------------------------
describe("BACKLOG-2668 — the tier gate on the unique-name rule", () => {
  beforeEach(() => {
    mockDb = new RealDatabase(":memory:");
    mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  });

  afterEach(() => {
    mockDb?.close();
    mockDb = null;
  });

  // =========================================================================
  // 1. THE PREDICATE — every tier state a real database can hold
  // =========================================================================
  describe("resolveContactAutoLinkMode", () => {
    /**
     * CONTROL (break -> observed): add `"free"` to `AI_TIER_SUBSCRIPTIONS` and
     * the first row goes red — and so does every basic-tier case below it.
     */
    it.each<[string, string | null | undefined, ContactAutoLinkMode]>([
      ["'free' — the basic tier -> off", "free", "off"],
      ["the schema default, which is the basic tier -> off", undefined, "off"],
      ["a NULL tier — unknown, not free, same answer -> off", null, "off"],
      ["'pro', with no toggle to turn on yet -> suggest", "pro", "suggest"],
      ["'enterprise', with no toggle to turn on yet -> suggest", "enterprise", "suggest"],
    ])("resolves %s", (_label, tier, expected) => {
      setTier(tier);
      expect(resolveContactAutoLinkMode(USER)).toBe(expected);
    });

    it("resolves a user with no row at all to off", () => {
      expect(resolveContactAutoLinkMode(USER)).toBe("off");
    });

    /**
     * Fail-CLOSED, and proven by removing the table rather than by trusting the
     * `catch`. A gate that threw into the pass would be caught one level up in
     * `runOpportunisticLinking` and reported as "linking failed" — which reads
     * like a transient error and is not one.
     */
    it("resolves to off when the users table cannot be read at all", () => {
      mockDb!.exec("DROP TABLE users");
      expect(resolveContactAutoLinkMode(USER)).toBe("off");
    });

    it("resolves an unrecognised tier string to off", () => {
      // The real column has a CHECK, so this state is reached by a future tier
      // name arriving before this Set learns about it — the direction that must
      // fail towards doing nothing.
      mockDb!.exec("DROP TABLE users");
      mockDb!.exec("CREATE TABLE users (id TEXT PRIMARY KEY, subscription_tier TEXT)");
      mockDb!
        .prepare("INSERT INTO users (id, subscription_tier) VALUES (?, 'ai-plus')")
        .run(USER);
      expect(resolveContactAutoLinkMode(USER)).toBe("off");
    });
  });

  // =========================================================================
  // 2. THE PRODUCTION ENTRY — the founder's ruling, end to end
  // =========================================================================
  describe("runUniqueNameAutoLink (the entry the linking pass actually calls)", () => {
    /**
     * THE CONTROL THIS ITEM EXISTS FOR.
     *
     * CONTROL (break -> observed): make the wrapper pass `"auto"` unconditionally
     * instead of `resolveContactAutoLinkMode(userId)`. This goes red on the LINK
     * SET — `outlook|out-1|unique_name` appears — not on a counter.
     */
    it.each<[string, string | null | undefined]>([
      ["'free', the basic tier", "free"],
      ["the schema default", undefined],
      ["a NULL tier", null],
    ])("decides NOTHING on %s — no link, and no question either", (_label, tier) => {
      setTier(tier);
      seedQualifyingPair();
      const onAsk = jest.fn();

      const summary = runUniqueNameAutoLink(USER, onAsk);

      // The database, first.
      expect(linkSet("c-robin")).toEqual(UNTOUCHED);
      expect(proposalSet()).toEqual([]);
      // "unlinked and UNPROPOSED" — the callback is never reached at all.
      expect(onAsk).not.toHaveBeenCalled();
      // And the pass did not evaluate a single group, so it decided nothing
      // even privately.
      expect(summary.groups).toBe(0);
      expect(summary.actions).toEqual([]);
      expect(summary.askPairs).toEqual([]);
      expect(summary.withheldByMode).toBe(0);
    });

    it("decides nothing when the user has no row at all", () => {
      seedQualifyingPair();
      const onAsk = jest.fn();

      runUniqueNameAutoLink(USER, onAsk);

      expect(linkSet("c-robin")).toEqual(UNTOUCHED);
      expect(proposalSet()).toEqual([]);
      expect(onAsk).not.toHaveBeenCalled();
    });

    /**
     * The AI tier, as it ships today: the toggle has no storage yet
     * (BACKLOG-2616 owns it), a toggle nobody turned on is off, and the 13 Aug
     * ruling permits automatic linking only behind a toggle the user turned on.
     * So the pair the rule was SURE about becomes a question.
     */
    it.each(["pro", "enterprise"])("suggests but does not link on %s", (tier) => {
      setTier(tier);
      seedQualifyingPair();

      const summary = runUniqueNameAutoLink(USER, fileNameQuestion);

      expect(linkSet("c-robin")).toEqual(UNTOUCHED);
      expect(proposalSet()).toEqual(SUGGESTED);
      expect(summary.autoLinked).toBe(0);
      expect(summary.withheldByMode).toBe(1);
    });
  });

  // =========================================================================
  // 3. THE THREE MODES, driven directly
  // =========================================================================
  describe("the mode matrix", () => {
    /**
     * `off` returns BEFORE reading anything — proven by deleting the table the
     * pass reads first. A pass that gathered the groups and discarded the
     * verdicts would still have made every decision the basic tier is not
     * allowed to make; this is the difference, and it is observable.
     *
     * CONTROL (break -> observed): move the `mode === "off"` return to AFTER
     * `collectNameGroups(userId)` and this throws "no such table: external_contacts".
     */
    it("off does not read the contact tables at all", () => {
      seedQualifyingPair();
      mockDb!.exec("DROP TABLE external_contacts");

      const summary = runUniqueNameAutoLinkForMode("off", USER, fileNameQuestion);

      expect(summary.groups).toBe(0);
      expect(linkSet("c-robin")).toEqual(UNTOUCHED);
      expect(proposalSet()).toEqual([]);
    });

    /** The positive half of the control above: `auto` genuinely needs that table. */
    it("auto DOES read them — so the test above is about the gate, not the fixture", () => {
      seedQualifyingPair();
      mockDb!.exec("DROP TABLE external_contacts");

      expect(() => runUniqueNameAutoLinkForMode("auto", USER, fileNameQuestion)).toThrow(
        /no such table: external_contacts/,
      );
    });

    /**
     * CONTROL (break -> observed): delete the `if (mode === "suggest")` branch so
     * `suggest` falls through to `createLink`. This goes red on the link set with
     * `outlook|out-1|unique_name` present and the proposal set empty.
     */
    it("suggest files the question and creates NO link", () => {
      seedQualifyingPair();

      const summary = runUniqueNameAutoLinkForMode("suggest", USER, fileNameQuestion);

      expect(linkSet("c-robin")).toEqual(UNTOUCHED);
      expect(proposalSet()).toEqual(SUGGESTED);
      expect(summary.withheldByMode).toBe(1);
      expect(summary.autoLinked).toBe(0);
      expect(summary.actions).toEqual([]);
      expect(summary.askPairs).toEqual([
        {
          contactId: "c-robin",
          sourceType: "outlook",
          sourceRecordId: "out-1",
          reason: "name_unique_suggestion",
          holderCount: 2,
          displayName: PERSON,
        },
      ]);
    });

    /**
     * The positive control. A change that merely stopped linking everywhere
     * would pass every assertion above and break the product.
     *
     * CONTROL (break -> observed): route `auto` into the suggest branch and this
     * goes red — the link set loses `outlook|out-1|unique_name`.
     */
    it("auto links exactly as it did before the gate existed", () => {
      seedQualifyingPair();

      const summary = runUniqueNameAutoLinkForMode("auto", USER, fileNameQuestion);

      expect(linkSet("c-robin")).toEqual(LINKED);
      expect(proposalSet()).toEqual([]);
      expect(summary.actions).toEqual([
        { sourceType: "outlook", sourceRecordId: "out-1", contactId: "c-robin" },
      ]);
      expect(summary.withheldByMode).toBe(0);
    });

    /**
     * The ask band is not the auto-link band, and the gate must not have moved
     * it. Three holders is "the rule cannot tell" in every mode the pass runs
     * in, and it keeps its own reason.
     */
    it.each<ContactAutoLinkMode>(["suggest", "auto"])(
      "leaves the ask band untouched in %s — a third holder still reads name_not_unique",
      (mode) => {
        seedQualifyingPair();
        addThirdHolder();

        const summary = runUniqueNameAutoLinkForMode(mode, USER, fileNameQuestion);

        expect(linkSet("c-robin")).toEqual(UNTOUCHED);
        expect(proposalSet()).toEqual(
          [
            "c-robin|outlook|out-1|name_not_unique",
            "c-robin|outlook|out-2|name_not_unique",
          ].sort(),
        );
        expect(summary.withheldByMode).toBe(0);
      },
    );
  });

  // =========================================================================
  // 4. WHERE THE GATES MEET — the orderings that are load-bearing
  // =========================================================================
  describe("the tier gate against the other two bars", () => {
    /**
     * A verdict beats everything, in every mode. A pair the user has already
     * called different people must not come back as a question just because the
     * mode changed.
     *
     * CONTROL (break -> observed): move the `mode === "suggest"` branch ABOVE the
     * `hasCannotLink` check and this goes red — a question the user already
     * answered is filed again.
     */
    it("does not ask about a pair the user already called different people", () => {
      seedQualifyingPair();
      recordVerdict({
        userId: USER,
        contactId: "c-robin",
        sourceType: "outlook",
        sourceRecordId: "out-1",
        identityVerdict: "different_people",
        decidedBy: "review_queue",
      });

      const summary = runUniqueNameAutoLinkForMode("suggest", USER, fileNameQuestion);

      expect(linkSet("c-robin")).toEqual(UNTOUCHED);
      expect(proposalSet()).toEqual([]);
      expect(summary.barredByVerdict).toBe(1);
      expect(summary.withheldByMode).toBe(0);
    });

    /**
     * BACKLOG-2666 SURVIVES THE GATE, AND KEEPS ITS OWN SENTENCE.
     *
     * `suggest` is the only mode production can currently reach, so if this
     * branch took precedence the frozen question would disappear from the
     * shipping tree while every 2666 test stayed green — they drive `auto`.
     *
     * CONTROL (break -> observed): move the `mode === "suggest"` branch ABOVE the
     * `isContactOnFrozenTransaction` check and this goes red on the reason:
     * `name_unique_suggestion` instead of `frozen_audit_contact`.
     */
    it("keeps the frozen-audit reason in suggest, not the new one", () => {
      seedQualifyingPair();
      freezeContact("c-robin", "t-exported");

      const summary = runUniqueNameAutoLinkForMode("suggest", USER, fileNameQuestion);

      expect(linkSet("c-robin")).toEqual(UNTOUCHED);
      expect(proposalSet()).toEqual(["c-robin|outlook|out-1|frozen_audit_contact"]);
      expect(summary.barredByFreeze).toBe(1);
      expect(summary.withheldByMode).toBe(0);
    });
  });

  // =========================================================================
  // 5. THE SENTENCE THE USER READS
  // =========================================================================
  /**
   * Both switches in `contactLinkEvidence` have a `default:`, so a new reason
   * with no case renders "This match was not applied automatically." with tsc,
   * lint and every other test still green. This is the only thing that catches it.
   *
   * CONTROL (break -> observed): comment out the `case "name_unique_suggestion":`
   * arm of `summaryForReason` and this goes red on the summary text.
   */
  it("renders its own sentence for name_unique_suggestion, not the generic fallback", () => {
    seedQualifyingPair();
    runUniqueNameAutoLinkForMode("suggest", USER, fileNameQuestion);

    const [proposal] = listPendingProposals(USER);
    const evidence = JSON.parse(proposal.evidence_json ?? "{}") as { summary?: string };

    expect(evidence.summary).toContain("Automatic linking is off");
    expect(evidence.summary).not.toContain("This match was not applied automatically");
    // The rule's own verdict was that these two are one person; the setting is
    // what stopped the link. `no_known_connection` would contradict that.
    expect(proposal.relationship_assessment).toBe("possibly_connected");
  });
});
