/**
 * @jest-environment node
 *
 * BACKLOG-2556 — the app never decides two records are the same person.
 *
 * ===========================================================================
 * THE RULE, AS THE FOUNDER SETTLED IT (D2, 2026-08-06)
 * ===========================================================================
 *   "for the basic tier no AI add-on gate turns on we do not do any
 *    consolidation at all, 100% raw contact list, unless the user will link
 *    manually when it's implemented or edit an imported contact"
 *   "if a contact is imported don't show it twice, show the imported one"
 *
 * SUPPRESS ONLY WHAT WE KNOW. NEVER WHAT WE GUESS.
 *
 *   KEPT (knowledge)   the crosswalk says you clicked import on THAT card
 *   GONE (judgement)   two records share an email  -> same person
 *                      two records share a phone   -> same person
 *                      fold two rows into one "combined" row
 *
 * ===========================================================================
 * WHY THESE ARE THE ASSERTIONS AND NOT SOMETHING EASIER
 * ===========================================================================
 * The strongest control for a deletion is BEHAVIOURAL: a record that would
 * previously have been silently folded or hidden now stands as its own row.
 * Every case below is written as an EXACT NAME SET, never a count — a count of
 * 2 cannot tell "the fold is gone" from "a different row dropped out", and
 * this is precisely the kind of change where the wrong row disappearing is the
 * failure mode.
 *
 * `getLinkedSourceKeys` / `getRejectedSourceKeys` and every crosswalk write run
 * for REAL against real SQL here (see the sibling `pickerIdentity` suite), and
 * `dbTransaction` is a REAL transaction — `mockDb.transaction(fn)()`, not the
 * `(fn) => fn()` passthrough that ten `contact-handlers.*` suites install and
 * that BACKLOG-2368 exists to reject. So the "still suppressed" case here is
 * exercising the actual rule, not a stub agreeing with the test.
 *
 * Run under plain node (`node:sqlite`); the repo's better-sqlite3 binary is an
 * Electron build and cannot load under it.
 *
 * ===========================================================================
 * STATUS — HALF THE SPECIFICATION HAS LANDED (BACKLOG-2556, 2026-08-09)
 * ===========================================================================
 * The deletion named above is TWO deletions, and only the first has shipped.
 *
 *   SHIPPED — THE FOLD. `findDuplicateOwner` and both its call sites, the
 *   `absorbedRecords` / `collapsedSources` payload they produced, and the
 *   purple "N records combined" disclosure that drew it. This is the pass that
 *   folded two UNIMPORTED records into one row.
 *
 *   NOT SHIPPED — THE CONTENT FALLBACKS. `emailClaimedByImported` /
 *   `phoneClaimedByImported`, which decide that an unimported record is
 *   ALREADY SAVED because a saved contact shares its address or number under a
 *   compatible name. They are the same class of guess and they are owned by
 *   BACKLOG-2608, which replaces them with a crosswalk-based check rather than
 *   deleting them blind — they are currently the only thing stopping contacts
 *   imported before the crosswalk existed from appearing twice.
 *
 * SO THE THREE `it.failing` CASES DID NOT ALL FLIP TOGETHER, and which one did
 * is itself the measurement:
 *
 *   FLIPPED TO `it` BY THE FOLD DELETION
 *     - two unclaimed records sharing an email, neither absorbing the other
 *       (BOTH records are unimported — only the fold could have hidden one)
 *
 *   STILL `it.failing`, NOW POINTED AT BACKLOG-2608
 *     - same name, same number, no crosswalk row: the card is still offered
 *     - claiming one record does not suppress a different unclaimed one
 *       (in BOTH, a SAVED contact holds the identifier, so the drop happens in
 *       `phoneClaimedByImported` before the fold was ever reached)
 *
 * That split is the discriminating evidence that the fold and the fallbacks are
 * separate mechanisms rather than one rule described twice: deleting the fold
 * moved exactly one of the three, and the two it did not move are the two whose
 * fixtures contain a saved contact.
 *
 *   LIVE (passing throughout, kept as PINS)
 *     - two people sharing an email are two rows
 *     - a saved contact and a record on the same office line are two rows
 *     - a record claimed in the crosswalk is still suppressed
 *
 * WHY THE FIRST TWO PINS ALREADY PASS, which is a real finding and not an
 * accident: BACKLOG-2531 made the email check require a compatible name, as the
 * phone check already did. So a shared identifier between people with DIFFERENT
 * names no longer folds anything. What survives — and what the deletion removes
 * — is the guess where the names ARE compatible, which is why every skipped
 * case below uses the same name or the same surname.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IpcMainInvokeEvent } from "electron";
import { CONTACT_IDENTITY_SCHEMA } from "../services/__tests__/helpers/contactIdentitySchema";
import { openTestDb, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;

const registeredHandlers = new Map<string, any>();

let mockImportedContacts: any[] = [];
let mockShadowRows: any[] = [];

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => registeredHandlers.set(channel, fn),
  },
  app: { getPath: jest.fn(() => "/tmp") },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));

jest.mock("../services/db/core/dbConnection", () => ({
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
import { createLink } from "../services/db/contactSourceLinkDbService";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

function seedContactRow(id: string, name: string): void {
  mockDb!
    .prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(id, USER, name);
}

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

/** The names the picker offered, sorted. Identity, never a count. */
async function pickerNames(): Promise<string[]> {
  const handler = registeredHandlers.get("contacts:get-available");
  const result = await handler(mockEvent, USER);
  expect(result.success).toBe(true);
  return (result.contacts as Array<{ name: string }>).map((c) => c.name).sort();
}

/** The rows, so a test can assert nothing was folded INTO one of them. */
async function pickerRows(): Promise<Array<Record<string, unknown>>> {
  const handler = registeredHandlers.get("contacts:get-available");
  const result = await handler(mockEvent, USER);
  expect(result.success).toBe(true);
  return result.contacts as Array<Record<string, unknown>>;
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
describe("a shared email is not evidence of one person (BACKLOG-2556)", () => {
  /**
   * A couple on one address, an assistant on a manager's card, two agents on
   * one office line. BACKLOG-2496 records why this is a data-integrity defect
   * and not merely a display quirk: their correspondence merges onto a single
   * contact, and "on an exported audit that is someone else's mail in a
   * compliance record."
   *
   * PIN, NOT A CONTROL — measured, not assumed. This already passes at
   * `572367f2`: BACKLOG-2531 made the email check require a compatible name,
   * and "Chris" / "Dana" are not compatible. Reinstating the check after the
   * deletion will NOT redden it. Its job is to stop a future change bringing
   * back the name-blind version, which is the shape that shipped for four
   * months.
   */
  it("two people sharing an email address are two rows [PIN]", async () => {
    mockImportedContacts = [
      importedContact("c-chris", "Chris Alvarez", null, "home@example.com"),
    ];
    mockShadowRows = [
      shadowRow("out-dana", "Dana Alvarez", "outlook", ["home@example.com"], []),
    ];

    // Chris is a SAVED contact and is not an "available to import" row; the
    // question is whether Dana's card is still offered. Before the deletion the
    // shared address hid her and this returned [].
    expect(await pickerNames()).toEqual(["Dana Alvarez"]);
  });

  /**
   * The same rule inside the shadow table itself: two DIFFERENT people, both
   * unclaimed, sharing an address. This is the branch `findDuplicateOwner`
   * folded — one row would have absorbed the other and said "2 records
   * combined".
   *
   * CONTROL 1 FOR THE FOLD DELETION — FLIPPED FROM `it.failing` TO `it` BY
   * BACKLOG-2556. It was red at `572367f2` (the fold absorbed Sam into Robin)
   * and it is green now.
   *
   * OBSERVED RED, 2026-08-09: reinstating `findDuplicateOwner` and its
   * external-loop call site turns this back to
   * `Expected ["Robin Hale","Sam Hale"] / Received ["Robin Hale"]`.
   *
   * This is the founder's Elena Marsh / Elena Marsh-Okonkwo case in the same
   * shape: two surnames that share a prefix, one address, neither imported.
   */
  it("two unclaimed records sharing an email are two rows, and neither absorbs the other", async () => {
    mockShadowRows = [
      shadowRow("out-1", "Robin Hale", "outlook", ["shared@example.com"], []),
      shadowRow("mac-1", "Sam Hale", "macos", ["shared@example.com"], []),
    ];

    expect(await pickerNames()).toEqual(["Robin Hale", "Sam Hale"]);

    // Nothing was folded, so no row carries an absorbed record.
    for (const row of await pickerRows()) {
      expect(row.absorbedRecords ?? []).toEqual([]);
      expect(row.collapsedSources ?? []).toEqual([]);
    }
  });
});

// ===========================================================================
describe("a shared phone is not evidence of one person (BACKLOG-2556)", () => {
  /**
   * BACKLOG-2416's case, now answered by the rule rather than by a name check.
   * The name check made the guess better; D2 removes the guess.
   *
   * PIN, NOT A CONTROL — passes at `572367f2` for the same reason as the email
   * case above (BACKLOG-2416 added the name check here first).
   */
  it("a saved contact and a record on the same office line are two rows [PIN]", async () => {
    mockImportedContacts = [
      importedContact("c-lee", "Lee Park", "+14085550101", null),
    ];
    mockShadowRows = [
      shadowRow("out-mo", "Mo Park", "outlook", [], ["(408) 555-0101"]),
    ];

    expect(await pickerNames()).toEqual(["Mo Park"]);
  });

  /**
   * The hardest case for the OLD rule and the easiest for this one: the SAME
   * name and the same number. Every content rule folds these; only the
   * crosswalk can say whether the user actually imported that card.
   *
   * This is the founder's Casey Lane shape with no link present.
   *
   * STILL `it.failing` AFTER BACKLOG-2556, AND POINTED AT BACKLOG-2608.
   *
   * Measured, not assumed: `c-casey` is a SAVED contact holding
   * `+14085550101`, so `phoneClaimedByImported` drops the Outlook card at
   * `contacts:get-available` before the fold was ever consulted. Deleting the
   * fold does not and cannot move this case — which is why the fold deletion
   * flipped exactly one of the three `it.failing` cases and not three.
   *
   * The runner still asserts the red. BACKLOG-2608 replaces the content
   * fallbacks with a crosswalk check and cannot merge without flipping this
   * to `it`.
   */
  it.failing("same name, same number, no crosswalk row: the card is still offered", async () => {
    mockImportedContacts = [
      importedContact("c-casey", "Casey Lane", "+14085550101", null),
    ];
    mockShadowRows = [
      shadowRow("out-casey", "Casey Lane", "outlook", [], ["(408) 555-0101"]),
    ];

    expect(await pickerNames()).toEqual(["Casey Lane"]);
  });
});

// ===========================================================================
describe("the knowledge half survives untouched (BACKLOG-2556)", () => {
  /**
   * THE OTHER DIRECTION, and the one that matters most: deleting the guessing
   * must not delete the knowing. "If a contact is imported don't show it twice,
   * show the imported one" — that is the crosswalk, and it still works.
   *
   * PIN today, CONTROL after the deletion. Deliberately a plain `it`, not
   * `it.failing`: it passes now and must keep passing through the deletion. It passes at `572367f2` because BOTH
   * the crosswalk check and the content checks suppress this record; once the
   * content checks are gone the crosswalk is the only thing holding it, and
   * dropping the `linkedSourceKeys` check reddens this while every other case
   * stays green. Stated rather than implied — an unstated control is an unrun
   * control.
   */
  it("a record claimed in the crosswalk is still suppressed [PIN -> CONTROL]", async () => {
    seedContactRow("c-casey", "Casey Lane");
    createLink({
      userId: USER,
      contactId: "c-casey",
      sourceType: "outlook",
      sourceRecordId: "out-casey",
      matchMethod: "source_id",
    });

    mockImportedContacts = [
      importedContact("c-casey", "Casey Lane", "+14085550101", null),
    ];
    mockShadowRows = [
      shadowRow("out-casey", "Casey Lane", "outlook", [], ["(408) 555-0101"]),
    ];

    expect(await pickerNames()).toEqual([]);
  });

  /**
   * And the claim is per-RECORD, not per-person: claiming the Outlook card does
   * not suppress an unclaimed macOS card that happens to share details.
   *
   * STILL `it.failing` AFTER BACKLOG-2556, AND POINTED AT BACKLOG-2608: `c-casey`
   * is a SAVED contact holding the number, so `phoneClaimedByImported` takes
   * `mac-casey` before the fold could have.
   *
   * MEASURED PRECISELY, because the first measurement was not precise enough
   * and shipped a broken assertion (SR, §2). Returning `false` from
   * `phoneClaimedByImported` — the BACKLOG-2608 simulation — decides
   * **assertion 1 only**: the macOS card becomes offered and
   * `pickerNames()` passes. Assertion 2 is a separate claim about WHICH
   * address book the surviving row came from, and the fallback has nothing to
   * do with it. Reading only the first assertion is what let a wrong field name
   * through; both are stated here so the next reader does not repeat it.
   */
  it.failing("claiming one record does not suppress a different unclaimed one", async () => {
    seedContactRow("c-casey", "Casey Lane");
    createLink({
      userId: USER,
      contactId: "c-casey",
      sourceType: "outlook",
      sourceRecordId: "out-casey",
      matchMethod: "source_id",
    });

    mockImportedContacts = [
      importedContact("c-casey", "Casey Lane", "+14085550101", null),
    ];
    mockShadowRows = [
      shadowRow("out-casey", "Casey Lane", "outlook", [], ["(408) 555-0101"]),
      shadowRow("mac-casey", "Casey Lane", "macos", [], ["(408) 555-0101"]),
    ];

    // The macOS card is still on offer; only the claimed Outlook one is gone.
    expect(await pickerNames()).toEqual(["Casey Lane"]);
    // THE ADDRESS BOOK IS `externalSourceType`, NOT `source`.
    //
    // This read `r.source` and expected `["macos"]`. `source` is the PROVIDER
    // CATEGORY, and the push site runs the shadow row's source through
    // `toPersistedContactSource`, which maps the Mac address book to
    // `contacts_app` (BACKLOG-1900: only outlook / google_contacts / iphone /
    // android_sync keep a distinct value there). So the assertion described a
    // shape the producer CANNOT emit — the same defect this PR corrected in six
    // renderer fixtures, surviving in the gate suite the PR re-pointed.
    //
    // It matters because of WHEN it would have fired. Measured 2026-08-09 by
    // returning `false` from `phoneClaimedByImported`, i.e. simulating
    // BACKLOG-2608: assertion 1 above PASSES — the macOS card really is offered
    // once the fallback is gone — and the case still failed, on the field name.
    // BACKLOG-2608's author would have flipped this to `it`, seen red, and read
    // a finished fix as unfinished.
    const sources = (await pickerRows()).map((r) => r.externalSourceType).sort();
    expect(sources).toEqual(["macos"]);
  });
});
