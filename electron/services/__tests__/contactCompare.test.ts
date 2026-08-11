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
// BACKLOG-2628 control #4 — the REAL unlink. It writes the `different_people`
// verdict and takes back the record's copied values in one transaction; a
// hand-rolled DELETE would describe a state the app never reaches.
import { getContactProvenance, unlinkContactSource } from "../contactProvenance";
import { proposeLink } from "../db/contactLinkReviewDbService";
import { countReviewQueue, getReviewQueue } from "../contactLinkReview";
import { canUnlinkSource } from "../../../src/utils/contactSourceAffordances";
import { getReviewStateByContact } from "../db/contactSourceSets";
// The REAL hand-link producer. It writes a `same_person` / `manual_link` verdict
// AND the `manual` crosswalk row in one transaction — which is precisely why the
// fixtures below cannot be built with the `link()` helper: `createLink` writes no
// verdict, so a hand-built "manual link" describes a state this app never emits
// and cannot reproduce the founder's defect at all. See `10 Aug` block below.
import { linkSourceRecordToContact } from "../contactManualLink";
// BACKLOG-2502 — the REAL constant the service filters origin rows by, so the
// "no non-origin links" premise below is transcribed from the producer instead
// of re-spelled as a source-type list that would drift away from it.
import { ORIGIN_MATCH_METHOD } from "../db/contactIdentitySchemaSql";

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
  /** BACKLOG-2628 control #3 — a link the user made BY HAND, not by matching. */
  let manualLinkId = "";

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
    /*
      BACKLOG-2628 control #3 — LINKED BY HAND.

      `manual` is a `ContactMatchMethod`, not a source: the user searched for
      this record and attached it. The two above were attached by the matcher on
      a phone and an email. The wording must key off BEING linked, so all three
      read the same — and `match_method` is the only thing that differs.

      NOT `source_id`: that method is what column 1 absorbs, so such a record
      never renders as a column of its own and the control would be asserting
      about a column that is not on screen.
    */
    addExternal("goo-d5", "Paul Dorian", "google_contacts", { emails: [SHARED_EMAIL] });
    manualLinkId = link("d5", "google_contacts", "goo-d5", "manual");

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

  /**
   * BACKLOG-2628 CONTROL #1b — A LINKED RECORD IS ON THE CONTACT'S DEALS.
   *
   * This test used to assert the opposite (`source.transactions` is `[]`, "the
   * renderer writes 'not a contact yet'"). That WAS D5's reading, and the
   * founder saw where it led: a column tagged `linked record`, offering
   * `Unlink`, whose Transactions cell said the record belonged to nobody.
   *
   * CONTROL, run: put `transactions: [] as string[]` back on the source-row
   * mapping in `contactCompare.ts` and this goes red on the address.
   *
   * The assertion names the VALUE, never the absence of the old string — an
   * `expect(...).not.toContain("not a contact yet")` would pass just as happily
   * against `[]`, which is the state being fixed.
   */
  it("a linked record carries the contact's transactions — it is on those deals, through the contact", async () => {
    const view = await getContactCompareColumns(USER, "d5");
    const source = view!.columns.find((c) => c.linkId === outlookLinkId)!;

    expect(source.kind).toBe("source");
    expect(source.transactions).toEqual(["571 Dale St N"]);
    // and the contact's own column carries the same deal, because it is one deal
    expect(view!.columns[0].transactions).toEqual(["571 Dale St N"]);
  });

  /**
   * BACKLOG-2628 CONTROL #3 — THE WORDING KEYS OFF LINK STATE, NOT OFF HOW THE
   * LINK WAS MADE.
   *
   * Three records on one contact: attached on a matching phone, on a matching
   * email, and BY HAND. All three are linked, so all three read as linked. If
   * anything ever gates this on `match_method` — "only records the user chose
   * are really linked" is the plausible mistake — this table separates them.
   *
   * EXACT ID SET, not a count: a count of 3 would pass while the manual link
   * rendered as some other column.
   */
  it("a hand-made link and a matcher-made link both read as linked", async () => {
    const view = await getContactCompareColumns(USER, "d5");
    const byId = new Map(view!.columns.map((c) => [c.linkId, c]));

    expect(new Set(byId.keys())).toEqual(
      new Set([view!.columns[0].linkId, macLinkId, outlookLinkId, manualLinkId]),
    );
    for (const linkId of [macLinkId, outlookLinkId, manualLinkId]) {
      expect({ linkId, kind: byId.get(linkId)!.kind, txns: byId.get(linkId)!.transactions }).toEqual(
        { linkId, kind: "source", txns: ["571 Dale St N"] },
      );
    }
  });

  /**
   * BACKLOG-2628 — a linked record on a contact with NO deals reads the ordinary
   * empty state, not the unlinked statement.
   *
   * The `emptyText` branch is the renderer's, so what this pins is the input it
   * branches on: `[]` reaching a `source` column must come from the contact
   * genuinely being on no transactions, and NOT from the hard-coded `[]` this
   * item removed. Those two are indistinguishable in the payload, which is why
   * the test above asserts the populated case by value.
   */
  it("a linked record on a contact with no deals carries no transactions", async () => {
    // `robin marsh` is on this repo's FICTIONAL_NAMES allow-list
    // (`scripts/ci/check-fixture-pii.mjs`) — the repo is public and the name
    // shares a line with an address here.
    addContact("d5b", "Robin Marsh");
    origin("d5b", "contacts_app");
    addExternal("out-d5b", "Robin Marsh", "outlook", { emails: ["robin@example.net"] });
    const linkId = link("d5b", "outlook", "out-d5b", "email");

    const view = await getContactCompareColumns(USER, "d5b");
    const source = view!.columns.find((c) => c.linkId === linkId)!;

    expect(source.kind).toBe("source");
    expect(source.transactions).toEqual([]);
    expect(view!.columns[0].transactions).toEqual([]);
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
   * THE ONE THAT MATTERS — AND IT WAS INVERTED. Founder blocker, 2026-08-09.
   *
   * This test used to assert `isConfirmed` STAYED TRUE with a candidate on
   * screen, on the reasoning that a proposal is not a link and must not re-open
   * PR D's screen on contacts the user has already decided. The first half of
   * that is still true and the conclusion was still wrong: `isConfirmed` is what
   * `ContactCompareSources` renders "You have confirmed these records are the
   * same person" from, INSTEAD of the decision buttons. So a settled contact
   * with a new question against it showed the founder a screen that asserted a
   * decision he had never made and gave him no way to make one.
   *
   * The original worry does not materialise, and the reason is structural: only
   * the review-queue route passes a `proposedSource`. From the contact list none
   * is passed, `kind: "proposed"` is absent, and the expression is unchanged —
   * which is what the second half of this test pins.
   *
   * CONTROL (run, red): drop `!proposedColumnPresent` from `isConfirmed` and the
   * first assertion goes red — `Expected: false, Received: true`.
   */
  it("re-opens the decision — a settled contact with a NEW question is not settled", async () => {
    confirmContactSources(USER, "pc");
    const without = await getContactCompareColumns(USER, "pc");
    expect(without!.isConfirmed).toBe(true);

    const withProposal = await getContactCompareColumns(USER, "pc", {
      sourceType: "android_sync",
      sourceRecordId: "and-pc",
    });

    expect(withProposal!.isConfirmed).toBe(false);
    expect(withProposal!.columns.some((c) => c.kind === "proposed")).toBe(true);

    // AND THE CONTACT ROUTE IS UNTOUCHED. Asked again without a candidate — the
    // shape the contact list produces — it still reads confirmed. This is the
    // regression guard for what PR D added, and it is asserted AFTER the flip
    // above so a fix that simply stopped confirming anything cannot pass.
    expect((await getContactCompareColumns(USER, "pc"))!.isConfirmed).toBe(true);
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
// BACKLOG-2628 — THE ROUND TRIP
// ===========================================================================

/**
 * CONTROL #4 — a record that was linked and then UNLINKED returns to the
 * unlinked wording.
 *
 * WHY THIS IS A SERVICE TEST AND NOT A RENDERER ONE. Unlinking does not change
 * a column's wording; it removes the column. The record only becomes VISIBLE
 * again as the queue's candidate, and it is the same record either way — so the
 * only place the round trip can be observed is here, where `kind` is decided.
 * A renderer test would just be controls #1 and #2 again with a different name.
 *
 * THROUGH THE REAL `unlinkContactSource`, not a `DELETE FROM
 * contact_source_links`. A hand-rolled delete would leave out the
 * `different_people` verdict and the value take-back that the real path writes
 * in the same transaction, and this test's whole claim is about what the app
 * does — the shape of a state it can actually reach.
 */
describe("linked, then unlinked, reads as unlinked again", () => {
  it("the same record goes source -> gone -> proposed, and its transactions with it", async () => {
    addContact("rt", "Paul Dorian", { phones: [SHARED_PHONE] });
    origin("rt", "contacts_app");
    // Two attached records, so unlinking one still leaves something to compare
    // and the view does not collapse to null for an unrelated reason.
    addExternal("mac-rt", "Paul Dorian", "macos", { phones: [SHARED_PHONE] });
    link("rt", "macos", "mac-rt", "phone");
    addExternal("out-rt", "Paul Dorian", "outlook", { emails: [SHARED_EMAIL] });
    const outLinkId = link("rt", "outlook", "out-rt", "email");
    addTransaction("txn-rt", "571 Dale St N", "rt");

    // ---- linked -----------------------------------------------------------
    const linked = await getContactCompareColumns(USER, "rt");
    const asSource = linked!.columns.find((c) => c.linkId === outLinkId)!;
    expect({ kind: asSource.kind, txns: asSource.transactions }).toEqual({
      kind: "source",
      txns: ["571 Dale St N"],
    });

    // ---- unlinked, through the shipped path --------------------------------
    expect(unlinkContactSource(USER, "rt", outLinkId).ok).toBe(true);

    const detached = await getContactCompareColumns(USER, "rt");
    // Gone from the comparison entirely — EXACT id set, so a column merely
    // renamed or re-keyed would fail here rather than pass a count.
    expect(new Set(columnIds(detached))).toEqual(
      new Set(detached!.columns.filter((c) => c.linkId !== outLinkId).map((c) => c.linkId)),
    );
    expect(columnIds(detached)).not.toContain(outLinkId);

    // ---- offered back as the queue's candidate ------------------------------
    const proposed = await getContactCompareColumns(USER, "rt", {
      sourceType: "outlook",
      sourceRecordId: "out-rt",
    });
    const asProposed = proposed!.columns.find(
      (c) => c.linkId === "proposed:outlook:out-rt",
    )!;
    // The unlinked wording's INPUT, restored: it belongs to nobody, so it is on
    // no deals, and the renderer writes "not a contact yet" over this `[]`.
    expect({ kind: asProposed.kind, txns: asProposed.transactions }).toEqual({
      kind: "proposed",
      txns: [],
    });
    // The contact still holds the deal — the record left, the transaction did not.
    expect(proposed!.columns[0].transactions).toEqual(["571 Dale St N"]);
  });
});

// ===========================================================================
// BACKLOG-2502 R8 — THE CONTACT SIDE, AS ONE COLUMN
// ===========================================================================

/**
 * FOUNDER-OBSERVED, 2026-08-09, on `76ec6476`: *"the compare screen still shows
 * four columns for one question"*.
 *
 * It was not the pairwise change failing — there was exactly one candidate. The
 * other three columns were HIS OWN records, one per linked source, arranged as
 * if he were being asked to choose between them. He is being asked one thing: is
 * this candidate this person.
 *
 * So on the review route the contact is drawn as one column carrying everything
 * it is already made of. On the contact route it is NOT, because there, one
 * column per source is the feature — it is how a user sees which record
 * contributed what, and how they unlink the wrong one.
 */
describe("R8 — collapsing the contact side", () => {
  /** Held by the Outlook record and by no contact row — the value a naive collapse drops. */
  const RECORD_ONLY_PHONE = "+12065550155";
  /** Held by the Google record and by no contact row. */
  const RECORD_ONLY_EMAIL = "pd.google@example.com";

  /**
   * The founder's shape: a contact assembled from THREE of its own records
   * (origin + an absorbed `source_id` row + two attached ones) with one
   * candidate against it. Four columns before this change, two after.
   */
  function assembledContact(id: string): void {
    addContact(id, "Paul Dorian", { phones: [SHARED_PHONE], emails: [SHARED_EMAIL] });
    origin(id, "contacts_app");
    addExternal(`mac-${id}`, "Paul Dorian", "macos", { phones: [SHARED_PHONE] });
    link(id, "macos", `mac-${id}`, "source_id");
    // Carries a number the contact itself does not have.
    addExternal(`out-${id}`, "Paul Dorian", "outlook", { phones: [RECORD_ONLY_PHONE] });
    link(id, "outlook", `out-${id}`, "email");
    // Carries an address the contact itself does not have.
    addExternal(`goo-${id}`, "Paul Dorian", "google_contacts", { emails: [RECORD_ONLY_EMAIL] });
    link(id, "google_contacts", `goo-${id}`, "phone");
    // The candidate, unlinked.
    addExternal(`and-${id}`, "Paul Dorian", "android_sync", { phones: [SHARED_PHONE] });
  }

  const candidate = (id: string) => ({
    sourceType: "android_sync",
    sourceRecordId: `and-${id}`,
  });

  it("draws TWO columns where the contact route draws four", async () => {
    assembledContact("r8a");

    // CONTROL: drop the `collapseContactSources` branch on `sourceRows` and this
    // reads ["contact","source","source","proposed"] — the founder's screenshot.
    const collapsed = await getContactCompareColumns(USER, "r8a", candidate("r8a"), {
      collapseContactSources: true,
    });
    expect(collapsed!.columns.map((c) => c.kind)).toEqual(["contact", "proposed"]);
    expect(collapsed!.columns.map((c) => c.linkId)[1]).toBe(
      "proposed:android_sync:and-r8a",
    );
  });

  it("keeps every value the collapsed records held, not the first one found", async () => {
    assembledContact("r8b");

    const collapsed = await getContactCompareColumns(USER, "r8b", candidate("r8b"), {
      collapseContactSources: true,
    });
    const contactColumn = collapsed!.columns[0];

    // THE UNION, ASSERTED AS AN EXACT SET. A collapse that showed only
    // `contact_phones` would pass any "two columns" test while silently losing
    // the Outlook number — the failure the founder has been bitten by before.
    // CONTROL: build the contact column from `contactPhones` alone and
    // `+12065550155` disappears from this list.
    expect(contactColumn.phones.map((p) => p.value)).toEqual([
      SHARED_PHONE,
      RECORD_ONLY_PHONE,
    ]);
    expect(contactColumn.emails.map((e) => e.value)).toEqual([
      SHARED_EMAIL,
      RECORD_ONLY_EMAIL,
    ]);
    // The contact's own values LEAD — they are the saved truth the rest of the
    // app uses, and the order is what the user reads first.
    expect(contactColumn.phones[0].value).toBe(SHARED_PHONE);
    // And the candidate's shared number still marks against the collapsed side,
    // so collapsing did not cost the comparison its point.
    expect(contactColumn.phones[0].matched).toBe(true);
  });

  /**
   * CONTROL 3, AND THE ONE THAT MATTERS MOST: both surfaces share one component,
   * so a collapse that leaked would silently rewrite Clients & Contacts.
   */
  it("leaves the contact route drawing one column per source, with its own values", async () => {
    assembledContact("r8c");

    const contactRoute = await getContactCompareColumns(USER, "r8c");
    // CONTROL: default the option to true, or collapse whenever a candidate is
    // present, and this reads ["contact"] — PR C's whole screen gone.
    expect(contactRoute!.columns.map((c) => c.kind)).toEqual([
      "contact",
      "source",
      "source",
    ]);
    // Unchanged values: the union belongs to the collapsed column and nowhere
    // else, so the record's own number is still ITS number here.
    expect(contactRoute!.columns[0].phones.map((p) => p.value)).toEqual([SHARED_PHONE]);
    const outlookColumn = contactRoute!.columns.find((c) => c.columnLabel.includes("Outlook"));
    expect(outlookColumn!.phones.map((p) => p.value)).toEqual([RECORD_ONLY_PHONE]);

    // The same contact with a candidate, still uncollapsed, is four columns —
    // which is exactly what the founder saw, and is correct on this route.
    const withCandidate = await getContactCompareColumns(USER, "r8c", candidate("r8c"));
    expect(withCandidate!.columns.map((c) => c.kind)).toEqual([
      "contact",
      "source",
      "source",
      "proposed",
    ]);
  });

  it("draws two columns for a contact with ONE record, not one and not three", async () => {
    // R1's contact: a single source record, which is what most of the queue is.
    addContact("r8d", "Paul Dorian", { phones: [SHARED_PHONE] });
    origin("r8d", "contacts_app");
    addExternal("mac-r8d", "Paul Dorian", "macos", { phones: [SHARED_PHONE] });
    link("r8d", "macos", "mac-r8d", "source_id");
    addExternal("and-r8d", "Paul Dorian", "android_sync", { phones: [SHARED_PHONE] });

    // CONTROL, corrected after running it: the ordering mutation I first wrote
    // here CANNOT go red — this contact's only non-origin link is the absorbed
    // one, so `sourceRows` is empty whether the collapse runs before the guard
    // or after it, and both orders return the same view. The mutation that does
    // fire is R1's guard bug returning — `if (sourceRows.length === 0)`, which
    // collapsing makes far likelier because it empties `sourceRows` for EVERY
    // contact. Run: all four R8 views come back null.
    const view = await getContactCompareColumns(USER, "r8d", candidate("r8d"), {
      collapseContactSources: true,
    });
    expect(view!.columns.map((c) => c.kind)).toEqual(["contact", "proposed"]);
  });

  it("takes a record's company when the contact has none, rather than losing it", async () => {
    addContact("r8e", "Paul Dorian", { phones: [SHARED_PHONE] });
    origin("r8e", "contacts_app");
    addExternal("out-r8e", "Paul Dorian", "outlook", {
      phones: [SHARED_PHONE],
      company: "Example Realty",
    });
    link("r8e", "outlook", "out-r8e", "email");
    addExternal("and-r8e", "Paul Dorian", "android_sync", { phones: [SHARED_PHONE] });

    // Company is ONE value on both sides, so there is no union to show — but a
    // company that was visible in its own column must not vanish because that
    // column was folded away. CONTROL: use `contact.company` alone and this
    // reads null.
    const collapsed = await getContactCompareColumns(USER, "r8e", candidate("r8e"), {
      collapseContactSources: true,
    });
    expect(collapsed!.columns[0].company).toBe("Example Realty");
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
// BACKLOG-2502 — THE VACUOUS TRUTH ON THE EMPTY LINK SET
// ===========================================================================

/**
 * FOUNDER BLOCKER, 2026-08-09, on his own data: "Test contact Blue Spaces" plus
 * an Outlook record sharing an address. The compare screen opened, both columns
 * rendered — and the footer read *"You have confirmed these records are the same
 * person"* with no buttons under it.
 *
 * `[].every(...)` IS `true`. A contact with NO non-origin links reads confirmed
 * unconditionally, and a contact with no non-origin links is exactly what the
 * review queue is made of: one record, which is why an unrelated record looked
 * like it might be a second one.
 *
 * The empty set is pinned BY NAME here rather than left to fall out of the
 * proposal guard, because the two guards overlap on this shape and the emptiness
 * is the older and less obvious of the two faults.
 */
describe("a contact with no non-origin links at all", () => {
  /**
   * The set `isConfirmed` quantifies over, read back through the SAME predicate
   * the service filters by. Asserted as a PREMISE below: a test about the empty
   * set that ran against a non-empty one would prove nothing, and nothing else
   * in the fixture makes the emptiness visible.
   */
  const nonOriginLinks = (contactId: string): string[] =>
    (
      mockDb!
        .prepare(
          `SELECT source_type, source_record_id FROM contact_source_links
            WHERE user_id = ? AND contact_id = ? AND match_method != ?
            ORDER BY source_type, source_record_id`,
        )
        .all(USER, contactId, ORIGIN_MATCH_METHOD) as {
        source_type: string;
        source_record_id: string;
      }[]
    ).map((r) => `${r.source_type}|${r.source_record_id}`);

  /**
   * CONTROL 1 — THE FOUNDER'S EXACT CASE, and the primary test on this fix.
   *
   * Restore `const isConfirmed = nonOrigin.every(...)` and this goes red with
   * `Expected: false, Received: true` — the screen that cannot be answered.
   *
   * Note for the reviewer: reverting EITHER guard alone leaves this green,
   * because on this shape they overlap — `nonOrigin` is empty AND a proposed
   * column is present. The guard that bites alone for the proposal is the
   * settled-contact test above; the length guard is defence in depth for a shape
   * the column rules do not currently produce without a candidate.
   */
  it("does not read confirmed just because it has nothing to be confirmed", async () => {
    addContact("vt1", "Test contact Blue Spaces", { source: "manual" });
    origin("vt1", "manual");
    addExternal("out-vt1", "Test contact Blue Spaces", "outlook", { emails: [SHARED_EMAIL] });
    propose("vt1", "outlook", "out-vt1", "record:out-vt1");

    // THE PREMISE. This is the empty set the vacuous truth lives on.
    expect(nonOriginLinks("vt1")).toEqual([]);

    const view = await getContactCompareColumns(USER, "vt1", {
      sourceType: "outlook",
      sourceRecordId: "out-vt1",
    });

    // The screen the founder was looking at: two columns, one of them the
    // candidate, and NOTHING confirmed about either of them.
    expect(view).not.toBeNull();
    expect(view!.columns.map((c) => c.kind)).toEqual(["contact", "proposed"]);
    expect(view!.isConfirmed).toBe(false);
  });

  /**
   * The same contact once the answer is in. `confirmProposal` creates the link,
   * so the set this quantifies over stops being empty by the ordinary route —
   * which is what makes the guard above a guard rather than a permanent `false`.
   */
  it("reads confirmed once the candidate has actually been linked and judged", async () => {
    addContact("vt2", "Ada Lovelace", { source: "manual" });
    origin("vt2", "manual");
    addExternal("out-vt2", "Ada Lovelace", "outlook", { emails: [SHARED_EMAIL] });
    link("vt2", "outlook", "out-vt2", "email");
    confirmContactSources(USER, "vt2");

    expect(nonOriginLinks("vt2")).toEqual(["outlook|out-vt2"]);
    // No candidate is passed: this is the contact route, after the queue is done
    // with it. CONTROL: keep `nonOrigin.length > 0` but move it AFTER a `!`, or
    // leave `!proposedColumnPresent` permanently false, and this goes red.
    expect((await getContactCompareColumns(USER, "vt2"))!.isConfirmed).toBe(true);
  });
});

// ===========================================================================
// BACKLOG-2471 PR F — WHICH CONTACTS THE LIST FLAGS AND INTERCEPTS
// ===========================================================================

describe("the review-state set", () => {
  /**
   * THE RULE THIS BLOCK EXISTS FOR, AS BACKLOG-2626 LEFT IT.
   *
   * It used to be one rule: the set equalled "the contacts the compare screen
   * opens for", because the same flag drove the badge AND the click. BACKLOG-2626
   * split those. A click now walks OPEN QUESTIONS, which are proposals; the badge
   * still describes the crosswalk. So the set is a union of two populations and
   * the invariants are checked separately:
   *
   *   - **crosswalk half** — `columns` still equals what `Compare sources` draws,
   *     and `needsReview` still equals `!isConfirmed`, both checked against the
   *     REAL `getContactCompareColumns`. `Compare sources` is still gated on
   *     `showSourcesPanel`, so this half is unchanged and must stay so.
   *   - **question half** — `openQuestions` equals what the REAL review queue
   *     would ask, checked against `getReviewQueue`. A badge promising a question
   *     the queue has none of is the founder's defect from the other side: the
   *     row says something is outstanding and the walk opens onto nothing.
   *
   * Every case is built through the REAL producers (`recordContactOrigin`,
   * `createLink`, `proposeLink`) and checked against the REAL shipped readers,
   * never against a re-derived predicate. A test that re-implemented the rule
   * would only ever agree with itself.
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
      // rA joins the set — a badge on a contact with nothing combined.
      //
      // None of these shapes carries a proposal, so the crosswalk half is the
      // WHOLE set here and the equality is exact. The question half gets its own
      // tests below rather than being folded in, precisely so this one keeps
      // asserting the unchanged rule rather than a weakened union.
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
        /*
          BACKLOG-2626 — THE OTHER NUMBER, ASSERTED AGAINST THE SOURCES PANEL.

          CORRECTED after founder QA on `b64da8c8`. This used to assert
          `records === view.columns.length + (imported ? 1 : 0)` — that the two
          numbers differ by one on any imported contact. **That was the
          off-by-one itself, written down a second time.** The expectation and
          the code came from the same wrong idea, so every shape agreed and the
          suite proved nothing. The founder found it by comparing the row against
          his own contact card: `Sources 4`, row said 5.

          So it is asserted against the PANEL, derived from `getContactProvenance`
          — the shipped reader the card renders from, not a re-spelled predicate.
          An imported contact's own record IS in that panel (its `source_id`
          row), so the two are equal; a hand-made contact's own record is not
          (its `origin` row is synthetic and dropped in SQL), so `records` is one
          MORE. Both directions, per shape, in one expectation.
        */
        const panel = getContactProvenance(USER, shape.id);
        const ownRecordIsInThePanel = panel.some((s) => s.matchMethod === "source_id");
        expect({ shape: shape.name, records: state.records }).toEqual({
          shape: shape.name,
          records: panel.length + (ownRecordIsInThePanel ? 0 : 1),
        });
      }
    }
  });

  it("excludes a contact with nothing to compare", () => {
    shapes[0].build();
    expect(getReviewStateByContact(USER).has("rA")).toBe(false);
  });

  // =========================================================================
  // BACKLOG-2626 — THE RECORD COUNT, AFTER FOUNDER QA ON `b64da8c8`
  // =========================================================================

  /**
   * HIS EXACT SHAPE, AND HIS EXACT COMPARISON.
   *
   *   Sources 4
   *     Mac address book — Rosalind Vance       Recognised by its own entry ...
   *     Mac address book — Roz Vance            You confirmed this yourself
   *     Mac address book — Rosalind Vance-Hale  You confirmed this yourself
   *     Mac address book — Rosalind Hale        You confirmed this yourself
   *
   * The row read **"5 records combined"**. The first entry is the `source_id`
   * row written at import — the contact's OWN record — and `1 + link_count`
   * counted him twice.
   *
   * The badge and the panel are asserted in ONE test because comparing them is
   * how he found it. Split across two tests, each could stay green while
   * disagreeing with the other, which is exactly what happened: the old
   * expectation restated the bug and agreed with the code.
   *
   * OBSERVED RED: restore `records: 1 + r.link_count` and this reads 5 against a
   * panel of 4.
   */
  it("counts an imported contact's own record ONCE, matching its Sources panel", () => {
    addContact("rQ", "Rosalind Vance", { phones: [SHARED_PHONE] });
    origin("rQ", "contacts_app");
    // The record she was imported FROM — "recognised by its own entry".
    addExternal("mac-rQ", "Rosalind Vance", "macos", { phones: [SHARED_PHONE] });
    link("rQ", "macos", "mac-rQ", "source_id");
    // Three further records he confirmed himself.
    for (const [id, name] of [
      ["roz-rQ", "Roz Vance"],
      ["hale-rQ", "Rosalind Vance-Hale"],
      ["rh-rQ", "Rosalind Hale"],
    ] as const) {
      addExternal(id, name, "macos", { phones: [SHARED_PHONE] });
      link("rQ", "macos", id, "manual");
    }

    const state = getReviewStateByContact(USER).get("rQ")!;
    const panel = getContactProvenance(USER, "rQ");

    expect(panel).toHaveLength(4);
    expect(state.records).toBe(4);
    // THE COMPARISON HE MADE, as one assertion.
    expect(state.records).toBe(panel.length);
  });

  /**
   * THE OTHER DIRECTION — the case the broken expression got RIGHT, which must
   * stay right.
   *
   * A hand-made contact carries only a synthetic `origin:${contactId}` row. It
   * stands for no address-book record and is dropped in SQL, so her own record
   * is genuinely NOT among the links and the `+ 1` belongs.
   *
   * OBSERVED RED: make the expression a bare `r.link_count` — the obvious
   * over-correction — and this reads 2 where three records came together, while
   * the imported test above stays green. Without this half, "fix the off-by-one"
   * could be satisfied by subtracting one everywhere.
   */
  it("still counts a hand-made contact's own record, which no link stands for", () => {
    addContact("rH", "Alan Turing", { source: "manual" });
    origin("rH", "manual");
    addExternal("out-rH", "Alan Turing", "outlook");
    addExternal("and-rH", "Alan Turing", "android_sync");
    link("rH", "outlook", "out-rH", "manual");
    link("rH", "android_sync", "and-rH", "email");

    const state = getReviewStateByContact(USER).get("rH")!;
    const panel = getContactProvenance(USER, "rH");

    expect(panel).toHaveLength(2);
    expect(panel.some((s) => s.matchMethod === "source_id")).toBe(false);
    // Her own record plus the two linked ones.
    expect(state.records).toBe(3);
    expect(state.records).toBe(panel.length + 1);
  });

  /**
   * A contact assembled from exactly ONE record shows no count — the `> 1` gate
   * in `ContactRow`. Nothing is COMBINED at one, so the phrase would be a false
   * statement and not merely an ungrammatical one.
   *
   * The shape: imported from one record, with one further record ATTACHED and
   * then unlinked — leaving a single `source_id` row, which is the only way a
   * crosswalk member reaches `records: 1`. Built through the real producers, so
   * this is a state the app can actually emit rather than one hand-typed to make
   * the assertion convenient.
   */
  it("reports a single-record contact as one, so the row shows no count", () => {
    addContact("rS", "Tad Brooks");
    origin("rS", "contacts_app");
    addExternal("mac-rS", "Tad Brooks", "macos");
    link("rS", "macos", "mac-rS", "source_id");
    // A second, ATTACHED record — without it the HAVING clause excludes her.
    addExternal("out-rS", "Tad Brooks", "outlook");
    link("rS", "outlook", "out-rS", "email");

    expect(getReviewStateByContact(USER).get("rS")!.records).toBe(2);

    // Now detach it, leaving only the record she was made from.
    mockDb!.prepare(`DELETE FROM contact_source_links WHERE source_record_id = 'out-rS'`).run();

    // She leaves the crosswalk population entirely — one record, nothing
    // combined, no badge and no count. `undefined` is the no-badge state.
    expect(getReviewStateByContact(USER).get("rS")).toBeUndefined();
    expect(getContactProvenance(USER, "rS")).toHaveLength(1);
  });

  it("a partly confirmed contact still needs review", () => {
    shapes[4].build();
    expect(getReviewStateByContact(USER).get("rE")).toEqual({
      columns: 3,
      records: 3,
      needsReview: true,
      openQuestions: 0,
      badge: "autolinked",
    });
  });

  // =========================================================================
  // BACKLOG-2626 — WHO DECIDED, AFTER FOUNDER QA ON `010bfd93` (10 Aug)
  // =========================================================================

  /**
   * THE FIXTURES BELOW ARE BUILT THROUGH `linkSourceRecordToContact`, AND THAT
   * IS THE WHOLE REASON THEY CATCH ANYTHING.
   *
   * The `link()` helper calls `createLink`, which writes a crosswalk row and NO
   * verdict. A "manual link" built that way describes a state the app cannot
   * emit: the real producer writes `same_person` / `manual_link` and the row in
   * ONE transaction. `rQ` above is exactly that invented shape — three `manual`
   * rows with no verdicts — and it is why the existing suite could not see this
   * defect: under any fix it still reads `autolinked`, correctly, because
   * nothing in it was ever confirmed.
   *
   * So each fixture ASSERTS ITS OWN SHAPE against the crosswalk before asserting
   * the badge. A fixture missing the verdict-less `source_id` row, or carrying
   * verdict-less `manual` rows, cannot reproduce the founder's defect at all,
   * and the shape assertions are what stop it from silently becoming that.
   */
  const verdictsFor = (contactId: string): Array<{ method: string; verdict: string | null }> =>
    mockDb!
      .prepare(
        `SELECT l.match_method AS method, v.identity_verdict AS verdict
           FROM contact_source_links l
           LEFT JOIN contact_link_verdicts v
             ON v.contact_id = l.contact_id
            AND v.source_type = l.source_type
            AND v.source_record_id = l.source_record_id
          WHERE l.contact_id = ? AND l.match_method <> ?
          ORDER BY l.match_method, l.source_record_id`,
      )
      .all(contactId, ORIGIN_MATCH_METHOD) as Array<{ method: string; verdict: string | null }>;

  /**
   * HIS EXACT SHAPE. He imported Desmond Okafor — the negative control, nothing
   * is ever proposed for him — and attached Petra Lindqvist BY HAND. The row
   * read `2 records combined` beside **`Autolinked`**. Nothing guessed anything.
   *
   * The count was right and the badge was a statement about WHO DECIDED, so the
   * two are asserted together here: the fix must move one and not the other.
   *
   * OBSERVED RED: drop the `MAX(...)` arm from `unconfirmed` and this reads
   * `autolinked` with `needsReview: true` — the shipped defect, exactly.
   */
  it("a contact whose every attached record was linked BY HAND is not autolinked", () => {
    addContact("rDO", "Desmond Okafor");
    origin("rDO", "contacts_app");
    // The record he was imported FROM. Nothing reviews it, so it never gets a
    // verdict — the row that flipped the badge.
    addExternal("mac-rDO", "Desmond Okafor", "macos");
    link("rDO", "macos", "mac-rDO", "source_id");
    // Petra, attached by hand through the REAL writer.
    addExternal("petra-rDO", "Petra Lindqvist", "macos");
    expect(linkSourceRecordToContact(USER, "rDO", "macos", "petra-rDO").ok).toBe(true);

    // THE SHAPE, transcribed from his database and asserted against ours.
    expect(verdictsFor("rDO")).toEqual([
      { method: "manual", verdict: "same_person" },
      { method: "source_id", verdict: null },
    ]);

    expect(getReviewStateByContact(USER).get("rDO")).toEqual({
      columns: 2,
      records: 2,
      needsReview: false,
      openQuestions: 0,
      badge: "user_linked",
    });
  });

  /**
   * THE SAME SHAPE AT THREE HAND-MADE LINKS — Rosalind Vance, who had been
   * mislabelled all evening. One verdict-less `source_id` row outvoted three
   * explicit human decisions, which is the defect stated at its worst.
   */
  it("stays the user's own doing however many records they linked by hand", () => {
    addContact("rRV", "Rosalind Vance");
    origin("rRV", "contacts_app");
    addExternal("mac-rRV", "Rosalind Vance", "macos");
    link("rRV", "macos", "mac-rRV", "source_id");
    for (const record of ["roz-rRV", "hale-rRV", "rh-rRV"]) {
      addExternal(record, "Rosalind Vance", "macos");
      expect(linkSourceRecordToContact(USER, "rRV", "macos", record).ok).toBe(true);
    }

    expect(verdictsFor("rRV")).toEqual([
      { method: "manual", verdict: "same_person" },
      { method: "manual", verdict: "same_person" },
      { method: "manual", verdict: "same_person" },
      { method: "source_id", verdict: null },
    ]);

    expect(getReviewStateByContact(USER).get("rRV")).toEqual({
      columns: 4,
      records: 4,
      needsReview: false,
      openQuestions: 0,
      badge: "user_linked",
    });
  });

  /**
   * THE DISCRIMINATOR. Without this the two tests above are satisfied by
   * returning `user_linked` unconditionally.
   *
   * `twoColumnContact` is the imported contact plus a record the matcher
   * attached on CONTENT (`match_method: 'email'`), unjudged. That is a link the
   * app made and the user has not ratified — the state `Autolinked` exists to
   * name — and it must survive the fix untouched.
   */
  it("still says autolinked when the app attached the record, not the user", () => {
    twoColumnContact("rAL");

    expect(verdictsFor("rAL")).toEqual([
      { method: "email", verdict: null },
      { method: "source_id", verdict: null },
    ]);

    const state = getReviewStateByContact(USER).get("rAL")!;
    expect(state.needsReview).toBe(true);
    expect(state.badge).toBe("autolinked");
  });

  /**
   * THE TRAP, PINNED — the reason `unconfirmed` SUBTRACTS instead of the `WHERE`
   * FILTERING.
   *
   * A collapsed import writes a `source_id` row per record it stood for
   * (BACKLOG-2458, the founder's Casey Lane), so this contact holds TWO of them
   * plus one hand-attached record. `link_count` and `source_id_count` come from
   * the same row set as `unconfirmed` and feed `records` and `columns`, so
   * dropping `source_id` rows from that set silently re-breaks `6f8374df`.
   *
   * IT MUST BE THIS SHAPE. With a single `source_id` row the filtered and
   * subtracted spellings are numerically IDENTICAL — `columns` is
   * `1 + (L-1) - 0` either way — so Desmond and Rosalind cannot fail under the
   * naive fix and count assertions on them would prove nothing. At two, the
   * filter drops both rows and the numbers move.
   *
   * OBSERVED RED: widen the `WHERE` to `AND l.match_method <> 'source_id'` and
   * this reads `columns: 2, records: 2` against a Sources panel of 3.
   *
   * The badge here stays `autolinked`, and deliberately: only ONE `source_id`
   * row is exempt, mirroring the one `columns` and `records` already absorb.
   * Whether picking a collapsed picker row means the user linked BOTH records is
   * the founder's call, filed on BACKLOG-2626 and not decided here.
   */
  it("counts every record of a collapsed import, which the naive fix would drop", () => {
    addContact("rCI", "Casey Lane");
    origin("rCI", "contacts_app");
    // One picker row stood for both of these, so both are `source_id`.
    addExternal("mac-rCI", "Casey Lane", "macos");
    addExternal("out-rCI", "Casey Lane", "outlook");
    link("rCI", "macos", "mac-rCI", "source_id");
    link("rCI", "outlook", "out-rCI", "source_id");
    // Plus one attached by hand, so the contact is not source_id-only.
    addExternal("and-rCI", "Casey Lane", "android_sync");
    expect(linkSourceRecordToContact(USER, "rCI", "android_sync", "and-rCI").ok).toBe(true);

    const state = getReviewStateByContact(USER).get("rCI")!;
    const panel = getContactProvenance(USER, "rCI");

    // THE COUNTS `6f8374df` ESTABLISHED — three real records, once each,
    // asserted against the panel the founder compared the row to.
    expect(panel).toHaveLength(3);
    expect(state.records).toBe(3);
    expect(state.records).toBe(panel.length);
    expect(state.columns).toBe(3);

    // The second `source_id` row is still unratified, so the badge does not move.
    expect(state.badge).toBe("autolinked");
  });

  // =========================================================================
  // BACKLOG-2626 — THE QUESTION HALF, AND THE THREE BADGES
  // =========================================================================

  /**
   * THE POPULATION THE OLD RULE COULD NOT SEE.
   *
   * `rA` is the founder's Rosalind shape: imported from ONE address-book card,
   * nothing attached, so the crosswalk has nothing to say about her and the old
   * membership rule excluded her outright. A proposal stands against her, and if
   * she carries no badge the question is invisible outside the queue — which is
   * exactly what he reported on the clean database: *"I don't see a pill
   * indicating suggested duplicates or auto linked."*
   *
   * CONTROL, OBSERVED: delete the second population loop in
   * `getReviewStateByContact` (the `for (const [contactId, open] of
   * openQuestions)` block) and this goes red with `undefined` — she vanishes
   * from the set entirely, which is the shipped-today behaviour.
   */
  it("a contact with only a QUESTION earns a badge the crosswalk cannot give her", () => {
    shapes[0].build();
    addExternal("out-rA", "Tad Brooks", "outlook");
    propose("rA", "outlook", "out-rA", "contact:rA");

    expect(getReviewStateByContact(USER).get("rA")).toEqual({
      columns: 1,
      records: 1,
      needsReview: false,
      openQuestions: 1,
      badge: "suggestion",
    });
  });

  /**
   * `openQuestions` EQUALS WHAT THE QUEUE WOULD ASK — checked against the queue's
   * OWN reader, not against a copy of its SQL.
   *
   * `PENDING_JOIN` refuses a proposal whose source record has vanished, because a
   * question with no answer is one the queue cannot ask. The badge must refuse it
   * too, or the row promises something the walk cannot open onto.
   *
   * The unanswerable proposal here points at a record that was never inserted
   * into `external_contacts` — the real shape after an address-book entry is
   * deleted between the linking pass and the read.
   *
   * CONTROL, OBSERVED: drop the `JOIN external_contacts` from
   * `getOpenQuestionsByContact` and `openQuestions` reads 2 while the queue asks
   * 1.
   */
  it("counts only the questions the queue would actually ask", () => {
    shapes[0].build();
    addExternal("out-rA", "Tad Brooks", "outlook");
    propose("rA", "outlook", "out-rA", "contact:rA");
    // Askable by `status` alone, unanswerable in fact: no such record exists.
    propose("rA", "android_sync", "gone-rA", "contact:rA");

    const asked = getReviewQueue(USER)
      .flatMap((c) => c.items)
      .filter((i) => i.contactId === "rA");

    expect(asked.map((i) => i.sourceRecordId)).toEqual(["out-rA"]);
    expect(getReviewStateByContact(USER).get("rA")!.openQuestions).toBe(asked.length);
    expect(countReviewQueue(USER)).toBe(asked.length);
  });

  /**
   * PRECEDENCE: Suggestion > Autolinked > You linked these.
   *
   * The three sets are NOT disjoint — `11abce67` says so explicitly, and this is
   * the shape it describes: a contact holding an auto-attached record awaiting
   * confirmation AND a separate proposal the matcher refused to guess about.
   *
   * `Suggestion` must win. It is the state that replaced the forced compare
   * screen as the way an open question stays discoverable; demote it and the
   * question is invisible outside the queue again, which is the whole defect.
   *
   * CONTROL, OBSERVED: reverse the badge ternary to
   * `needsReview ? "autolinked" : open > 0 ? "suggestion" : "user_linked"` and
   * this goes red reading `autolinked`, while the two single-state tests either
   * side of it stay green — the asymmetry that makes this about precedence and
   * not about the values.
   */
  it("an open question outranks an unratified auto-link", () => {
    twoColumnContact("rP");
    addExternal("and-rP", "Paul Dorian", "android_sync");
    propose("rP", "android_sync", "and-rP", "contact:rP");

    const state = getReviewStateByContact(USER).get("rP")!;
    expect(state.needsReview).toBe(true);
    expect(state.openQuestions).toBe(1);
    expect(state.badge).toBe("suggestion");
  });

  /**
   * The user decided, by either route — and the founder ruled out a fourth
   * "Confirmed" state: *"confirmed" and "you linked it" are the same fact from
   * his side.* So confirming through the compare screen produces `user_linked`,
   * the same value a manual link produces, and there is no fourth value for a
   * future reader to reach for.
   */
  it("a fully confirmed contact reads as the user's own doing", () => {
    twoColumnContact("rU");
    confirmContactSources(USER, "rU");

    expect(getReviewStateByContact(USER).get("rU")!.badge).toBe("user_linked");
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
