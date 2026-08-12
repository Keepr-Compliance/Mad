/**
 * BACKLOG-2486 — the iPhone contact WRITE gate answers to `iphoneContacts` alone.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * `iPhoneSyncStorageService.storeContacts` used to read
 * `!iphoneEnabled && !macosEnabled` — "check both keys for compatibility". On a
 * Mac `macosContacts` is on for essentially every user, so the second clause was
 * always false and turning iPhone Contacts OFF stored the contacts anyway.
 *
 * The SR review of PR #2201 drove this exact function and recorded the result:
 *
 *   | Stored preferences            | Contacts written        |
 *   | iphone:true,  macos:true      | 3 — recordIds 1,2,3     |
 *   | iphone:FALSE, macos:true      | 3 — BYTE-IDENTICAL      |
 *   | iphone:false, macos:false     | 0 — control             |
 *
 * Row 2 is what this suite makes impossible to reintroduce.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT MOCKED
 * ---------------------------------------------------------------------------
 * The REAL `persistSyncResult` runs, calling the REAL private `storeContacts`
 * and therefore the real gate. Same harness shape as
 * `iPhoneSyncStorageService.rollback.test.ts`.
 *
 * `preferenceHelper` is NOT mocked — `supabaseService.getPreferences` is, one
 * level further out. Half the matrix below is about what an ABSENT key means,
 * and a mocked `isContactSourceEnabled` would answer that question with whatever
 * the test asked for. `process.platform` is overridden per case because the
 * derived-default rule reads it (`preferenceHelper.ts:66`).
 *
 * Assertions are on the exact `recordId` SET handed to `upsertFromiPhone`, never
 * on a count — "2 contacts stored" cannot tell you it stored the wrong two.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

if (typeof globalThis.setImmediate === "undefined") {
  (globalThis as unknown as Record<string, unknown>).setImmediate = (fn: () => void) =>
    setTimeout(fn, 0);
}

jest.mock("electron", () => ({
  app: { getPath: jest.fn().mockReturnValue("/mock/userData") },
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    promises: {
      unlink: jest.fn().mockResolvedValue(undefined),
      mkdir: jest.fn().mockResolvedValue(undefined),
      stat: jest.fn().mockResolvedValue({ size: 1024 }),
      copyFile: jest.fn().mockResolvedValue(undefined),
    },
    createReadStream: jest.fn(),
  };
});

jest.mock("../databaseService");
jest.mock("../db/externalContactDbService");
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: { resolveAttachmentPath: jest.fn() },
}));
jest.mock("../../utils/messageTypeDetector", () => ({
  detectMessageType: jest.fn().mockReturnValue("text"),
}));

// THE ONLY PREFERENCE MOCK. `preferenceHelper` runs for real.
let mockPreferences: Record<string, any> = {};
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: jest.fn(() => Promise.resolve(mockPreferences)) },
}));

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import * as externalContactDb from "../db/externalContactDbService";
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import type { SyncResult } from "../deviceSyncOrchestrator";
import type { iOSContact } from "../../types/iosContacts";

const mockExternalContactDb = externalContactDb as jest.Mocked<typeof externalContactDb>;

const USER = "550e8400-e29b-41d4-a716-446655440000";

/**
 * An iPhone contact as the backup parser yields it.
 * `id` is `ABPerson.ROWID`, which `storeContacts` stringifies into `recordId`
 * (`iPhoneSyncStorageService.ts:608`).
 */
function iosContact(id: number, displayName: string, email: string, phone: string): iOSContact {
  return {
    id,
    displayName,
    organization: null,
    phoneNumbers: [{ normalizedNumber: phone, label: "mobile" }],
    emails: [{ email, label: "home" }],
    externalUuid: null,
    externalIdentifier: null,
    externalModificationTag: null,
    modifiedAt: null,
    createdAt: null,
    storeId: null,
  } as unknown as iOSContact;
}

const CONTACTS: iOSContact[] = [
  iosContact(101, "Ana Whitfield", "ana@example.com", "+15550101"),
  iosContact(102, "Ben Carrow", "ben@example.com", "+15550102"),
  iosContact(103, "Cleo Marsh", "cleo@example.com", "+15550103"),
];

/** Every recordId actually handed to the writer. Identity, never a count. */
function storedRecordIds(): string[] {
  const calls = mockExternalContactDb.upsertFromiPhone.mock.calls;
  if (calls.length === 0) return [];
  return calls
    .flatMap((call) => (call[1] as Array<{ recordId: string }>) ?? [])
    .map((c) => c.recordId)
    .sort();
}

function prefs(direct: Record<string, boolean>, phoneType = "iphone"): Record<string, any> {
  return { phone_type: phoneType, contactSources: { direct } };
}

const realPlatform = process.platform;
function setPlatform(platform: "darwin" | "win32"): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

async function runSync(): Promise<void> {
  const syncResult: SyncResult = {
    success: true,
    messages: [],
    contacts: CONTACTS,
    conversations: [],
    error: null,
    duration: 100,
  } as unknown as SyncResult;
  await iPhoneSyncStorageService.persistSyncResult(USER, syncResult, "/mock/backup");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPreferences = {};
  mockExternalContactDb.upsertFromiPhone.mockReturnValue(CONTACTS.length);
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

// ===========================================================================
// THE MATRIX — swept, not sampled.
//
// Expectations are literal id sets. `ALL` is the full corpus; `[]` means the
// gate suppressed the write entirely.
// ===========================================================================

const ALL = ["101", "102", "103"];

type Cell = {
  platform: "darwin" | "win32";
  iphone?: boolean;
  macos?: boolean;
  expected: string[];
};

const MATRIX: Cell[] = [
  // ---- macOS ------------------------------------------------------------
  { platform: "darwin", iphone: true, macos: true, expected: ALL },
  { platform: "darwin", iphone: true, macos: false, expected: ALL },
  // THE ROW THE SR REVIEW CAUGHT. Before the fix this stored all three.
  { platform: "darwin", iphone: false, macos: true, expected: [] },
  { platform: "darwin", iphone: false, macos: false, expected: [] },
  // Absent iPhone on macOS derives FALSE (BACKLOG-2479).
  { platform: "darwin", macos: true, expected: [] },
  { platform: "darwin", macos: false, expected: [] },
  { platform: "darwin", iphone: true, expected: ALL },
  { platform: "darwin", iphone: false, expected: [] },
  { platform: "darwin", expected: [] },

  // ---- Windows ----------------------------------------------------------
  { platform: "win32", iphone: true, macos: true, expected: ALL },
  { platform: "win32", iphone: true, macos: false, expected: ALL },
  { platform: "win32", iphone: false, macos: true, expected: [] },
  { platform: "win32", iphone: false, macos: false, expected: [] },
  // Absent iPhone on Windows derives TRUE. This is the population commit
  // `c774e198` added the OR for; the derived default now covers them.
  { platform: "win32", macos: true, expected: ALL },
  { platform: "win32", macos: false, expected: ALL },
  { platform: "win32", iphone: true, expected: ALL },
  { platform: "win32", iphone: false, expected: [] },
  { platform: "win32", expected: ALL },
];

describe("BACKLOG-2486 — iPhone contact storage obeys iphoneContacts alone", () => {
  for (const cell of MATRIX) {
    const label =
      `${cell.platform}: iphoneContacts=${cell.iphone ?? "ABSENT"}, ` +
      `macosContacts=${cell.macos ?? "ABSENT"}`;

    it(label, async () => {
      setPlatform(cell.platform);
      const direct: Record<string, boolean> = {};
      if (cell.iphone !== undefined) direct.iphoneContacts = cell.iphone;
      if (cell.macos !== undefined) direct.macosContacts = cell.macos;
      mockPreferences = prefs(direct);

      await runSync();

      expect(storedRecordIds()).toEqual(cell.expected);
    });
  }
});

// ===========================================================================
describe("BACKLOG-2486 — the read-failure path still fails OPEN", () => {
  /**
   * The third outcome of `isContactSourceEnabled`. When preferences cannot be
   * read at all, `phone_type` is invisible too, so applying the derived rule
   * would be guessing — and guessing OFF silently breaks a working sync the user
   * just asked for. It must fall back to `defaultValue` (true).
   *
   * Without this case, replacing the `catch` fallback with the derived rule
   * would pass every other test in this file on macOS.
   */
  it("stores every contact when the preference store throws, even on macOS", async () => {
    setPlatform("darwin");
    const supabaseService = jest.requireMock("../supabaseService").default;
    supabaseService.getPreferences.mockRejectedValue(new Error("offline"));

    await runSync();

    expect(storedRecordIds()).toEqual(ALL);
  });
});
