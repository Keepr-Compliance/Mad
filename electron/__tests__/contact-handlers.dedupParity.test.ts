/**
 * @jest-environment node
 *
 * BACKLOG-2416, closed by BACKLOG-2370 — THERE IS NOW ONE RULE, SO THERE IS
 * NOTHING LEFT TO KEEP IN PARITY.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE USED TO BE, AND WHY IT CHANGED
 * ---------------------------------------------------------------------------
 * The BACKLOG-2416 defect was never that either rule was wrong in isolation. It
 * was that there were TWO. `contactHandlers` required `namesAreCompatible`
 * before a shared phone could collapse two records; the renderer's
 * `contactPickerList` matched on the phone unconditionally. Both suites were
 * green; the disagreement lived in the gap between them. This suite existed to
 * run THE SAME PAIR through BOTH layers and compare the verdicts.
 *
 * It also recorded one case where the layers still disagreed — two records
 * carrying a name and nothing else — and said, in as many words, that
 * reconciling them "IS A FOUNDER DECISION, not something to settle inside a bug
 * fix", because it means either resurrecting name matching in the backend or
 * removing it from the renderer, and each has a real cost.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION, 2026-08-04
 * ---------------------------------------------------------------------------
 * The founder was shown the second rule and chose removal: *"ok sounds good we
 * can remove it then simple is better."* His reasoning is the product's — a
 * combination worth showing a user is worth STORING, and once stored it is a
 * link. The renderer's pass stored nothing, so a merge it made could not be
 * audited, undone or explained, and on 2026-08-04 it silently reversed an unlink
 * he had just performed.
 *
 * So the question this suite asked is now answered by subtraction. Parity is no
 * longer something to check pair by pair; it is structural. What is worth
 * pinning is the property that replaced it, and there are exactly two halves:
 *
 *   1. The BACKEND rule still behaves exactly as BACKLOG-2416 left it. Every
 *      case below is the ORIGINAL case with the same expectation — an office
 *      line, an abbreviated spelling, a generational suffix, a shared email with
 *      incompatible names. If the founder's decision had been reversed onto the
 *      backend instead, these would move.
 *   2. The RENDERER applies NO rule. It is handed a set and returns that set.
 *
 * Together those say what "one matching rule" means operationally: the only
 * thing that can remove a record is the main process, and what it removes it
 * records.
 *
 * `contact-handlers.oneMatchingRule.test.ts` pins the consequence end to end,
 * including the released-record case that made the decision necessary.
 * `contactNameCompat.parity.test.ts` still pins the shared NAME rule, which the
 * backend continues to consume.
 *
 * ---------------------------------------------------------------------------
 * BACKLOG-2556, 2026-08-09 — HALF 1 ABOVE IS NO LONGER TRUE. RE-POINTED.
 * ---------------------------------------------------------------------------
 * Half 1 said "the BACKEND rule still behaves exactly as BACKLOG-2416 left it".
 * The founder deleted that rule: *"ok lets delete the fold"*. `findDuplicateOwner`
 * and both its call sites are gone, so the backend no longer decides that two
 * unimported records are one person on ANY content.
 *
 * THREE CASES HERE ASSERTED "keeps ONE" AND NOW ASSERT "keeps BOTH" — the same
 * pairs, the opposite verdict, each carrying the reason inline. They are the
 * sharpest form of this deletion's control: the pairs were chosen precisely
 * because the old rule folded them.
 *
 * The FIVE "keeps BOTH" cases are untouched and still pass. That matters more
 * than it looks: Margaret Chen / Margaret Torres on one office line survived
 * because of the NAME guard INSIDE the fold. Deleting the guard instead of the
 * fold would have kept those five green while inverting them in the field, so
 * they are the discriminating negative for "did you delete the right thing".
 *
 * The suite's FILENAME is now historical. It is kept because the pairs and
 * their catalogue references are the value here, and a rename would detach the
 * cases from the four months of reasoning above them. There is nothing left in
 * parity because there is nothing left to be in parity WITH — both rules are
 * deleted, the renderer's by BACKLOG-2370 and the backend's by BACKLOG-2556.
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

let mockShadowRows: any[] = [];

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getImportedContactsByUserIdAsync: jest.fn(() => Promise.resolve([])),
    getRemovedContactIdentifiers: jest.fn(() => Promise.resolve([])),
    getImportedContactsByUserId: jest.fn(() => Promise.resolve([])),
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

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

interface Record {
  recordId: string;
  name: string;
  source: string;
  emails: string[];
  phones: string[];
}

/** The source record ids the BACKEND picker keeps, sorted. */
async function backendKeeps(records: Record[]): Promise<string[]> {
  mockShadowRows = records.map((r) => ({
    id: `ext-${r.recordId}`,
    user_id: USER,
    name: r.name,
    phones: r.phones,
    emails: r.emails,
    company: null,
    source: r.source,
    external_record_id: r.recordId,
    external_uuid: null,
    last_message_at: null,
    synced_at: "2026-08-03T00:00:00.000Z",
  }));
  const handler = registeredHandlers.get("contacts:get-available");
  const result = await handler(mockEvent, USER);
  expect(result.success).toBe(true);
  return (result.contacts as Array<{ externalRecordId: string }>)
    .map((c) => c.externalRecordId)
    .sort();
}

/**
 * The source record ids the RENDERER keeps, sorted.
 *
 * Since BACKLOG-2370 this is simply "all of them, by id". It is still driven
 * through the real `assembleContacts` rather than replaced with `records.map` —
 * the point of the assertions below is that the renderer applies no rule, and
 * that is only worth stating if the real function is the thing being asked.
 */
function rendererKeeps(records: Record[]): string[] {
  const externals = records.map(
    (r) =>
      ({
        id: r.recordId,
        name: r.name,
        display_name: r.name,
        email: r.emails[0] ?? null,
        phone: r.phones[0] ?? null,
        allEmails: r.emails,
        allPhones: r.phones,
      }) as never,
  );
  return assembleContacts([], externals)
    .map((c) => c.id)
    .sort();
}

/**
 * The BACKEND keeps exactly `expected`, and the RENDERER keeps everything it is
 * given.
 *
 * These are no longer the same assertion, and that asymmetry is the point. The
 * renderer is checked against `everyRecord` — the full input — so a dedup rule
 * reappearing in that layer turns this red no matter which shape it matches on.
 */
async function assertOneRuleDecides(records: Record[], expected: string[]): Promise<void> {
  const backend = await backendKeeps(records);
  const renderer = rendererKeeps(records);
  const everyRecord = records.map((r) => r.recordId).sort();
  expect({ backend, renderer }).toEqual({ backend: expected, renderer: everyRecord });
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
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
describe("BACKLOG-2370 — the backend decides, and the renderer decides nothing", () => {
  /**
   * NEGATIVE CONTROL (executed, output in the PR): restore any dedup rule to
   * `contactPickerList.assembleContacts` and every case here goes red on the
   * `renderer` half, naming the records that layer removed.
   *
   * Each case keeps its ORIGINAL BACKLOG-2416 backend expectation, so this suite
   * still fails if the backend rule drifts — which is the half of the old parity
   * guarantee that is still meaningful.
   */
  it("two people on one office line: the backend keeps BOTH", async () => {
    await assertOneRuleDecides(
      [
        { recordId: "chen", name: "Margaret Chen", source: "macos", emails: [], phones: ["(415) 555-0102"] },
        { recordId: "torres", name: "Margaret Torres", source: "outlook", emails: [], phones: ["415-555-0102"] },
      ],
      ["chen", "torres"],
    );
  });

  /**
   * RE-POINTED BY BACKLOG-2556 — was "the backend keeps ONE", `["chen-mac"]`.
   *
   * The same person recorded in two address books really is one person, and the
   * old rule got this pair right. It is still deleted, because the app cannot
   * tell this pair from Elena Marsh / Elena Marsh-Okonkwo, and getting that one
   * wrong hid a reachable person. Two rows the user can merge beats one row
   * with someone missing from it.
   */
  it("the same person twice on one line: the backend keeps BOTH [BACKLOG-2556]", async () => {
    await assertOneRuleDecides(
      [
        { recordId: "chen-mac", name: "Margaret Chen", source: "macos", emails: [], phones: ["(415) 555-0102"] },
        { recordId: "chen-out", name: "Margaret Chen", source: "outlook", emails: [], phones: ["415-555-0102"] },
      ],
      ["chen-mac", "chen-out"],
    );
  });

  /**
   * RE-POINTED BY BACKLOG-2556 — was "the backend keeps ONE", `["chen-full"]`.
   *
   * "Margaret C." is prefix-compatible with "Margaret Chen" — and equally
   * compatible with Margaret Chen's daughter. That is the guess.
   */
  it("an abbreviated spelling on one line: the backend keeps BOTH [BACKLOG-2556]", async () => {
    await assertOneRuleDecides(
      [
        { recordId: "chen-abbrev", name: "Margaret C.", source: "outlook", emails: [], phones: ["415-555-0102"] },
        { recordId: "chen-full", name: "Margaret Chen", source: "macos", emails: [], phones: ["(415) 555-0102"] },
      ],
      ["chen-abbrev", "chen-full"],
    );
  });

  it("a generational suffix on one line: the backend keeps BOTH", async () => {
    // Jr never collapses into Sr (catalogue L6).
    await assertOneRuleDecides(
      [
        { recordId: "sr", name: "Robert King Sr", source: "macos", emails: [], phones: ["(415) 555-0100"] },
        { recordId: "jr", name: "Robert King Jr", source: "outlook", emails: [], phones: ["415-555-0100"] },
      ],
      ["jr", "sr"],
    );
  });

  it("a shared email with INCOMPATIBLE names: the backend keeps BOTH", async () => {
    // REVERSED BY BACKLOG-2531, deliberately, with the founder's agreement.
    //
    // This used to assert ONE, on the stated grounds that "email is a strong
    // identity signal and is deliberately NOT name-gated". That sentence is the
    // defect, written down as a decision.
    //
    // An address is shared exactly as an office line is — a married couple on
    // one `home@`, an assistant's address on their manager's card, two agents
    // at one brokerage. Margaret Chen and Margaret Torres are two people, and
    // the phone rule two tests up has said so since BACKLOG-2416. The email
    // rule now says it too: ONE rule, not a strict one and a blind one.
    //
    // What it cost while it stood: the second person never reached the picker,
    // so they could never be imported, so their correspondence landed on the
    // first person's contact — and on a transaction under audit that is one
    // person's mail inside another person's compliance record. Silent.
    await assertOneRuleDecides(
      [
        { recordId: "a", name: "Margaret Chen", source: "macos", emails: ["office@brokerage.com"], phones: [] },
        { recordId: "b", name: "Margaret Torres", source: "outlook", emails: ["office@brokerage.com"], phones: [] },
      ],
      ["a", "b"],
    );
  });

  /**
   * RE-POINTED BY BACKLOG-2556 — was "the backend still keeps ONE", `["a"]`.
   *
   * Its old comment read: *"Removing the collapse entirely would pass the test
   * above and be wrong."* The founder decided otherwise on 2026-08-09, having
   * watched this exact branch hide Elena Marsh-Okonkwo under Elena Marsh on a
   * shared address — two different surnames, no user decision anywhere, and the
   * hidden record unreachable rather than merely mislabelled.
   *
   * This is the branch the founder's Elena case runs through, and it is the one
   * `contact-handlers.foldDeleted-2556.test.ts` control 1 reddens on revert.
   */
  it("a shared email with COMPATIBLE names: the backend keeps BOTH [BACKLOG-2556]", async () => {
    await assertOneRuleDecides(
      [
        { recordId: "a", name: "Margaret Chen", source: "macos", emails: ["office@brokerage.com"], phones: [] },
        { recordId: "b", name: "Margaret C.", source: "outlook", emails: ["office@brokerage.com"], phones: [] },
      ],
      ["a", "b"],
    );
  });

  it("no shared identifier at all: the backend keeps BOTH", async () => {
    await assertOneRuleDecides(
      [
        { recordId: "a", name: "Jane Seller", source: "outlook", emails: ["jane@realty.com"], phones: [] },
        { recordId: "b", name: "Jane Seller", source: "macos", emails: [], phones: ["(415) 555-0109"] },
      ],
      ["a", "b"],
    );
  });
});

// ===========================================================================
describe("BACKLOG-2370 — the name-only question, answered", () => {
  /**
   * ✅ RESOLVED. This described a real divergence, deliberately left as an open
   * question:
   *
   *   BACKEND  keeps both. `findDuplicateOwner` has no name-only branch;
   *            BACKLOG-2316 removed name matching outright because it hid
   *            distinct people who share a name (the two Margarets).
   *   RENDERER kept one, on the reasoning that a name is a last-resort identity
   *            when there is nothing else.
   *
   * BACKLOG-2370 answered it by removing the renderer's rule entirely, so the
   * backend's reading is now the only one. That is the same reading BACKLOG-2316
   * arrived at from field data, and it is the safer one HERE for a reason
   * specific to what these records are: a name-only address-book card has a
   * source pill and an id the user can select and assign, so hiding it removes a
   * REACHABLE record — while showing two cards that turn out to be one person
   * costs a duplicate row the user can see and act on.
   */
  it("name-only records: BOTH kept, by the backend, and the renderer hides neither", async () => {
    const records: Record[] = [
      { recordId: "nm-out", name: "Name Only", source: "outlook", emails: [], phones: [] },
      { recordId: "nm-mac", name: "Name Only", source: "macos", emails: [], phones: [] },
    ];

    // Was: backend ["nm-mac", "nm-out"], renderer ["nm-out"].
    await assertOneRuleDecides(records, ["nm-mac", "nm-out"]);
  });

  /**
   * REMOVED by BACKLOG-2515 — its subject was deleted, and re-pointing it would
   * assert something false.
   *
   * It read `ImportContactsModal.tsx` off disk and asserted the file did not
   * mention `contactPickerList`, on the grounds that "the only component that
   * reaches `contacts:import`" applied no renderer dedup. That component is
   * gone: it was rendered only by `ContactSelectModal`, which no user could
   * reach.
   *
   * The live import surface is now `Contacts.tsx`, and it DOES use
   * `contactPickerList` — legitimately, for display. So the old assertion is
   * not merely orphaned, it is now WRONG about the surface it would be
   * re-pointed at, and a mechanical re-point would have produced a green test
   * making a false claim.
   *
   * What it was protecting — that wiring the picker list into the import path
   * stays a deliberate choice — is not lost: BACKLOG-2370 deleted the renderer
   * dedup outright, so there is no longer a second rule to accidentally apply.
   *
   * Note also that a `readFileSync` on a source path is invisible to `tsc` and
   * to every import-graph check. This one only surfaced because the suite was
   * RUN. It is the deletion-sweep case that no static gate can catch.
   */
});
