/**
 * @jest-environment node
 *
 * BACKLOG-2427 + BACKLOG-2423 — when do a source record's emails and phones
 * move ONTO a contact, and when do they come back OFF?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE USES `node:sqlite` AND NOT THE REPO'S USUAL REAL DRIVER
 * ---------------------------------------------------------------------------
 * The sibling identity suites (`contactSourceLinker`, `contactProvenance`, …)
 * reach past Jest's module mock and `require()` the real
 * `better-sqlite3-multiple-ciphers` out of `node_modules`. That binary is an
 * ELECTRON build — NODE_MODULE_VERSION 139 — so under plain `node` (ABI 127) it
 * cannot be loaded at all, and every one of those suites is red on a developer
 * machine before a single line of product code is considered. Rebuilding it is
 * not an option: it is shared by every worktree on this machine.
 *
 * `node:sqlite` is the SQLite that ships inside Node 22 itself. Same engine,
 * same SQL — `json_each`, window functions and `@name` parameters all verified
 * present — with no binary to build and nothing shared to disturb. So the
 * assertions below execute REAL SQL against the REAL schema constants, and they
 * do it on this machine, which is the whole point: a proof you cannot run is
 * not a proof.
 *
 * ---------------------------------------------------------------------------
 * ASSERTION STYLE — EXACT VALUE SETS, NEVER COUNTS
 * ---------------------------------------------------------------------------
 * `expect(emails).toHaveLength(2)` is equally satisfied by deleting the WRONG
 * address, which is precisely the failure being fixed. Every assertion below
 * names the exact set it expects.
 */

import { jest } from "@jest/globals";
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

type Db = InstanceType<typeof DatabaseSync>;

// Must be named `mock*` to satisfy babel-plugin-jest-hoist's out-of-scope rule.
let mockDb: Db | null = null;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
  },
  // node:sqlite has no `db.transaction(fn)` helper, so the semantics
  // `unlinkContactSource` relies on (all-or-nothing) are spelled out.
  dbTransaction: <T>(fn: () => T): T => {
    mockDb!.exec("BEGIN");
    try {
      const out = fn();
      mockDb!.exec("COMMIT");
      return out;
    } catch (e) {
      mockDb!.exec("ROLLBACK");
      throw e;
    }
  },
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { unlinkContactSource } from "../contactProvenance";
import {
  applyLinkedSourceValues,
  removeUnlinkedSourceValues,
} from "../contactSourceValues";
import { createLink, getLinksForContact } from "../db/contactSourceLinkDbService";
import {
  getRejectedSourceKeys,
  recordVerdict,
} from "../db/contactLinkReviewDbService";
import { sourceKey } from "../db/contactSourceLinkDbService";
import { getContactEmailsForTransaction } from "../db/contactDbService";

const USER = "user-2427";

// The founder's actual case, 2026-08-02.
const PAUL = "contact-paul-dorian";
const TXN = "txn-571-dale-st-n";

/** Outlook-only. The address that must GO. */
const OUTLOOK_ONLY_EMAIL = "dorian@bluespaces.com";
/** On BOTH source records. Must SURVIVE losing one of them. */
const SHARED_EMAIL = "paul@pauljdorian.com";
/**
 * On the Outlook record too — so "not contributed by the rejected source" is
 * NOT what saves it. Only `source = 'manual'` saves it. That makes this a real
 * test of the typed-value guarantee rather than an accident of the fixture.
 */
const MANUAL_EMAIL = "paul.typed@example.com";
/** On BOTH records. The number that stranded the released record. */
const SHARED_PHONE_E164 = "+14082104874";
const SHARED_PHONE_KEY = "4082104874";
const SHARED_PHONE_RAW = "(408) 210-4874";

// ---------------------------------------------------------------------------
// SEED HELPERS
// ---------------------------------------------------------------------------

function addContact(id: string, displayName: string): void {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, USER, displayName);
}

function addEmail(
  contactId: string,
  email: string,
  source: "import" | "manual" | "inferred" | null,
  isPrimary = 0,
): void {
  mockDb!
    .prepare(
      "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, ?, ?)",
    )
    .run(`${contactId}-${email}`, contactId, email, isPrimary, source);
}

function addPhone(
  contactId: string,
  e164: string,
  key: string,
  source: "import" | "manual" | "inferred" | null,
  isPrimary = 1,
): void {
  mockDb!
    .prepare(
      `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`${contactId}-${e164}`, contactId, e164, key, isPrimary, source);
}

function addExternal(
  recordId: string,
  name: string,
  source: string,
  emails: string[],
  phones: string[],
): void {
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, phones_normalized_json, emails_json,
         external_record_id, source, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ext-${source}-${recordId}`,
      USER,
      name,
      JSON.stringify(phones),
      JSON.stringify(phones.map((p) => p.replace(/\D/g, "").slice(-10))),
      JSON.stringify(emails),
      recordId,
      source,
      "2026-08-02T00:00:00.000Z",
    );
}

function addTransactionWithContact(txnId: string, contactId: string, exported: boolean): void {
  mockDb!
    .prepare(
      "INSERT INTO transactions (id, user_id, property_address, first_exported_at) VALUES (?, ?, ?, ?)",
    )
    .run(txnId, USER, "571 Dale St N", exported ? "2026-08-01T00:00:00.000Z" : null);
  mockDb!
    .prepare(
      "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, ?)",
    )
    .run(`${txnId}-${contactId}`, txnId, contactId, "seller");
}

// ---------------------------------------------------------------------------
// OBSERVATION HELPERS — sets, sorted, exact
// ---------------------------------------------------------------------------

function emailsOn(contactId: string): string[] {
  return (
    mockDb!
      .prepare("SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY email")
      .all(contactId) as Array<{ email: string }>
  ).map((r) => r.email);
}

function phonesOn(contactId: string): string[] {
  return (
    mockDb!
      .prepare("SELECT phone_e164 FROM contact_phones WHERE contact_id = ? ORDER BY phone_e164")
      .all(contactId) as Array<{ phone_e164: string }>
  ).map((r) => r.phone_e164);
}

function linkKeysFor(contactId: string): string[] {
  return getLinksForContact(contactId)
    .map((l) => `${l.source_type}/${l.source_record_id}`)
    .sort();
}

/**
 * THE FOUNDER'S CONTACT, exactly as QA found it.
 *
 * Paul Dorian, a party to 571 Dale St N, assembled from a macOS card and an
 * Outlook record, with the Outlook record's unique address already copied onto
 * him by the backfill.
 */
function seedPaulDorian(opts: { exported?: boolean } = {}): { outlookLinkId: string } {
  addContact(PAUL, "Paul Dorian");

  addExternal("mac-paul", "Paul Dorian", "macos", [SHARED_EMAIL], [SHARED_PHONE_RAW]);
  addExternal(
    "out-paul",
    "Paul Dorian",
    "outlook",
    [OUTLOOK_ONLY_EMAIL, SHARED_EMAIL, MANUAL_EMAIL],
    [SHARED_PHONE_RAW],
  );

  // What the backfill left behind: everything both records carry, plus the one
  // address only Outlook has. Plus one the user typed.
  addEmail(PAUL, SHARED_EMAIL, "import", 1);
  addEmail(PAUL, OUTLOOK_ONLY_EMAIL, "import");
  addEmail(PAUL, MANUAL_EMAIL, "manual");
  addPhone(PAUL, SHARED_PHONE_E164, SHARED_PHONE_KEY, "import");

  createLink({
    userId: USER,
    contactId: PAUL,
    sourceType: "macos",
    sourceRecordId: "mac-paul",
    matchMethod: "source_id",
  });
  const outlook = createLink({
    userId: USER,
    contactId: PAUL,
    sourceType: "outlook",
    sourceRecordId: "out-paul",
    matchMethod: "email",
  });

  addTransactionWithContact(TXN, PAUL, opts.exported ?? false);

  return { outlookLinkId: outlook.id! };
}

beforeEach(() => {
  mockDb = new DatabaseSync(":memory:");
  mockDb.exec("PRAGMA foreign_keys = ON");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("sanity", () => {
  it("runs real SQL against the real identity schema", () => {
    expect(mockDb!.prepare("SELECT 1 AS n").get()).toEqual({ n: 1 });
    // The column the whole removal rule turns on must actually exist.
    const cols = (
      mockDb!.prepare("PRAGMA table_info(contact_emails)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("source");
  });
});

// ===========================================================================
describe("BACKLOG-2427 — the founder's case: unlink must reverse the copy", () => {
  /**
   * THE HEADLINE TEST. Founder QA, 2026-08-02, real data.
   *
   * He pressed "Not this person" on the Outlook source of his saved contact
   * Paul Dorian, who is a party to 571 Dale St N. Before this fix the link went,
   * the verdict was recorded, and `dorian@bluespaces.com` — an address that
   * exists ONLY in that Outlook record — stayed on the contact, so the audit for
   * that transaction went on searching for the correspondence of a person he had
   * just said was somebody else.
   *
   * NEGATIVE CONTROL (executed, see PR): delete the
   * `removeUnlinkedSourceValues` call from `unlinkContactSource` and this block
   * fails on the first assertion, with the Outlook-only address still present.
   */
  it("removes what only the rejected source had, and keeps everything else", () => {
    const { outlookLinkId } = seedPaulDorian();

    const outcome = unlinkContactSource(USER, PAUL, outlookLinkId);

    expect(outcome).toMatchObject({ ok: true, remaining: 1 });

    // 1. The Outlook-only address is GONE — the whole point.
    // 2. The shared address SURVIVES — the macOS card still carries it.
    // 3. The typed address SURVIVES — even though the rejected record had it too.
    expect(emailsOn(PAUL)).toEqual([MANUAL_EMAIL, SHARED_EMAIL]);

    // The shared phone survives: the still-linked macOS record carries it.
    expect(phonesOn(PAUL)).toEqual([SHARED_PHONE_E164]);

    // The contact and the other source are untouched.
    expect(linkKeysFor(PAUL)).toEqual(["macos/mac-paul"]);
  });

  it("takes the rejected address out of the transaction's audit sweep", () => {
    const { outlookLinkId } = seedPaulDorian();

    // This is what the email sync actually reads, and what made the leftover
    // address a correctness problem rather than a cosmetic one.
    expect(getContactEmailsForTransaction(TXN).sort()).toEqual(
      [MANUAL_EMAIL, OUTLOOK_ONLY_EMAIL, SHARED_EMAIL].sort(),
    );

    unlinkContactSource(USER, PAUL, outlookLinkId);

    expect(getContactEmailsForTransaction(TXN).sort()).toEqual(
      [MANUAL_EMAIL, SHARED_EMAIL].sort(),
    );
  });

  it("reports what it took back, so the UI can stop promising more than it does", () => {
    const { outlookLinkId } = seedPaulDorian();
    const outcome = unlinkContactSource(USER, PAUL, outlookLinkId);
    expect(outcome).toEqual({
      ok: true,
      remaining: 1,
      removedEmails: 1,
      removedPhones: 0,
    });
  });

  it("still records the different_people verdict that makes the unlink stick", () => {
    const { outlookLinkId } = seedPaulDorian();
    unlinkContactSource(USER, PAUL, outlookLinkId);

    const verdicts = mockDb!
      .prepare(
        `SELECT source_type, source_record_id, identity_verdict, decided_by
           FROM contact_link_verdicts WHERE user_id = ? AND contact_id = ?`,
      )
      .all(USER, PAUL);
    expect(verdicts).toEqual([
      {
        source_type: "outlook",
        source_record_id: "out-paul",
        identity_verdict: "different_people",
        decided_by: "provenance_unlink",
      },
    ]);
  });

  /**
   * The case that a `CONTACT_SOURCE_RECORDS_SQL`-based implementation gets
   * silently wrong. That query's content-fallback branches switch ON when the
   * contact has no crosswalk rows left, so unlinking the LAST source re-matches
   * the record just released and concludes every value is still contributed.
   */
  it("still removes when the rejected source was the contact's ONLY link", () => {
    addContact("solo", "Solo Person");
    addExternal("out-solo", "Solo Person", "outlook", ["solo@bluespaces.com"], []);
    addEmail("solo", "solo@bluespaces.com", "import", 1);
    const link = createLink({
      userId: USER,
      contactId: "solo",
      sourceType: "outlook",
      sourceRecordId: "out-solo",
      matchMethod: "email",
    });

    unlinkContactSource(USER, "solo", link.id!);

    expect(emailsOn("solo")).toEqual([]);
  });

  it("never removes a value another still-linked source also contributes", () => {
    const { outlookLinkId } = seedPaulDorian();
    removeUnlinkedSourceValues(USER, PAUL, "outlook", "out-paul");
    // The link is still in place here, so the macOS AND Outlook records both
    // count as remaining — nothing may be removed at all.
    expect(emailsOn(PAUL).sort()).toEqual(
      [MANUAL_EMAIL, OUTLOOK_ONLY_EMAIL, SHARED_EMAIL].sort(),
    );
    expect(outlookLinkId).toBeTruthy();
  });

  it("leaves a value of unknown provenance (source NULL) alone", () => {
    addContact("legacy", "Legacy Person");
    addExternal("out-legacy", "Legacy Person", "outlook", ["legacy@bluespaces.com"], []);
    // Row predating the `source` column — we cannot know who put it there.
    addEmail("legacy", "legacy@bluespaces.com", null, 1);
    const link = createLink({
      userId: USER,
      contactId: "legacy",
      sourceType: "outlook",
      sourceRecordId: "out-legacy",
      matchMethod: "email",
    });

    unlinkContactSource(USER, "legacy", link.id!);

    expect(emailsOn("legacy")).toEqual(["legacy@bluespaces.com"]);
  });
});

// ===========================================================================
describe("BACKLOG-2427 — frozen audits: refuse the removal and explain", () => {
  /**
   * Founder decision, 2026-08-02: refuse and explain. Removing an address from
   * a contact on an EXPORTED transaction changes what a re-export searches —
   * silently altering the inputs of a document already handed to someone.
   *
   * Refused means refused THE REMOVAL, not the whole action: the link still
   * goes and the verdict still stands, so the user can still correct a wrong
   * merge on the transactions where a wrong merge costs the most.
   */
  it("keeps the addresses, removes the link, and says which happened", () => {
    const { outlookLinkId } = seedPaulDorian({ exported: true });

    const outcome = unlinkContactSource(USER, PAUL, outlookLinkId);

    expect(outcome).toEqual({
      ok: true,
      remaining: 1,
      removedEmails: 0,
      removedPhones: 0,
      retainedReason: "frozen_transaction",
    });
    // Nothing was taken from the exported audit's search set.
    expect(emailsOn(PAUL).sort()).toEqual(
      [MANUAL_EMAIL, OUTLOOK_ONLY_EMAIL, SHARED_EMAIL].sort(),
    );
    // The correction the user asked for still happened.
    expect(linkKeysFor(PAUL)).toEqual(["macos/mac-paul"]);
  });

  it("does not claim a refusal when there was nothing to remove anyway", () => {
    // Every value the Outlook record holds is also on the macOS card, so the
    // frozen guard must never fire — reporting `retainedReason` here would tell
    // the user something was withheld when nothing was.
    addContact("shared", "Shared Person");
    addExternal("mac-shared", "Shared Person", "macos", ["both@example.com"], []);
    addExternal("out-shared", "Shared Person", "outlook", ["both@example.com"], []);
    addEmail("shared", "both@example.com", "import", 1);
    createLink({
      userId: USER,
      contactId: "shared",
      sourceType: "macos",
      sourceRecordId: "mac-shared",
      matchMethod: "source_id",
    });
    const out = createLink({
      userId: USER,
      contactId: "shared",
      sourceType: "outlook",
      sourceRecordId: "out-shared",
      matchMethod: "email",
    });
    addTransactionWithContact("txn-frozen-2", "shared", true);

    const outcome = unlinkContactSource(USER, "shared", out.id!);

    expect(outcome).toEqual({ ok: true, remaining: 1, removedEmails: 0, removedPhones: 0 });
    expect(emailsOn("shared")).toEqual(["both@example.com"]);
  });
});

// ===========================================================================
describe("BACKLOG-2427 — the released record becomes reachable again", () => {
  /**
   * The second half of the founder's report: *"Does the unlinked Outlook record
   * appear as its own person? no. i also went to the settings, clicked the blue
   * re-import button and still nothing."*
   *
   * Note what does NOT rescue it. The released record is named "Paul Dorian",
   * identical to the contact, so a name-compatibility rule still hides it. And
   * the shared phone is genuinely on the still-linked macOS card, so the
   * removal above correctly KEEPS it. Only the user's recorded answer
   * distinguishes "this record is that person" from "this record shares that
   * person's office line" — which is why the picker has to read the verdict.
   */
  it("publishes the released record as a rejected source key the picker can honour", () => {
    const { outlookLinkId } = seedPaulDorian();

    expect([...getRejectedSourceKeys(USER)]).toEqual([]);

    unlinkContactSource(USER, PAUL, outlookLinkId);

    expect([...getRejectedSourceKeys(USER)]).toEqual([sourceKey("outlook", "out-paul")]);
    // And the phone that stranded it is STILL on the contact — proving the
    // release does not depend on the removal having taken it away.
    expect(phonesOn(PAUL)).toEqual([SHARED_PHONE_E164]);
  });

  it("stops treating a record as released once the user changes their mind", () => {
    const { outlookLinkId } = seedPaulDorian();
    unlinkContactSource(USER, PAUL, outlookLinkId);
    expect([...getRejectedSourceKeys(USER)]).toEqual([sourceKey("outlook", "out-paul")]);

    // Latest verdict wins — `recordVerdict` appends, never updates.
    recordVerdict({
      userId: USER,
      contactId: PAUL,
      sourceType: "outlook",
      sourceRecordId: "out-paul",
      identityVerdict: "same_person",
      decidedBy: "review_queue",
    });

    expect([...getRejectedSourceKeys(USER)]).toEqual([]);
  });
});

// ===========================================================================
describe("BACKLOG-2423 — a newly linked source contributes immediately", () => {
  /**
   * The inverse timing defect. `backfillImportedContactsFromExternal` is gated
   * once per user per session, so a source linked AFTER it ran contributed
   * nothing until the next app start; a transaction created in that window
   * swept an incomplete address set and nothing re-swept when the addresses
   * later arrived.
   *
   * NEGATIVE CONTROL (executed, see PR): remove the `applyLinkedSourceValues`
   * call from the linker and this block fails with the contact still holding
   * only its original address.
   */
  it("copies a linked record's addresses onto the contact at link time", () => {
    addContact("late", "Late Linker");
    addEmail("late", "known@example.com", "import", 1);
    addExternal("out-late", "Late Linker", "outlook", ["known@example.com", "new@outlook.com"], [
      "(415) 555-0000",
    ]);
    createLink({
      userId: USER,
      contactId: "late",
      sourceType: "outlook",
      sourceRecordId: "out-late",
      matchMethod: "email",
    });

    const before = emailsOn("late");
    const result = applyLinkedSourceValues(USER, "late");

    expect(before).toEqual(["known@example.com"]);
    expect(result).toEqual({ emailsAdded: 1, phonesAdded: 1 });
    expect(emailsOn("late")).toEqual(["known@example.com", "new@outlook.com"]);
    expect(phonesOn("late")).toEqual(["+14155550000"]);
  });

  it("is idempotent, so running it on every link costs nothing once converged", () => {
    addContact("idem", "Idem Person");
    addExternal("out-idem", "Idem Person", "outlook", ["a@example.com"], []);
    createLink({
      userId: USER,
      contactId: "idem",
      sourceType: "outlook",
      sourceRecordId: "out-idem",
      matchMethod: "email",
    });

    expect(applyLinkedSourceValues(USER, "idem")).toEqual({ emailsAdded: 1, phonesAdded: 0 });
    expect(applyLinkedSourceValues(USER, "idem")).toEqual({ emailsAdded: 0, phonesAdded: 0 });
    expect(emailsOn("idem")).toEqual(["a@example.com"]);
  });

  it("copies from EVERY linked source, not just one winner", () => {
    addContact("multi", "Multi Source");
    addExternal("mac-multi", "Multi Source", "macos", ["mac@example.com"], []);
    addExternal("out-multi", "Multi Source", "outlook", ["out@example.com"], []);
    createLink({
      userId: USER,
      contactId: "multi",
      sourceType: "macos",
      sourceRecordId: "mac-multi",
      matchMethod: "source_id",
    });
    createLink({
      userId: USER,
      contactId: "multi",
      sourceType: "outlook",
      sourceRecordId: "out-multi",
      matchMethod: "email",
    });

    applyLinkedSourceValues(USER, "multi");

    expect(emailsOn("multi")).toEqual(["mac@example.com", "out@example.com"]);
  });

  /** A copy that arrives is only safe if the unlink can take it back again. */
  it("round-trips: a link copies, and unlinking that same link takes it back", () => {
    addContact("round", "Round Trip");
    addExternal("out-round", "Round Trip", "outlook", ["only@outlook.com"], []);
    const link = createLink({
      userId: USER,
      contactId: "round",
      sourceType: "outlook",
      sourceRecordId: "out-round",
      matchMethod: "email",
    });

    applyLinkedSourceValues(USER, "round");
    expect(emailsOn("round")).toEqual(["only@outlook.com"]);

    unlinkContactSource(USER, "round", link.id!);
    expect(emailsOn("round")).toEqual([]);
  });
});
