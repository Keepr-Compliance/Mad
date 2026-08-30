/**
 * @jest-environment node
 *
 * BACKLOG-2986 — THE ANDROID CONTACT **WRITE** GATE.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * `androidContacts` used to gate exactly one thing: whether `android_sync` rows
 * were offered in the picker (`contactHandlers.ts:1252` computes it, `:1596`
 * applies it). It gated NOTHING on the write path. `storeContacts` ended with an
 * unconditional `this.promoteToMainContacts(...)`, and that method reads no
 * preference at all — there was no `isContactSourceEnabled` call anywhere in
 * `localSyncService.ts`.
 *
 * So a user who switched Android contacts OFF watched them vanish from the
 * picker while the next sync kept writing new ones straight into their main
 * `contacts` table. From the founder's own session log:
 *
 *     Promoted 26 Android contacts to main contacts table (363 already existed)
 *
 * 26 real rows, created without the user importing anything. Founder,
 * 2026-08-30: *"contacts aren't auto imported."* A control that does not control
 * the thing it names is the defect BACKLOG-2986 exists to fix — not a smaller
 * version of the feature.
 *
 * ===========================================================================
 * THIS SUITE ASSERTS AGAINST THE `contacts` TABLE, NOT THE PICKER
 * ===========================================================================
 * A control that checked what the picker returns would have passed on the
 * broken behaviour: the picker was already gated. The question is what LANDS,
 * so `createContactsBatch` and `findContactByNormalizedPhone` are the REAL
 * implementations from `db/contactDbService` running against a real in-memory
 * SQLite, and every assertion reads rows back off that database. Same harness
 * shape as `localSyncService.promoteTwice-2987.test.ts`.
 *
 * ===========================================================================
 * AND IT ASSERTS THE STORE IS **LOSSLESS**, WHICH IS HALF THE POINT
 * ===========================================================================
 * The gate skips the PROMOTION only. The shadow-table write runs whatever the
 * preference says, and `W-C1` pins that with an exact `external_record_id` set.
 *
 * That asymmetry is the DECISION on BACKLOG-3001, not a convenience. The iPhone
 * write gate (`iPhoneSyncStorageService.ts:606`) skips the whole store, and it
 * is right to: iPhone contacts are desktop-PULLED and can be read off the backup
 * again. Android contacts are phone-PUSHED and the companion sends a DIFF
 * (BACKLOG-2411), so a record the desktop declines to store is one it can never
 * ask for again. Without the losslessness assertion, "gated promotion" and
 * "gated everything" are indistinguishable — and the second one is data loss.
 *
 * ===========================================================================
 * WHAT IS AND IS NOT MOCKED
 * ===========================================================================
 * `preferenceHelper` is **NOT** mocked. `supabaseService.getPreferences` is, one
 * level further out — because half this matrix is about what an ABSENT key
 * means, and a mocked `isContactSourceEnabled` would answer that question with
 * whatever the test asked for instead of with the real derived rule. Same
 * arrangement as `iPhoneSyncStorageService.sourceGate.test.ts`.
 *
 * `process.platform` is deliberately NOT stubbed: unlike the `iphoneContacts`
 * arm, the `androidContacts` arm of `isContactSourceOnByDefault` reads only the
 * phone type (`return isAndroid`), so these verdicts are identical on a macOS
 * and a Windows runner. `W-C6` pins that, so a future platform clause cannot be
 * added without a test noticing.
 *
 * FIXTURES ARE INVENTED. Names are placeholders, numbers are inside the
 * reserved-for-fiction `+1 555 01xx` range, addresses use `example.test`.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 \
 *     electron/services/__tests__/localSyncService.writeGate-2986.test.ts
 */

import { openTestDb, type TestDb } from "./helpers/syncSqliteDriver";
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";

let mockDb: TestDb | null = null;

/**
 * The preferences bag `isContactSourceEnabled` reads. Controlled per case; a
 * rejection models "preferences could not be READ AT ALL", which is a different
 * state from "the key is absent" and must produce a different answer.
 */
const mockGetPreferences = jest.fn();

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../contactsService", () => ({ getContactNames: () => new Map() }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: () => false,
}));

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({ auth: { getUser: jest.fn() } }),
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
  },
}));

// The shadow-table write is mocked so its ARGUMENTS can be read back — that is
// what proves the store stayed lossless while the promotion was skipped.
jest.mock("../db/externalContactDbService", () => ({
  __esModule: true,
  syncContactsBySource: jest.fn(() => ({ inserted: 0, updated: 0, deleted: 0, total: 0 })),
  upsertExternalContacts: jest.fn(() => 0),
  markSourceRecordsCurrent: jest.fn(() => 0),
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
  getCount: jest.fn(() => 0),
}));

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    findContactByNormalizedPhone: (userId: string, normalized: string) =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../db/contactDbService").findContactByNormalizedPhone(userId, normalized),
    createContactsBatch: (rows: unknown[]) =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../db/contactDbService").createContactsBatch(rows),
  },
}));

import localSyncService from "../localSyncService";
import * as externalContactDb from "../db/externalContactDbService";
import type { SyncContact } from "../../types/localSync";

type StoreContacts = (
  userId: string,
  deviceId: string,
  contacts: SyncContact[],
  isFullSync?: boolean,
) => Promise<number>;

const storeContacts = (
  localSyncService as unknown as { storeContacts: StoreContacts }
).storeContacts.bind(localSyncService);

const USER = "user-2986";
// pii-allow-uuid: a hand-written placeholder device id, not a real record — the digits are a visible pattern, never generated
const DEVICE = "22222222-3333-4444-8555-666666666666";

/**
 * FIXTURE PROVENANCE: the three shapes `promoteToMainContacts` treats
 * differently, transcribed from `localSyncService.promoteTwice-2987.test.ts`
 * so the two suites agree about what an Android address book looks like. Every
 * value invented.
 */
const ADDRESS_BOOK: SyncContact[] = [
  {
    id: "phone-and-email",
    displayName: "Gate Fixture One",
    phones: [{ number: "+15550111" + "1" }],
    emails: [{ address: "gate-one@example.test" }],
  },
  {
    id: "email-only",
    displayName: "Gate Fixture Two",
    phones: [],
    emails: [{ address: "gate-two@example.test" }],
  },
  {
    id: "short-code-only",
    displayName: "24680",
    phones: [{ number: "24680" }],
    emails: [],
  },
];

/**
 * Every display name in the MAIN contacts table — an exact set, never a count.
 * Scoped by user so a case can use a fresh one instead of deleting rows: a
 * DELETE would also take the BACKLOG-2987 crosswalk claims with it via their
 * FK, and a later assertion would then be resting on a cascade nobody asserted.
 */
function contactNamesOnDisk(userId: string = USER): string[] {
  return (
    mockDb!
      .prepare("SELECT display_name FROM contacts WHERE user_id = ? ORDER BY display_name")
      .all(userId) as Array<{ display_name: string }>
  ).map((r) => r.display_name);
}

/**
 * Every `external_record_id` handed to the shadow-table write, across all calls.
 * The losslessness assertion reads this.
 */
function shadowRecordIds(): string[] {
  const calls = (externalContactDb.syncContactsBySource as jest.Mock).mock.calls;
  return calls
    .flatMap((call) => call[2] as Array<{ external_record_id: string }>)
    .map((r) => r.external_record_id)
    .sort();
}

/** The bag onboarding actually writes: only the keys it decided, nothing else. */
function prefs(direct: Record<string, boolean>, phoneType?: string) {
  return {
    ...(phoneType ? { phone_type: phoneType } : {}),
    contactSources: { direct },
  };
}

const ALL_NAMES = ["24680", "Gate Fixture One", "Gate Fixture Two"];

beforeEach(() => {
  mockDb = openTestDb(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  jest.clearAllMocks();
  (externalContactDb.syncContactsBySource as jest.Mock).mockReturnValue({
    inserted: 0,
    updated: 0,
    deleted: 0,
    total: 0,
  });
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("BACKLOG-2986 — androidContacts gates what lands in the contacts table", () => {
  /**
   * W-C1. THE ONE THE ITEM CAME BACK FOR. Red before this change: the founder's
   * 26 were created on every sync regardless of the switch.
   */
  it("writes NOTHING to the contacts table when the source is switched off", async () => {
    mockGetPreferences.mockResolvedValue(prefs({ androidContacts: false }, "android"));

    await storeContacts(USER, DEVICE, ADDRESS_BOOK, true);

    expect(contactNamesOnDisk()).toEqual([]);
  });

  /**
   * W-C1b. THE OTHER HALF, and it is not optional. Skipping the SHADOW write
   * too would also leave the contacts table empty and pass the assertion above
   * — while destroying records only the phone holds (BACKLOG-3001: Android is
   * push-only and the companion sends a diff). The exact record set, not a
   * count: "3 records stored" cannot tell you it stored the wrong three.
   */
  it("still stores every pushed record in external_contacts — the phone holds the only copy", async () => {
    mockGetPreferences.mockResolvedValue(prefs({ androidContacts: false }, "android"));

    await storeContacts(USER, DEVICE, ADDRESS_BOOK, true);

    expect(shadowRecordIds()).toEqual([
      `android-${DEVICE}-email-only`,
      `android-${DEVICE}-phone-and-email`,
      `android-${DEVICE}-short-code-only`,
    ]);
  });

  it("promotes every contact when the source is switched on", async () => {
    mockGetPreferences.mockResolvedValue(prefs({ androidContacts: true }, "android"));

    await storeContacts(USER, DEVICE, ADDRESS_BOOK, true);

    expect(contactNamesOnDisk()).toEqual(ALL_NAMES);
  });
});

describe("BACKLOG-2986 — the write path reads the SAME derived default as the picker", () => {
  /**
   * W-C3. The state nearly every user is in: onboarding writes
   * `androidContacts` only for a declared-Android user, so for everyone else the
   * key is absent — and absent now derives OFF. The picker and this path must
   * reach that verdict by the same route, or the switch means one thing on one
   * screen and another in the database.
   */
  it("writes nothing when the key is ABSENT and no Android phone was declared", async () => {
    mockGetPreferences.mockResolvedValue(prefs({ macosContacts: true }, "iphone"));

    await storeContacts(USER, DEVICE, ADDRESS_BOOK, true);

    expect(contactNamesOnDisk()).toEqual([]);
  });

  it("writes nothing when the key is ABSENT and no phone type was recorded either", async () => {
    mockGetPreferences.mockResolvedValue({});

    await storeContacts(USER, DEVICE, ADDRESS_BOOK, true);

    expect(contactNamesOnDisk()).toEqual([]);
  });

  /**
   * W-C4. Not a hole in "default OFF" — the companion is this user's only
   * address book, and it is the card onboarding would have pre-ticked.
   */
  it("promotes when the key is ABSENT but an Android phone was declared", async () => {
    mockGetPreferences.mockResolvedValue(prefs({ googleContacts: true }, "android"));

    await storeContacts(USER, DEVICE, ADDRESS_BOOK, true);

    expect(contactNamesOnDisk()).toEqual(ALL_NAMES);
  });

  /**
   * W-C5. A DIFFERENT STATE FROM "absent", and it must get a different answer.
   * A failed read cannot see `phone_type` either, so deriving would be guessing
   * — and guessing OFF would silently stop a working import on a network blip.
   * The picker gate passes the same `defaultValue: true`, so both fail open
   * together and can never disagree about a user who is offline.
   */
  it("fails OPEN and promotes when preferences cannot be read at all", async () => {
    mockGetPreferences.mockRejectedValue(new Error("offline"));

    await storeContacts(USER, DEVICE, ADDRESS_BOOK, true);

    expect(contactNamesOnDisk()).toEqual(ALL_NAMES);
  });

  /**
   * W-C6. The `androidContacts` arm of the rule reads the phone type and
   * nothing else, so no `process.platform` stub appears anywhere above. Pinned
   * rather than assumed: a platform clause added later would make every verdict
   * in this file depend on which runner CI happened to use, and nothing else
   * here would notice.
   */
  it("reaches the same verdict on either desktop — the rule reads the phone, not the platform", async () => {
    const realPlatform = process.platform;
    try {
      for (const platform of ["darwin", "win32"] as NodeJS.Platform[]) {
        Object.defineProperty(process, "platform", { value: platform, configurable: true });

        // A fresh user per case rather than a DELETE — see contactNamesOnDisk.
        const offUser = `${USER}-off-${platform}`;
        mockGetPreferences.mockResolvedValue(prefs({ macosContacts: true }, "iphone"));
        await storeContacts(offUser, DEVICE, ADDRESS_BOOK, true);
        expect(contactNamesOnDisk(offUser)).toEqual([]);

        const onUser = `${USER}-on-${platform}`;
        mockGetPreferences.mockResolvedValue(prefs({}, "android"));
        await storeContacts(onUser, DEVICE, ADDRESS_BOOK, true);
        expect(contactNamesOnDisk(onUser)).toEqual(ALL_NAMES);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    }
  });
});
