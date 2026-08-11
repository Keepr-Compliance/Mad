/**
 * @jest-environment node
 *
 * BACKLOG-2617 — CREATING A CONTACT CREATES A CONTACT.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS PINNING, AND WHY IT HAS TO GO THROUGH THE REAL HANDLER
 * ---------------------------------------------------------------------------
 * `contacts:create` used to open with a duplicate-by-name branch. It called
 * `findContactByName`:
 *
 *     LOWER(display_name) = LOWER(?) AND is_imported = 1
 *
 * Name only. No email, no phone, no `removed_at` filter. On a hit the handler
 * **returned the existing contact and reported `success: true`**, having
 * created nothing.
 *
 * The user has a saved contact Robin Marsh, their lender. A different Robin
 * Marsh, a buyer's agent, needs adding to a deal. They type the name, press
 * Save, are told it worked — and the LENDER is now attached to the deal.
 * Nothing was created, so there is nothing to undo, and nothing told them.
 * Founder-verified in the running app on 2026-08-09.
 *
 * Founder's decision, same day: **a name is not an identifier.** Two people can
 * share one. Create just creates. He was offered "ask which you meant" and
 * "create it but flag it as a possible duplicate" and chose neither, so this
 * suite asserts the absence of a prompt as much as the presence of a row.
 *
 * WHY IT MUST BE THE HANDLER, NOT `createContact`. The defect was never in
 * `createContact` — that function always created. It was in the twenty lines
 * ABOVE the call to it. A suite that exercised `contactDbService.createContact`
 * directly would pass identically before and after the fix and prove nothing.
 * So this drives the registered `contacts:create` IPC handler against a real
 * sqlite database, the same harness as
 * `contact-handlers.typedValueProvenance.test.ts`.
 *
 * ONE DELIBERATE DIFFERENCE FROM THAT SIBLING, and it is the whole point.
 * That suite stubs `findContactByName: () => Promise.resolve(null)` — a fixture
 * that switched the branch off, which is why nothing there ever noticed the
 * branch was wrong. This suite stubs nothing: the facade below forwards to
 * whatever `contactDbService` actually exports. On the fixed tree that export
 * does not exist and the forward resolves to null; on the reverted tree the
 * REAL name-only query runs against the REAL rows. That is what makes the
 * negative control a behavioural failure rather than a compile error.
 *
 * NEGATIVE CONTROL, EXECUTED — see the PR body for the transcript. Restoring
 * `contactHandlers.ts`, `contactDbService.ts` and `databaseService.ts` from
 * b6112e06 turns the substitution and tombstone cases red, each reporting the
 * pre-existing contact's id where a new id was required.
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
  // A REAL transaction, not a passthrough — see BACKLOG-2537 in the sibling suite.
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

/**
 * `databaseService` is a THIN FACADE. Every method the create path touches is
 * forwarded to the REAL `contactDbService` so the real writes hit the real
 * schema.
 *
 * `findContactByName` is forwarded CONDITIONALLY and on purpose. The fix
 * deletes that export, so on the fixed tree the lookup resolves to null and the
 * handler never had a chance to substitute. Revert the three production files
 * and the export reappears, the real name-only SELECT runs, and the cases below
 * fail with a behavioural message. Naming the method explicitly here — rather
 * than dropping it — is what keeps this suite able to FAIL.
 */
jest.mock("../services/databaseService", () => {
  const contactDb = jest.requireActual(
    "../services/db/contactDbService",
  ) as Record<string, unknown>;
  return {
    __esModule: true,
    default: {
      createContact: (data: any, origin: any) =>
        (contactDb.createContact as any)(data, origin),
      backfillContactEmails: (id: string, emails: string[], source?: any) =>
        (contactDb.backfillContactEmails as any)(id, emails, source),
      backfillContactPhones: (id: string, phones: string[], source?: any) =>
        (contactDb.backfillContactPhones as any)(id, phones, source),
      findContactByName: (userId: string, name: string) => {
        const legacy = contactDb.findContactByName as
          | ((u: string, n: string) => Promise<unknown>)
          | undefined;
        return legacy ? legacy(userId, name) : Promise.resolve(null);
      },
      getUserById: (id: string) => Promise.resolve({ id }),
      isInitialized: () => true,
      getImportedContactsByUserIdAsync: () => Promise.resolve([]),
      getUnimportedContactsByUserId: () => Promise.resolve([]),
    },
  };
});

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
  getCount: jest.fn(() => 0),
  getAllForUser: jest.fn(() => []),
  getAllForUserAsync: jest.fn(() => Promise.resolve([])),
  isStale: jest.fn(() => false),
  fullSync: jest.fn(),
  getLastSyncTime: jest.fn(() => null),
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
  syncOutlookContacts: jest.fn(),
  getContactSourceStats: jest.fn(() => ({})),
  markSourceRecordsCurrent: jest.fn(),
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
import { deleteContact, createContact } from "../services/db/contactDbService";
import { originRecordId } from "../services/db/contactOriginLink";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

// Two different people who share a name. Both names are on the fixture PII
// allow-list; every number is inside the reserved 555-01xx range and every
// address is on a reserved RFC 2606 domain.
const SHARED_NAME = "Robin Marsh";

// ---------------------------------------------------------------------------
// OBSERVATION HELPERS — read rows, never seed the property under test
// ---------------------------------------------------------------------------

/** Every contact id currently in the database, tombstoned ones included. */
function allContactIds(): Set<string> {
  const rows = mockDb!.prepare("SELECT id FROM contacts").all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

function rowFor(id: string): { display_name: string; is_imported: number; removed_at: string | null } {
  return mockDb!
    .prepare("SELECT display_name, is_imported, removed_at FROM contacts WHERE id = ?")
    .get(id) as { display_name: string; is_imported: number; removed_at: string | null };
}

/** The synthetic `origin:<id>` crosswalk row `createContact` writes in-transaction. */
function originRowCountFor(contactId: string): number {
  const row = mockDb!
    .prepare(
      "SELECT COUNT(*) AS n FROM contact_source_links WHERE user_id = ? AND source_record_id = ?",
    )
    .get(USER, originRecordId(contactId)) as { n: number };
  return row.n;
}

/**
 * Drive the REAL handler exactly as the Add Contact form does, and return both
 * the id it handed back and the id set that existed immediately before the call.
 *
 * Every case below goes through this, so the "did it substitute?" question is
 * asked identically everywhere rather than re-expressed per test.
 */
async function create(payload: Record<string, unknown>): Promise<{
  returnedId: string;
  before: Set<string>;
}> {
  const before = allContactIds();
  const handler = registeredHandlers.get("contacts:create");
  const result = await handler(mockEvent, USER, payload);
  // Fail loudly with the handler's own reason; a bare truthiness assertion here
  // reports "expected true, received false" and buries the SQL error under it.
  if (!result.success) throw new Error(`contacts:create failed: ${result.error}`);
  return { returnedId: result.contact.id as string, before };
}

/**
 * THE ASSERTION THE WHOLE ITEM REDUCES TO: the id handed back names a row that
 * did not exist before the call. Not "a row was added" — a count is satisfied
 * by adding one row and returning a different one's id, which is very close to
 * the bug.
 */
function expectFreshlyCreated(returnedId: string, before: Set<string>): void {
  expect(before.has(returnedId)).toBe(false);
  expect(allContactIds().has(returnedId)).toBe(true);
}

/** Seed a contact through the real writer, so its shape is one the app emits. */
async function seedExisting(
  name: string,
  opts: { email: string; phone: string; isImported: boolean },
): Promise<string> {
  const contact = await createContact(
    {
      user_id: USER,
      display_name: name,
      email: opts.email,
      phone: opts.phone,
      source: "contacts_app",
      is_imported: opts.isImported,
    } as any,
    { kind: "derived" },
  );
  return contact.id;
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  registeredHandlers.clear();
  registerContactHandlers({} as any);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("two people who share a name are two contacts (BACKLOG-2617)", () => {
  /**
   * THE FOUNDER'S CASE, END TO END. The lender exists and is imported — the
   * exact precondition the old branch required. Adding the buyer's agent must
   * produce a SECOND contact.
   */
  it("creates a new contact when an IMPORTED contact already has that name", async () => {
    const lenderId = await seedExisting(SHARED_NAME, {
      email: "lender@example.com",
      phone: "(408) 555-0141",
      isImported: true,
    });

    const { returnedId, before } = await create({
      name: SHARED_NAME,
      email: "buyers.agent@example.org",
      phone: "(408) 555-0142",
    });

    expectFreshlyCreated(returnedId, before);
    expect(returnedId).not.toBe(lenderId);

    // Exact ID SET, not a count: both people are present, and the lender was
    // neither returned nor disturbed.
    expect(allContactIds()).toEqual(new Set([lenderId, returnedId]));
    expect(rowFor(lenderId).display_name).toBe(SHARED_NAME);
    expect(rowFor(returnedId).display_name).toBe(SHARED_NAME);
  });

  /**
   * The buyer's agent gets their OWN origin crosswalk row.
   *
   * This is the gap BACKLOG-2473 flagged: the early return fired BEFORE the
   * origin write, so a contact first reached through that branch never got one.
   * It cannot recur, because there is no second create path left to skip it —
   * but the row is what proves the create genuinely ran rather than a lookup
   * having answered.
   */
  it("gives the second person their own origin crosswalk row", async () => {
    const lenderId = await seedExisting(SHARED_NAME, {
      email: "lender@example.com",
      phone: "(408) 555-0141",
      isImported: true,
    });

    const { returnedId } = await create({
      name: SHARED_NAME,
      email: "buyers.agent@example.org",
    });

    expect(originRowCountFor(returnedId)).toBe(1);
    // And the pre-existing person still has exactly one — not two, and not the
    // new contact's.
    expect(originRowCountFor(lenderId)).toBe(1);
  });

  /**
   * NO SILENT SUBSTITUTION ANYWHERE ON THE PATH, swept across the boundary
   * rather than sampled at one point.
   *
   * The four inputs are not decoration. Under the deleted rule they did NOT
   * behave alike, and the split is the clearest statement of how arbitrary it
   * was:
   *
   *   - exact name           → captured (`LOWER(a) = LOWER(b)`)
   *   - different case       → captured (same reason)
   *   - surrounding spaces   → captured, because `validateString` TRIMS before
   *                            the lookup ran, so " Robin Marsh " arrived as
   *                            "Robin Marsh". A fixture that assumed the spaces
   *                            survived would be describing a state the app
   *                            cannot emit.
   *   - added middle initial → NOT captured, so this one person could be added
   *                            twice while the other three could not.
   *
   * All four must now create. The last case is included precisely BECAUSE it
   * passed before: a control set made only of previously-failing inputs cannot
   * show that the fix left correct behaviour alone.
   */
  it.each([
    ["the same name exactly", SHARED_NAME],
    ["the same name in a different case", "robin marsh"],
    ["the same name with surrounding whitespace", "  Robin Marsh  "],
    ["the same name plus a middle initial", "Robin B Marsh"],
  ])("returns a brand-new id for %s", async (_label, typedName) => {
    const existingId = await seedExisting(SHARED_NAME, {
      email: "lender@example.com",
      phone: "(408) 555-0141",
      isImported: true,
    });

    const { returnedId, before } = await create({
      name: typedName,
      email: "second.person@example.org",
    });

    expectFreshlyCreated(returnedId, before);
    expect(returnedId).not.toBe(existingId);
    expect(allContactIds()).toEqual(new Set([existingId, returnedId]));
  });
});

// ===========================================================================
describe("a REMOVED contact does not capture a new create (BACKLOG-2617)", () => {
  /**
   * Contacts are tombstoned, not deleted: `removed_at` is set and the row
   * stays. The deleted lookup had no `removed_at` filter, so a contact the user
   * had explicitly removed could still answer for a new one — press Save and
   * get back the person you deleted, with no row added and no way to tell.
   *
   * NOT A TOMBSTONE FILTER. The create path does not consult tombstones now
   * because it does not consult anything; it creates. The matching-side
   * tombstone defect is BACKLOG-2636 and is deliberately untouched here.
   */
  it("creates a new contact when a tombstoned contact holds that name", async () => {
    const removedId = await seedExisting(SHARED_NAME, {
      email: "removed@example.com",
      phone: "(408) 555-0143",
      isImported: true,
    });
    await deleteContact(removedId, "user_deleted");

    // The tombstone is real, not asserted into existence.
    expect(rowFor(removedId).removed_at).not.toBeNull();

    const { returnedId, before } = await create({
      name: SHARED_NAME,
      email: "the.living.one@example.org",
    });

    expectFreshlyCreated(returnedId, before);
    expect(returnedId).not.toBe(removedId);
    expect(rowFor(returnedId).removed_at).toBeNull();
    expect(allContactIds()).toEqual(new Set([removedId, returnedId]));
  });
});

// ===========================================================================
describe("`is_imported` is no longer consulted on the create path (BACKLOG-2617)", () => {
  /**
   * CHARACTERISING THE FLAG, because it is the reason this bug survived and the
   * reason the founder's first hand-test looked like a refutation.
   *
   * The deleted query ended `AND is_imported = 1`, so the outcome depended on a
   * field the user cannot see:
   *
   *   existing contact is_imported = 1 → BEFORE: substituted.  AFTER: creates.
   *   existing contact is_imported = 0 → BEFORE: created.      AFTER: creates.
   *
   * He re-added a contact he had made by hand, got two rows, and reasonably
   * concluded the report was wrong. His contact was not imported. Since
   * `createContact` DEFAULTS `is_imported` to 1 and everything arriving from an
   * import or a sync sets it, the sparing case was the minority — the one way
   * to test it by hand was the one way that could not reproduce it.
   *
   * Both rows of that table are asserted. The `is_imported = 0` case is the
   * previously-passing half and is kept for the same reason as the middle
   * initial above: to show the fix did not achieve its result by breaking
   * something that already worked.
   */
  it.each([
    ["an imported contact holds the name (the case that used to substitute)", true],
    ["a hand-made, non-imported contact holds the name (the case that never did)", false],
  ])("creates a new contact when %s", async (_label, isImported) => {
    const existingId = await seedExisting(SHARED_NAME, {
      email: "existing@example.com",
      phone: "(408) 555-0144",
      isImported: isImported as boolean,
    });
    expect(rowFor(existingId).is_imported).toBe(isImported ? 1 : 0);

    const { returnedId, before } = await create({
      name: SHARED_NAME,
      email: "newcomer@example.org",
    });

    expectFreshlyCreated(returnedId, before);
    expect(allContactIds()).toEqual(new Set([existingId, returnedId]));
  });
});

// ===========================================================================
describe("create reports what it actually did (BACKLOG-2617)", () => {
  /**
   * The founder was offered a confirmation prompt and a "possible duplicate"
   * flag, and chose neither: create just creates. So the response carries no
   * question, no candidate list and no duplicate marker — and this asserts
   * that, because the failure mode of a well-meant follow-up PR is to add one.
   *
   * Anything of that kind belongs to the matcher once contact-versus-contact
   * proposals exist (BACKLOG-2616), not to the create path.
   */
  it("returns the created contact with no prompt or duplicate flag attached", async () => {
    await seedExisting(SHARED_NAME, {
      email: "lender@example.com",
      phone: "(408) 555-0141",
      isImported: true,
    });

    const handler = registeredHandlers.get("contacts:create");
    const result = await handler(mockEvent, USER, {
      name: SHARED_NAME,
      email: "buyers.agent@example.org",
    });

    expect(result.success).toBe(true);
    expect(result.contact.name).toBe(SHARED_NAME);
    expect(Object.keys(result)).toEqual(["success", "contact"]);
  });
});
