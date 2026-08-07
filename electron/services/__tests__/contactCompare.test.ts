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

import { getContactCompareColumns } from "../contactCompare";
import { createLink } from "../db/contactSourceLinkDbService";
import { recordContactOrigin, originRecordId } from "../db/contactOriginLink";
import { showSourcesPanel } from "../../../src/utils/contactSourceAffordances";
import { getContactProvenance } from "../contactProvenance";

const USER = "user-compare-2471";
const OTHER_USER = "user-other-2471";

/**
 * Fixture values. RFC 2606 domains and NANP reserved-fictional numbers, where
 * 555 is the EXCHANGE and never the area code — `scripts/ci/check-fixture-pii.mjs`
 * rejects the other spelling.
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
