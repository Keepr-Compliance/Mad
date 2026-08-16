/**
 * @jest-environment node
 *
 * BACKLOG-2370 — ONE MATCHING RULE, NOT TWO.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE SPANS BOTH PROCESSES
 * ---------------------------------------------------------------------------
 * The defect this pins could not be seen from either side. `contacts:get-available`
 * did exactly the right thing — it consulted the user's recorded `different_people`
 * verdict and RELEASED the record it had wrongly linked — and its own suite was
 * green. `contactPickerList`'s dedup pass then compared that released record
 * against the saved contact it had just been released FROM and hid it, and its
 * own suite was green too. The user's unlink was silently reversed in the gap
 * between two green suites.
 *
 * So these assertions drive the REAL handler over a real SQLite database and feed
 * its REAL output into the REAL renderer assembly, which is the only place the
 * two rules ever met. Neither rule is reimplemented here.
 *
 * ---------------------------------------------------------------------------
 * EXACT IDENTITY SETS, NEVER COUNTS
 * ---------------------------------------------------------------------------
 * Every assertion names the records it expects. A count passes while naming the
 * wrong people, and on a surface where a contact is a party to a transaction
 * under audit, naming the wrong people IS the failure.
 *
 * Fixtures use reserved values only — RFC 2606 domains, +1 555 01xx numbers
 * (BACKLOG-2485).
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
// The REAL renderer assembly. It cannot import from `electron/`, and this suite
// is the only place both halves are loaded at once.
import { assembleContacts } from "../../src/utils/contactPickerList";
import type { ExtendedContact } from "../../src/types/components";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    synced_at: "2026-08-04T00:00:00.000Z",
  };
}

/** A saved (imported) contact as `contacts:get-all` returns it. */
function saved(
  id: string,
  name: string,
  emails: string[],
  phones: string[],
): Record<string, unknown> {
  return {
    id,
    user_id: USER,
    name,
    display_name: name,
    email: emails[0] ?? null,
    phone: phones[0] ?? null,
    allEmails: emails,
    allPhones: phones,
    company: null,
    source: "contacts_app",
    is_imported: 1,
    last_communication_at: null,
  };
}

/**
 * The user pressed "Not this person" on a source record: the crosswalk row goes
 * and a `different_people` verdict is appended. Written as raw SQL against the
 * REAL schema rather than through a helper, so the suite depends on the shape
 * `getRejectedSourceKeys` actually queries.
 */
/**
 * The crosswalk row that says this source record IS this contact.
 *
 * BACKLOG-2608: raw SQL against the REAL schema, for the same reason
 * `recordUnlinkVerdict` below is — the suite must depend on the shape
 * `getLinkedSourceKeys` actually queries, and a saved contact needs a real
 * `contacts` row for the foreign key to hold.
 */
function recordCrosswalkLink(contactId: string, name: string, sourceType: string, sourceRecordId: string): void {
  mockDb!
    .prepare("INSERT OR IGNORE INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)")
    .run(contactId, USER, name);
  mockDb!
    .prepare(
      `INSERT INTO contact_source_links
         (id, user_id, contact_id, source_type, source_record_id, match_method)
       VALUES (?, ?, ?, ?, ?, 'source_id')`,
    )
    .run(`l-${sourceType}-${sourceRecordId}`, USER, contactId, sourceType, sourceRecordId);
}

function recordUnlinkVerdict(contactId: string, sourceType: string, sourceRecordId: string): void {
  mockDb!
    .prepare(
      `INSERT INTO contact_link_verdicts
         (id, user_id, contact_id, source_type, source_record_id,
          identity_verdict, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, 'different_people', 'user', ?)`,
    )
    .run(
      `v-${sourceRecordId}`,
      USER,
      contactId,
      sourceType,
      sourceRecordId,
      "2026-08-04T12:00:00.000Z",
    );
}

/** Everything `contacts:get-available` returns, as the renderer receives it. */
async function externalsFromMain(): Promise<ExtendedContact[]> {
  const handler = registeredHandlers.get("contacts:get-available");
  const result = await handler(mockEvent, USER);
  expect(result.success).toBe(true);
  return result.contacts as ExtendedContact[];
}

/** Sorted row ids, i.e. the identity SET the two surfaces render. */
function idsOf(rows: ExtendedContact[]): string[] {
  return rows.map((c) => c.id).sort();
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockImportedContacts = [];
  mockShadowRows = [];
  registeredHandlers.clear();
  registerContactHandlers({
    isDestroyed: () => false,
    webContents: { send: jest.fn() },
  } as any);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("BACKLOG-2370 — an unlinked record comes back, and stays back", () => {
  /**
   * THE FOUNDER'S CASE, 2026-08-04, reproduced end to end.
   *
   * He unlinked an Outlook record from a saved contact. The record carries the
   * SAME NAME and the SAME NUMBER as that contact — which is precisely why it
   * was wrongly linked.
   *
   * BACKLOG-2608 — THE FIXTURE NOW DESCRIBES THE STATE ITS OWN COMMENT CLAIMED.
   * The macOS record was annotated "still legitimately linked" and NO crosswalk
   * row existed for it; it was dropping out of the picker only because the
   * saved contact held its number under a compatible name. With the content
   * checks deleted that record is correctly offered, and the fix is to write
   * the link the comment always asserted rather than to relax the assertion.
   * The suite now tests what it says it tests.
   *
   * Note what carries the release now: nothing does. A released record has no
   * crosswalk row, and the crosswalk is the only suppressor, so "not this
   * person" is honoured by the ABSENCE of a rule rather than by an exemption.
   */
  const CONTACT_ID = "saved-lane";

  beforeEach(() => {
    mockImportedContacts = [
      saved(CONTACT_ID, "Casey Example", [], ["+1 (555) 0143"]),
    ];
    mockShadowRows = [
      // Still legitimately linked — the macOS card really is this person, and it
      // is where the shared number lives.
      shadowRow("mac-casey", "Casey Example", "macos", [], ["+1 (555) 0143"]),
      // RELEASED by the user. Same name, same number.
      shadowRow("out-casey", "Casey Example", "outlook", [], ["+1 (555) 0143"]),
    ];
    recordCrosswalkLink(CONTACT_ID, "Casey Example", "macos", "mac-casey");
    recordUnlinkVerdict(CONTACT_ID, "outlook", "out-casey");
  });

  it("the main process releases it — the decision the user made is honoured", async () => {
    const externals = await externalsFromMain();

    // The macOS record is suppressed because the crosswalk claims it. The
    // released Outlook record is not claimed by anything, so it is offered.
    expect(externals.map((c) => (c as any).externalRecordId).sort()).toEqual(["out-casey"]);
  });

  it("and the renderer still shows it — this is the assertion that used to fail", async () => {
    const externals = await externalsFromMain();

    const rendered = assembleContacts(
      mockImportedContacts as unknown as ExtendedContact[],
      externals,
    );

    // BEFORE BACKLOG-2370 the released record was absent from this set: the
    // renderer's dedup pass matched it to `saved-lane` on the shared phone
    // with a compatible name and dropped it. The row was unreachable on Clients
    // & Contacts AND on the transaction contact picker, both of which
    // `ContactSearchList` backs, so the unlink could not be completed or undone.
    expect(idsOf(rendered)).toEqual([CONTACT_ID, "ext-out-casey"].sort());
  });

  it("the released record is importable — it is a row of its own, not a fold", async () => {
    const externals = await externalsFromMain();
    const rendered = assembleContacts(
      mockImportedContacts as unknown as ExtendedContact[],
      externals,
    );

    const released = rendered.find((c) => c.id === "ext-out-casey");
    expect(released).toBeDefined();
    // It carries its own source identity, so selecting it writes a crosswalk row
    // for the record the user chose rather than re-deriving one by resemblance.
    expect((released as any).externalRecordId).toBe("out-casey");
    expect((released as any).externalSourceType).toBe("outlook");
    // And nothing claims to have absorbed it.
    for (const row of rendered) {
      expect((row as any).absorbedRecords ?? []).toEqual([]);
    }
  });
});

// ===========================================================================
describe("BACKLOG-2316 — two people on one office line both survive both layers", () => {
  /**
   * The two-Margarets case. It is the reason the main process gates a shared
   * phone on name compatibility, and it must not regress now that the second
   * rule is gone — a removed dedup layer can only ever show MORE, so this pins
   * that "more" is still exactly the right two people and not a third row.
   */
  beforeEach(() => {
    mockShadowRows = [
      shadowRow("chen", "Margaret Chen", "macos", [], ["(555) 0100"]),
      shadowRow("torres", "Margaret Torres", "outlook", [], ["555-0100"]),
    ];
  });

  it("both are returned by the main process and both are rendered", async () => {
    const externals = await externalsFromMain();
    expect(externals.map((c) => (c as any).externalRecordId).sort()).toEqual(["chen", "torres"]);

    expect(idsOf(assembleContacts([], externals))).toEqual(["ext-chen", "ext-torres"]);
  });

  /**
   * RE-POINTED BY BACKLOG-2556 — was "is still ONE row", and asserted the
   * `absorbedRecords` disclosure that went with the fold.
   *
   * Main folded the Outlook record into the macOS one and drew "1 record
   * combined" on the survivor. The founder deleted that: *"ok lets delete the
   * fold"*. Both records now reach the renderer, and there is no
   * `absorbedRecords` channel left to disclose anything on — that field is
   * deleted from `AvailableContact` with the fold that filled it.
   *
   * The renderer half of the assertion is UNCHANGED in meaning and is the part
   * still worth having: whatever main returns, `assembleContacts` passes
   * through untouched.
   */
  it("the same person twice on one line is TWO rows — decided by main, not here [BACKLOG-2556]", async () => {
    mockShadowRows = [
      shadowRow("chen-mac", "Margaret Chen", "macos", [], ["(555) 0100"]),
      shadowRow("chen-out", "Margaret Chen", "outlook", [], ["555-0100"]),
    ];

    const externals = await externalsFromMain();
    expect(externals.map((c) => (c as any).externalRecordId).sort()).toEqual([
      "chen-mac",
      "chen-out",
    ]);
    // Nothing was absorbed, and there is nowhere for an absorption to be
    // recorded. Asserted on the ROW rather than on the type so this stays a
    // behavioural check: re-adding the field alone would not redden it, but
    // re-adding the fold would.
    for (const row of externals) {
      expect((row as any).absorbedRecords).toBeUndefined();
      expect((row as any).collapsedSources).toBeUndefined();
    }

    // The renderer passes main's answer straight through.
    expect(idsOf(assembleContacts([], externals))).toEqual([
      "ext-chen-mac",
      "ext-chen-out",
    ]);
  });
});

// ===========================================================================
describe("BACKLOG-2370 — no saved contact ever disappears", () => {
  /**
   * The removed pass compared saved contacts against externals and dropped the
   * EXTERNAL. But it also never merged two saved rows, and that must remain
   * true: a saved contact is a real record with transaction history that can
   * appear on an exported audit.
   */
  it("every saved contact is rendered, including two sharing one email address", async () => {
    mockImportedContacts = [
      saved("s-1", "Ada Example", ["office@example.test"], []),
      saved("s-2", "Ben Example", ["office@example.test"], []),
      saved("s-3", "Cleo Example", [], ["+1 (555) 0111"]),
      saved("s-4", "Cleo Example", [], ["+1 (555) 0111"]),
      saved("s-5", "Dov Example", [], []),
      saved("s-6", "Dov Example", [], []),
    ];
    mockShadowRows = [];

    const externals = await externalsFromMain();
    const rendered = assembleContacts(
      mockImportedContacts as unknown as ExtendedContact[],
      externals,
    );

    expect(idsOf(rendered)).toEqual(["s-1", "s-2", "s-3", "s-4", "s-5", "s-6"]);
  });
});

// ===========================================================================
describe("BACKLOG-2370 — MEASUREMENT: what removing the layer actually changes", () => {
  /**
   * ===========================================================================
   * THE RISK, MEASURED RATHER THAN ASSUMED
   * ===========================================================================
   * Removing a dedup layer can only ever show MORE rows. The question is whether
   * the extra rows are duplicates the main process fails to catch — and the
   * honest way to answer it is to run a corpus shaped like the founder's through
   * the REAL handler and compare the identity sets, not to reason about it.
   *
   * This test states the difference as an exact set. If a future change to the
   * main process makes the renderer's output diverge from main's in some new
   * way, this goes red and NAMES the record, instead of the difference being
   * discovered by a user who cannot find someone.
   */
  beforeEach(() => {
    mockImportedContacts = [
      saved("s-alice", "Alice Example", ["alice@example.test"], []),
      saved("s-casey", "Casey Example", [], ["+1 (555) 0143"]),
    ];
    mockShadowRows = [
      // Same person in two books on one email -> main folds one away.
      shadowRow("mac-bea", "Bea Example", "macos", ["bea@example.test"], []),
      shadowRow("out-bea", "Bea E", "outlook", ["BEA@example.test"], []),
      // Two people on one office line -> main keeps both.
      shadowRow("mac-cleo", "Cleo Example", "macos", [], ["+1 (555) 0100"]),
      shadowRow("mac-dov", "Dov Example", "macos", [], ["+1 (555) 0100"]),
      // Claimed by the crosswalk -> main drops it. BACKLOG-2608: this row was
      // annotated "already imported by email" and was dropped by the content
      // fallback. That fallback is deleted, so the fixture now carries the
      // crosswalk row that is the ONLY thing entitled to drop it — and the
      // "nothing else appeared" assertion below still has a suppressed record
      // to be about.
      shadowRow("out-alice", "Alice Example", "outlook", ["alice@example.test"], []),
      // Released by the user -> main returns it.
      shadowRow("out-casey", "Casey Example", "outlook", [], ["+1 (555) 0143"]),
      // Name and nothing else, twice. Main keeps BOTH (BACKLOG-2316 removed
      // name matching because it hid distinct people who share a name). The
      // removed renderer pass kept ONE — this is the name-only divergence
      // `contact-handlers.dedupParity.test.ts` recorded as an open question, and
      // BACKLOG-2370 is the founder decision that closed it.
      shadowRow("mac-nameonly", "Fenn Example", "macos", [], []),
      shadowRow("out-nameonly", "Fenn Example", "outlook", [], []),
      // Nobody's duplicate.
      shadowRow("mac-gus", "Gus Example", "macos", ["gus@example.test"], []),
    ];
    recordCrosswalkLink("s-alice", "Alice Example", "outlook", "out-alice");
    recordUnlinkVerdict("s-casey", "outlook", "out-casey");
  });

  it("the rendered set is EXACTLY the main process's answer, plus the saved rows", async () => {
    const externals = await externalsFromMain();
    const rendered = assembleContacts(
      mockImportedContacts as unknown as ExtendedContact[],
      externals,
    );

    // BACKLOG-2556: was 7 out — `out-bea` was folded into `mac-bea` on the
    // shared address. The fold is deleted, so it is 8, and `out-bea` is the one
    // that came back. `out-alice` is still filtered — now by the crosswalk row
    // in the fixture rather than by the deleted `emailClaimedByImported`
    // fallback (BACKLOG-2608). The SET is unchanged; the reason one member is
    // absent is not.
    expect(externals.map((c) => (c as any).externalRecordId).sort()).toEqual([
      "mac-bea",
      "mac-cleo",
      "mac-dov",
      "mac-gus",
      "mac-nameonly",
      "out-bea",
      "out-nameonly",
      "out-casey",
    ].sort());

    // And the renderer adds nothing and removes nothing.
    expect(idsOf(rendered)).toEqual(
      ["s-alice", "s-casey", ...externals.map((c) => c.id)].sort(),
    );
  });

  it("names the FOUR records that would have been hidden, and why each must stay", async () => {
    const externals = await externalsFromMain();
    const rendered = assembleContacts(
      mockImportedContacts as unknown as ExtendedContact[],
      externals,
    );
    const shown = new Set(rendered.map((c) => c.id));

    // 1. THE DEFECT. Released by the user; the removed pass re-hid it on the
    //    shared phone plus a compatible name.
    expect(shown.has("ext-out-casey")).toBe(true);

    // 2. THE NAME-ONLY DIVERGENCE. Two address-book cards carrying a name and
    //    nothing else. The removed pass kept one. Each is a REACHABLE record
    //    with a source pill and an id the user can select and assign, and they
    //    may simply be two different people — which is exactly why the main
    //    process stopped matching on names in BACKLOG-2316.
    expect(shown.has("ext-mac-nameonly")).toBe(true);
    expect(shown.has("ext-out-nameonly")).toBe(true);

    // 3. BACKLOG-2556 — THE FOLD IS GONE. `out-bea` ("Bea E") shared
    //    `BEA@example.test` with `mac-bea` ("Bea Example") under a
    //    prefix-compatible name, and was folded away with a purple "1 record
    //    combined" toggle on the survivor. It is now its own row. This is the
    //    Elena Marsh / Elena Marsh-Okonkwo shape: two spellings, one address,
    //    and no way for the app to know whether they are one person.
    expect(shown.has("ext-out-bea")).toBe(true);

    // Nothing ELSE appeared. The KNOWLEDGE half still suppresses: the Outlook
    // Alice is filtered because the crosswalk says a saved contact claims that
    // exact record (BACKLOG-2608 — it used to be filtered on the address alone).
    expect(shown.has("ext-out-alice")).toBe(false);
  });

  /**
   * =========================================================================
   * THE ONE GENUINELY NEW DUPLICATE, NAMED RATHER THAN FILTERED AWAY
   * =========================================================================
   * Removing a dedup layer can surface duplicates the remaining layer does not
   * catch. Exactly one shape does, and this is it — found by an existing suite
   * going red (`EditContactsModal.twoPane.test.tsx`), not by reasoning.
   *
   * ## The shape
   *
   * A saved contact with MORE THAN ONE email (or phone), whose address-book card
   * is filed under a SECONDARY one, and which has no crosswalk row linking the
   * two. `contacts:get-available` builds its already-imported sets from the
   * PRIMARY value only — `importedContacts.map((c) => c.email)` and
   * `ic.phone` — so it does not recognise the card and returns it. The removed
   * renderer pass DID bridge them, because the saved contact's `allEmails`
   * carries both.
   *
   * ## Why it is left showing
   *
   * Re-adding a renderer rule to hide it would reintroduce the whole defect —
   * quietly, and in the layer that stores nothing. The founder's decision is one
   * rule. If this is worth fixing it is worth fixing where the decision is made
   * and recorded: either widen main's already-imported sets to every email and
   * phone, or let the crosswalk converge. Both are main-process changes, out of
   * scope here (BACKLOG-2370 explicitly does not touch a main-process matching
   * rule), and both would turn this test red — which is when it should be
   * rewritten.
   *
   * ## How far it actually reaches
   *
   * Not to contacts imported since BACKLOG-2401: those have a `contact_source_links`
   * row, and the crosswalk check runs BEFORE the email/phone fallback and
   * suppresses the card whatever its address. The exposure is the converging
   * legacy set — contacts imported before the crosswalk existed, or created by
   * hand — which is the same set the fallback itself exists to serve.
   */
  it("KNOWN CONSEQUENCE: a card filed under a saved contact's SECONDARY email is now shown", async () => {
    mockImportedContacts = [
      // Primary casey@work.example.test, secondary casey@home.example.test.
      saved("s-multi", "Casey Multi", ["casey@work.example.test", "casey@home.example.test"], []),
    ];
    mockShadowRows = [
      shadowRow("out-multi", "Casey Multi", "outlook", ["casey@home.example.test"], []),
    ];

    const externals = await externalsFromMain();

    // MAIN is the layer that lets it through, and it did so before this task —
    // its already-imported set holds the PRIMARY address only. Naming that here
    // is the point: the renderer is not the thing that changed its mind.
    expect(externals.map((c) => (c as any).externalRecordId)).toEqual(["out-multi"]);

    const rendered = assembleContacts(
      mockImportedContacts as unknown as ExtendedContact[],
      externals,
    );
    // Two rows for one person. Accepted, and accepted VISIBLY: a duplicate row
    // is something the user can see and act on, which is the trade the founder
    // made against a hidden record nobody can.
    expect(idsOf(rendered)).toEqual(["ext-out-multi", "s-multi"]);
  });

  it("...and the same shape on a SECONDARY phone number", async () => {
    mockImportedContacts = [
      saved("s-phones", "Rae Example", [], ["+1 (555) 0155", "+1 (555) 0156"]),
    ];
    mockShadowRows = [
      shadowRow("out-rae", "Rae Example", "outlook", [], ["+1 (555) 0156"]),
    ];

    const externals = await externalsFromMain();
    expect(externals.map((c) => (c as any).externalRecordId)).toEqual(["out-rae"]);

    expect(
      idsOf(
        assembleContacts(mockImportedContacts as unknown as ExtendedContact[], externals),
      ),
    ).toEqual(["ext-out-rae", "s-phones"]);
  });

  /**
   * BACKLOG-2608 — THE CONTROL IS NOW THE CROSSWALK, BECAUSE THE PRIMARY /
   * SECONDARY DISTINCTION NO LONGER EXISTS.
   *
   * This asserted that the SAME card filed under the saved contact's PRIMARY
   * address was caught while the secondary one was not, proving the gap lived
   * in main's primary-only set. Both content sets are deleted, so primary and
   * secondary are now treated identically — neither suppresses — and asserting
   * `[]` on the primary card would assert nothing that is still true.
   *
   * The claim worth keeping is that main still suppresses SOMETHING, and what.
   * So the fixture writes the crosswalk row and the assertion is unchanged in
   * shape: an identical card, one difference, and main catches it.
   *
   * The two "KNOWN CONSEQUENCE" cases above are now understated rather than
   * wrong — a card under a saved contact's PRIMARY value is shown too. Left
   * standing because their point survives: a visible duplicate row is the trade
   * the founder made against a hidden record nobody can act on.
   */
  it("but a card the crosswalk claims is still suppressed by main", async () => {
    mockImportedContacts = [
      saved("s-multi", "Casey Multi", ["casey@work.example.test", "casey@home.example.test"], []),
    ];
    mockShadowRows = [
      shadowRow("out-multi", "Casey Multi", "outlook", ["casey@work.example.test"], []),
    ];
    recordCrosswalkLink("s-multi", "Casey Multi", "outlook", "out-multi");

    const externals = await externalsFromMain();
    expect(externals).toEqual([]);

    expect(
      idsOf(
        assembleContacts(mockImportedContacts as unknown as ExtendedContact[], externals),
      ),
    ).toEqual(["s-multi"]);
  });

  /**
   * RE-POINTED BY BACKLOG-2556 — was "the main process still discloses every
   * collapse it makes", asserting `{ "Bea Example": ["Bea E"] }`.
   *
   * That test was correct and is now meaningless: with no collapse there is
   * nothing to disclose, and asserting `{}` against a deleted field would pass
   * for the wrong reason — it would stay green if the fold came back but the
   * disclosure did not, which is the WORSE of the two failure modes (a record
   * vanishing with nothing on screen to say so).
   *
   * So it asserts the property that replaced it: every shadow row the picker
   * did not suppress on the KNOWLEDGE half reaches the caller, by exact id set.
   * `out-alice` is absent because the crosswalk claims it (BACKLOG-2608 — it
   * used to be absent because a saved contact held its address); nothing else
   * is. If the fold returns, this names the record it swallowed.
   */
  it("nothing is folded away, so there is nothing to disclose [BACKLOG-2556]", async () => {
    const externals = await externalsFromMain();

    expect(externals.map((row) => (row as any).externalRecordId).sort()).toEqual([
      "mac-bea",
      "mac-cleo",
      "mac-dov",
      "mac-gus",
      "mac-nameonly",
      "out-bea",
      "out-casey",
      "out-nameonly",
    ]);
    for (const row of externals) {
      expect((row as any).absorbedRecords).toBeUndefined();
    }
  });
});
