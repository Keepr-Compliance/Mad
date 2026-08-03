/**
 * @jest-environment node
 *
 * BACKLOG-2410 — the contact-level review queue, its verdicts, and the
 * guarantee that a rejected pair is never proposed OR linked again.
 *
 * ---------------------------------------------------------------------------
 * ASSERTION STYLE — EXACT ID SETS, NEVER COUNTS
 * ---------------------------------------------------------------------------
 * `expect(queue).toHaveLength(1)` is equally satisfied by queueing the WRONG
 * pair, which is the failure this feature exists to prevent. Every assertion
 * below names the exact ids it expects.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS
 * ---------------------------------------------------------------------------
 * Each block states the control that was run to prove it can fail. The controls
 * were executed and their observed failure counts are recorded in the PR.
 * Re-run them when changing the rules they pin.
 *
 * THE MOST IMPORTANT ONE, named in the acceptance criteria: remove the
 * cannot-link persistence and confirm a re-run re-proposes the rejected pair.
 * "Across a re-run" is asserted literally — the linking pass is invoked a
 * second time in the same test, because a guarantee verified only within one
 * session is not the guarantee that was asked for.
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

import { linkExternalContactsForUser, resolveSourceRecord } from "../contactSourceLinker";
import {
  countReviewQueue,
  getReviewQueue,
  confirmProposal,
  rejectProposal,
} from "../contactLinkReview";
import {
  hasCannotLink,
  hasMustLink,
  listVerdicts,
  getLatestVerdict,
} from "../db/contactLinkReviewDbService";
import { getLinksForContact, createLink } from "../db/contactSourceLinkDbService";

const USER = "user-2410";
const OTHER_USER = "user-other-2410";
const CURRENT_SYNC = "2026-08-02T00:00:00.000Z";

// ---------------------------------------------------------------------------
// SEED HELPERS
// ---------------------------------------------------------------------------

function lookupKey(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

function addContact(
  id: string,
  displayName: string,
  opts: { emails?: string[]; phones?: string[]; userId?: string } = {},
): string {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, opts.userId ?? USER, displayName);
  (opts.emails ?? []).forEach((e, i) => {
    mockDb!
      .prepare("INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, ?)")
      .run(`${id}-e${i}`, id, e, i === 0 ? 1 : 0);
  });
  (opts.phones ?? []).forEach((p, i) => {
    mockDb!
      .prepare(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary) VALUES (?, ?, ?, ?, ?)",
      )
      .run(`${id}-p${i}`, id, p, lookupKey(p), i === 0 ? 1 : 0);
  });
  return id;
}

function addExternal(
  recordId: string,
  name: string,
  opts: {
    source?: string;
    emails?: string[];
    phones?: string[];
    userId?: string;
    syncedAt?: string;
  } = {},
): void {
  const phones = opts.phones ?? [];
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, phones_normalized_json, emails_json,
         external_record_id, source, synced_at, external_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      `ext-${opts.source ?? "macos"}-${recordId}`,
      opts.userId ?? USER,
      name,
      JSON.stringify(phones),
      JSON.stringify(phones.map(lookupKey)),
      JSON.stringify(opts.emails ?? []),
      recordId,
      opts.source ?? "macos",
      opts.syncedAt ?? CURRENT_SYNC,
    );
}

function addTransaction(
  id: string,
  address: string,
  contactIds: string[],
  opts: { exported?: boolean } = {},
): void {
  mockDb!
    .prepare(
      "INSERT INTO transactions (id, user_id, property_address, first_exported_at) VALUES (?, ?, ?, ?)",
    )
    .run(id, USER, address, opts.exported ? "2024-01-01T00:00:00.000Z" : null);
  contactIds.forEach((cid, i) => {
    mockDb!
      .prepare(
        "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, ?)",
      )
      .run(`${id}-tc${i}`, id, cid, i === 0 ? "buyer" : "seller");
  });
}

/** Every pending proposal as `contactId|sourceType|recordId` — an exact set. */
function pendingPairs(userId = USER): string[] {
  return getReviewQueue(userId)
    .flatMap((c) => c.items)
    .map((i) => `${i.contactId}|${i.sourceType}|${i.sourceRecordId}`)
    .sort();
}

/** Every crosswalk link for a contact as `sourceType|recordId|method`. */
function linkSet(contactId: string): string[] {
  return getLinksForContact(contactId)
    .map((l) => `${l.source_type}|${l.source_record_id}|${l.match_method}`)
    .sort();
}

beforeEach(() => {
  mockDb = new RealDatabase(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
// 1. A WITHHELD LINK REACHES THE QUEUE, WITH ITS EVIDENCE
// ===========================================================================
describe("a withheld link appears in the queue with its evidence", () => {
  /**
   * The Daniel/Lilly case (catalogue C8/C9). A phone number was recorded against
   * Daniel and later corrected — it is Lilly's. Daniel's SAVED contact still
   * carries it, so a phone fallback matches Lilly's record to Daniel.
   *
   * NEGATIVE CONTROL RUN: deleted the `recordProposal(...)` call from the
   * `liveConflict` branch of contactSourceLinker. Observed: 17 failed / 59
   * passed over this suite plus the BACKLOG-2401 suite — every queue assertion
   * here goes red (the queue is simply empty), while contactSourceLinker.test.ts
   * stays GREEN at 49/49. That split is the point: the withholding behaviour is
   * independently covered by 2401, and these tests pin only the new thing, which
   * is that a withheld match now goes somewhere.
   */
  function seedIdentifierReassigned(): void {
    // Daniel: saved with the number, and his own macOS record no longer has it.
    addContact("c-daniel", "Daniel Haim", { phones: ["+14155550134"] });
    addExternal("mac-daniel", "Daniel Haim", { phones: ["+14155559999"] });
    createLink({
      userId: USER,
      contactId: "c-daniel",
      sourceType: "macos",
      sourceRecordId: "mac-daniel",
      matchMethod: "source_id",
    });
    // Lilly's record now carries the number, and has no link of its own.
    addExternal("mac-lilly", "Lilly Haim", { phones: ["+14155550134"] });
  }

  it("queues the exact withheld pair and nothing else", () => {
    seedIdentifierReassigned();

    const summary = linkExternalContactsForUser(USER);
    expect(summary.flagged).toBe(1);

    expect(pendingPairs()).toEqual(["c-daniel|macos|mac-lilly"]);
    expect(countReviewQueue(USER)).toBe(1);

    // And no link was created for it — withholding still means withholding.
    expect(linkSet("c-daniel")).toEqual(["macos|mac-daniel|source_id"]);
  });

  it("states the reason in words and never as a score", () => {
    seedIdentifierReassigned();
    linkExternalContactsForUser(USER);

    const item = getReviewQueue(USER)[0].items[0];
    expect(item.reason).toBe("identifier_reassigned");
    expect(item.evidence?.summary).toContain("…0134");
    expect(item.evidence?.summary).toContain("Mac address book");
    expect(item.evidence?.summary).toContain("moved to a different person");
    // The masked identifier is present; the raw one is not.
    expect(item.evidence?.summary).not.toContain("4155550134");
    // No numeric confidence anywhere in the serialised item.
    expect(JSON.stringify(item)).not.toMatch(/confidence/i);
  });

  it("reports the two axes separately, in words", () => {
    seedIdentifierReassigned();
    linkExternalContactsForUser(USER);

    const item = getReviewQueue(USER)[0].items[0];
    expect(item.identity).toBe("possibly_same_person");
    expect(item.identityPhrase).toBe("possibly the same person");
    expect(item.relationship).toBe("possibly_connected");
    expect(item.relationshipPhrase).toBe("possibly connected");
  });

  /**
   * THE AXES MUST BE ABLE TO DISAGREE. A buyer and a seller on one deal are
   * strongly related and definitely not the same person; one collapsed scale
   * cannot express that. This is the test that would go red if someone
   * "simplified" the two columns into one.
   */
  it("reports CONNECTED for two contacts who share a transaction, while identity stays unknown", () => {
    // The buyer and the seller on one deal share an office line. A record
    // carrying that line could be either of them — so the queue asks, and it
    // must report them as CONNECTED and NOT as probably-the-same.
    addContact("c-buyer", "Jane Buyer", { phones: ["+14155550100"] });
    addContact("c-seller", "John Seller", { phones: ["+14155550100"] });
    addTransaction("t-oak", "123 Oak St", ["c-buyer", "c-seller"]);
    addExternal("mac-frontdesk", "Front Desk", { phones: ["+14155550100"] });

    linkExternalContactsForUser(USER);
    const items = getReviewQueue(USER).flatMap((c) => c.items);

    expect(items.map((i) => i.contactId).sort()).toEqual(["c-buyer", "c-seller"]);
    for (const item of items) {
      expect(item.relationship).toBe("connected");
      // The whole point: connected, and still not known to be the same person.
      expect(item.identity).toBe("possibly_same_person");
      expect(item.evidence?.details.join(" ")).toContain("123 Oak St");
      expect(item.evidence?.details.join(" ")).toContain("not the same as being one person");
    }
  });

  /**
   * The negative half of the axis. Two people who share an identifier but no
   * deal, no company and nothing else are `no known connection` on the
   * relationship axis — the reading must not default to "connected" just
   * because a question is being asked about them.
   */
  it("does not invent a connection where there is none", () => {
    addContact("c-a", "Alice Stone", { phones: ["+14155550100"] });
    addContact("c-b", "Bob Stone", { phones: ["+14155550100"] });
    addExternal("mac-x", "A Stone", { phones: ["+14155550100"] });

    linkExternalContactsForUser(USER);
    const items = getReviewQueue(USER).flatMap((c) => c.items);

    expect(items.map((i) => i.contactId).sort()).toEqual(["c-a", "c-b"]);
    expect(items.every((i) => i.relationship === "possibly_connected")).toBe(true);
    expect(items.every((i) => !i.evidence?.details.join(" ").includes("both appear on"))).toBe(true);
  });

  it("does not queue anything for a clean id match", () => {
    addContact("c-jane", "Jane Doe", { emails: ["jane@example.com"] });
    addExternal("mac-jane", "Jane Doe", { emails: ["jane@example.com"] });
    createLink({
      userId: USER,
      contactId: "c-jane",
      sourceType: "macos",
      sourceRecordId: "mac-jane",
      matchMethod: "source_id",
    });

    linkExternalContactsForUser(USER);
    expect(pendingPairs()).toEqual([]);
    expect(countReviewQueue(USER)).toBe(0);
  });

  it("scopes the queue to one user", () => {
    seedIdentifierReassigned();
    linkExternalContactsForUser(USER);
    expect(pendingPairs(OTHER_USER)).toEqual([]);
    expect(countReviewQueue(OTHER_USER)).toBe(0);
  });
});

// ===========================================================================
// 2. CONFIRM CREATES THE LINK. REJECT RECORDS A CANNOT-LINK.
// ===========================================================================
describe("answering a question", () => {
  function seedOneQuestion(): string {
    addContact("c-daniel", "Daniel Haim", { phones: ["+14155550134"] });
    addExternal("mac-daniel", "Daniel Haim", { phones: ["+14155559999"] });
    createLink({
      userId: USER,
      contactId: "c-daniel",
      sourceType: "macos",
      sourceRecordId: "mac-daniel",
      matchMethod: "source_id",
    });
    addExternal("mac-lilly", "Lilly Haim", { phones: ["+14155550134"] });
    linkExternalContactsForUser(USER);
    return getReviewQueue(USER)[0].items[0].proposalId;
  }

  /**
   * NEGATIVE CONTROL RUN: changed `confirmProposal` to record the verdict but
   * skip `createLink`. Observed: the confirm tests fail on the exact link set,
   * while the reject tests still pass — the two effects are pinned separately.
   */
  it("confirm creates the link, recorded honestly as manual", () => {
    const proposalId = seedOneQuestion();

    const outcome = confirmProposal(USER, proposalId);
    expect(outcome).toEqual({ ok: true, linked: true, alsoRejected: 0 });

    expect(linkSet("c-daniel")).toEqual([
      "macos|mac-daniel|source_id",
      "macos|mac-lilly|manual",
    ]);
    expect(pendingPairs()).toEqual([]);
  });

  it("confirm records a must-link the matcher can read back", () => {
    const proposalId = seedOneQuestion();
    confirmProposal(USER, proposalId);

    expect(hasMustLink(USER, "c-daniel", "macos", "mac-lilly")).toBe(true);
    expect(hasCannotLink(USER, "c-daniel", "macos", "mac-lilly")).toBe(false);
  });

  /**
   * NEGATIVE CONTROL RUN: removed the `recordVerdict(...)` call from
   * `rejectProposal`. Observed: this test and every re-run test in section 3
   * fail; the "removed from the queue" assertion alone still passes — which is
   * exactly why the queue-status assertion cannot stand in for the verdict.
   */
  it("reject records a durable cannot-link and creates nothing", () => {
    const proposalId = seedOneQuestion();

    const outcome = rejectProposal(USER, proposalId);
    expect(outcome).toEqual({ ok: true, linked: false, alsoRejected: 0 });

    expect(hasCannotLink(USER, "c-daniel", "macos", "mac-lilly")).toBe(true);
    // Daniel keeps his own record and gains nothing.
    expect(linkSet("c-daniel")).toEqual(["macos|mac-daniel|source_id"]);
    expect(pendingPairs()).toEqual([]);
  });

  it("keeps the verdict as a labelled example, with the evidence as it was shown", () => {
    const proposalId = seedOneQuestion();
    rejectProposal(USER, proposalId);

    const verdicts = listVerdicts(USER);
    expect(verdicts.map((v) => `${v.contact_id}|${v.source_record_id}|${v.identity_verdict}`)).toEqual(
      ["c-daniel|mac-lilly|different_people"],
    );
    // Both axes are retained, separately.
    expect(verdicts[0].relationship_verdict).toBe("possibly_connected");
    expect(verdicts[0].reason).toBe("identifier_reassigned");
    expect(verdicts[0].decided_by).toBe("review_queue");
    // The evidence snapshot travels with the label.
    expect(JSON.parse(verdicts[0].evidence_json as string).summary).toContain("…0134");
  });

  it("answering twice is refused rather than applied twice", () => {
    const proposalId = seedOneQuestion();
    expect(confirmProposal(USER, proposalId).ok).toBe(true);

    const second = confirmProposal(USER, proposalId);
    expect(second).toEqual({ ok: false, error: "That review item has already been answered." });
    // Still exactly one new link, not two.
    expect(linkSet("c-daniel")).toEqual([
      "macos|mac-daniel|source_id",
      "macos|mac-lilly|manual",
    ]);
  });

  it("refuses a proposal belonging to another user", () => {
    const proposalId = seedOneQuestion();
    expect(confirmProposal(OTHER_USER, proposalId).ok).toBe(false);
    expect(rejectProposal(OTHER_USER, proposalId).ok).toBe(false);
    expect(pendingPairs()).toEqual(["c-daniel|macos|mac-lilly"]);
  });
});

// ===========================================================================
// 3. A REJECTED PAIR IS NEVER PROPOSED AGAIN — VERIFIED ACROSS A RE-RUN
// ===========================================================================
describe("a rejected pair survives a re-run", () => {
  function seedAndReject(): void {
    addContact("c-daniel", "Daniel Haim", { phones: ["+14155550134"] });
    addExternal("mac-daniel", "Daniel Haim", { phones: ["+14155559999"] });
    createLink({
      userId: USER,
      contactId: "c-daniel",
      sourceType: "macos",
      sourceRecordId: "mac-daniel",
      matchMethod: "source_id",
    });
    addExternal("mac-lilly", "Lilly Haim", { phones: ["+14155550134"] });

    linkExternalContactsForUser(USER);
    const proposalId = getReviewQueue(USER)[0].items[0].proposalId;
    rejectProposal(USER, proposalId);
  }

  /**
   * THE ACCEPTANCE CRITERION, LITERALLY. The pass is invoked a SECOND time —
   * a fresh derivation from the same data, which is what "a re-run" means.
   *
   * NEGATIVE CONTROL RUN: removed the `hasCannotLink` filter from
   * `resolveSourceRecord`'s content path. Observed across this suite and the
   * provenance suite: 4 failed / 33 passed —
   *   - unlinkContactSource > the unlink survives a re-run   (the link COMES BACK)
   *   - reports the refusal distinguishably, not as 'no match'
   *   - stays barred when a different rule reaches the same pair
   *   - rejecting one candidate leaves the other, and the re-run can then resolve it
   *
   * NOT observed, and recorded because the obvious prediction is wrong:
   * `is not re-proposed by a second pass` and `does not silently link it either`
   * still PASS. In this seed the pair is independently withheld by
   * BACKLOG-2401's reassignment guard and independently de-duplicated by the
   * proposal pair UNIQUE, so the verdict is not the only thing holding it. The
   * cases where the verdict IS the only thing holding it are the four above —
   * and the first is a silent re-merge of a link the user removed by hand, which
   * is the outcome this constraint exists to prevent.
   */
  it("is not re-proposed by a second pass", () => {
    seedAndReject();
    expect(pendingPairs()).toEqual([]);

    linkExternalContactsForUser(USER); // RE-RUN
    expect(pendingPairs()).toEqual([]);
    expect(countReviewQueue(USER)).toBe(0);
  });

  /**
   * THE OTHER LOCK, pinned separately.
   *
   * An UNANSWERED question must not be duplicated by the next sync. Without the
   * pair UNIQUE on `contact_link_proposals` the pass appends a fresh pending row
   * every time it runs, so the button's count climbs on every sync and the modal
   * shows the same question over and over.
   *
   * NEGATIVE CONTROL RUN: removed
   * `UNIQUE (user_id, contact_id, source_type, source_record_id)` from the
   * proposals DDL. Observed: 1 failed / 26 passed — this test, on three
   * identical pending rows, and NOTHING else in the file. Every other "never
   * re-proposed" guarantee is carried by the verdict consult rather than by the
   * constraint, so without this test the constraint would be unpinned.
   */
  it("does not duplicate an UNANSWERED question on every sync", () => {
    addContact("c-daniel", "Daniel Haim", { phones: ["+14155550134"] });
    addExternal("mac-daniel", "Daniel Haim", { phones: ["+14155559999"] });
    createLink({
      userId: USER,
      contactId: "c-daniel",
      sourceType: "macos",
      sourceRecordId: "mac-daniel",
      matchMethod: "source_id",
    });
    addExternal("mac-lilly", "Lilly Haim", { phones: ["+14155550134"] });

    linkExternalContactsForUser(USER);
    linkExternalContactsForUser(USER);
    linkExternalContactsForUser(USER);

    expect(pendingPairs()).toEqual(["c-daniel|macos|mac-lilly"]);
    expect(countReviewQueue(USER)).toBe(1);
    // The raw rows, not just what the display join surfaces.
    expect(
      mockDb!.prepare("SELECT contact_id, source_record_id FROM contact_link_proposals").all(),
    ).toEqual([{ contact_id: "c-daniel", source_record_id: "mac-lilly" }]);
  });

  it("does not silently link it either", () => {
    seedAndReject();
    linkExternalContactsForUser(USER); // RE-RUN

    expect(linkSet("c-daniel")).toEqual(["macos|mac-daniel|source_id"]);
  });

  /**
   * The count has to be distinguishable AND has to travel. `summary.declined`
   * is what `contactHandlers` publishes into the ingestion funnel
   * (`recordLinks`), which is the line support actually reads — folding it into
   * `unmatched` would make "this user has rejected forty suggestions" look like
   * "this user has forty new people", and those need opposite responses.
   *
   * NEGATIVE CONTROL RUN: removed `case "declined": summary.declined++;` from
   * `linkSourceRecords`, letting it fall through to `unmatched`. Observed:
   * 1 failed / 27 passed — this test, on `declined 0 / unmatched 1`.
   */
  it("reports the refusal distinguishably, not as 'no match'", () => {
    seedAndReject();
    const summary = linkExternalContactsForUser(USER); // RE-RUN

    const declined = summary.resolutions.filter((r) => r.outcome === "declined");
    expect(declined.map((r) => r.sourceRecordId)).toEqual(["mac-lilly"]);
    expect(summary.declined).toBe(1);
    expect(summary.unmatched).toBe(0);

    // The arithmetic the funnel line asserts still closes with the new bucket.
    expect(
      summary.idMatched + summary.contentMatched + summary.flagged + summary.declined +
        summary.unmatched,
    ).toBe(summary.resolutions.length);
  });

  /**
   * A RULES CHANGE MUST NOT REVIVE IT EITHER. The verdict is keyed on the pair,
   * not on the reason, so a second rule reaching the same pair by a different
   * route is still barred. Simulated by calling the resolver directly with a
   * candidate that matches on EMAIL rather than phone — a different reason, the
   * same pair.
   */
  it("stays barred when a different rule reaches the same pair", () => {
    seedAndReject();
    // Give Daniel an email his contact record also carries: a fresh route.
    mockDb!
      .prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES ('x1','c-daniel','l@x.io')")
      .run();

    const resolution = resolveSourceRecord(USER, {
      sourceType: "macos",
      sourceRecordId: "mac-lilly",
      emails: ["l@x.io"],
    });

    expect(resolution.outcome).toBe("declined");
    expect(linkSet("c-daniel")).toEqual(["macos|mac-daniel|source_id"]);
    expect(pendingPairs()).toEqual([]);
  });

  it("a CONFIRMED pair is not re-proposed either", () => {
    addContact("c-daniel", "Daniel Haim", { phones: ["+14155550134"] });
    addExternal("mac-daniel", "Daniel Haim", { phones: ["+14155559999"] });
    createLink({
      userId: USER,
      contactId: "c-daniel",
      sourceType: "macos",
      sourceRecordId: "mac-daniel",
      matchMethod: "source_id",
    });
    addExternal("mac-lilly", "Lilly Haim", { phones: ["+14155550134"] });
    linkExternalContactsForUser(USER);
    confirmProposal(USER, getReviewQueue(USER)[0].items[0].proposalId);

    linkExternalContactsForUser(USER); // RE-RUN
    expect(pendingPairs()).toEqual([]);
    // The confirmed link resolves by source id from here on.
    expect(linkSet("c-daniel")).toEqual([
      "macos|mac-daniel|source_id",
      "macos|mac-lilly|manual",
    ]);
  });
});

// ===========================================================================
// 4. CLUSTERS — ONE ANSWER RESOLVING SEVERAL PAIRS
// ===========================================================================
describe("cluster-level questions", () => {
  /**
   * One phone number held by two saved contacts. Picking is guessing, so the
   * record is offered against BOTH — one question, two options.
   */
  function seedAmbiguous(): void {
    addContact("c-alice", "Alice Stone", { phones: ["+14155550134"] });
    addContact("c-bob", "Bob Stone", { phones: ["+14155550134"] });
    addExternal("mac-x", "A. Stone", { phones: ["+14155550134"] });
  }

  it("offers every candidate in ONE cluster, not one question per candidate", () => {
    seedAmbiguous();
    linkExternalContactsForUser(USER);

    const clusters = getReviewQueue(USER);
    expect(clusters.map((c) => c.clusterKey)).toEqual(["record:macos:mac-x"]);
    expect(clusters[0].exclusive).toBe(true);
    expect(clusters[0].items.map((i) => i.contactId).sort()).toEqual(["c-alice", "c-bob"]);
    expect(clusters[0].question).toBe('Which of these is "A. Stone"?');
  });

  /**
   * NEGATIVE CONTROL RUN: made `rejectSiblings` a no-op returning 0. Observed:
   * this test fails on `alsoRejected` AND on the leftover pending pair, and the
   * "not re-proposed" assertion below fails on the re-run — proving the sibling
   * rejection is written as a real verdict rather than a display filter.
   */
  it("confirming one option answers the whole cluster", () => {
    seedAmbiguous();
    linkExternalContactsForUser(USER);

    const cluster = getReviewQueue(USER)[0];
    const alice = cluster.items.find((i) => i.contactId === "c-alice")!;

    const outcome = confirmProposal(USER, alice.proposalId);
    expect(outcome).toEqual({ ok: true, linked: true, alsoRejected: 1 });

    expect(pendingPairs()).toEqual([]);
    expect(linkSet("c-alice")).toEqual(["macos|mac-x|manual"]);
    expect(linkSet("c-bob")).toEqual([]);

    // The implied rejection is a real, durable verdict.
    expect(hasCannotLink(USER, "c-bob", "macos", "mac-x")).toBe(true);
    expect(getLatestVerdict(USER, "c-bob", "macos", "mac-x")?.decided_by).toBe(
      "review_queue_implied",
    );
  });

  it("the cluster is not re-proposed after a re-run", () => {
    seedAmbiguous();
    linkExternalContactsForUser(USER);
    const cluster = getReviewQueue(USER)[0];
    confirmProposal(USER, cluster.items.find((i) => i.contactId === "c-alice")!.proposalId);

    linkExternalContactsForUser(USER); // RE-RUN
    expect(pendingPairs()).toEqual([]);
  });

  /**
   * Rejecting ONE candidate must not answer the others — a rejection says who it
   * is not, never who it is. And it should make the remaining ambiguity
   * resolvable: with Bob ruled out, Alice is the only holder left.
   */
  it("rejecting one candidate leaves the other, and the re-run can then resolve it", () => {
    seedAmbiguous();
    linkExternalContactsForUser(USER);
    const cluster = getReviewQueue(USER)[0];
    rejectProposal(USER, cluster.items.find((i) => i.contactId === "c-bob")!.proposalId);

    expect(pendingPairs()).toEqual(["c-alice|macos|mac-x"]);

    // A re-run now sees a single viable candidate and links it deterministically
    // — the user's "not Bob" turned an unanswerable question into an answer.
    linkExternalContactsForUser(USER);
    expect(linkSet("c-alice")).toEqual(["macos|mac-x|phone"]);
    expect(linkSet("c-bob")).toEqual([]);
  });

  it("groups several records wanting one contact under that contact", () => {
    addContact("c-jane", "Jane Doe", { emails: ["jane@example.com"] });
    addExternal("mac-jane", "Jane Doe", { emails: ["jane@example.com"] });
    createLink({
      userId: USER,
      contactId: "c-jane",
      sourceType: "macos",
      sourceRecordId: "mac-jane",
      matchMethod: "source_id",
    });
    // Two more current macOS records both carrying her address (iCloud+Exchange).
    addExternal("mac-jane-2", "Jane Doe", { emails: ["jane@example.com"] });
    addExternal("mac-jane-3", "Jane D", { emails: ["jane@example.com"] });

    linkExternalContactsForUser(USER);

    const clusters = getReviewQueue(USER);
    expect(clusters.map((c) => c.clusterKey)).toEqual(["contact:c-jane"]);
    expect(clusters[0].exclusive).toBe(false);
    expect(clusters[0].items.map((i) => i.sourceRecordId).sort()).toEqual([
      "mac-jane-2",
      "mac-jane-3",
    ]);
    expect(clusters[0].items.every((i) => i.reason === "duplicate_source_record")).toBe(true);
    // Both records still assert the same address at the same time.
    expect(clusters[0].items.every((i) => i.relationship === "connected")).toBe(true);
  });
});

// ===========================================================================
// 5. THE QUEUE ONLY SHOWS ANSWERABLE QUESTIONS
// ===========================================================================
describe("stale questions", () => {
  function seedThenRemoveRecord(): void {
    addContact("c-daniel", "Daniel Haim", { phones: ["+14155550134"] });
    addExternal("mac-daniel", "Daniel Haim", { phones: ["+14155559999"] });
    createLink({
      userId: USER,
      contactId: "c-daniel",
      sourceType: "macos",
      sourceRecordId: "mac-daniel",
      matchMethod: "source_id",
    });
    addExternal("mac-lilly", "Lilly Haim", { phones: ["+14155550134"] });
    linkExternalContactsForUser(USER);
    mockDb!
      .prepare("DELETE FROM external_contacts WHERE external_record_id = 'mac-lilly'")
      .run();
  }

  it("hides a question whose source record has gone, and the count agrees", () => {
    seedThenRemoveRecord();
    expect(pendingPairs()).toEqual([]);
    expect(countReviewQueue(USER)).toBe(0);
  });

  it("hides a question whose contact was tombstoned, and the count agrees", () => {
    addContact("c-daniel", "Daniel Haim", { phones: ["+14155550134"] });
    addExternal("mac-daniel", "Daniel Haim", { phones: ["+14155559999"] });
    createLink({
      userId: USER,
      contactId: "c-daniel",
      sourceType: "macos",
      sourceRecordId: "mac-daniel",
      matchMethod: "source_id",
    });
    addExternal("mac-lilly", "Lilly Haim", { phones: ["+14155550134"] });
    linkExternalContactsForUser(USER);
    expect(countReviewQueue(USER)).toBe(1);

    mockDb!.prepare("UPDATE contacts SET removed_at = '2026-08-02' WHERE id = 'c-daniel'").run();

    expect(pendingPairs()).toEqual([]);
    expect(countReviewQueue(USER)).toBe(0);
  });

  /**
   * A frozen-audit contact is offered rather than linked, per BACKLOG-2401's
   * belt-and-braces guard. The queue is where that decision now goes.
   */
  it("queues a frozen-audit contact instead of linking it", () => {
    addContact("c-jon", "Jon Frost", { emails: ["jon@example.com"] });
    addTransaction("t-frozen", "999 Ice Rd", ["c-jon"], { exported: true });
    addExternal("out-jon", "Jon Frost", { source: "outlook", emails: ["jon@example.com"] });

    linkExternalContactsForUser(USER);

    expect(pendingPairs()).toEqual(["c-jon|outlook|out-jon"]);
    expect(linkSet("c-jon")).toEqual([]);
    const item = getReviewQueue(USER)[0].items[0];
    expect(item.reason).toBe("frozen_audit_contact");
    expect(item.evidence?.summary).toContain("already exported");
  });
});
