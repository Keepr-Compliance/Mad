/**
 * @jest-environment node
 *
 * BACKLOG-2416 + BACKLOG-2427 (second half) — what the import picker is allowed
 * to call "already imported".
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 * Two defects with one cause: `contacts:get-available` inferred that a source
 * record belonged to a saved contact from A PHONE NUMBER ALONE
 * (`importedPhones.has(normalized)`), with no name check and no reference to
 * the crosswalk or to anything the user had said.
 *
 *   BACKLOG-2416  Two people on one office line hide each other. The backend's
 *                 own `isDuplicate` had always required `namesAreCompatible`
 *                 before a shared phone could collapse two records; this filter
 *                 did not, so the two layers disagreed about who is one person.
 *
 *   BACKLOG-2427  A record the user RELEASED with "Not this person" disappears
 *                 instead of becoming importable — it still carries the phone
 *                 the saved contact carries, so it reads as already imported.
 *                 Founder, 2026-08-02: *"Does the unlinked Outlook record
 *                 appear as its own person? no. i also went to the settings,
 *                 clicked the blue re-import button and still nothing."*
 *
 * ---------------------------------------------------------------------------
 * WHY THE CROSSWALK AND VERDICT READS ARE **NOT** MOCKED
 * ---------------------------------------------------------------------------
 * They are the thing under test. `getLinkedSourceKeys` and
 * `getRejectedSourceKeys` run for real against a real in-memory SQLite
 * (`node:sqlite`, the engine shipped inside Node 22 — the repo's
 * better-sqlite3 binary is an Electron build and cannot load under plain node).
 * So these assertions exercise the actual SQL that decides which records the
 * user has released, not a stub that says what the test wants to hear.
 *
 * Only the layers AROUND that decision — the saved-contact list and the shadow
 * table — are mocked, because they are the inputs, not the rule.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IpcMainInvokeEvent } from "electron";
import { CONTACT_IDENTITY_SCHEMA } from "../services/__tests__/helpers/contactIdentitySchema";
import { openTestDb, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;

const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false },
}));

// REAL SQL for the crosswalk and the verdicts.
jest.mock("../services/db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  /**
   * A REAL TRANSACTION, NOT A PASSTHROUGH (BACKLOG-2537).
   *
   * This used to be `(fn) => fn()`. Every statement still ran and every caller
   * was still satisfied, so no test here changed colour — which is precisely
   * what made it dangerous. It is the exact mutant `syncSqliteDriver.transaction.test.ts`
   * exists to reject: it removes the atomicity while leaving the suite green.
   *
   * The consequence was not that some test was wrong today. It was that ANY
   * atomicity test written in this file tomorrow COULD NOT FAIL — the writes
   * would land, nothing would roll back, and the assertion would pass whether
   * or not the production path had a transaction at all.
   *
   * `TestDb.transaction()` is a real BEGIN/COMMIT/ROLLBACK (SAVEPOINT when
   * nested), pinned on both engines by BACKLOG-2368 and BACKLOG-2496.
   */
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

let mockImportedContacts: any[] = [];
let mockShadowRows: any[] = [];

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getImportedContactsByUserIdAsync: jest.fn(() => Promise.resolve(mockImportedContacts)),
    getRemovedContactIdentifiers: jest.fn(() => Promise.resolve([])),
    getImportedContactsByUserId: jest.fn(() => Promise.resolve(mockImportedContacts)),
    getUnimportedContactsByUserId: jest.fn(() => Promise.resolve([])),
    getUserById: jest.fn((id: string) => Promise.resolve({ id })),
    isInitialized: jest.fn(() => true),
    backfillContactEmails: jest.fn(() => Promise.resolve(0)),
    backfillContactPhones: jest.fn(() => Promise.resolve(0)),
  },
}));

jest.mock("../services/contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(() =>
    Promise.resolve({ phoneToContactInfo: {}, contacts: [], status: { loaded: true } }),
  ),
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logContactAction: jest.fn() },
}));

jest.mock("../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../utils/preferenceHelper", () => ({
  __esModule: true,
  isContactSourceEnabled: jest.fn(() => Promise.resolve(true)),
}));

jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), fetchContacts: jest.fn() },
}));

jest.mock("../services/db/externalContactDbService", () => ({
  __esModule: true,
  getCount: jest.fn(() => mockShadowRows.length),
  getAllForUser: jest.fn(() => mockShadowRows),
  getAllForUserAsync: jest.fn(() => Promise.resolve(mockShadowRows)),
  // Never stale — no sync path may run, so the picker reads exactly what the
  // test seeded.
  isStale: jest.fn(() => false),
  fullSync: jest.fn(),
  getLastSyncTime: jest.fn(() => null),
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
  syncOutlookContacts: jest.fn(),
  getContactSourceStats: jest.fn(() => ({})),
  markSourceRecordsCurrent: jest.fn(),
}));

jest.mock("../services/db/contactDbService", () => ({
  ...(jest.requireActual("../services/db/contactDbService") as object),
  getContactEmailEntries: jest.fn(() => []),
  getContactPhoneEntries: jest.fn(() => []),
}));

jest.mock("../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn(), sync: jest.fn() },
}));

jest.mock("../workers/contactWorkerPool", () => ({
  __esModule: true,
  isPoolReady: jest.fn(() => false),
  queryContacts: jest.fn(() => Promise.resolve([])),
}));

import { registerContactHandlers } from "../handlers/contactHandlers";
import { createLink, sourceKey } from "../services/db/contactSourceLinkDbService";
import {
  recordVerdict,
  getRejectedSourceKeys,
} from "../services/db/contactLinkReviewDbService";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

// The founder's case.
const CASEY = "contact-casey-lane";
const CASEY_PHONE_E164 = "+14085550101";
const CASEY_PHONE_RAW = "(408) 555-0101";

// ---------------------------------------------------------------------------
// SEED HELPERS
// ---------------------------------------------------------------------------

/**
 * The saved contact's ROW, needed by the crosswalk's foreign key.
 *
 * The picker reads its saved contacts through the mocked service, but
 * `createLink` writes real SQL — so a link test needs the real row to exist.
 */
function seedContactRow(id: string, name: string): void {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, USER, name);
}

/** A saved contact as `getImportedContactsByUserIdAsync` returns it. */
function importedContact(id: string, name: string, phone: string | null, email: string | null) {
  return {
    id,
    user_id: USER,
    display_name: name,
    name,
    email,
    phone,
    company: null,
    allEmails: email ? [email] : [],
    allPhones: phone ? [phone] : [],
    is_imported: 1,
    last_communication_at: null,
  };
}

/** A shadow-table row as `getAllForUserAsync` returns it. */
function shadowRow(
  recordId: string,
  name: string,
  source: string,
  emails: string[],
  phones: string[],
) {
  return {
    id: `ext-${recordId}`,
    user_id: USER,
    name,
    phones,
    emails,
    company: null,
    source,
    external_record_id: recordId,
    external_uuid: null,
    last_message_at: null,
    synced_at: "2026-08-02T00:00:00.000Z",
  };
}

/** The names the picker actually offered, sorted. Identity, never a count. */
async function pickerNames(): Promise<string[]> {
  const handler = registeredHandlers.get("contacts:get-available");
  const result = await handler(mockEvent, USER);
  expect(result.success).toBe(true);
  return (result.contacts as Array<{ name: string }>).map((c) => c.name).sort();
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockImportedContacts = [];
  mockShadowRows = [];
  registeredHandlers.clear();
  registerContactHandlers({} as any);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("BACKLOG-2427 — a released record comes back to the picker", () => {
  /**
   * THE FOUNDER'S SECOND HALF.
   *
   * Casey Lane is saved and carries `4085550101`. The Outlook record he
   * rejected carries the same number and the SAME NAME, so neither a name rule
   * nor the BACKLOG-2427 removal can rescue it — the number is legitimately on
   * the still-linked macOS card. Only his recorded answer can.
   *
   * NEGATIVE CONTROL (executed, see PR): restore the phone-only filter
   * (`importedPhones.has(normalized)`) and the "reappears" case goes red with
   * an empty picker.
   */
  beforeEach(() => {
    mockImportedContacts = [
      importedContact(CASEY, "Casey Lane", CASEY_PHONE_E164, "casey@example.com"),
    ];
    mockShadowRows = [
      shadowRow("out-casey", "Casey Lane", "outlook", ["casey@bluespaces.com"], [CASEY_PHONE_RAW]),
    ];
  });

  it("hides the record while it is still linked to the contact", async () => {
    seedContactRow(CASEY, "Casey Lane");
    createLink({
      userId: USER,
      contactId: CASEY,
      sourceType: "outlook",
      sourceRecordId: "out-casey",
      matchMethod: "email",
    });

    expect(await pickerNames()).toEqual([]);
  });

  /**
   * BACKLOG-2608 — INVERTED, AND THIS IS THE HEADLINE CHANGE.
   *
   * This asserted `[]`: no link and no verdict, but the phone matched under a
   * compatible name, so the record was declared already-imported. That is the
   * guess the founder had removed. "Suppress only what we KNOW" — and what we
   * know is the crosswalk, which says nothing about this record.
   *
   * OBSERVED RED, 2026-08-09: restoring `phoneClaimedByImported` and its call
   * site gives `Expected ["Casey Lane"] / Received []`.
   */
  it("OFFERS the record on a shared phone when the crosswalk says nothing about it", async () => {
    expect(await pickerNames()).toEqual(["Casey Lane"]);
  });

  it("OFFERS the record once the user has said it is a different person", async () => {
    recordVerdict({
      userId: USER,
      contactId: CASEY,
      sourceType: "outlook",
      sourceRecordId: "out-casey",
      identityVerdict: "different_people",
      reason: "manual_unlink",
      decidedBy: "provenance_unlink",
    });

    expect(await pickerNames()).toEqual(["Casey Lane"]);
  });

  /**
   * BACKLOG-2608 — THE MIND-CHANGE IS HONOURED BY THE LINK, NOT BY THE VERDICT.
   *
   * This used to pass on the verdict alone, because a `same_person` verdict
   * removed the pair from `getRejectedSourceKeys` and the content checks then
   * hid it again. Both halves of that are gone, so the assertion now names what
   * actually makes a record already-imported: the crosswalk row.
   *
   * That is not a weakening. Answering "same person" in the review queue writes
   * the link (`confirmProposal` -> `createLink`), and a manual link writes it
   * too — so every real route to this state writes one. What no longer happens
   * is a record disappearing on a verdict whose link never landed, which is the
   * half-state `contactManualLink.ts` documents and BACKLOG-2608's first
   * hypothesis chased.
   *
   * BOTH ASSERTIONS ARE THE POINT, stated so a later reader does not take the
   * second for the whole test: the verdict on its own leaves the record
   * offered, and the link removes it.
   */
  it("hides it again when the mind-change writes the link, and not on the verdict alone", async () => {
    recordVerdict({
      userId: USER,
      contactId: CASEY,
      sourceType: "outlook",
      sourceRecordId: "out-casey",
      identityVerdict: "different_people",
      decidedBy: "provenance_unlink",
    });
    recordVerdict({
      userId: USER,
      contactId: CASEY,
      sourceType: "outlook",
      sourceRecordId: "out-casey",
      identityVerdict: "same_person",
      decidedBy: "review_queue",
    });

    // The verdict alone changes nothing about what is offered.
    expect(await pickerNames()).toEqual(["Casey Lane"]);

    // The link is what the picker reads.
    seedContactRow(CASEY, "Casey Lane");
    createLink({
      userId: USER,
      contactId: CASEY,
      sourceType: "outlook",
      sourceRecordId: "out-casey",
      matchMethod: "manual",
    });

    expect(await pickerNames()).toEqual([]);
  });

  it("keeps a released record hidden if ANOTHER contact legitimately claims it", async () => {
    // Rejected from Casey, but the crosswalk says it belongs to someone else.
    // The crosswalk check runs first and must win — otherwise a rejection from
    // one contact would re-offer a record that is already imported as another.
    recordVerdict({
      userId: USER,
      contactId: CASEY,
      sourceType: "outlook",
      sourceRecordId: "out-casey",
      identityVerdict: "different_people",
      decidedBy: "provenance_unlink",
    });
    seedContactRow("some-other-contact", "Someone Else");
    createLink({
      userId: USER,
      contactId: "some-other-contact",
      sourceType: "outlook",
      sourceRecordId: "out-casey",
      matchMethod: "source_id",
    });

    expect(await pickerNames()).toEqual([]);
  });

  /**
   * BACKLOG-2608 — RE-POINTED AT THE RULE THAT NOW ENFORCES PAIR KEYING.
   *
   * The property under test is unchanged and still matters: two sources that
   * happen to issue the same id string must not speak for each other. What
   * changed is which mechanism can demonstrate it. The RELEASE could, only
   * because a release was an exemption from the content checks — with those
   * gone, neither record is suppressed and the picker cannot tell the two
   * apart, so asserting through the release would assert nothing.
   *
   * The crosswalk keys on the PAIR too, and it is now the only suppressor, so
   * the same property is asserted where it is now load-bearing: link
   * `outlook/out-casey`, leave `google_contacts/out-casey` alone, and only the
   * Google record is offered.
   *
   * The verdict's own pair keying is still asserted directly on
   * `getRejectedSourceKeys` — it is a property of the review service and does
   * not stop being true because the picker stopped reading it.
   *
   * OBSERVED RED, 2026-08-09: keying `getLinkedSourceKeys` on the record id
   * alone instead of the pair gives `Expected ["google_contacts"] / Received
   * []`.
   */
  it("keys suppression on the PAIR, so another source's identical id is unaffected", async () => {
    mockShadowRows.push(
      shadowRow("out-casey", "Casey Lane", "google_contacts", [], [CASEY_PHONE_RAW]),
    );
    seedContactRow(CASEY, "Casey Lane");
    createLink({
      userId: USER,
      contactId: CASEY,
      sourceType: "outlook",
      sourceRecordId: "out-casey",
      matchMethod: "source_id",
    });
    recordVerdict({
      userId: USER,
      contactId: CASEY,
      sourceType: "outlook",
      sourceRecordId: "out-casey",
      identityVerdict: "different_people",
      decidedBy: "provenance_unlink",
    });

    const handler = registeredHandlers.get("contacts:get-available");
    const result = await handler(mockEvent, USER);
    expect(
      (result.contacts as Array<{ source: string }>).map((c) => c.source),
    ).toEqual(["google_contacts"]);
    expect([...getRejectedSourceKeys(USER)]).toEqual([sourceKey("outlook", "out-casey")]);
  });
});

// ===========================================================================
describe("BACKLOG-2416 — two people on one office line", () => {
  /**
   * The disagreement SR measured: the picker matched on phone with no name
   * check while the backend's `isDuplicate` required `namesAreCompatible`.
   *
   * NEGATIVE CONTROL (executed, see PR): restore the phone-only filter and the
   * "distinct person" case goes red — Margaret Torres vanishes.
   */
  beforeEach(() => {
    mockImportedContacts = [
      importedContact("contact-chen", "Margaret Chen", "+14155550102", "chen@brokerage.com"),
    ];
  });

  it("still offers a DISTINCT person who shares the brokerage line", async () => {
    mockShadowRows = [
      shadowRow("mac-torres", "Margaret Torres", "macos", ["torres@brokerage.com"], [
        "(415) 555-0102",
      ]),
    ];

    expect(await pickerNames()).toEqual(["Margaret Torres"]);
  });

  /**
   * BACKLOG-2531 — THE CASE THIS ITEM EXISTS FOR.
   *
   * Two people share one household address. Before the name gate reached the
   * EMAIL check, the second was declared already-imported on the address alone,
   * never appeared in the picker, and so could never be imported — their mail
   * then landed on the first person's contact, and on a transaction under audit
   * that is one person's correspondence inside another person's record.
   *
   * NEGATIVE CONTROL (executed): drop the name argument from
   * `emailClaimedByImported` so a bare address match decides it again, and this
   * goes red — `[]` instead of `["Tom Whitfield"]`.
   */
  it("offers a DISTINCT person who shares the household email address", async () => {
    mockImportedContacts = [
      importedContact("contact-sarah", "Sarah Whitfield", "+14155550140", "home@example.com"),
    ];
    mockShadowRows = [
      shadowRow("mac-tom", "Tom Whitfield", "macos", ["home@example.com"], []),
    ];

    expect(await pickerNames()).toEqual(["Tom Whitfield"]);
  });

  /**
   * =========================================================================
   * BACKLOG-2608 — THE THREE CASES BELOW ALL INVERTED, AND ON PURPOSE.
   * =========================================================================
   * Each asserted `[]` on the strength of "a saved contact holds this
   * identifier and carries a compatible name, so this record is that person".
   * Each was a guess: undisclosed, and with no way for the user to overturn it.
   *
   * The founder's case that settled it: you answer "not this person" about a
   * record, so there is no longer a pending question — and it disappears
   * anyway, because the hiding rule never looked at questions, it looked at
   * whether a saved contact held that email, which it still does.
   *
   *   "if I clicked not this person this contact shouldn't disappear."
   *
   * So a record is offered unless the crosswalk claims it. The cost is stated
   * plainly rather than hidden: a genuine duplicate of an already-saved person
   * IS now offered again when no crosswalk row exists for it — a row the user
   * declines, rather than a person who cannot be imported at all.
   *
   * The crosswalk case is asserted immediately after these three, so "the fix
   * hides nothing" and "the fix hides the right thing" are both measured.
   */
  it("OFFERS the SAME person recorded again on that address when nothing claims the record", async () => {
    mockImportedContacts = [
      importedContact("contact-sarah", "Sarah Whitfield", "+14155550140", "home@example.com"),
    ];
    mockShadowRows = [
      shadowRow("mac-sarah", "Sarah Whitfield", "macos", ["home@example.com"], []),
    ];

    expect(await pickerNames()).toEqual(["Sarah Whitfield"]);
  });

  it("OFFERS the SAME person recorded again on that line when nothing claims the record", async () => {
    mockShadowRows = [
      shadowRow("mac-chen", "Margaret Chen", "macos", ["chen@brokerage.com"], ["(415) 555-0102"]),
    ];

    expect(await pickerNames()).toEqual(["Margaret Chen"]);
  });

  it("OFFERS an abbreviated spelling of the same person — a name is not a claim", async () => {
    // "Margaret C." is prefix-compatible with "Margaret Chen", which is exactly
    // what `namesAreCompatible` was for and exactly why it cannot decide this.
    mockShadowRows = [
      shadowRow("mac-chen-abbrev", "Margaret C.", "macos", [], ["(415) 555-0102"]),
    ];

    expect(await pickerNames()).toEqual(["Margaret C."]);
  });

  /**
   * THE OTHER DIRECTION, and the one a careless deletion breaks. Same fixture
   * as the "same person on that line" case above, plus the crosswalk row that
   * says the user actually imported THAT card.
   *
   * OBSERVED RED, 2026-08-09: dropping the `linkedSourceKeys` check gives
   * `Expected [] / Received ["Margaret Chen"]`.
   */
  it("still hides the SAME person once the crosswalk claims that record", async () => {
    seedContactRow("contact-chen", "Margaret Chen");
    createLink({
      userId: USER,
      contactId: "contact-chen",
      sourceType: "macos",
      sourceRecordId: "mac-chen",
      matchMethod: "source_id",
    });
    mockShadowRows = [
      shadowRow("mac-chen", "Margaret Chen", "macos", ["chen@brokerage.com"], ["(415) 555-0102"]),
    ];

    expect(await pickerNames()).toEqual([]);
  });

  it("keeps BOTH distinct people when they arrive together on one line", async () => {
    mockShadowRows = [
      shadowRow("mac-torres", "Margaret Torres", "macos", ["torres@brokerage.com"], [
        "(415) 555-0102",
      ]),
      shadowRow("mac-okafor", "Margaret Okafor", "macos", ["okafor@brokerage.com"], [
        "(415) 555-0102",
      ]),
    ];

    expect(await pickerNames()).toEqual(["Margaret Okafor", "Margaret Torres"]);
  });

  /**
   * BACKLOG-2608 — INVERTED. The comment this replaced read "email is a strong
   * identity signal and is deliberately NOT name-gated", which was already
   * false when it was written: BACKLOG-2531 name-gated it, for the household
   * address case. Strong or not, it is a resemblance and not a record of
   * anything the user did.
   */
  it("OFFERS a record whose EMAIL matches an imported contact", async () => {
    mockShadowRows = [
      shadowRow("mac-email", "M. Chen", "macos", ["chen@brokerage.com"], []),
    ];

    expect(await pickerNames()).toEqual(["M. Chen"]);
  });
});
