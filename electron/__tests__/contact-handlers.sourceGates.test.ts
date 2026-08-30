/**
 * @jest-environment node
 *
 * BACKLOG-2486 — each contact source answers to its OWN preference.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 * Three gates used to OR `iphoneContacts` with `macosContacts`. On a Mac
 * `macosContacts` is on for essentially every user, so the second clause decided
 * every case and unticking iPhone Contacts suppressed NOTHING.
 *
 * The founder's bar is symmetrical: what he picks arrives, what he does not pick
 * does not. So the assertion is not "iPhone can be turned off" — it is that EVERY
 * source responds to its own key and to no other key.
 *
 * ---------------------------------------------------------------------------
 * WHY `preferenceHelper` IS **NOT** MOCKED — this is the point of the suite
 * ---------------------------------------------------------------------------
 * Every other contact-handler suite mocks `isContactSourceEnabled` to return a
 * boolean. That is fine when the preference value is an input, and useless here,
 * because HALF THIS MATRIX IS ABOUT WHAT AN ABSENT KEY MEANS. A mocked
 * `isContactSourceEnabled` would answer that question with whatever the test
 * asked for, and the test would be asserting its own mock.
 *
 * So the real `preferenceHelper` runs, and only `supabaseService.getPreferences`
 * is mocked — one level further out, at the actual I/O boundary. That makes the
 * derived-default rule (`contactSourceDefaults.isContactSourceOnByDefault`) part
 * of what is under test, which it must be: `iphoneContacts` is the only key in
 * BACKEND_DERIVED_DEFAULT_KEYS. BACKLOG-2986 added `androidContacts` to that
 * list, so those two are the keys whose absent value is not simply `true`.
 *
 * `process.platform` is overridden per case because the derived rule reads it
 * (`preferenceHelper.ts:66`).
 *
 * ---------------------------------------------------------------------------
 * FIXTURE PROVENANCE
 * ---------------------------------------------------------------------------
 * The preference bag shape is transcribed from its real producer, not invented.
 * `ContactSourceStep.buildDirectContactSourcePrefs` (`ContactSourceStep.tsx:219-230`)
 * writes ONLY the visible, non-comingSoon keys, under
 * `{ contactSources: { direct: {...} } }` — see `:446-450` (Continue) and
 * `:262-267` (Skip). `getPreferences` returns that bag raw
 * (`supabaseService.ts:1176-1192`).
 *
 * That is why the "absent" column of this matrix is a REAL state and not a
 * hypothetical: on macOS + iPhone + Microsoft SSO the step writes
 * `{ macosContacts, iphoneContacts, outlookContacts }` and leaves
 * `googleContacts` / `androidContacts` genuinely absent.
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

// THE ONLY PREFERENCE MOCK. `preferenceHelper` itself runs for real.
let mockPreferences: Record<string, any> = {};
jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getPreferences: jest.fn(() => Promise.resolve(mockPreferences)),
  },
}));

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

const mockGetContactNames = jest.fn(() =>
  Promise.resolve({ phoneToContactInfo: {}, contacts: [], status: { loaded: true } }),
);
jest.mock("../services/contactsService", () => ({
  __esModule: true,
  getContactNames: (...args: unknown[]) => (mockGetContactNames as any)(...args),
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logContactAction: jest.fn() },
}));

jest.mock("../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), fetchContacts: jest.fn() },
}));

const mockFullSync = jest.fn();
jest.mock("../services/db/externalContactDbService", () => ({
  __esModule: true,
  getCount: jest.fn(() => mockShadowRows.length),
  getAllForUser: jest.fn(() => mockShadowRows),
  getAllForUserAsync: jest.fn(() => Promise.resolve(mockShadowRows)),
  isStale: jest.fn(() => false),
  fullSync: (...args: unknown[]) => (mockFullSync as any)(...args),
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

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

// ---------------------------------------------------------------------------
// CORPUS — one distinct person per source, no shared identifiers.
//
// Distinct on purpose. If the same person appeared in two sources the picker's
// dedup would collapse them and a suppressed record would be indistinguishable
// from an absorbed one — the gate under test would not be the thing deciding the
// answer. The same-person case is a separate test at the bottom, where it is the
// subject rather than a confound.
// ---------------------------------------------------------------------------

function shadowRow(
  recordId: string,
  name: string,
  source: string,
  email: string,
  phone: string,
) {
  return {
    id: `ext-${recordId}`,
    user_id: USER,
    name,
    phones: [phone],
    emails: [email],
    company: null,
    source,
    external_record_id: recordId,
    external_uuid: null,
    last_message_at: null,
    synced_at: "2026-08-05T00:00:00.000Z",
  };
}

const IPHONE_ROW = shadowRow("rec-iphone", "Ana Whitfield", "iphone", "ana@example.com", "+15550101");
const MACOS_ROW = shadowRow("rec-macos", "Ben Carrow", "macos", "ben@example.com", "+15550102");
const OUTLOOK_ROW = shadowRow("rec-outlook", "Cleo Marsh", "outlook", "cleo@example.com", "+15550103");
const ANDROID_ROW = shadowRow("rec-android", "Dev Ranjan", "android_sync", "dev@example.com", "+15550104");

const ALL_ROWS = [IPHONE_ROW, MACOS_ROW, OUTLOOK_ROW, ANDROID_ROW];

const IPHONE_ID = "ext-rec-iphone";
const MACOS_ID = "ext-rec-macos";
const OUTLOOK_ID = "ext-rec-outlook";
const ANDROID_ID = "ext-rec-android";

/** The EXACT set of records the picker offered. Identity, never a count. */
async function pickerIds(): Promise<string[]> {
  const handler = registeredHandlers.get("contacts:get-available");
  const result = await handler(mockEvent, USER);
  expect(result.success).toBe(true);
  return (result.contacts as Array<{ id: string }>).map((c) => c.id).sort();
}

/** Build the preference bag exactly as onboarding writes it: absent means absent. */
function prefs(direct: Record<string, boolean>, phoneType?: string): Record<string, any> {
  return {
    ...(phoneType ? { phone_type: phoneType } : {}),
    contactSources: { direct },
  };
}

const realPlatform = process.platform;
function setPlatform(platform: "darwin" | "win32"): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockShadowRows = [...ALL_ROWS];
  mockPreferences = {};
  mockFullSync.mockClear();
  mockGetContactNames.mockClear();
  registeredHandlers.clear();
  registerContactHandlers({} as any);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

// ===========================================================================
// THE MATRIX — swept, not sampled.
//
// `iphoneContacts` x `macosContacts` over {true, false, ABSENT} x
// {darwin, win32} = 18 points. Expectations are written out as literal id sets
// rather than derived from the rule, so that a bug in the rule cannot also
// produce the expectation that hides it.
//
// Outlook and Android are the CONTROLS: no combination of the iPhone and macOS
// preferences may move either one.
//
// BACKLOG-2986 flipped Android's constant from "in every set" to "in none", and
// the control is unchanged by that. Every bag below carries `phone_type:
// "iphone"` with `androidContacts` ABSENT — the state onboarding actually
// leaves an iPhone user in — and an absent `androidContacts` now DERIVES FALSE
// rather than falling to the blanket `true` the caller passes. What the control
// still asserts is the thing that matters: Android's presence does not move when
// the iPhone or macOS preference moves. Its own key is swept separately below.
// ===========================================================================

type Cell = {
  platform: "darwin" | "win32";
  iphone?: boolean;
  macos?: boolean;
  expected: string[];
};

const MATRIX: Cell[] = [
  // ---- macOS ------------------------------------------------------------
  // Stored iPhone value wins in every row where it is present.
  { platform: "darwin", iphone: true, macos: true, expected: [IPHONE_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "darwin", iphone: true, macos: false, expected: [IPHONE_ID, OUTLOOK_ID] },
  // THE FOUNDER'S CASE. Before the fix this row was identical to the one above
  // it: `macosEnabled` answered for iPhone and the record came through anyway.
  { platform: "darwin", iphone: false, macos: true, expected: [MACOS_ID, OUTLOOK_ID] },
  { platform: "darwin", iphone: false, macos: false, expected: [OUTLOOK_ID] },
  // Absent iPhone on macOS DERIVES false (BACKLOG-2479: the Mac address book
  // already carries the iPhone's contacts via iCloud).
  { platform: "darwin", macos: true, expected: [MACOS_ID, OUTLOOK_ID] },
  { platform: "darwin", macos: false, expected: [OUTLOOK_ID] },
  // Absent macOS fails OPEN on true — it is NOT in BACKEND_DERIVED_DEFAULT_KEYS.
  { platform: "darwin", iphone: true, expected: [IPHONE_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "darwin", iphone: false, expected: [MACOS_ID, OUTLOOK_ID] },
  // Both absent: iPhone derives false, macOS fails open true.
  { platform: "darwin", expected: [MACOS_ID, OUTLOOK_ID] },

  // ---- Windows ----------------------------------------------------------
  // No macOS address book exists here, but the preference is still readable.
  { platform: "win32", iphone: true, macos: true, expected: [IPHONE_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", iphone: true, macos: false, expected: [IPHONE_ID, OUTLOOK_ID] },
  { platform: "win32", iphone: false, macos: true, expected: [MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", iphone: false, macos: false, expected: [OUTLOOK_ID] },
  // Absent iPhone on Windows DERIVES TRUE. This is the case commit `c774e198`
  // bolted the OR on to rescue; the derived default now covers it, which is what
  // makes removing the OR safe.
  { platform: "win32", macos: true, expected: [IPHONE_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", macos: false, expected: [IPHONE_ID, OUTLOOK_ID] },
  { platform: "win32", iphone: true, expected: [IPHONE_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", iphone: false, expected: [MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", expected: [IPHONE_ID, MACOS_ID, OUTLOOK_ID] },
];

describe("BACKLOG-2486 — the iPhone x macOS preference matrix", () => {
  for (const cell of MATRIX) {
    const label =
      `${cell.platform}: iphoneContacts=${cell.iphone ?? "ABSENT"}, ` +
      `macosContacts=${cell.macos ?? "ABSENT"}`;

    it(label, async () => {
      setPlatform(cell.platform);
      const direct: Record<string, boolean> = {};
      if (cell.iphone !== undefined) direct.iphoneContacts = cell.iphone;
      if (cell.macos !== undefined) direct.macosContacts = cell.macos;
      mockPreferences = prefs(direct, "iphone");

      expect(await pickerIds()).toEqual(cell.expected);
    });
  }
});

// ===========================================================================
describe("BACKLOG-2486 — the founder's case, one person in two sources", () => {
  /**
   * The Mac address book carries the iPhone's contacts via iCloud, so the SAME
   * person legitimately exists as two records. This is the corpus BACKLOG-2486
   * asks for: "test it as an exact identity set on a corpus where the same
   * person exists in both sources".
   *
   * Note what is asserted: with iPhone off, the surviving record is the MAC one,
   * by id. A count would have said "1 contact" for both the fixed and the broken
   * build — the broken build collapses the pair by shared email and also returns
   * one row. Only the id says WHICH one survived.
   */
  const SAME_PERSON_IPHONE = shadowRow(
    "rec-dual-iphone",
    "Ana Whitfield",
    "iphone",
    "ana@example.com",
    "+15550101",
  );
  const SAME_PERSON_MACOS = shadowRow(
    "rec-dual-macos",
    "Ana Whitfield",
    "macos",
    "ana@example.com",
    "+15550101",
  );

  beforeEach(() => {
    mockShadowRows = [SAME_PERSON_IPHONE, SAME_PERSON_MACOS];
    setPlatform("darwin");
  });

  it("offers the MAC record, not the iPhone one, when iPhone is off", async () => {
    mockPreferences = prefs({ iphoneContacts: false, macosContacts: true }, "iphone");
    expect(await pickerIds()).toEqual(["ext-rec-dual-macos"]);
  });

  it("offers the IPHONE record, not the Mac one, when macOS is off", async () => {
    mockPreferences = prefs({ iphoneContacts: true, macosContacts: false }, "iphone");
    expect(await pickerIds()).toEqual(["ext-rec-dual-iphone"]);
  });

  it("offers neither when both are off", async () => {
    mockPreferences = prefs({ iphoneContacts: false, macosContacts: false }, "iphone");
    expect(await pickerIds()).toEqual([]);
  });
});

// ===========================================================================
describe("BACKLOG-2486 — the macOS address-book READ is gated on macosContacts alone", () => {
  /**
   * STEP 2 of the picker reads the Mac address book and writes it to the shadow
   * table. Everything in that block is macOS data — `fullSync` deletes
   * `source='macos'` only — so `iphoneContacts` must not decide whether it runs.
   *
   * The read only fires when the shadow table is EMPTY (`getCount() === 0`),
   * which is why these cases seed no rows.
   */
  beforeEach(() => {
    mockShadowRows = [];
    setPlatform("darwin");
  });

  it("does NOT read the address book when only iPhone is enabled", async () => {
    mockPreferences = prefs({ iphoneContacts: true, macosContacts: false }, "iphone");
    await pickerIds();
    expect(mockGetContactNames).not.toHaveBeenCalled();
    expect(mockFullSync).not.toHaveBeenCalled();
  });

  it("reads the address book when macOS is enabled and iPhone is off", async () => {
    mockPreferences = prefs({ iphoneContacts: false, macosContacts: true }, "iphone");
    await pickerIds();
    expect(mockGetContactNames).toHaveBeenCalled();
  });

  it("does NOT read the address book when both are off", async () => {
    mockPreferences = prefs({ iphoneContacts: false, macosContacts: false }, "iphone");
    await pickerIds();
    expect(mockGetContactNames).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe("BACKLOG-2486 — a preference READ FAILURE still fails open", () => {
  /**
   * The third outcome of `isContactSourceEnabled`, and the one most easily lost
   * when splitting gates. When preferences cannot be read at all, `phone_type`
   * is not visible either, so the derived rule would be guessing — and guessing
   * OFF silently breaks a working import. It must fall back to the caller's
   * `defaultValue` (true), NOT to the derived default.
   *
   * Without this case, replacing the `catch` fallback with the derived rule
   * would pass every other test in this file.
   */
  it("shows every source when the preference store throws", async () => {
    setPlatform("darwin");
    const supabaseService = jest.requireMock("../services/supabaseService").default;
    supabaseService.getPreferences.mockRejectedValueOnce(new Error("offline"));
    supabaseService.getPreferences.mockRejectedValue(new Error("offline"));

    expect(await pickerIds()).toEqual([ANDROID_ID, IPHONE_ID, MACOS_ID, OUTLOOK_ID]);

    supabaseService.getPreferences.mockReset();
    supabaseService.getPreferences.mockImplementation(() => Promise.resolve(mockPreferences));
  });
});

// ===========================================================================
describe("BACKLOG-2477 — `messages.source` is not part of any contacts decision", () => {
  /**
   * `messages.source` is a RADIO BUTTON: `macos-native` OR `iphone-sync` OR
   * `android-companion`, exclusive by construction. Correct for text messages,
   * which come from one place. Contacts are CHECKBOXES and always have been.
   *
   * The main process has never consulted the field for a contacts decision — its
   * only reader anywhere in `electron/` is the support-ticket diagnostics payload
   * (`supportTicketService.ts:676`), which reports it and decides nothing. This
   * suite is what stops that starting: the picker's id set must be invariant
   * under the radio button.
   *
   * HONESTY ABOUT WHAT THIS IS: a REGRESSION GUARD, not a control for the
   * BACKLOG-2477 fix. That fix is in the renderer orchestrator, so these cases
   * are green on both sides of it. They were driven red on purpose by
   * temporarily adding a `messages.source` gate to `contactHandlers` — the diff
   * and its failure output are recorded in the PR.
   *
   * FIXTURE PROVENANCE: `{ messages: { source } }` sits alongside
   * `contactSources` in the same preference bag, written by
   * `usePhoneTypeApi.ts:188-191` at onboarding and by
   * `ImportSourceSettings.tsx:168-173` from the Settings radio. ABSENT is a real
   * state: every install predating the BACKLOG-2408 write has no such key.
   */
  const SOURCES = [undefined, "macos-native", "iphone-sync", "android-companion"];

  for (const source of SOURCES) {
    it(`offers the same id set with messages.source=${source ?? "ABSENT"}`, async () => {
      setPlatform("darwin");
      mockPreferences = {
        ...prefs({ iphoneContacts: true, macosContacts: true, outlookContacts: true }, "iphone"),
        ...(source ? { messages: { source } } : {}),
      };

      // BACKLOG-2986: Android is absent from this set because `androidContacts`
      // is absent from the bag and the bag says `phone_type: "iphone"` — it now
      // derives FALSE. That is orthogonal to what this suite asserts: the set is
      // the SAME for all four radio positions, which is the invariant.
      expect(await pickerIds()).toEqual([IPHONE_ID, MACOS_ID, OUTLOOK_ID]);
    });
  }

  it("still answers to the checkboxes while the radio button is set to iPhone", async () => {
    // The pairing of the two rules, in one case: the radio is on `iphone-sync`
    // and it is the CHECKBOX that removes the iPhone record, not the radio.
    setPlatform("darwin");
    mockPreferences = {
      ...prefs({ iphoneContacts: false, macosContacts: true, outlookContacts: true }, "iphone"),
      messages: { source: "iphone-sync" },
    };

    expect(await pickerIds()).toEqual([MACOS_ID, OUTLOOK_ID]);
  });
});

// ===========================================================================
// BACKLOG-2986 — `androidContacts` x declared phone type, swept.
//
// The matrix above holds Android still while iPhone and macOS move. This one
// does the opposite: it moves ONLY the Android key and the phone type the
// derived default reads, and pins the exact id set at every point.
//
// It exists because BACKLOG-2986 changed what an ABSENT `androidContacts` means.
// Before: the blanket `true` the caller passes, so Android contacts imported for
// essentially every user — onboarding writes this key ONLY for someone who
// declared an Android phone, so absent is where nearly everyone is, and there
// was no Settings control that could write it. Founder, 2026-08-30: "contacts
// aren't auto imported."
//
// FIXTURE PROVENANCE: `outlookContacts` is pinned true because onboarding writes
// it for every user; `macosContacts` and `iphoneContacts` are left ABSENT
// because for a declared-Android user onboarding genuinely never writes them
// (their cards carry `platforms: ["macos"]` / `phoneType: "iphone"`), and
// pinning them would be a bag no producer can emit. Expectations are literal id
// sets, not derived from the rule, so a bug in the rule cannot also write the
// expectation that hides it.
// ===========================================================================

type AndroidCell = {
  platform: "darwin" | "win32";
  phoneType?: "iphone" | "android";
  android?: boolean;
  expected: string[];
};

const ANDROID_MATRIX: AndroidCell[] = [
  // ---- macOS ------------------------------------------------------------
  // THE REPORTED CASE: iPhone declared, key absent. Was [ANDROID, MACOS,
  // OUTLOOK] before the fix — 389 Android contacts nobody asked for.
  { platform: "darwin", phoneType: "iphone", expected: [MACOS_ID, OUTLOOK_ID] },
  // A stored value always wins over the derived default, in both directions.
  { platform: "darwin", phoneType: "iphone", android: true, expected: [ANDROID_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "darwin", phoneType: "iphone", android: false, expected: [MACOS_ID, OUTLOOK_ID] },
  // Declared Android + absent key derives ON: the companion is this user's only
  // address book, and it is the card onboarding would have pre-ticked.
  { platform: "darwin", phoneType: "android", expected: [ANDROID_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "darwin", phoneType: "android", android: true, expected: [ANDROID_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "darwin", phoneType: "android", android: false, expected: [MACOS_ID, OUTLOOK_ID] },
  // No phone type recorded at all — an install predating the step. Absent reads
  // as "not an Android user", so OFF.
  { platform: "darwin", expected: [MACOS_ID, OUTLOOK_ID] },
  { platform: "darwin", android: true, expected: [ANDROID_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "darwin", android: false, expected: [MACOS_ID, OUTLOOK_ID] },

  // ---- Windows ----------------------------------------------------------
  // The Android answer is identical on Windows: the rule reads the PHONE, not
  // the desktop. (iPhone's presence differs, because an absent `iphoneContacts`
  // derives TRUE on Windows — BACKLOG-2486.)
  { platform: "win32", phoneType: "iphone", expected: [IPHONE_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", phoneType: "iphone", android: true, expected: [ANDROID_ID, IPHONE_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", phoneType: "iphone", android: false, expected: [IPHONE_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", phoneType: "android", expected: [ANDROID_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", phoneType: "android", android: true, expected: [ANDROID_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", phoneType: "android", android: false, expected: [MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", expected: [IPHONE_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", android: true, expected: [ANDROID_ID, IPHONE_ID, MACOS_ID, OUTLOOK_ID] },
  { platform: "win32", android: false, expected: [IPHONE_ID, MACOS_ID, OUTLOOK_ID] },
];

describe("BACKLOG-2986 — the androidContacts x phone-type matrix", () => {
  for (const cell of ANDROID_MATRIX) {
    const label =
      `${cell.platform}: androidContacts=${cell.android ?? "ABSENT"}, ` +
      `phone_type=${cell.phoneType ?? "ABSENT"}`;

    it(label, async () => {
      setPlatform(cell.platform);
      const direct: Record<string, boolean> = { outlookContacts: true };
      if (cell.android !== undefined) direct.androidContacts = cell.android;
      mockPreferences = prefs(direct, cell.phoneType);

      expect(await pickerIds()).toEqual(cell.expected);
    });
  }
});
