/**
 * @jest-environment node
 *
 * BACKLOG-2471 PR C — the compare screen's columns, read-only.
 *
 * ---------------------------------------------------------------------------
 * THE TWO THAT MATTER
 * ---------------------------------------------------------------------------
 * 1. `a source column shows THAT RECORD'S OWN messages`. After
 *    `applyLinkedSourceValues` a linked record's addresses have already been
 *    copied onto the contact, so "the contact's messages" and "the record's
 *    messages" overlap almost completely on real data. A fixture without a
 *    DELIBERATE ASYMMETRY — one address only the record holds, one text only the
 *    contact can be reached at — passes whether the reader matches by record or
 *    by contact. The asymmetry IS the test.
 *
 * 2. `the column set` is enumerated by RUNNING the rule over every link shape,
 *    not by reasoning about it, and the shapes are built through the REAL
 *    producers (`recordContactOrigin`, `createLink`) rather than hand-written
 *    INSERTs. Both writers use `INSERT OR IGNORE`, which swallows a CHECK
 *    violation silently — so a hand-typed origin row could pin a state the
 *    producer is incapable of emitting, and the suite would never know.
 *
 * Every assertion names EXACT id sets. A count would pass while rendering the
 * wrong column.
 */

import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";
import { CONTACT_COMMUNICATION_SCHEMA } from "./helpers/contactCommunicationSchema";

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

import { getContactCompareColumns, confirmContactSources } from "../contactCompare";
import { createLink } from "../db/contactSourceLinkDbService";
import { recordContactOrigin, originRecordId } from "../db/contactOriginLink";
import { showSourcesPanel } from "../../../src/utils/contactSourceAffordances";
import { getContactProvenance } from "../contactProvenance";
import { proposeLink } from "../db/contactLinkReviewDbService";
import { countReviewQueue, getReviewQueue } from "../contactLinkReview";
import { canUnlinkSource } from "../../../src/utils/contactSourceAffordances";
import { getReviewStateByContact } from "../db/contactSourceSets";

const USER = "user-compare-2471";
const OTHER_USER = "user-other-2471";

/**
 * Fixture values. RFC 2606 domains and NANP reserved-fictional numbers, where
 * 555 is the EXCHANGE and never the area code — `scripts/ci/check-fixture-pii.mjs`
 * rejects the other spelling.
 *
 * ---------------------------------------------------------------------------
 * "PAUL DORIAN" IS BASELINED IN THAT GUARD, AND THIS IS THE RECORDED RULING
 * ---------------------------------------------------------------------------
 * The guard flags a personal name sharing a line with a number — the identity-row
 * shape that leaked in BACKLOG-2542. It fires once in this file, on the
 * removed-contact fixture, where the number on the line is a `removed_at`
 * TIMESTAMP rather than an address or a phone.
 *
 * The name is the founder's own mock persona — it is the name throughout the
 * approved compare-screen mock this feature is built from, so the fixtures read
 * as the design does. **SR ruling `a54893bc`** records that it is invented and
 * not a real person's, which is the review decision the baseline's own
 * `$comment` requires before an entry may be added (PR-SOP §6.2d).
 *
 * The citation lives HERE, and in the PR body, deliberately: the baseline JSON's
 * `$comment` is regenerated verbatim by `--update-baseline`
 * (`check-fixture-pii.mjs:394-401`), so a note written into that file would be
 * erased without trace by the next person to run the tool.
 *
 * `FICTIONAL_NAMES` was deliberately NOT widened — §6.2d names that exact move
 * as the one that hid real-name shapes on 2026-08-06.
 */
const SHARED_PHONE = "+12065550142";
const SHARED_EMAIL = "paul@example.com";
/** Held by the Outlook record and by nothing else. The asymmetry in test 1. */
const OUTLOOK_ONLY_EMAIL = "p.dorian@example.test";
/** Reaches the contact and no source record. The other half of the asymmetry. */
const CONTACT_ONLY_PHONE = "+12065550188";

function addContact(
  id: string,
  displayName: string,
  opts: {
    source?: string;
    company?: string | null;
    emails?: string[];
    phones?: string[];
    removedAt?: string | null;
    userId?: string;
  } = {},
): void {
  mockDb!
    .prepare(
      `INSERT INTO contacts (id, user_id, display_name, company, source, is_imported, removed_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      id,
      opts.userId ?? USER,
      displayName,
      opts.company ?? null,
      opts.source ?? "contacts_app",
      opts.removedAt ?? null,
    );
  (opts.emails ?? []).forEach((e, i) => {
    mockDb!
      .prepare(
        "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, ?, 'import')",
      )
      .run(`${id}-e${i}`, id, e, i === 0 ? 1 : 0);
  });
  (opts.phones ?? []).forEach((p, i) => {
    mockDb!
      .prepare(
        `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source)
         VALUES (?, ?, ?, ?, ?, ?, 'import')`,
      )
      .run(`${id}-p${i}`, id, p, p, p.slice(-10), i === 0 ? 1 : 0);
  });
}

function addExternal(
  recordId: string,
  name: string,
  source: string,
  opts: { emails?: string[]; phones?: string[]; company?: string | null } = {},
): void {
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, emails_json, company, external_record_id, source, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      `ec-${recordId}`,
      USER,
      name,
      JSON.stringify(opts.phones ?? []),
      JSON.stringify(opts.emails ?? []),
      opts.company ?? null,
      recordId,
      source,
    );
}

/** A link, through the REAL writer. Returns the crosswalk row id. */
function link(
  contactId: string,
  sourceType: "macos" | "outlook" | "google_contacts" | "iphone" | "android_sync",
  recordId: string,
  matchMethod: "source_id" | "email" | "phone" | "manual" | "scored" | "unique_name",
): string {
  const out = createLink({
    userId: USER,
    contactId,
    sourceType,
    sourceRecordId: recordId,
    matchMethod,
    assertMethod: true,
  });
  if (!out.id) throw new Error(`fixture link not created for ${recordId}`);
  return out.id;
}

/**
 * The origin row, through the REAL producer.
 *
 * `recordContactOrigin` maps `contacts.source` to the origin `source_type` and
 * INSERT-OR-IGNOREs. It returns whether a row was written, and the fixture
 * ASSERTS that — because a swallowed CHECK violation and a successful write are
 * otherwise indistinguishable, and a suite built on the silent failure would be
 * pinning a state the app cannot reach.
 */
function origin(contactId: string, contactSource: string): string {
  const wrote = recordContactOrigin(USER, contactId, contactSource);
  expect(wrote).toBe(true);
  const row = mockDb!
    .prepare(
      "SELECT id FROM contact_source_links WHERE contact_id = ? AND source_record_id = ?",
    )
    .get(contactId, originRecordId(contactId)) as { id: string } | undefined;
  expect(row?.id).toBeTruthy();
  return row!.id;
}

function addEmail(
  id: string,
  subject: string,
  sentAt: string,
  participants: string[],
): void {
  mockDb!
    .prepare(
      `INSERT INTO emails (id, user_id, source, direction, subject, sent_at)
       VALUES (?, ?, 'outlook', 'inbound', ?, ?)`,
    )
    .run(id, USER, subject, sentAt);
  participants.forEach((addr, i) => {
    mockDb!
      .prepare(
        `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
         VALUES (?, 'to', ?, ?, ?)`,
      )
      .run(id, i, `${id}-h${i}`, addr);
  });
}

function addText(
  id: string,
  body: string,
  sentAt: string,
  participantsFlat: string,
  opts: { associatedMessageType?: number | null } = {},
): void {
  mockDb!
    .prepare(
      `INSERT INTO messages (id, user_id, channel, direction, body_text, participants_flat,
                             thread_id, sent_at, associated_message_type)
       VALUES (?, ?, 'imessage', 'inbound', ?, ?, ?, ?, ?)`,
    )
    .run(id, USER, body, participantsFlat, `thread-${id}`, sentAt, opts.associatedMessageType ?? null);
}

function addTransaction(txnId: string, address: string, contactId: string): void {
  mockDb!
    .prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)")
    .run(txnId, USER, address);
  mockDb!
    .prepare(
      "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, 'Buyer')",
    )
    .run(`${txnId}-tc`, txnId, contactId);
}

const columnIds = (view: Awaited<ReturnType<typeof getContactCompareColumns>>): string[] =>
  (view?.columns ?? []).map((c) => c.linkId);

beforeEach(() => {
  mockDb = new RealDatabase(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockDb.exec(CONTACT_COMMUNICATION_SCHEMA);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
// 1 + 2 — WHICH LINKS BECOME COLUMNS, AND THE BUTTON THAT MUST AGREE
// ===========================================================================
describe("the column set, enumerated by execution", () => {
  /**
   * Each case builds a real link shape and asserts the EXACT column id set.
   *
   * CONTROL: delete the `absorbed` computation in `getContactCompareColumns` so
   * no created-from link is absorbed. "imported, one attached record" then
   * returns three columns instead of two and this table goes red — while every
   * type-check and lint stays green, which is why the control is worth stating.
   */
  it("hand-typed contact with nothing attached has nothing to compare", async () => {
    addContact("c1", "Ada Lovelace", { source: "manual" });
    origin("c1", "manual");

    expect(await getContactCompareColumns(USER, "c1")).toBeNull();
  });

  it("imported contact with nothing attached has nothing to compare", async () => {
    addContact("c2", "Paul Dorian");
    origin("c2", "contacts_app");
    addExternal("mac-1", "Paul Dorian", "macos");
    link("c2", "macos", "mac-1", "source_id");

    expect(await getContactCompareColumns(USER, "c2")).toBeNull();
  });

  it("imported contact plus one attached record is TWO columns — the contact and the record", async () => {
    addContact("c3", "Paul Dorian", { emails: [SHARED_EMAIL] });
    const originId = origin("c3", "contacts_app");
    addExternal("mac-3", "Paul Dorian", "macos");
    link("c3", "macos", "mac-3", "source_id");
    addExternal("out-3", "Paul Dorian", "outlook", { emails: [SHARED_EMAIL] });
    const attachedId = link("c3", "outlook", "out-3", "email");

    const view = await getContactCompareColumns(USER, "c3");

    // The contact's column carries the ORIGIN row's id; the Mac card the contact
    // was made from is NOT a third column.
    expect(columnIds(view)).toEqual([originId, attachedId]);
    expect(view?.columns[0].kind).toBe("contact");
    expect(view?.columns[1].kind).toBe("source");
  });

  it("a collapsed import — two source_id records, nothing attached — still opens", async () => {
    // BACKLOG-2458, the founder's Casey Lane: one pick, two address books. This
    // is the case an "attached records only" rule would make unreachable.
    addContact("c4", "Casey Lane");
    const originId = origin("c4", "contacts_app");
    addExternal("mac-4", "Casey Lane", "macos");
    addExternal("out-4", "Casey Lane", "outlook");
    link("c4", "macos", "mac-4", "source_id");
    const second = link("c4", "outlook", "out-4", "source_id");

    const view = await getContactCompareColumns(USER, "c4");

    // The origin row is absorbed into the contact's column; ONE source_id row is
    // the record it was created from and rides along on that same column, so the
    // survivor is the only source column.
    expect(columnIds(view)).toEqual([originId, second]);
  });

  it("a contact with no origin row is labelled by the record it was created from", async () => {
    // Pre-v61 contacts have no origin row. The screen must not blank on them.
    addContact("c5", "Grace Hopper");
    addExternal("mac-5", "Grace Hopper", "macos");
    addExternal("out-5", "Grace Hopper", "outlook");
    const first = link("c5", "macos", "mac-5", "source_id");
    const attached = link("c5", "outlook", "out-5", "phone");

    const view = await getContactCompareColumns(USER, "c5");

    expect(columnIds(view)).toEqual([first, attached]);
    expect(view?.columns[0].kind).toBe("contact");
    // The contact's column shows the CONTACT's name, not the record's.
    expect(view?.columns[0].displayName).toBe("Grace Hopper");
  });

  /**
   * THE GATE CLAIM, AND ITS PREMISE.
   *
   * `Compare sources` is gated on `showSourcesPanel(sourceList)`, and that is
   * only equivalent to "this screen has something to show" BECAUSE
   * `getContactProvenance` filters origin rows in SQL — so `sourceList` never
   * contains the row this reader absorbs. The premise is asserted here rather
   * than assumed, and BOTH SIDES of the equivalence are covered: the shapes that
   * open the screen and the shapes that must not.
   *
   * CONTROL: remove `AND l.match_method <> ?` from `getContactProvenance` and
   * the two "nothing to compare" rows go red — the panel predicate starts
   * counting the absorbed row and claims there is something to compare when
   * there is not.
   */
  it("the button predicate and the column set agree on every shape, in both directions", async () => {
    const shapes: { id: string; name: string; build: () => void; opens: boolean }[] = [
      {
        id: "g1",
        name: "hand-typed, nothing attached",
        build: () => {
          addContact("g1", "Ada Lovelace", { source: "manual" });
          origin("g1", "manual");
        },
        opens: false,
      },
      {
        id: "g2",
        name: "imported, nothing attached",
        build: () => {
          addContact("g2", "Paul Dorian");
          origin("g2", "contacts_app");
          addExternal("mac-g2", "Paul Dorian", "macos");
          link("g2", "macos", "mac-g2", "source_id");
        },
        opens: false,
      },
      {
        id: "g3",
        name: "imported plus one attached",
        build: () => {
          addContact("g3", "Paul Dorian");
          origin("g3", "contacts_app");
          addExternal("mac-g3", "Paul Dorian", "macos");
          link("g3", "macos", "mac-g3", "source_id");
          addExternal("out-g3", "Paul Dorian", "outlook");
          link("g3", "outlook", "out-g3", "email");
        },
        opens: true,
      },
      {
        id: "g4",
        name: "collapsed import, two source_id",
        build: () => {
          addContact("g4", "Casey Lane");
          origin("g4", "contacts_app");
          addExternal("mac-g4", "Casey Lane", "macos");
          addExternal("out-g4", "Casey Lane", "outlook");
          link("g4", "macos", "mac-g4", "source_id");
          link("g4", "outlook", "out-g4", "source_id");
        },
        opens: true,
      },
      {
        id: "g5",
        name: "hand-typed plus one manual link",
        build: () => {
          addContact("g5", "Alan Turing", { source: "manual" });
          origin("g5", "manual");
          addExternal("out-g5", "Alan Turing", "outlook");
          link("g5", "outlook", "out-g5", "manual");
        },
        opens: true,
      },
    ];

    for (const shape of shapes) {
      shape.build();
      const panelOpens = showSourcesPanel(getContactProvenance(USER, shape.id));
      const view = await getContactCompareColumns(USER, shape.id);
      expect({ shape: shape.name, panelOpens, hasColumns: view !== null }).toEqual({
        shape: shape.name,
        panelOpens: shape.opens,
        hasColumns: shape.opens,
      });
    }
  });
});

// ===========================================================================
// 5 + 6 + 7 — THE D5 CELL TREATMENTS
// ===========================================================================
describe("founder decision D5 — what a source column shows", () => {
  /** Set by the fixture so every assertion selects a column BY ID. */
  let macLinkId = "";
  let outlookLinkId = "";

  beforeEach(() => {
    addContact("d5", "Paul Dorian", {
      company: "Example Realty",
      emails: [SHARED_EMAIL],
      phones: [SHARED_PHONE, CONTACT_ONLY_PHONE],
    });
    origin("d5", "contacts_app");
    // ATTACHED, not `source_id`: a record the contact picked up afterwards, so
    // it is genuinely a column of its own. (Selecting columns by LABEL rather
    // than by id would be wrong here in any case — an imported contact's own
    // column is labelled "Mac address book" too, from its origin row.)
    addExternal("mac-d5", "Paul Dorian", "macos", { phones: [SHARED_PHONE] });
    macLinkId = link("d5", "macos", "mac-d5", "phone");
    addExternal("out-d5", "Paul Dorian", "outlook", {
      emails: [SHARED_EMAIL, OUTLOOK_ONLY_EMAIL],
      company: "Example Realty",
    });
    outlookLinkId = link("d5", "outlook", "out-d5", "email");

    addTransaction("txn-1", "571 Dale St N", "d5");

    // Reaches the OUTLOOK record only — the asymmetry that makes the
    // "source's own messages" claim falsifiable.
    addEmail("em-1", "571 Dale St — signed disclosures", "2026-08-01T10:00:00Z", [
      OUTLOOK_ONLY_EMAIL,
    ]);
    // Reaches the CONTACT only. No source record carries this number.
    addText("tx-1", "Photos from the walkthrough", "2026-07-28T09:00:00Z", CONTACT_ONLY_PHONE);
    // Reaches the contact AND the Mac record — both may show it.
    addText("tx-2", "Re: inspection scheduling", "2026-08-02T09:00:00Z", SHARED_PHONE);
  });

  it("a source record's Transactions cell is empty — the renderer writes 'not a contact yet'", async () => {
    const view = await getContactCompareColumns(USER, "d5");
    const source = view!.columns.find((c) => c.kind === "source")!;

    expect(source.transactions).toEqual([]);
    // and the contact's column carries the real one
    expect(view!.columns[0].transactions).toEqual(["571 Dale St N"]);
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * CONTROL: in `loadCommunications`, feed every bundle the CONTACT's addresses
   * instead of its own column's. The Outlook column then also reports `tx-1`
   * and `tx-2` and this goes red. Without `OUTLOOK_ONLY_EMAIL` and
   * `CONTACT_ONLY_PHONE` in the fixture the two sets would be identical and the
   * control would stay GREEN — which is the whole reason the asymmetry is here.
   */
  it("a source column shows THAT RECORD'S own messages, not the contact's", async () => {
    const view = await getContactCompareColumns(USER, "d5");
    const outlook = view!.columns.find((c) => c.linkId === outlookLinkId)!;
    const mac = view!.columns.find((c) => c.linkId === macLinkId)!;
    const contact = view!.columns[0];

    // The Outlook record holds one address, and exactly one message reaches it.
    expect(outlook.recentCommunication.map((i) => i.id)).toEqual(["em-1"]);
    // The Mac record holds only the shared phone.
    expect(mac.recentCommunication.map((i) => i.id)).toEqual(["tx-2"]);
    // The contact is reachable at both of its numbers and its address.
    expect(new Set(contact.recentCommunication.map((i) => i.id))).toEqual(
      new Set(["tx-2", "tx-1"]),
    );
  });

  it("newest first, and capped at three", async () => {
    addText("tx-3", "one", "2026-06-01T09:00:00Z", CONTACT_ONLY_PHONE);
    addText("tx-4", "two", "2026-06-02T09:00:00Z", CONTACT_ONLY_PHONE);

    const view = await getContactCompareColumns(USER, "d5");
    // CONTROL: remove the `.slice(0, RECENT_COMMUNICATION_LIMIT)` and this
    // reports four ids; reverse the comparator and the order flips.
    expect(view!.columns[0].recentCommunication.map((i) => i.id)).toEqual([
      "tx-2",
      "tx-1",
      "tx-4",
    ]);
  });

  it("a tapback is not recent communication", async () => {
    addText("tx-react", "liked", "2026-08-05T09:00:00Z", CONTACT_ONLY_PHONE, {
      associatedMessageType: 2000,
    });

    const view = await getContactCompareColumns(USER, "d5");
    expect(view!.columns[0].recentCommunication.map((i) => i.id)).not.toContain("tx-react");
  });
});

// ===========================================================================
// 10 — MARKING
// ===========================================================================
describe("match marking", () => {
  it("marks a value carried by two columns, by the same keys the rest of the app uses", async () => {
    addContact("m1", "Paul Dorian", { emails: [SHARED_EMAIL], phones: [SHARED_PHONE] });
    origin("m1", "contacts_app");
    // Different SPELLING of the same number, and a different case of the same
    // address. CONTROL: compare raw strings instead of `toLookupKey` /
    // lower-cased trim and both marks disappear.
    addExternal("out-m1", "Paul Dorian", "outlook", {
      emails: ["PAUL@example.com"],
      phones: ["(206) 555-0142"],
    });
    link("m1", "outlook", "out-m1", "email");

    const view = await getContactCompareColumns(USER, "m1");
    const source = view!.columns[1];

    expect(source.emails).toEqual([{ value: "PAUL@example.com", matched: true }]);
    expect(source.phones).toEqual([{ value: "(206) 555-0142", matched: true }]);
    expect(view!.columns[0].emails).toEqual([{ value: SHARED_EMAIL, matched: true }]);
  });

  it("marks the two names that agree and leaves the third alone", async () => {
    // The mock's three-source example: "Paul Dorian", "Paul Dorian",
    // "Paul J. Dorian". CONTROL: require unanimity for the name mark and the
    // first two lose their badges.
    addContact("m2", "Paul Dorian", { emails: [SHARED_EMAIL] });
    origin("m2", "contacts_app");
    addExternal("out-m2", "Paul Dorian", "outlook", { emails: [SHARED_EMAIL] });
    link("m2", "outlook", "out-m2", "email");
    addExternal("and-m2", "Paul J. Dorian", "android_sync", { emails: [SHARED_EMAIL] });
    link("m2", "android_sync", "and-m2", "email");

    const view = await getContactCompareColumns(USER, "m2");

    // Columns render in the crosswalk's own order — `source_type` first — so the
    // Android record precedes the Outlook one.
    expect(view!.columns.map((c) => c.name)).toEqual([
      { value: "Paul Dorian", matched: true },
      { value: "Paul J. Dorian", matched: false },
      { value: "Paul Dorian", matched: true },
    ]);
    // …and the sentence does NOT claim the names match, because they do not all.
    expect(view!.namesMatch).toBe(false);
  });
});

// ===========================================================================
// 11 + 12 + 13 — THE REASON SENTENCE
// ===========================================================================
describe("the reason sentence", () => {
  it("names the shared phone and the matching names, on two columns", async () => {
    addContact("r1", "Paul Dorian", { phones: [SHARED_PHONE] });
    origin("r1", "contacts_app");
    addExternal("out-r1", "Paul Dorian", "outlook", { phones: [SHARED_PHONE] });
    link("r1", "outlook", "out-r1", "phone");

    const view = await getContactCompareColumns(USER, "r1");

    expect(view!.title).toBe("Is this the same Paul Dorian?");
    expect(view!.reason).toBe(
      `Both records list the phone number ${SHARED_PHONE}, and the names match.`,
    );
  });

  it("counts the columns in words on three", async () => {
    addContact("r2", "Paul Dorian", { emails: [SHARED_EMAIL] });
    origin("r2", "contacts_app");
    addExternal("out-r2", "Paul Dorian", "outlook", { emails: [SHARED_EMAIL] });
    link("r2", "outlook", "out-r2", "email");
    addExternal("and-r2", "Paul Dorian", "android_sync", { emails: [SHARED_EMAIL] });
    link("r2", "android_sync", "and-r2", "email");

    const view = await getContactCompareColumns(USER, "r2");
    expect(view!.reason).toBe(
      `Three records share the email address ${SHARED_EMAIL}, and the names match.`,
    );
  });

  it("falls back to how the link was made when the records share nothing", async () => {
    addContact("r3", "Alan Turing", { source: "manual" });
    origin("r3", "manual");
    addExternal("out-r3", "A. M. Turing", "outlook", { emails: ["amt@example.test"] });
    link("r3", "outlook", "out-r3", "manual");

    const view = await getContactCompareColumns(USER, "r3");
    expect(view!.reason).toBe("You confirmed this yourself.");
  });
});

// ===========================================================================
// 14 + 15 + 16 + 17 — READ-ONLY, AND THE GUARDS
// ===========================================================================
describe("guards", () => {
  it("writes NOTHING — the crosswalk and the verdicts are untouched", async () => {
    addContact("w1", "Paul Dorian", { phones: [SHARED_PHONE] });
    origin("w1", "contacts_app");
    addExternal("out-w1", "Paul Dorian", "outlook", { phones: [SHARED_PHONE] });
    link("w1", "outlook", "out-w1", "phone");

    const before = {
      links: mockDb!.prepare("SELECT * FROM contact_source_links ORDER BY id").all(),
      verdicts: mockDb!.prepare("SELECT * FROM contact_link_verdicts ORDER BY rowid").all(),
    };

    await getContactCompareColumns(USER, "w1");

    // CONTROL: add any `recordVerdict` or `createLink` call to the reader and
    // this goes red. PR C is the read-only half and this is what says so.
    expect({
      links: mockDb!.prepare("SELECT * FROM contact_source_links ORDER BY id").all(),
      verdicts: mockDb!.prepare("SELECT * FROM contact_link_verdicts ORDER BY rowid").all(),
    }).toEqual(before);
  });

  it("refuses a removed contact", async () => {
    addContact("t1", "Paul Dorian", { removedAt: "2026-08-01T00:00:00Z" });
    origin("t1", "contacts_app");
    addExternal("out-t1", "Paul Dorian", "outlook");
    link("t1", "outlook", "out-t1", "email");

    // CONTROL: drop `contact.removed_at` from the guard and this returns
    // columns. Nothing upstream would catch it — `getContactById` deliberately
    // still returns removed contacts, and provenance never joins `contacts`.
    expect(await getContactCompareColumns(USER, "t1")).toBeNull();
  });

  it("keeps the column when the source record has gone, and says so", async () => {
    addContact("v1", "Paul Dorian");
    const originId = origin("v1", "contacts_app");
    // A crosswalk row whose external_contacts row does not exist.
    const ghost = link("v1", "outlook", "out-vanished", "email");

    const view = await getContactCompareColumns(USER, "v1");

    // CONTROL: make the reader's LEFT JOIN a JOIN and this column disappears —
    // a two-record contact would then look like a one-record contact, which is
    // the invisibility this screen exists to end.
    expect(columnIds(view)).toEqual([originId, ghost]);
    const gone = view!.columns[1];
    expect(gone.sourceRecordPresent).toBe(false);
    expect(gone.name).toBeNull();
    expect(gone.emails).toEqual([]);
  });

  it("refuses another user's contact", async () => {
    addContact("x1", "Paul Dorian", { userId: OTHER_USER });
    addExternal("out-x1", "Paul Dorian", "outlook");
    mockDb!
      .prepare(
        `INSERT INTO contact_source_links (id, user_id, contact_id, source_type, source_record_id, match_method)
         VALUES ('lx1', ?, 'x1', 'outlook', 'out-x1', 'email')`,
      )
      .run(OTHER_USER);

    expect(await getContactCompareColumns(USER, "x1")).toBeNull();
  });

  it("returns null for a contact that does not exist", async () => {
    expect(await getContactCompareColumns(USER, "nope")).toBeNull();
  });
});

// ===========================================================================
// BACKLOG-2471 PR D — DECIDE FROM THE SCREEN
// ===========================================================================

/** A pending review-queue question for a pair, through the REAL producer. */
function propose(
  contactId: string,
  sourceType: "macos" | "outlook" | "android_sync",
  recordId: string,
  clusterKey: string,
): string {
  const out = proposeLink({
    userId: USER,
    contactId,
    sourceType,
    sourceRecordId: recordId,
    reason: "ambiguous_identifier",
    matchedOn: clusterKey.startsWith("name:") ? "name" : "email",
    identityAssessment: "possibly_same_person",
    relationshipAssessment: "possibly_connected",
    clusterKey,
    evidence: { lines: [] } as never,
  });
  if (!out.id) throw new Error(`fixture proposal not created for ${recordId}`);
  return out.id;
}

/** Exact verdict set, as `(contact, source_type, record)` triples. */
function verdictSet(identity = "same_person"): string[] {
  return (
    mockDb!
      .prepare(
        `SELECT contact_id, source_type, source_record_id FROM contact_link_verdicts
          WHERE identity_verdict = ? ORDER BY source_type, source_record_id`,
      )
      .all(identity) as { contact_id: string; source_type: string; source_record_id: string }[]
  ).map((r) => `${r.contact_id}|${r.source_type}|${r.source_record_id}`);
}

/**
 * A contact with an origin row, a `source_id` row that PR C's column rule
 * ABSORBS into column 1, and one attached record that gets a column.
 *
 * The absorbed row is the point: it is a link with no column, and #1 below is
 * what proves `Confirm` does not forget it.
 */
function twoColumnContact(id = "cf"): { absorbed: string; attached: string } {
  addContact(id, "Paul Dorian", { phones: [SHARED_PHONE] });
  origin(id, "contacts_app");
  addExternal(`mac-${id}`, "Paul Dorian", "macos", { phones: [SHARED_PHONE] });
  const absorbed = link(id, "macos", `mac-${id}`, "source_id");
  addExternal(`out-${id}`, "Paul Dorian", "outlook", { phones: [SHARED_PHONE] });
  const attached = link(id, "outlook", `out-${id}`, "email");
  return { absorbed, attached };
}

describe("confirm — the write", () => {
  it("writes one verdict per NON-ORIGIN LINK, including the one column 1 absorbed", async () => {
    twoColumnContact();

    const view = await getContactCompareColumns(USER, "cf");
    // Two columns on screen…
    expect(view!.columns).toHaveLength(2);

    const outcome = confirmContactSources(USER, "cf");

    // …and THREE links exist, of which two are non-origin. The absorbed
    // `source_id` row has no column and must still be confirmed.
    // CONTROL: confirm only the rendered source columns and `mac-cf` drops out
    // of this set — after which `isConfirmed` can never become true.
    expect(outcome).toEqual({ ok: true, confirmed: 2, alreadyConfirmed: 0, proposalsResolved: 0 });
    expect(verdictSet()).toEqual(["cf|macos|mac-cf", "cf|outlook|out-cf"]);
  });

  it("and the contact then reads confirmed", async () => {
    twoColumnContact();

    expect((await getContactCompareColumns(USER, "cf"))!.isConfirmed).toBe(false);
    confirmContactSources(USER, "cf");
    // Proves the set above is the RIGHT set, not merely a set.
    expect((await getContactCompareColumns(USER, "cf"))!.isConfirmed).toBe(true);
  });

  it("never writes a verdict for an origin row", async () => {
    twoColumnContact();
    confirmContactSources(USER, "cf");

    // The origin row points at the synthetic `origin:<contactId>` and its
    // source_type is outside the verdict CHECK. Passing it in would throw and
    // roll the whole transaction back; the loop excludes it in SQL, and
    // `RecordVerdictInput.sourceType` refuses it at compile time too.
    expect(verdictSet().some((k) => k.includes("origin:"))).toBe(false);
    expect(
      mockDb!.prepare("SELECT COUNT(*) AS n FROM contact_link_verdicts").get(),
    ).toEqual({ n: 2 });
  });

  it("is idempotent — a second press writes nothing", async () => {
    twoColumnContact();

    const first = confirmContactSources(USER, "cf");
    const second = confirmContactSources(USER, "cf");

    // CONTROL: drop the `hasMustLink` skip and the row COUNT doubles — harmless
    // to behaviour (latest wins) but it puts two identical unprompted decisions
    // into the calibration set.
    expect(first.confirmed).toBe(2);
    expect(second).toEqual({ ok: true, confirmed: 0, alreadyConfirmed: 2, proposalsResolved: 0 });
    expect(mockDb!.prepare("SELECT COUNT(*) AS n FROM contact_link_verdicts").get()).toEqual({
      n: 2,
    });
  });
});

describe("confirm — the question does NOT come back", () => {
  it("retires the pending queue question for a confirmed pair", async () => {
    const { attached } = twoColumnContact();
    expect(attached).toBeTruthy();
    const stale = propose("cf", "outlook", "out-cf", "record:out-cf");

    expect(countReviewQueue(USER)).toBe(1);
    const outcome = confirmContactSources(USER, "cf");

    // THE ONE THAT MATTERS. `PENDING_JOIN` selects on `p.status = 'pending'`
    // alone — it reads neither verdicts nor links — so a verdict-only
    // implementation passes every test about verdicts while "Review N possible
    // duplicates" does not move.
    // CONTROL: delete the resolveProposal loop and this goes red while every
    // test in the block above stays green.
    expect(outcome.proposalsResolved).toBe(1);
    expect(countReviewQueue(USER)).toBe(0);
    expect(getReviewQueue(USER).flatMap((c) => c.items.map((i) => i.proposalId))).not.toContain(
      stale,
    );
  });

  it("retires a NAME-rule question too, not only a record-cluster one", async () => {
    twoColumnContact();
    // `proposeLink` has TWO production callers: resolveSourceRecord (which
    // writes `record:` clusters) and fileNameQuestion (the unique-exact-name
    // rule, `name:<name>`). Matching is by PAIR for exactly this reason.
    // CONTROL: filter the resolve loop to `cluster_key LIKE 'record:%'` — the
    // optimisation someone will reach for — and this goes red while the test
    // above stays green.
    propose("cf", "outlook", "out-cf", "name:paul dorian");

    expect(countReviewQueue(USER)).toBe(1);
    expect(confirmContactSources(USER, "cf").proposalsResolved).toBe(1);
    expect(countReviewQueue(USER)).toBe(0);
  });

  it("leaves a question about a DIFFERENT pair alone", async () => {
    twoColumnContact();
    addContact("other", "Grace Hopper");
    origin("other", "contacts_app");
    addExternal("out-other", "Grace Hopper", "outlook");
    link("other", "outlook", "out-other", "email");
    const untouched = propose("other", "outlook", "out-other", "record:out-other");

    confirmContactSources(USER, "cf");

    // CONTROL: resolve every pending proposal instead of the confirmed pairs and
    // this goes red — one contact's confirmation would silently answer another's
    // question.
    expect(countReviewQueue(USER)).toBe(1);
    expect(getReviewQueue(USER).flatMap((c) => c.items.map((i) => i.proposalId))).toContain(
      untouched,
    );
  });
});

describe("confirm — the guards", () => {
  it("refuses a removed contact", async () => {
    twoColumnContact();
    mockDb!.prepare("UPDATE contacts SET removed_at = ? WHERE id = 'cf'").run("2026-08-01");

    // The WRITER states its own guard: the reader's does not cover it.
    expect(confirmContactSources(USER, "cf").ok).toBe(false);
    expect(verdictSet()).toEqual([]);
  });

  it("refuses another user's contact", async () => {
    twoColumnContact();

    expect(confirmContactSources(OTHER_USER, "cf").ok).toBe(false);
    expect(verdictSet()).toEqual([]);
  });

  it("does nothing for a contact with no non-origin links", async () => {
    addContact("bare", "Ada Lovelace", { source: "manual" });
    origin("bare", "manual");

    expect(confirmContactSources(USER, "bare")).toEqual({
      ok: true,
      confirmed: 0,
      alreadyConfirmed: 0,
      proposalsResolved: 0,
    });
    expect(verdictSet()).toEqual([]);
  });
});

describe("every source column is detachable, by construction", () => {
  /**
   * PR D renders `Unlink` on every source column WITHOUT re-spelling
   * `canUnlinkSource`. That is only safe while PR C's column rule guarantees it,
   * so the guarantee is asserted here rather than assumed there.
   *
   * CONTROL: stop absorbing the created-from row in `getContactCompareColumns`
   * and the imported-with-nothing-attached shape renders a column whose
   * `canUnlinkSource` is FALSE — an Unlink button that would always fail.
   */
  it.each([
    [
      // THE SHAPE THAT MAKES THE CONTROL BITE. Today this contact has no view at
      // all (its only record is the one it was created from, which column 1
      // absorbs). Stop absorbing and it renders ONE source column whose
      // `canUnlinkSource` is FALSE — an Unlink button that could only ever fail.
      // Without this row the control below reddens the column-set tests and
      // leaves this invariant green, which would be a test proving nothing.
      "imported with nothing attached (no view today)",
      "s0",
      () => {
        addContact("s0", "Tad Brooks");
        origin("s0", "contacts_app");
        addExternal("mac-s0", "Tad Brooks", "macos");
        link("s0", "macos", "mac-s0", "source_id");
      },
    ],
    ["imported plus one attached", "s1", () => twoColumnContact("s1")],
    [
      "collapsed import, two source_id rows",
      "s2",
      () => {
        addContact("s2", "Casey Lane");
        origin("s2", "contacts_app");
        addExternal("mac-s2", "Casey Lane", "macos");
        addExternal("out-s2", "Casey Lane", "outlook");
        link("s2", "macos", "mac-s2", "source_id");
        link("s2", "outlook", "out-s2", "source_id");
      },
    ],
    [
      "hand-typed plus one manual link",
      "s3",
      () => {
        addContact("s3", "Alan Turing", { source: "manual" });
        origin("s3", "manual");
        addExternal("out-s3", "Alan Turing", "outlook");
        link("s3", "outlook", "out-s3", "manual");
      },
    ],
  ])("%s", async (_name, contactId, build) => {
    build();
    const view = await getContactCompareColumns(USER, contactId as string);
    const sourceList = getContactProvenance(USER, contactId as string);

    // A contact with nothing to compare has no view — vacuously fine, and the
    // assertion below is what stops that becoming a way to pass.
    const sourceColumns = (view?.columns ?? []).filter((c) => c.kind === "source");
    for (const column of sourceColumns) {
      const link = sourceList.find((l) => l.linkId === column.linkId);
      expect(link).toBeTruthy();
      expect(canUnlinkSource(sourceList, link!)).toBe(true);
    }
  });
});

// ===========================================================================
// BACKLOG-2502 — THE REVIEW QUEUE'S CANDIDATE, AS ONE MORE COLUMN
// ===========================================================================

describe("the proposed column", () => {
  beforeEach(() => {
    twoColumnContact("pc");
    // A record NOBODY has linked — the queue's candidate. It has no crosswalk
    // row, which is exactly why the reader cannot find it any other way.
    addExternal("and-pc", "Paul Dorian", "android_sync", {
      emails: [SHARED_EMAIL],
      phones: [SHARED_PHONE],
    });
  });

  it("renders the unlinked candidate as the last column", async () => {
    const view = await getContactCompareColumns(USER, "pc", {
      sourceType: "android_sync",
      sourceRecordId: "and-pc",
    });

    // CONTROL: ignore the third argument and the candidate silently disappears
    // from the comparison the user is being asked to make.
    const last = view!.columns[view!.columns.length - 1];
    expect(last.linkId).toBe("proposed:android_sync:and-pc");
    expect(last.kind).toBe("proposed");
    expect(last.displayName).toBe("Paul Dorian");
    // Its values join the same cross-column marking — the point of showing it.
    expect(last.phones).toEqual([{ value: SHARED_PHONE, matched: true }]);
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * `isConfirmed` quantifies over non-origin LINKS. A proposal is not a link, so
   * a proposed column must not make a settled contact read unsettled — that
   * would re-open PR D's screen on contacts the user has already decided, and no
   * test about the review list would catch it.
   */
  it("does NOT change whether the contact reads confirmed", async () => {
    confirmContactSources(USER, "pc");
    const without = await getContactCompareColumns(USER, "pc");
    expect(without!.isConfirmed).toBe(true);

    const withProposal = await getContactCompareColumns(USER, "pc", {
      sourceType: "android_sync",
      sourceRecordId: "and-pc",
    });

    // CONTROL: count the proposed column as a link — for instance by deriving
    // `isConfirmed` from `columns` instead of from `nonOrigin` — and this flips.
    expect(withProposal!.isConfirmed).toBe(true);
    expect(withProposal!.columns.some((c) => c.kind === "proposed")).toBe(true);
  });

  it("omits the column rather than rendering a blank one when the record is gone", async () => {
    const view = await getContactCompareColumns(USER, "pc", {
      sourceType: "android_sync",
      sourceRecordId: "does-not-exist",
    });

    // It cannot happen through the queue — PENDING_JOIN inner-joins
    // external_contacts — so a miss means a stale renderer. An empty column
    // would invite a decision about a record that is not there.
    expect(view!.columns.every((c) => c.kind !== "proposed")).toBe(true);
  });

  it("leaves the view untouched when no candidate is passed", async () => {
    const plain = await getContactCompareColumns(USER, "pc");
    expect(plain!.columns.map((c) => c.kind)).toEqual(["contact", "source"]);
  });
});

// ===========================================================================
// BACKLOG-2502 R1 — COMPARE, FROM A CONTACT THAT HAS ONLY ONE RECORD
// ===========================================================================

/**
 * THE FOUNDER-OBSERVED DEFECT, 7 Aug.
 *
 * "When I click Compare on a Possible-duplicates row, on some I see: Compare
 * sources / This contact has only one record, so there is nothing to compare."
 *
 * The guard counted `sourceRows` — links, minus the absorbed one — and returned
 * before the candidate was appended. So it failed on precisely the shape the
 * review queue is made of: a contact assembled from ONE record, which is why an
 * unlinked record looked like a match in the first place.
 *
 * Every case below builds that one-record shape through the REAL writers and
 * asks the REAL shipped function, so the assertions cannot agree with a
 * re-derived rule.
 */
describe("the one-record contact the review queue asks about", () => {
  /** The `rA` shape: imported, its origin row plus the `source_id` row that
   *  column 1 absorbs. Nothing left to be a second column. */
  /** Returns the ORIGIN row id, which is what keys column 1 — so the assertions
   *  below can name both columns exactly without hard-coding a uuid. */
  const oneRecordContact = (id: string, name: string): string => {
    addContact(id, name, { phones: [SHARED_PHONE] });
    const originId = origin(id, "contacts_app");
    addExternal(`mac-${id}`, name, "macos", { phones: [SHARED_PHONE] });
    link(id, "macos", `mac-${id}`, "source_id");
    return originId;
  };

  it("still has nothing to compare with no candidate — the guard is not deleted", async () => {
    oneRecordContact("g1", "Tad Brooks");
    expect(await getContactCompareColumns(USER, "g1")).toBeNull();
  });

  /**
   * CONTROL C1. Revert the guard to `if (sourceRows.length === 0) return null;`
   * and this returns null — the exact dead Compare the founder hit.
   */
  it("renders TWO columns once the queue's candidate is passed", async () => {
    const originId = oneRecordContact("g2", "Paul Dorian");
    addExternal("out-g2", "Paul Dorian", "outlook", {
      emails: [SHARED_EMAIL],
      phones: [SHARED_PHONE],
    });

    const view = await getContactCompareColumns(USER, "g2", {
      sourceType: "outlook",
      sourceRecordId: "out-g2",
    });

    expect(view).not.toBeNull();
    // Identity, not count: WHICH two columns, in which order.
    expect(columnIds(view)).toEqual([originId, "proposed:outlook:out-g2"]);
    expect(view!.columns.map((c) => c.kind)).toEqual(["contact", "proposed"]);
    // The candidate joins the cross-column marking, which is the whole point of
    // opening this screen: the shared phone is what the user is judging.
    expect(view!.columns[1].phones).toEqual([{ value: SHARED_PHONE, matched: true }]);
  });

  /**
   * The guard counts the record, NOT the request. A `proposedSource` naming a
   * record that is gone renders no second column, so the view is still a single
   * column and must still be null — otherwise the fix would trade a dead button
   * for a one-column "comparison".
   */
  it("stays null when the candidate record does not exist", async () => {
    oneRecordContact("g3", "Ada Lovelace");
    const view = await getContactCompareColumns(USER, "g3", {
      sourceType: "outlook",
      sourceRecordId: "gone",
    });
    expect(view).toBeNull();
  });

  /** A removed contact is out regardless — the tombstone guard is upstream of
   *  this one and a candidate must not reopen it. */
  it("stays null for a removed contact even with a candidate", async () => {
    oneRecordContact("g4", "Grace Hopper");
    addExternal("out-g4", "Grace Hopper", "outlook", { emails: [SHARED_EMAIL] });
    mockDb!.prepare("UPDATE contacts SET removed_at = datetime('now') WHERE id = 'g4'").run();

    expect(
      await getContactCompareColumns(USER, "g4", {
        sourceType: "outlook",
        sourceRecordId: "out-g4",
      }),
    ).toBeNull();
  });
});

// ===========================================================================
// BACKLOG-2471 PR F — WHICH CONTACTS THE LIST FLAGS AND INTERCEPTS
// ===========================================================================

describe("the review-state set", () => {
  /**
   * THE RULE THIS BLOCK EXISTS FOR.
   *
   * The set decides which rows are flagged AND which clicks open the compare
   * screen, so it must equal the set the compare screen actually opens for. If
   * it does not, one of two lies ships: a flagged row that opens an ordinary
   * card, or an intercepted click landing on "there is nothing to compare".
   *
   * Every case below is built through the REAL producers and then checked
   * against the REAL shipped functions — `getContactCompareColumns` and its
   * `isConfirmed` — rather than against a re-derived predicate. A test that
   * re-implemented the rule would only ever agree with itself.
   */
  const shapes: { id: string; name: string; build: () => void }[] = [
    {
      id: "rA",
      name: "imported, nothing attached — compare cannot open",
      build: () => {
        addContact("rA", "Tad Brooks");
        origin("rA", "contacts_app");
        addExternal("mac-rA", "Tad Brooks", "macos");
        link("rA", "macos", "mac-rA", "source_id");
      },
    },
    {
      id: "rB",
      name: "imported plus one attached, unjudged",
      build: () => twoColumnContact("rB"),
    },
    {
      id: "rC",
      name: "imported plus one attached, fully confirmed",
      build: () => {
        twoColumnContact("rC");
        confirmContactSources(USER, "rC");
      },
    },
    {
      id: "rD",
      name: "collapsed import, two source_id rows",
      build: () => {
        addContact("rD", "Casey Lane");
        origin("rD", "contacts_app");
        addExternal("mac-rD", "Casey Lane", "macos");
        addExternal("out-rD", "Casey Lane", "outlook");
        link("rD", "macos", "mac-rD", "source_id");
        link("rD", "outlook", "out-rD", "source_id");
      },
    },
    {
      id: "rE",
      name: "two attached links, only ONE confirmed",
      build: () => {
        addContact("rE", "Alan Turing", { source: "manual" });
        origin("rE", "manual");
        addExternal("out-rE", "Alan Turing", "outlook");
        addExternal("and-rE", "Alan Turing", "android_sync");
        link("rE", "outlook", "out-rE", "manual");
        link("rE", "android_sync", "and-rE", "email");
        // One of the two answered, by hand, so the contact is PARTLY decided.
        mockDb!
          .prepare(
            `INSERT INTO contact_link_verdicts
               (id, user_id, contact_id, source_type, source_record_id, identity_verdict, decided_by)
             VALUES ('v-rE', ?, 'rE', 'outlook', 'out-rE', 'same_person', 'compare_confirm')`,
          )
          .run(USER);
      },
    },
  ];

  it("membership equals what the compare screen does, on every shape", async () => {
    for (const shape of shapes) shape.build();

    const set = getReviewStateByContact(USER);

    for (const shape of shapes) {
      const view = await getContactCompareColumns(USER, shape.id);
      const state = set.get(shape.id);

      // CONTROL: drop the `COUNT(*) > 1 OR MIN(...) <> 'source_id'` clause and
      // rA joins the set — a flagged row whose click opens nothing.
      expect({ shape: shape.name, inSet: state !== undefined }).toEqual({
        shape: shape.name,
        inSet: view !== null,
      });

      if (view && state) {
        // CONTROL: write the HAVING as "has no confirmed link" and rE flips —
        // partial confirmation is not confirmation.
        expect({ shape: shape.name, needsReview: state.needsReview }).toEqual({
          shape: shape.name,
          needsReview: !view.isConfirmed,
        });
        // CONTROL: count links instead of columns and every imported contact
        // over-promises by one.
        expect({ shape: shape.name, columns: state.columns }).toEqual({
          shape: shape.name,
          columns: view.columns.length,
        });
      }
    }
  });

  it("excludes a contact with nothing to compare", () => {
    shapes[0].build();
    expect(getReviewStateByContact(USER).has("rA")).toBe(false);
  });

  it("a partly confirmed contact still needs review", () => {
    shapes[4].build();
    expect(getReviewStateByContact(USER).get("rE")).toEqual({
      columns: 3,
      needsReview: true,
    });
  });

  it("resolves 'latest' the same way the screen does, inside one second", async () => {
    twoColumnContact("rT");
    confirmContactSources(USER, "rT");
    expect(getReviewStateByContact(USER).get("rT")!.needsReview).toBe(false);

    // A reversal written with the SAME `decided_at` as the confirmation. Only
    // the insertion order (rowid) separates them — which is why both readers
    // must break the tie on rowid, not on the random uuid `id`.
    const decidedAt = (
      mockDb!
        .prepare("SELECT decided_at FROM contact_link_verdicts WHERE source_record_id = 'out-rT'")
        .get() as { decided_at: string }
    ).decided_at;
    mockDb!
      .prepare(
        `INSERT INTO contact_link_verdicts
           (id, user_id, contact_id, source_type, source_record_id, identity_verdict, decided_at, decided_by)
         VALUES ('aaaaaaaa-0000-0000-0000-000000000000', ?, 'rT', 'outlook', 'out-rT',
                 'different_people', ?, 'provenance_unlink')`,
      )
      .run(USER, decidedAt);

    const view = await getContactCompareColumns(USER, "rT");
    // CONTROL: order the window by `id DESC` and these two disagree — the id
    // above sorts FIRST among uuids, so the list would keep reading "confirmed"
    // while the screen reads the reversal.
    expect(getReviewStateByContact(USER).get("rT")!.needsReview).toBe(true);
    expect(view!.isConfirmed).toBe(false);
  });

  it("is empty when nothing is linked at all", () => {
    addContact("rZ", "Ada Lovelace", { source: "manual" });
    origin("rZ", "manual");
    expect(getReviewStateByContact(USER).size).toBe(0);
  });
});
