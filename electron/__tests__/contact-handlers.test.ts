/**
 * Unit tests for Contact Handlers
 * Tests contact IPC handlers including:
 * - CRUD operations
 * - Contact import
 * - Activity-based sorting
 * - Delete protection
 */

import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
  type RegisteredIpcHandler,
} from "../../tests/support/ipcHandlerRegistry";
import type { IpcMainInvokeEvent } from "electron";

// Mock electron module
const mockIpcHandle = jest.fn();
const mockWebContentsSend = jest.fn();

jest.mock("electron", () => ({
  ipcMain: {
    handle: mockIpcHandle,
  },
  BrowserWindow: jest.fn(),
  // BACKLOG-1977: contacts:get-available reads `app.isPackaged` for the
  // double-gated E2E isolation (`!app.isPackaged && KEEPR_E2E === '1'`).
  // isPackaged=false + KEEPR_E2E unset under Jest → gate falls through
  // (second condition false), so real handler behavior is preserved.
  app: { isPackaged: false },
}));

// Mock BrowserWindow instance for progress events
const mockMainWindow = {
  isDestroyed: jest.fn().mockReturnValue(false),
  webContents: {
    send: mockWebContentsSend,
  },
} as unknown as import("electron").BrowserWindow;

// Mock services - inline factories since jest.mock is hoisted
// Note: getUserById returns the user only for TEST_USER_ID, null for empty/invalid IDs
jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getImportedContactsByUserId: jest.fn(),
    getImportedContactsByUserIdAsync: jest.fn(),
    getUnimportedContactsByUserId: jest.fn(),
    getContactsSortedByActivity: jest.fn(),
    createContact: jest.fn(),
    createContactsBatch: jest.fn(),
    updateContact: jest.fn(),
    getContactById: jest.fn(),
    deleteContact: jest.fn(),
    removeContact: jest.fn(),
    getTransactionsByContact: jest.fn(),
    // BACKLOG-1933: contact-scoped comms
    getEmailsForContact: jest.fn(),
    getMessagesForContact: jest.fn(),
    markContactAsImported: jest.fn(),
    // getUserById returns user only for valid TEST_USER_ID
    getUserById: jest.fn().mockImplementation((id: string) => {
      if (id === '550e8400-e29b-41d4-a716-446655440000') {
        return Promise.resolve({ id });
      }
      return Promise.resolve(null);
    }),
    // getRawDatabase returns empty for invalid lookups
    getRawDatabase: jest.fn().mockReturnValue({
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(undefined), // No user found in fallback
      }),
    }),
    isInitialized: jest.fn().mockReturnValue(true),
    backfillContactEmails: jest.fn(),
    backfillContactPhones: jest.fn(),
    findContactByName: jest.fn(),
    searchContactsForSelection: jest.fn().mockReturnValue([]),
    getContactNamesByPhones: jest.fn().mockResolvedValue(new Map()),
    getLastMessageDatesForPhones: jest.fn().mockReturnValue(new Map()),
    backfillPhoneLastMessageTable: jest.fn().mockResolvedValue(0),
  },
}));

jest.mock("../services/contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(),
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: {
    log: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// TASK-1950: Mock preferenceHelper for contact source gating
const mockIsContactSourceEnabled = jest.fn().mockResolvedValue(true);
jest.mock("../utils/preferenceHelper", () => ({
  __esModule: true,
  isContactSourceEnabled: (...args: any[]) => mockIsContactSourceEnabled(...args),
}));

// TASK-1950: Mock outlookFetchService for syncOutlookContacts tests
jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: {
    initialize: jest.fn().mockResolvedValue(true),
    fetchContacts: jest.fn().mockResolvedValue({
      success: true,
      contacts: [],
    }),
  },
}));

// Mock syncOutlookContacts on externalContactDb (added after externalContactDbService mock)
// We'll add to the existing mock below

// TASK-1773: Mock external contact db service
// The shadow table starts empty, but fullSync populates it from macOS contacts
// We simulate this by having getAllForUser return contacts that match what fullSync stores
let mockExternalContacts: any[] = [];

jest.mock("../services/db/externalContactDbService", () => ({
  __esModule: true,
  getCount: jest.fn().mockImplementation(() => mockExternalContacts.length),
  getAllForUser: jest.fn().mockImplementation(() => mockExternalContacts),
  // TASK-1956: contacts:get-available now uses getAllForUserAsync (worker thread)
  getAllForUserAsync: jest.fn().mockImplementation(() => Promise.resolve(mockExternalContacts)),
  isStale: jest.fn().mockReturnValue(false),
  fullSync: jest.fn().mockImplementation((_userId: string, contacts: any[]) => {
    // Store the contacts that were synced
    mockExternalContacts = contacts.map((c: any, i: number) => ({
      id: `ext-${i}`,
      user_id: _userId,
      name: c.name,
      phones: c.phones || [],
      emails: c.emails || [],
      company: c.company || null,
      last_message_at: null,
      macos_record_id: c.recordId,
      synced_at: new Date().toISOString(),
    }));
    return { inserted: contacts.length, updated: 0, deleted: 0, total: contacts.length };
  }),
  getLastSyncTime: jest.fn().mockReturnValue(null),
  updateLastMessageAtFromLookupTable: jest.fn().mockReturnValue(0),
  syncOutlookContacts: jest.fn().mockReturnValue({ inserted: 0, deleted: 0, total: 0 }),
  getContactSourceStats: jest.fn().mockReturnValue({ macos: 0, iphone: 0, outlook: 0 }),
}));

// Mock contactDbService functions used by the handler (BACKLOG-1270)
jest.mock("../services/db/contactDbService", () => ({
  ...jest.requireActual("../services/db/contactDbService"),
  getContactEmailEntries: jest.fn().mockReturnValue([]),
  getContactPhoneEntries: jest.fn().mockReturnValue([]),
}));

// Import after mocks are set up
import { registerContactHandlers } from "../handlers/contactHandlers";
import databaseService from "../services/databaseService";
import { getContactNames } from "../services/contactsService";
import type {
  ContactNamesResult,
  LoadStatus,
  ContactInfo,
  ContactMap,
  PhoneToContactInfo,
} from "../services/contactsService";
import auditService from "../services/auditService";
import logService from "../services/logService";
import contactSyncService from "../services/contactSyncService";
import type { Contact } from "../types/models";
import type {
  ContactWithActivity,
  TransactionWithRoles,
} from "../services/db/contactDbService";
// BACKLOG-2391: the funnel module is deliberately NOT mocked — these tests read
// the real structured snapshot the diagnostics block will consume.
import {
  getContactIngestionFunnel,
  resetContactIngestionFunnel,
} from "../services/contactIngestionFunnel";

/**
 * BACKLOG-2414 — why the row fixtures below are CAST to `Contact` /
 * `ContactWithActivity` / `TransactionWithRoles` rather than completed.
 *
 * Once test files started being type-checked, every `mockResolvedValue(...)` on
 * a `jest.Mocked<typeof databaseService>` reader began demanding the reader's
 * full row type. These fixtures deliberately carry only the columns the handler
 * under test actually reads.
 *
 * Filling in the missing required columns is NOT a neutral edit here: it changes
 * the payload the production handler receives. `source` in particular is read by
 * the `contacts:get-available` dedup/precedence path, and `user_id` is compared
 * during update/delete authorisation — inventing values for them would silently
 * re-target the very behaviour these tests pin. The cast keeps the runtime object
 * byte-for-byte what it was and confines the change to the type layer.
 */

// Get typed references to mocked services
const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;
const mockContactsService = {
  getContactNames: getContactNames as jest.MockedFunction<
    typeof getContactNames
  >,
};

/**
 * BACKLOG-2404 — a COMPLETE reader result for the `getContactNames` mocks.
 *
 * ---------------------------------------------------------------------------
 * WHY A FACTORY, AND NOT JUST DELETING THE `as any`
 * ---------------------------------------------------------------------------
 * The incident: a mock here omitted the required `status` behind an `as any`,
 * so it asserted against a shape the real reader cannot return, and the
 * omission only surfaced once the handler started reading `status`.
 *
 * Deleting the casts would NOT have prevented it — and, stated precisely
 * because the obvious claim is wrong, **neither does this factory make the
 * omission a compile error. Nothing type-checks test files in this repo.**
 * `tsconfig.json` excludes `**\/*.test.ts`, so `tsc --noEmit` never loads them
 * (`--listFiles` reports zero files under `electron/__tests__`), and ts-jest
 * does not report type diagnostics either.
 *
 * Probed rather than assumed — three times, because two plausible-sounding
 * versions of this very comment were false:
 *   - `status: 12345`, a number where `LoadStatus` is required -> 0 tsc errors.
 *   - a required field deleted from an INLINE annotated literal -> 0 errors
 *     (spreading `Partial<LoadStatus>` re-optionalises every field).
 *   - `coverage` deleted from the annotated `const base: LoadStatus` below,
 *     with the mutation asserted to have applied -> still 0 errors, and jest
 *     still passes 89/89.
 * It is also why six other sites in this file pass `status: "loaded"` — a
 * string — and have always been green.
 *
 * What this factory actually buys, which is real but is not compile-time:
 *   1. **By construction** a call site cannot omit `status`; the factory always
 *      supplies a complete one. That is what stops a repeat of the incident.
 *   2. **One place to update.** A new required `LoadStatus` field is added here
 *      once and every call site inherits it, rather than being hunted across
 *      ten object literals that no tool will flag.
 *
 * The `: LoadStatus` annotation on `base` is kept because it costs nothing and
 * WOULD catch the omission the day test files are type-checked (filed as a
 * follow-up). It is not load-bearing today — do not describe it as a gate.
 */
function readerResult(
  over: {
    phoneToContactInfo?: PhoneToContactInfo;
    contacts?: ContactInfo[];
    contactMap?: ContactMap;
    status?: Partial<LoadStatus>;
  } = {},
): ContactNamesResult {
  // Annotated and spread-free: this is the line that actually checks the shape.
  const base: LoadStatus = {
    success: true,
    contactCount: over.contacts?.length ?? 0,
    booksFound: 1,
    booksRead: 1,
    booksFailed: 0,
    coverage: "complete",
    failures: [],
  };

  return {
    contactMap: over.contactMap ?? {},
    phoneToContactInfo: over.phoneToContactInfo ?? {},
    contacts: over.contacts ?? [],
    status: { ...base, ...over.status },
  };
}

/**
 * A reader result with NO `status` at all — the one shape `readerResult` cannot
 * express, since `status` is required on `ContactNamesResult`.
 *
 * A single NAMED escape hatch rather than an anonymous cast at the call site,
 * so the deliberate lie is visible and greppable. It exists only to drive the
 * "omit coverage, never fabricate zeros" branch.
 */
function readerResultWithoutStatus(over: {
  phoneToContactInfo?: PhoneToContactInfo;
} = {}): ContactNamesResult {
  return {
    contactMap: {},
    phoneToContactInfo: over.phoneToContactInfo ?? {},
    contacts: [],
  } as unknown as ContactNamesResult;
}

/**
 * BACKLOG-2414 — the LEGACY reader-result shape the six mocks below pass: a bare
 * `{ phoneToContactInfo, status: "loaded" }`, with no `contactMap` and with
 * `status` as a string where `LoadStatus` is an object. (These are the six sites
 * the `readerResult` note above already calls out.)
 *
 * They are left passing exactly that. Each one drives a `contacts:get-available`
 * dedup/precedence path that reads only `phoneToContactInfo`; routing them
 * through `readerResult()` would hand the handler under test a different payload,
 * which is the thing those tests pin. This wrapper is a single NAMED escape hatch
 * — the same pattern as `readerResultWithoutStatus` — so the drift is greppable
 * instead of six anonymous inline casts. It returns its argument untouched, so
 * the mocked value is unchanged at runtime.
 */
function legacyReaderResult<T>(literal: T): ContactNamesResult {
  return literal as unknown as ContactNamesResult;
}

const mockAuditService = auditService as jest.Mocked<typeof auditService>;
const mockLogService = logService as jest.Mocked<typeof logService>;

// Reset external contacts mock state
function resetExternalContactsMock() {
  // Access the mocked module and reset its state
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const externalContactDb = require("../services/db/externalContactDbService");
  (externalContactDb.getCount as jest.Mock).mockReturnValue(0);
  (externalContactDb.getAllForUser as jest.Mock).mockReturnValue([]);
  // TASK-1956: Also reset the async version used by contacts:get-available
  (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([]);
}

// Test UUIDs
const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_CONTACT_ID = "550e8400-e29b-41d4-a716-446655440001";

describe("Contact Handlers", () => {
  let registeredHandlers: IpcHandlerRegistry;
  const mockEvent = {} as IpcMainInvokeEvent;

  beforeAll(() => {
    // Capture registered handlers
    registeredHandlers = createIpcHandlerRegistry();
    mockIpcHandle.mockImplementation((channel: string, handler: RegisteredIpcHandler) => {
      registeredHandlers.set(channel, handler);
    });

    // Register all handlers with mock window
    registerContactHandlers(mockMainWindow);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetExternalContactsMock();
    // TASK-1950: Default all sources to enabled
    mockIsContactSourceEnabled.mockResolvedValue(true);
  });

  describe("contacts:get-all", () => {
    it("should return all imported contacts for user", async () => {
      const mockContacts = [
        { id: "contact-1", name: "John Doe", email: "john@example.com" },
        { id: "contact-2", name: "Jane Smith", email: "jane@example.com" },
      ] as Contact[];
      mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue(
        mockContacts,
      );

      const handler = registeredHandlers.get("contacts:get-all");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.contacts).toHaveLength(2);
      expect(mockLogService.debug).toHaveBeenCalledWith(
        expect.stringContaining("[PERF] contacts.getAll:"),
        "Contacts",
      );
    });

    it("should return empty contacts for invalid user ID (graceful deferred DB init)", async () => {
      const handler = registeredHandlers.get("contacts:get-all");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(true);
      expect(result.contacts).toEqual([]);
    });

    it("should handle database error", async () => {
      mockDatabaseService.getImportedContactsByUserIdAsync.mockRejectedValue(
        new Error("Database error"),
      );

      const handler = registeredHandlers.get("contacts:get-all");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Database error");
      expect(mockLogService.error).toHaveBeenCalled();
    });
  });

  describe("contacts:get-available", () => {
    it("should return available contacts for import", async () => {
      // TASK-1773: Set up external contacts in shadow table
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const externalContactDb = require("../services/db/externalContactDbService");
      (externalContactDb.getCount as jest.Mock).mockReturnValue(2); // Shadow table has data
      // TASK-1956: Handler now uses getAllForUserAsync (worker thread)
      (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
        {
          id: "ext-1",
          user_id: TEST_USER_ID,
          name: "John Doe",
          phones: ["555-1234"],
          emails: ["john@example.com"],
          company: null,
          last_message_at: null,
          macos_record_id: "record-1",
          synced_at: new Date().toISOString(),
        },
        {
          id: "ext-2",
          user_id: TEST_USER_ID,
          name: "Jane Smith",
          phones: ["555-5678"],
          emails: ["jane@example.com"],
          company: null,
          last_message_at: null,
          macos_record_id: "record-2",
          synced_at: new Date().toISOString(),
        },
      ]);

      mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
      mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

      const handler = registeredHandlers.get("contacts:get-available");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.contacts).toHaveLength(2);
      // TASK-1773: Shadow table always available, status is { loaded: true }
      expect(result.contactsStatus).toEqual({ loaded: true });
    });

    // BACKLOG-1900 (P0.2): the write path must persist the distinct origin.
    // getAvailableContacts previously flattened every non-outlook/google source
    // (incl. iphone, android_sync) to "contacts_app" in the ternary at :608-610,
    // so an iPhone-sourced contact was silently downgraded before it ever
    // reached contacts:create. These assert the distinct source is preserved.
    describe("BACKLOG-1900 P0.2: distinct source persistence", () => {
      const shadowContact = (id: string, name: string, source: string) => ({
        id,
        user_id: TEST_USER_ID,
        name,
        phones: [],
        emails: [`${name.replace(/\s+/g, "").toLowerCase()}@example.com`],
        company: null,
        source,
        last_message_at: null,
        synced_at: new Date().toISOString(),
      });

      const cases: Array<[string, string]> = [
        ["iphone", "iphone"],
        ["android_sync", "android_sync"],
        ["outlook", "outlook"],
        ["google_contacts", "google_contacts"],
        // macOS desktop address book and unknown values stay contacts_app
        ["macos", "contacts_app"],
        ["some_unknown_source", "contacts_app"],
      ];

      it.each(cases)(
        "maps external source %s -> persisted source %s in available contacts",
        async (externalSource, expectedSource) => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const externalContactDb = require("../services/db/externalContactDbService");
          (externalContactDb.getCount as jest.Mock).mockReturnValue(1);
          (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
            shadowContact("ext-src-1", "Origin Person", externalSource),
          ]);

          mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
          mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

          const handler = registeredHandlers.get("contacts:get-available");
          const result = await handler(mockEvent, TEST_USER_ID);

          expect(result.success).toBe(true);
          expect(result.contacts).toHaveLength(1);
          expect(result.contacts[0].source).toBe(expectedSource);
        },
      );

      it("does NOT downgrade an iphone-sourced contact to contacts_app (regression)", async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(1);
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          shadowContact("ext-iphone", "iPhone Person", "iphone"),
        ]);
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.contacts[0].source).toBe("iphone");
        expect(result.contacts[0].source).not.toBe("contacts_app");
      });
    });

    it("should filter out already imported contacts", async () => {
      // TASK-1773: Set up external contacts in shadow table
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const externalContactDb = require("../services/db/externalContactDbService");
      (externalContactDb.getCount as jest.Mock).mockReturnValue(2); // Shadow table has data
      // TASK-1956: Handler now uses getAllForUserAsync (worker thread)
      (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
        {
          id: "ext-1",
          user_id: TEST_USER_ID,
          name: "John Doe",
          phones: ["555-1234"],
          emails: ["john@example.com"],
          company: null,
          last_message_at: null,
          macos_record_id: "record-1",
          synced_at: new Date().toISOString(),
        },
        {
          id: "ext-2",
          user_id: TEST_USER_ID,
          name: "Jane Smith",
          phones: ["555-5678"],
          emails: ["jane@example.com"],
          company: null,
          last_message_at: null,
          macos_record_id: "record-2",
          synced_at: new Date().toISOString(),
        },
      ]);

      mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
      mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([
        { name: "John Doe", email: "john@example.com" } as Contact,
      ]);

      const handler = registeredHandlers.get("contacts:get-available");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0].name).toBe("Jane Smith");
    });

    it("should return empty contacts for invalid user ID (graceful deferred DB init)", async () => {
      const handler = registeredHandlers.get("contacts:get-available");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(true);
      expect(result.contacts).toEqual([]);
    });

    // BACKLOG-1977: QA-isolation E2E gate. When KEEPR_E2E=1 (and app.isPackaged
    // is false, per the electron mock), the handler short-circuits and returns
    // an empty external/available set WITHOUT reading the DB/shadow table, so a
    // developer/CI Mac's real address book cannot leak into isolated fixtures.
    it("returns empty available set when KEEPR_E2E=1 (QA isolation short-circuit)", async () => {
      const prevE2E = process.env.KEEPR_E2E;
      process.env.KEEPR_E2E = "1";
      try {
        // Populate the shadow table so we can prove the short-circuit fires
        // BEFORE any external contacts are read.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(2);
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          {
            id: "ext-1",
            user_id: TEST_USER_ID,
            name: "Leaked Contact",
            phones: ["555-0000"],
            emails: ["leak@example.com"],
            company: null,
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
        ]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.contacts).toEqual([]);
        expect(result.contactsStatus).toEqual({ loaded: true });
        // Short-circuit fires before the shadow table / imported-DB reads.
        expect(externalContactDb.getAllForUserAsync).not.toHaveBeenCalled();
        expect(
          mockDatabaseService.getImportedContactsByUserIdAsync,
        ).not.toHaveBeenCalled();
      } finally {
        if (prevE2E === undefined) {
          delete process.env.KEEPR_E2E;
        } else {
          process.env.KEEPR_E2E = prevE2E;
        }
      }
    });

    it("should handle contacts service error", async () => {
      // TASK-1773: When shadow table is empty and macOS sync fails,
      // handler logs warning but still returns available contacts (from DB)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const externalContactDb = require("../services/db/externalContactDbService");
      (externalContactDb.getCount as jest.Mock).mockReturnValue(0); // Empty shadow table

      mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
      mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);
      mockContactsService.getContactNames.mockRejectedValue(
        new Error("Contacts access denied"),
      );

      const handler = registeredHandlers.get("contacts:get-available");
      const result = await handler(mockEvent, TEST_USER_ID);

      // Handler now gracefully handles sync failures - returns empty but still succeeds
      expect(result.success).toBe(true);
      expect(result.contacts).toHaveLength(0);
      // The warning is logged but handler doesn't fail
      expect(mockLogService.warn).toHaveBeenCalled();
    });

    // TASK-982: Deduplication tests
    describe("deduplication by email", () => {
      it("should dedupe contacts with same email from iPhone sync and macOS Contacts", async () => {
        // Same contact exists in both sources with same email
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          {
            id: "db-1",
            name: "John Doe",
            email: "john@example.com",
            phone: "555-1234",
          } as Contact,
        ]);
        mockContactsService.getContactNames.mockResolvedValue(legacyReaderResult({
          phoneToContactInfo: {
            "555-9999": {
              name: "John D.", // Slightly different name
              phones: ["555-9999"],
              emails: ["john@example.com"], // Same email
            },
          },
          status: "loaded",
        }));
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        // Should only have 1 contact (iPhone-synced takes precedence)
        expect(result.contacts).toHaveLength(1);
        expect(result.contacts[0].id).toBe("db-1"); // DB contact wins
        expect(result.contacts[0].isFromDatabase).toBe(true);
      });

      it("should be case-insensitive when deduping by email", async () => {
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          {
            id: "db-1",
            name: "John Doe",
            email: "John@Example.COM",
            phone: "555-1234",
          } as Contact,
        ]);
        mockContactsService.getContactNames.mockResolvedValue(legacyReaderResult({
          phoneToContactInfo: {
            "555-9999": {
              name: "John D.",
              phones: ["555-9999"],
              emails: ["john@example.com"], // Same email, different case
            },
          },
          status: "loaded",
        }));
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.contacts).toHaveLength(1);
      });
    });

    describe("deduplication by phone", () => {
      it("should dedupe contacts with same phone number (different formats)", async () => {
        // iPhone sync has one format, macOS Contacts has another
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          {
            id: "db-1",
            name: "Jane Smith",
            email: "jane@example.com",
            phone: "+15551234567",
          } as Contact,
        ]);
        mockContactsService.getContactNames.mockResolvedValue(legacyReaderResult({
          phoneToContactInfo: {
            "(555) 123-4567": {
              name: "Jane S.", // Slightly different name
              phones: ["(555) 123-4567"], // Same phone, different format
              emails: ["janes@other.com"], // Different email
            },
          },
          status: "loaded",
        }));
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        // Should only have 1 contact (iPhone-synced takes precedence)
        expect(result.contacts).toHaveLength(1);
        expect(result.contacts[0].id).toBe("db-1");
      });

      it("should handle phone numbers with and without country code", async () => {
        // BACKLOG-2316: a shared phone now only dedupes when the NAMES are
        // compatible, so this test keeps the same name across sources to prove
        // the phone-format normalization (5559876543 == +1 555 987 6543) still
        // collapses the SAME person. (Distinct names on a shared line are
        // covered by the "distinct contacts are not over-suppressed" block.)
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          { id: "db-1", name: "Bob Jones", phone: "5559876543" } as Contact, // No country code
        ]);
        mockContactsService.getContactNames.mockResolvedValue(legacyReaderResult({
          phoneToContactInfo: {
            "+1 555 987 6543": {
              name: "Bob Jones",
              phones: ["+1 555 987 6543"], // With country code
              emails: [],
            },
          },
          status: "loaded",
        }));
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.contacts).toHaveLength(1);
        expect(result.contacts[0].id).toBe("db-1");
      });
    });

    // BACKLOG-2316: name-only matching was REMOVED from dedup — it silently
    // dropped distinct people who merely share a name string (e.g. multiple
    // "Margaret"s). Two records that share ONLY a name (no email, no shared
    // phone) must both survive. Genuine same-person duplicates still collapse
    // via email or a shared phone + compatible name (covered elsewhere), and a
    // re-import of a same-named contact is still de-duplicated at write time by
    // contacts:create (findContactByName).
    describe("name-only matches do NOT dedupe (BACKLOG-2316)", () => {
      it("keeps both contacts that share only a name (no email/phone overlap)", async () => {
        // db stub (name only) in STEP 1; the fuller record with a distinct
        // phone/email lives in the shadow table (STEP 3). They share ONLY a
        // name, so both must survive.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(1);
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          {
            id: "ext-alice",
            user_id: TEST_USER_ID,
            name: "Alice Brown", // Same name, but distinct identifiers
            phones: ["555-0000"],
            emails: ["alice@work.com"],
            source: "macos",
            company: null,
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
        ]);
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          { id: "db-1", name: "Alice Brown" } as Contact, // No email or phone
        ]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        // Both survive — the name alone is not proof they are the same person.
        expect(result.contacts).toHaveLength(2);
        const ids = new Set(result.contacts.map((c: any) => c.id));
        expect(ids).toEqual(new Set(["db-1", "ext-alice"]));
      });

      it("keeps both even when the shared name matches case-insensitively", async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(1);
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          {
            id: "ext-charlie",
            user_id: TEST_USER_ID,
            name: "charlie davis", // Same name, different case, distinct phone
            phones: ["555-1111"],
            emails: [],
            source: "macos",
            company: null,
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
        ]);
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          { id: "db-1", name: "CHARLIE DAVIS" } as Contact,
        ]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.contacts).toHaveLength(2);
      });
    });

    describe("iPhone-synced contacts take precedence", () => {
      it("should prefer iPhone-synced contacts over macOS Contacts app", async () => {
        // Same person in both sources
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          {
            id: "db-real-id",
            name: "Priority Contact",
            email: "priority@example.com",
            phone: "555-2222",
            company: "iPhone Company",
          } as Contact,
        ]);
        mockContactsService.getContactNames.mockResolvedValue(legacyReaderResult({
          phoneToContactInfo: {
            "555-2222": {
              name: "Priority Contact",
              phones: ["555-2222"],
              emails: ["priority@example.com"],
            },
          },
          status: "loaded",
        }));
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.contacts).toHaveLength(1);
        // Should have the real DB ID from iPhone sync
        expect(result.contacts[0].id).toBe("db-real-id");
        expect(result.contacts[0].isFromDatabase).toBe(true);
        expect(result.contacts[0].company).toBe("iPhone Company");
      });
    });

    describe("no false positives in deduplication", () => {
      it("should not dedupe contacts with different identifiers", async () => {
        // TASK-1773: Set up external contacts in shadow table
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(1); // Shadow table has data
        // TASK-1956: Handler now uses getAllForUserAsync (worker thread)
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          {
            id: "ext-2",
            user_id: TEST_USER_ID,
            name: "Person Two", // Different name
            phones: ["555-2222"], // Different phone
            emails: ["two@example.com"], // Different email
            company: null,
            last_message_at: null,
            macos_record_id: "record-2",
            synced_at: new Date().toISOString(),
          },
        ]);

        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          {
            id: "db-1",
            name: "Person One",
            email: "one@example.com",
            phone: "555-1111",
          } as Contact,
        ]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        // Should have both contacts (no deduplication)
        expect(result.contacts).toHaveLength(2);
      });
    });

    // BACKLOG-2316: the over-suppression regression. These assert EXACT contact
    // identity SETS survive dedup — counts alone hide identity bugs.
    describe("distinct contacts are not over-suppressed (BACKLOG-2316)", () => {
      it("keeps BOTH people who share one normalized phone (household/office line)", async () => {
        // Two DISTINCT people (different first names) share one landline. The
        // old predicate suppressed the second on the shared phone alone; both
        // must now survive.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(2);
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          {
            id: "ext-margaret",
            user_id: TEST_USER_ID,
            name: "Margaret Astor",
            phones: ["+15551230000"], // shared household line
            emails: [],
            source: "macos",
            company: null,
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
          {
            id: "ext-george",
            user_id: TEST_USER_ID,
            name: "George Astor", // same surname, DIFFERENT person
            phones: ["+15551230000"], // same shared line
            emails: [],
            source: "macos",
            company: null,
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
        ]);
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        const names = new Set(result.contacts.map((c: any) => c.name));
        expect(names).toEqual(new Set(["Margaret Astor", "George Astor"]));
      });

      /**
       * BACKLOG-2399 — the shape the relabel made reachable.
       *
       * `namesAreCompatible` compared token-by-token only up to the SHORTER
       * name's length, so a lone first name was prefix-compatible with every
       * longer name starting with it. On a shared office line that silently
       * removed a distinct person from the import picker.
       *
       * The shape was mostly unreachable before: these cards were labelled by
       * ORGANISATION ("Miller - Seller"), which collides with nothing.
       * BACKLOG-2399 relabels that population to bare first names — exactly
       * this shape — so a latent case became a common one.
       *
       * The test above (BACKLOG-2316) uses TWO FULL NAMES and cannot catch
       * this: "Margaret Astor" / "George Astor" diverge at token 0.
       */
      it("keeps a first-name-only contact AND a distinct longer name on one line (BACKLOG-2399)", async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(2);
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          {
            id: "ext-margaret-bare",
            user_id: TEST_USER_ID,
            // Post-relabel: was "Miller - Seller", now her actual first name.
            name: "Margaret",
            phones: ["+15551230000"], // shared office line
            emails: [],
            source: "macos",
            company: "Miller - Seller",
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
          {
            id: "ext-margaret-chen",
            user_id: TEST_USER_ID,
            name: "Margaret Chen", // SAME first name, DIFFERENT person
            phones: ["+15551230000"], // same office line
            emails: [],
            source: "macos",
            company: null,
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
        ]);
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        // Exact identity SET. Before the fix this was just ["Margaret"] —
        // Margaret Chen was unimportable and nothing reported it.
        const ids = new Set(result.contacts.map((c: any) => c.id));
        expect(ids).toEqual(new Set(["ext-margaret-bare", "ext-margaret-chen"]));
      });

      it("still collapses the SAME person recorded twice under one full name", async () => {
        // The control for the rule above: tightening the single-token case must
        // not stop genuine cross-source duplicates collapsing. Two full names
        // that agree token-by-token are still one person.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(2);
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          {
            id: "ext-jane-full",
            user_id: TEST_USER_ID,
            name: "Jane Smith",
            phones: ["+15554440000"],
            emails: [],
            source: "macos",
            company: null,
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
          {
            id: "ext-jane-abbrev",
            user_id: TEST_USER_ID,
            name: "Jane S.", // abbreviated surname, same person
            phones: ["+15554440000"],
            emails: [],
            source: "outlook",
            company: null,
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
        ]);
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        const ids = new Set(result.contacts.map((c: any) => c.id));
        expect(ids).toEqual(new Set(["ext-jane-full"]));
      });

      it("still collapses two identical bare first names on one line", async () => {
        // The other control: the tightening must not split an EXACT match.
        // "Margaret" / "Margaret" is handled by the equality check, so the same
        // person imported from two sources under a bare name still collapses.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(2);
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          {
            id: "ext-bare-macos",
            user_id: TEST_USER_ID,
            name: "Margaret",
            phones: ["+15556660000"],
            emails: [],
            source: "macos",
            company: null,
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
          {
            id: "ext-bare-outlook",
            user_id: TEST_USER_ID,
            name: "Margaret",
            phones: ["+15556660000"],
            emails: [],
            source: "outlook",
            company: null,
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
        ]);
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        const ids = new Set(result.contacts.map((c: any) => c.id));
        expect(ids).toEqual(new Set(["ext-bare-macos"]));
      });

      it("recovers a contact the phone-map last-wins overwrite dropped (uses person list)", async () => {
        // Empty shadow table => macOS sync path. `phoneToContactInfo` is
        // phone-keyed and last-wins, so it only retained George at the shared
        // number — Margaret was overwritten out of it. The handler must build
        // the shadow-sync payload from the person-deduped `contacts` list so
        // BOTH people (incl. the dropped Margaret) are written to the shadow
        // table. Asserted directly on the fullSync payload — the shared
        // getAllForUserAsync test-double does not read back what fullSync wrote.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(0); // empty => sync
        const fullSyncSpy = externalContactDb.fullSync as jest.Mock;

        mockContactsService.getContactNames.mockResolvedValue({
          contactMap: {},
          phoneToContactInfo: {
            // last-wins: only George survived under the shared key
            "+15559990000": {
              name: "George Reid",
              phones: ["+15559990000"],
              emails: [],
              recordId: "r-george",
            },
          },
          contacts: [
            {
              name: "Margaret Reid",
              phones: ["+15559990000"], // only phone = shared line
              emails: [],
              recordId: "r-margaret",
            },
            {
              name: "George Reid",
              phones: ["+15559990000"],
              emails: [],
              recordId: "r-george",
            },
          ],
          status: "loaded",
        } as any);
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(fullSyncSpy).toHaveBeenCalledTimes(1);
        const syncedPayload = fullSyncSpy.mock.calls[0][1] as Array<{ name: string }>;
        const syncedNames = new Set(syncedPayload.map((c) => c.name));
        // Margaret is recovered from the person list, not lost to the phone map.
        expect(syncedNames).toEqual(new Set(["Margaret Reid", "George Reid"]));
      });

      it("does NOT hide a distinct external contact that shares a name with an imported one", async () => {
        // A different "Margaret" is already imported. The external Margaret has
        // her own phone and no shared email/phone with the imported one, so she
        // must still appear as available (old code hid her by name).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(1);
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          {
            id: "ext-margaret-b",
            user_id: TEST_USER_ID,
            name: "Margaret",
            phones: ["+15557778888"],
            emails: [],
            source: "macos",
            company: null,
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
        ]);
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
        // A DIFFERENT Margaret is already imported (distinct phone/email).
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([
          { id: "imp-1", name: "Margaret", email: "other-margaret@example.com", phone: "+15550001111" } as Contact,
        ]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        const ids = new Set(result.contacts.map((c: any) => c.id));
        expect(ids).toContain("ext-margaret-b");
      });

      it("still collapses the SAME person across sources via a shared email", async () => {
        // Guard against over-correction: a genuine macOS+shadow duplicate that
        // shares an email must still collapse to one.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(1);
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          {
            id: "ext-dup",
            user_id: TEST_USER_ID,
            name: "Dana Lee",
            phones: ["+15552223333"],
            emails: ["dana@example.com"],
            source: "macos",
            company: null,
            last_message_at: null,
            synced_at: new Date().toISOString(),
          },
        ]);
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          { id: "db-dana", name: "Dana Lee", email: "dana@example.com", phone: "+15559998888" } as Contact,
        ]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.contacts).toHaveLength(1);
        expect(result.contacts[0].id).toBe("db-dana"); // DB record wins
      });
    });

    describe("already imported contacts filtered by phone", () => {
      it("should filter out macOS contacts if phone matches already imported", async () => {
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
        mockContactsService.getContactNames.mockResolvedValue(legacyReaderResult({
          phoneToContactInfo: {
            "(555) 333-4444": {
              name: "Already Imported Person",
              phones: ["(555) 333-4444"],
              emails: ["different@email.com"],
            },
          },
          status: "loaded",
        }));
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([
          {
            name: "Other Name",
            email: "other@email.com",
            phone: "+15553334444",
          } as Contact, // Same phone normalized
        ]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        // Should be empty - phone matches already imported contact
        expect(result.contacts).toHaveLength(0);
      });
    });

    /**
     * BACKLOG-2391 — picker funnel stage.
     *
     * Every `continue` in contacts:get-available drops a contact the user asked
     * for. None of those drops were countable, so "my contacts are missing"
     * could not be told apart from "they were never read off the Mac".
     *
     * ASSERTION STYLE: exact ID SETS for what survives, alongside the counts.
     * A count assertion alone passes when the WRONG rows survive.
     */
    describe("BACKLOG-2391: picker funnel counts", () => {
      beforeEach(() => {
        resetContactIngestionFunnel();
      });

      /**
       * A corpus with one drop of each kind, so every counter is non-zero and
       * a counter wired to the wrong branch cannot hide behind a zero:
       *   - db-keep          : shown
       *   - db-imported      : already-imported (phone matches an imported row)
       *   - ext-keep         : shown
       *   - ext-dup-of-db    : duplicate (shares db-keep's email)
       *   - ext-outlook-off  : source disabled (outlook switched off)
       *   - ext-imported     : already-imported (email matches an imported row)
       *
       * BACKLOG-2416: `db-imported` carries the NAME of the imported contact it
       * is meant to duplicate. A shared phone alone no longer proves two records
       * are one person — household and office lines are shared by distinct
       * people — so the row must name the person it claims to be. It was
       * previously "Db Imported" against an imported "Imported One", which under
       * the new rule is a DIFFERENT person on the same line and is correctly
       * shown. The intent of the fixture ("this row is already imported") is
       * unchanged; only its name now says so.
       */
      async function runFunnelFixture() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getCount as jest.Mock).mockReturnValue(4);
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          {
            id: "ext-keep", user_id: TEST_USER_ID, name: "Ext Keep",
            phones: ["+15551110000"], emails: ["ext-keep@example.com"],
            // BACKLOG-2458: the shadow table ALWAYS carries a source identity
            // (BACKLOG-2401 made it the identity). Omitting it here made the
            // fixture unable to express whether a collapsed record's identity
            // survives, which is the whole of the BACKLOG-2458 carry.
            external_record_id: "rec-ext-keep", external_uuid: null,
            source: "macos", company: null, last_message_at: null,
            synced_at: new Date().toISOString(),
          },
          {
            id: "ext-dup-of-db", user_id: TEST_USER_ID, name: "Db Keep",
            phones: ["+15552220000"], emails: ["db-keep@example.com"],
            external_record_id: "rec-ext-dup", external_uuid: null,
            source: "macos", company: null, last_message_at: null,
            synced_at: new Date().toISOString(),
          },
          {
            id: "ext-outlook-off", user_id: TEST_USER_ID, name: "Outlook Person",
            phones: ["+15553330000"], emails: ["outlook@example.com"],
            source: "outlook", company: null, last_message_at: null,
            synced_at: new Date().toISOString(),
          },
          {
            id: "ext-imported", user_id: TEST_USER_ID, name: "Ext Imported",
            phones: ["+15554440000"], emails: ["already@example.com"],
            source: "macos", company: null, last_message_at: null,
            synced_at: new Date().toISOString(),
          },
        ]);

        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          { id: "db-keep", name: "Db Keep", email: "db-keep@example.com", phone: "+15552220000" } as Contact,
          { id: "db-imported", name: "Imported One", email: "db-imported@example.com", phone: "+15559990000" } as Contact,
        ]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([
          { id: "imp-1", name: "Imported One", email: "already@example.com", phone: "+15559990000" } as Contact,
        ]);

        // Outlook switched OFF, everything else on.
        mockIsContactSourceEnabled.mockImplementation(
          async (_u: string, _c: string, key: string) => key !== "outlookContacts",
        );

        const handler = registeredHandlers.get("contacts:get-available");
        return handler(mockEvent, TEST_USER_ID);
      }

      it("reports every drop reason, and the arithmetic closes", async () => {
        const result = await runFunnelFixture();
        expect(result.success).toBe(true);

        const picker = getContactIngestionFunnel().picker;
        expect(picker).toBeDefined();

        expect(picker!.dbRowsIn).toBe(2);
        expect(picker!.externalRowsIn).toBe(4);
        expect(picker!.rowsIn).toBe(6);
        expect(picker!.sourceDisabled).toBe(1);      // ext-outlook-off
        expect(picker!.alreadyImported).toBe(2);     // db-imported (phone), ext-imported (email)
        expect(picker!.duplicateSuppressed).toBe(1); // ext-dup-of-db
        // BACKLOG-2458: the suppressed record handed its source identity to the
        // row that absorbed it (db-keep) instead of being discarded. A DB row
        // absorbing an EXTERNAL record's identity is the founder's case in
        // miniature: without this the user's choice of the collapsed row is
        // never recorded, and the next sync re-derives it by content matching.
        expect(picker!.collapsedIdentitiesCarried).toBe(1);
        expect(picker!.shown).toBe(2);

        // The funnel is only trustworthy if it balances.
        expect(
          picker!.rowsIn -
            picker!.sourceDisabled -
            picker!.alreadyImported -
            picker!.duplicateSuppressed,
        ).toBe(picker!.shown);
      });

      it("the surviving rows are the EXACT ones the counts claim", async () => {
        const result = await runFunnelFixture();

        // Identity, not count: `shown: 2` is equally satisfied by dropping
        // db-keep and keeping ext-dup-of-db, which would be the wrong rows.
        expect(result.contacts.map((c: { id: string }) => c.id).sort()).toEqual([
          "db-keep",
          "ext-keep",
        ]);
      });

      it("emits ONE info line per picker read — counters, never per-row", async () => {
        await runFunnelFixture();

        const pickerLines = mockLogService.info.mock.calls
          .map((c: unknown[]) => String(c[0]))
          .filter((m: string) => m.includes("picker:"));

        expect(pickerLines).toHaveLength(1);
        expect(pickerLines[0]).toBe(
          "[Contacts] picker: 6 in (db 2 + external 4) -> source-disabled 1" +
            " -> already-imported 2 -> dup-suppressed 1 (identity carried 1) -> shown 2",
        );
      });

      it("leaks no PII into any emitted log line", async () => {
        await runFunnelFixture();

        // Every name / address / number present in the fixture corpus.
        const pii = [
          "Ext Keep", "Db Keep", "Outlook Person", "Ext Imported", "Db Imported", "Imported One",
          "ext-keep@example.com", "db-keep@example.com", "outlook@example.com",
          "already@example.com", "db-imported@example.com",
          "+15551110000", "+15552220000", "+15553330000", "+15554440000", "+15559990000",
        ];

        const emitted = [
          ...mockLogService.info.mock.calls,
          ...mockLogService.warn.mock.calls,
          ...mockLogService.error.mock.calls,
        ]
          .map((c: unknown[]) =>
            c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
          )
          .join("\n");

        for (const secret of pii) {
          expect(emitted).not.toContain(secret);
        }
      });
    });
  });

  describe("contacts:import", () => {
    const contactsToImport = [
      { name: "John Doe", email: "john@example.com", phone: "555-1234" },
      { name: "Jane Smith", email: "jane@example.com", phone: "555-5678" },
    ];

    it("should import contacts successfully", async () => {
      // Mock createContactsBatch to return IDs for new contacts
      mockDatabaseService.createContactsBatch.mockReturnValue([
        "contact-john",
        "contact-jane",
      ]);
      // Mock getContactById to return contact data for each created ID
      mockDatabaseService.getContactById
        .mockResolvedValueOnce({
          id: "contact-john",
          name: "John Doe",
          email: "john@example.com",
          phone: "555-1234",
        } as Contact)
        .mockResolvedValueOnce({
          id: "contact-jane",
          name: "Jane Smith",
          email: "jane@example.com",
          phone: "555-5678",
        } as Contact);

      const handler = registeredHandlers.get("contacts:import");
      const result = await handler(mockEvent, TEST_USER_ID, contactsToImport);

      expect(result.success).toBe(true);
      expect(result.contacts).toHaveLength(2);
      expect(mockDatabaseService.createContactsBatch).toHaveBeenCalledTimes(1);
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("contacts:import");
      const result = await handler(mockEvent, "", contactsToImport);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No valid user found");
    });

    it("should handle empty contacts array", async () => {
      const handler = registeredHandlers.get("contacts:import");
      const result = await handler(mockEvent, TEST_USER_ID, []);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle non-array contacts", async () => {
      const handler = registeredHandlers.get("contacts:import");
      const result = await handler(mockEvent, TEST_USER_ID, "not-an-array");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should reject more than 5000 contacts", async () => {
      const manyContacts = Array(5001).fill({
        name: "Test",
        email: "test@example.com",
      });

      const handler = registeredHandlers.get("contacts:import");
      const result = await handler(mockEvent, TEST_USER_ID, manyContacts);

      expect(result.success).toBe(false);
      expect(result.error).toContain("5000");
    });

    it("should handle import failure", async () => {
      mockDatabaseService.createContactsBatch.mockImplementation(() => {
        throw new Error("Import failed");
      });

      const handler = registeredHandlers.get("contacts:import");
      const result = await handler(mockEvent, TEST_USER_ID, contactsToImport);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Import failed");
    });
  });

  describe("contacts:get-sorted-by-activity", () => {
    it("should return contacts sorted by activity", async () => {
      const sortedContacts = [
        { id: "contact-1", name: "Active John", lastActivity: new Date() },
        {
          id: "contact-2",
          name: "Less Active Jane",
          lastActivity: new Date(Date.now() - 86400000),
        },
        // BACKLOG-2414: `lastActivity` is not a `ContactWithActivity` field (the
        // real reader returns `last_communication_at`). Left verbatim because no
        // assertion here reads it — the test only pins the length and the reader
        // arguments — and renaming it would change the mocked payload.
      ] as unknown as ContactWithActivity[];
      mockDatabaseService.getContactsSortedByActivity.mockResolvedValue(
        sortedContacts,
      );

      const handler = registeredHandlers.get("contacts:get-sorted-by-activity");
      const result = await handler(mockEvent, TEST_USER_ID, "123 Main St");

      expect(result.success).toBe(true);
      expect(result.contacts).toHaveLength(2);
      expect(
        mockDatabaseService.getContactsSortedByActivity,
      ).toHaveBeenCalledWith(TEST_USER_ID, "123 Main St");
    });

    it("should work without property address", async () => {
      mockDatabaseService.getContactsSortedByActivity.mockResolvedValue([]);

      const handler = registeredHandlers.get("contacts:get-sorted-by-activity");
      const result = await handler(mockEvent, TEST_USER_ID, null);

      expect(result.success).toBe(true);
      expect(
        mockDatabaseService.getContactsSortedByActivity,
      ).toHaveBeenCalledWith(TEST_USER_ID, undefined);
    });

    it("should return empty contacts for invalid user ID (graceful deferred DB init)", async () => {
      const handler = registeredHandlers.get("contacts:get-sorted-by-activity");
      const result = await handler(mockEvent, "", null);

      expect(result.success).toBe(true);
      expect(result.contacts).toEqual([]);
    });
  });

  describe("contacts:create", () => {
    const validContactData = {
      name: "New Contact",
      email: "new@example.com",
      phone: "555-9999",
    };

    it("should create contact successfully", async () => {
      const createdContact = {
        id: "contact-new",
        ...validContactData,
      } as Contact;
      mockDatabaseService.createContact.mockResolvedValue(createdContact);

      const handler = registeredHandlers.get("contacts:create");
      const result = await handler(mockEvent, TEST_USER_ID, validContactData);

      expect(result.success).toBe(true);
      expect(result.contact).toEqual(createdContact);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "CONTACT_CREATE",
          success: true,
        }),
      );
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("contacts:create");
      const result = await handler(mockEvent, "", validContactData);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No valid user found");
    });

    // BACKLOG-1900 (P0.2): the distinct source coming from the import list must
    // reach the persist call (createContact) unchanged — the row is written with
    // 'iphone', not coerced to 'manual'/'contacts_app'. This is the write-path
    // assertion that pairs with the migration-v48 real-DB CHECK test proving the
    // column accepts + stores the value.
    it.each([
      ["iphone", "iphone"],
      ["android_sync", "android_sync"],
      ["outlook", "outlook"],
      ["google_contacts", "google_contacts"],
      ["contacts_app", "contacts_app"],
    ])(
      "persists distinct source %s via createContact",
      async (inputSource, expectedSource) => {
        mockDatabaseService.createContact.mockResolvedValue({
          id: "contact-src",
          name: "Imported Person",
        } as Contact);

        const handler = registeredHandlers.get("contacts:create");
        const result = await handler(mockEvent, TEST_USER_ID, {
          name: "Imported Person",
          email: "imported@example.com",
          source: inputSource,
        });

        expect(result.success).toBe(true);
        expect(mockDatabaseService.createContact).toHaveBeenCalledWith(
          expect.objectContaining({ source: expectedSource }),
        );
      },
    );

    it("falls back to manual when source is an unrecognised value", async () => {
      mockDatabaseService.createContact.mockResolvedValue({
        id: "contact-fallback",
        name: "Unknown Origin",
      } as Contact);

      const handler = registeredHandlers.get("contacts:create");
      const result = await handler(mockEvent, TEST_USER_ID, {
        name: "Unknown Origin",
        email: "unknown@example.com",
        source: "not_a_real_source",
      });

      expect(result.success).toBe(true);
      expect(mockDatabaseService.createContact).toHaveBeenCalledWith(
        expect.objectContaining({ source: "manual" }),
      );
    });

    it("should handle creation failure", async () => {
      mockDatabaseService.createContact.mockRejectedValue(
        new Error("Creation failed"),
      );

      const handler = registeredHandlers.get("contacts:create");
      const result = await handler(mockEvent, TEST_USER_ID, validContactData);

      expect(result.success).toBe(false);
      expect(mockLogService.error).toHaveBeenCalled();
    });
  });

  describe("contacts:update", () => {
    const existingContact = {
      id: TEST_CONTACT_ID,
      user_id: TEST_USER_ID,
      name: "Old Name",
      email: "old@example.com",
    } as Contact;

    it("should update contact successfully", async () => {
      mockDatabaseService.getContactById.mockResolvedValue(existingContact);
      mockDatabaseService.updateContact.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("contacts:update");
      const result = await handler(mockEvent, TEST_CONTACT_ID, {
        name: "New Name",
      });

      expect(result.success).toBe(true);
      expect(mockDatabaseService.updateContact).toHaveBeenCalled();
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "CONTACT_UPDATE",
          success: true,
        }),
      );
    });

    it("should handle invalid contact ID", async () => {
      const handler = registeredHandlers.get("contacts:update");
      const result = await handler(mockEvent, "", { name: "New Name" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle update failure", async () => {
      mockDatabaseService.getContactById.mockResolvedValue(existingContact);
      mockDatabaseService.updateContact.mockRejectedValue(
        new Error("Update failed"),
      );

      const handler = registeredHandlers.get("contacts:update");
      const result = await handler(mockEvent, TEST_CONTACT_ID, {
        name: "New Name",
      });

      expect(result.success).toBe(false);
      expect(mockLogService.error).toHaveBeenCalled();
    });
  });

  describe("contacts:checkCanDelete", () => {
    it("should return true when contact has no transactions", async () => {
      mockDatabaseService.getTransactionsByContact.mockResolvedValue([]);

      const handler = registeredHandlers.get("contacts:checkCanDelete");
      const result = await handler(mockEvent, TEST_CONTACT_ID);

      expect(result.success).toBe(true);
      expect(result.canDelete).toBe(true);
      expect(result.count).toBe(0);
    });

    it("should return false when contact has transactions", async () => {
      const transactions = [
        { id: "txn-1", property_address: "123 Main St" },
        { id: "txn-2", property_address: "456 Oak Ave" },
      ] as TransactionWithRoles[];
      mockDatabaseService.getTransactionsByContact.mockResolvedValue(
        transactions,
      );

      const handler = registeredHandlers.get("contacts:checkCanDelete");
      const result = await handler(mockEvent, TEST_CONTACT_ID);

      expect(result.success).toBe(true);
      expect(result.canDelete).toBe(false);
      expect(result.transactions).toHaveLength(2);
      expect(result.count).toBe(2);
    });

    it("should handle invalid contact ID", async () => {
      const handler = registeredHandlers.get("contacts:checkCanDelete");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });
  });

  describe("contacts:delete", () => {
    const existingContact = {
      id: TEST_CONTACT_ID,
      user_id: TEST_USER_ID,
      name: "John Doe",
    } as Contact;

    it("should delete contact successfully when no transactions", async () => {
      mockDatabaseService.getContactById.mockResolvedValue(existingContact);
      mockDatabaseService.getTransactionsByContact.mockResolvedValue([]);
      mockDatabaseService.deleteContact.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("contacts:delete");
      const result = await handler(mockEvent, TEST_CONTACT_ID);

      expect(result.success).toBe(true);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "CONTACT_DELETE",
          success: true,
        }),
      );
    });

    it("should prevent deletion when contact has transactions", async () => {
      mockDatabaseService.getContactById.mockResolvedValue(existingContact);
      mockDatabaseService.getTransactionsByContact.mockResolvedValue([
        { id: "txn-1" } as TransactionWithRoles,
      ]);

      const handler = registeredHandlers.get("contacts:delete");
      const result = await handler(mockEvent, TEST_CONTACT_ID);

      expect(result.success).toBe(false);
      expect(result.canDelete).toBe(false);
      expect(result.error).toContain("associated transactions");
    });

    it("should handle invalid contact ID", async () => {
      const handler = registeredHandlers.get("contacts:delete");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle deletion failure", async () => {
      mockDatabaseService.getContactById.mockResolvedValue(existingContact);
      mockDatabaseService.getTransactionsByContact.mockResolvedValue([]);
      mockDatabaseService.deleteContact.mockRejectedValue(
        new Error("Delete failed"),
      );

      const handler = registeredHandlers.get("contacts:delete");
      const result = await handler(mockEvent, TEST_CONTACT_ID);

      expect(result.success).toBe(false);
      expect(mockLogService.error).toHaveBeenCalled();
    });
  });

  describe("contacts:remove", () => {
    it("should remove contact from local database successfully", async () => {
      mockDatabaseService.getTransactionsByContact.mockResolvedValue([]);
      mockDatabaseService.removeContact.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("contacts:remove");
      const result = await handler(mockEvent, TEST_CONTACT_ID);

      expect(result.success).toBe(true);
      expect(mockDatabaseService.removeContact).toHaveBeenCalledWith(
        TEST_CONTACT_ID,
      );
    });

    it("should prevent removal when contact has transactions", async () => {
      mockDatabaseService.getTransactionsByContact.mockResolvedValue([
        { id: "txn-1" } as TransactionWithRoles,
      ]);

      const handler = registeredHandlers.get("contacts:remove");
      const result = await handler(mockEvent, TEST_CONTACT_ID);

      expect(result.success).toBe(false);
      expect(result.canDelete).toBe(false);
      expect(result.error).toContain("associated transactions");
    });

    it("should handle invalid contact ID", async () => {
      const handler = registeredHandlers.get("contacts:remove");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle removal failure", async () => {
      mockDatabaseService.getTransactionsByContact.mockResolvedValue([]);
      mockDatabaseService.removeContact.mockRejectedValue(
        new Error("Removal failed"),
      );

      const handler = registeredHandlers.get("contacts:remove");
      const result = await handler(mockEvent, TEST_CONTACT_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Removal failed");
    });
  });

  // TASK-1950: Contact source preference gating tests
  describe("contacts:syncExternal (preference gating)", () => {
    it("should skip sync when macOS contacts source is disabled", async () => {
      mockIsContactSourceEnabled.mockImplementation(
        async (_userId: string, _category: string, key: string) => {
          if (key === "macosContacts") return false;
          return true;
        }
      );

      const handler = registeredHandlers.get("contacts:syncExternal");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.inserted).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.total).toBe(0);
      // Verify macOS contacts API was NOT called
      expect(mockContactsService.getContactNames).not.toHaveBeenCalled();
    });

    it("should proceed with sync when macOS contacts source is enabled", async () => {
      mockIsContactSourceEnabled.mockResolvedValue(true);
      // BACKLOG-2404: built through the typed factory, so the required-field
      // contract is enforced at the factory's return annotation rather than
      // waved through by an `as any` (see readerResult's header).
      mockContactsService.getContactNames.mockResolvedValue(
        readerResult({
          phoneToContactInfo: {
            "+1234567890": {
              name: "Test Contact",
              phones: ["+1234567890"],
              emails: ["test@example.com"],
              company: "Test Corp",
              recordId: "rec-1",
            },
          },
          status: { contactCount: 1, booksFound: 3, booksRead: 3 },
        }),
      );

      const handler = registeredHandlers.get("contacts:syncExternal");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(mockContactsService.getContactNames).toHaveBeenCalled();
    });

    /**
     * BACKLOG-2404 — the coverage has to survive the IPC hop.
     *
     * The reader knowing "read 2 of 3" is worth nothing if the handler drops
     * it: Settings is the surface the user actually looks at, and it was
     * discarding this result entirely.
     */
    it("forwards a PARTIAL address-book read to the renderer", async () => {
      mockIsContactSourceEnabled.mockResolvedValue(true);
      mockContactsService.getContactNames.mockResolvedValue(
        readerResult({
          phoneToContactInfo: {
            "+1234567890": { name: "Test Contact", phones: ["+1234567890"], emails: [], recordId: "rec-1" },
          },
          status: {
            contactCount: 1,
            booksFound: 3,
            booksRead: 2,
            booksFailed: 1,
            coverage: "partial",
            failures: [{ path: "Sources/1DB81…/AddressBook-v22.abcddb", reason: "read-error" }],
          },
        }),
      );

      const handler = registeredHandlers.get("contacts:syncExternal");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.read).toEqual({ found: 3, read: 2, failed: 1, coverage: "partial" });
    });

    it("OMITS coverage rather than inventing zeros when the reader did not report it", async () => {
      // Defaulting to zeros would fabricate a measurement, and `read 0 of 0` is
      // indistinguishable from "we never looked" — the ambiguity this epic
      // exists to delete. Absent means unreported; the panel then draws nothing.
      mockIsContactSourceEnabled.mockResolvedValue(true);
      mockContactsService.getContactNames.mockResolvedValue(
        readerResultWithoutStatus({
          phoneToContactInfo: {
            "+1234567890": { name: "Test Contact", phones: ["+1234567890"], emails: [], recordId: "rec-1" },
          },
        }),
      );

      const handler = registeredHandlers.get("contacts:syncExternal");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.read).toBeUndefined();
    });
  });

  describe("contacts:syncOutlookContacts (preference gating)", () => {
    it("should skip sync when Outlook contacts source is disabled", async () => {
      mockIsContactSourceEnabled.mockImplementation(
        async (_userId: string, _category: string, key: string) => {
          if (key === "outlookContacts") return false;
          return true;
        }
      );

      const handler = registeredHandlers.get("contacts:syncOutlookContacts");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
    });
  });

  // BACKLOG-2142: the sync handlers must forward the typed `tokenExpired`
  // discriminator from contactSyncService so the renderer can render a
  // provider-aware reconnect CTA.
  describe("contacts sync handlers forward tokenExpired (BACKLOG-2142)", () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("syncOutlookContacts forwards tokenExpired + reconnectRequired from the service", async () => {
      mockIsContactSourceEnabled.mockResolvedValue(true);
      jest.spyOn(contactSyncService, "syncProvider").mockResolvedValue({
        source: "outlook",
        success: false,
        count: 0,
        tokenExpired: true,
        reconnectRequired: true,
        error: "Outlook token expired",
      });

      const handler = registeredHandlers.get("contacts:syncOutlookContacts");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(false);
      expect(result.tokenExpired).toBe(true);
      expect(result.reconnectRequired).toBe(true);
      expect(result.error).toContain("Outlook token expired");
    });

    it("syncGoogleContacts forwards tokenExpired from the service", async () => {
      mockIsContactSourceEnabled.mockResolvedValue(true);
      jest.spyOn(contactSyncService, "syncProvider").mockResolvedValue({
        source: "google_contacts",
        success: false,
        count: 0,
        tokenExpired: true,
        error: "Gmail token expired",
      });

      const handler = registeredHandlers.get("contacts:syncGoogleContacts");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(false);
      expect(result.tokenExpired).toBe(true);
      expect(result.error).toContain("Gmail token expired");
    });

    it("syncOutlookContacts omits tokenExpired on a clean success", async () => {
      mockIsContactSourceEnabled.mockResolvedValue(true);
      jest.spyOn(contactSyncService, "syncProvider").mockResolvedValue({
        source: "outlook",
        success: true,
        count: 7,
      });

      const handler = registeredHandlers.get("contacts:syncOutlookContacts");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.count).toBe(7);
      expect(result.tokenExpired).toBeUndefined();
    });
  });

  describe("contacts:get-available (preference gating)", () => {
    it("should skip iPhone DB contacts when both macOS and iPhone sources are disabled", async () => {
      mockIsContactSourceEnabled.mockImplementation(
        async (_userId: string, _category: string, key: string) => {
          if (key === "macosContacts") return false;
          if (key === "iphoneContacts") return false;
          return true;
        }
      );
      mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

      const handler = registeredHandlers.get("contacts:get-available");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      // getUnimportedContactsByUserId should NOT be called when both sources are disabled
      expect(mockDatabaseService.getUnimportedContactsByUserId).not.toHaveBeenCalled();
    });

    it("should include iPhone DB contacts when iphoneContacts is enabled but macOS is disabled", async () => {
      mockIsContactSourceEnabled.mockImplementation(
        async (_userId: string, _category: string, key: string) => {
          if (key === "macosContacts") return false;
          return true; // iphoneContacts returns true
        }
      );
      mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);
      mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);

      const handler = registeredHandlers.get("contacts:get-available");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      // getUnimportedContactsByUserId SHOULD be called when iphoneContacts is enabled
      expect(mockDatabaseService.getUnimportedContactsByUserId).toHaveBeenCalled();
    });

    it("should include iPhone DB contacts when macOS source is enabled", async () => {
      mockIsContactSourceEnabled.mockResolvedValue(true);
      mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);
      mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
        {
          id: "iphone-1",
          name: "iPhone Contact",
          email: "iphone@example.com",
          phone: "+1234567890",
        } as Contact,
      ]);

      const handler = registeredHandlers.get("contacts:get-available");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(mockDatabaseService.getUnimportedContactsByUserId).toHaveBeenCalled();
      expect(result.contacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "iPhone Contact" }),
        ])
      );
    });

    it("should filter out outlook contacts from shadow table when outlook source is disabled", async () => {
      // Enable macOS but disable Outlook
      mockIsContactSourceEnabled.mockImplementation(
        async (_userId: string, _category: string, key: string) => {
          if (key === "outlookContacts") return false;
          return true;
        }
      );
      mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);
      mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);

      // Set up shadow table with both macOS and Outlook contacts
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const externalContactDb = require("../services/db/externalContactDbService");
      (externalContactDb.getCount as jest.Mock).mockReturnValue(2);
      // TASK-1956: Handler now uses getAllForUserAsync (worker thread)
      (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
        {
          id: "ext-1",
          name: "Mac Contact",
          phones: ["+1111111111"],
          emails: ["mac@example.com"],
          source: "contacts_app",
          company: null,
          last_message_at: null,
        },
        {
          id: "ext-2",
          name: "Outlook Contact",
          phones: ["+2222222222"],
          emails: ["outlook@example.com"],
          source: "outlook",
          company: null,
          last_message_at: null,
        },
      ]);

      const handler = registeredHandlers.get("contacts:get-available");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      // Should include macOS contact but NOT Outlook contact
      const contactNames = result.contacts.map((c: any) => c.name);
      expect(contactNames).toContain("Mac Contact");
      expect(contactNames).not.toContain("Outlook Contact");
    });

    it("should return all contacts when no preferences are set (default behavior)", async () => {
      // All sources enabled by default
      mockIsContactSourceEnabled.mockResolvedValue(true);
      mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);
      mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
        {
          id: "iphone-1",
          name: "iPhone Contact",
          email: "iphone@example.com",
          phone: "+1234567890",
        } as Contact,
      ]);

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const externalContactDb = require("../services/db/externalContactDbService");
      (externalContactDb.getCount as jest.Mock).mockReturnValue(1);
      // TASK-1956: Handler now uses getAllForUserAsync (worker thread)
      (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
        {
          id: "ext-1",
          name: "Outlook Contact",
          phones: ["+2222222222"],
          emails: ["outlook@example.com"],
          source: "outlook",
          company: null,
          last_message_at: null,
        },
      ]);

      const handler = registeredHandlers.get("contacts:get-available");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      const contactNames = result.contacts.map((c: any) => c.name);
      expect(contactNames).toContain("iPhone Contact");
      expect(contactNames).toContain("Outlook Contact");
    });
  });

  /**
   * BACKLOG-2478: every source is gated BY ITS OWN PREFERENCE.
   *
   * `android_sync` had no named branch and fell to a catch-all that decided its
   * visibility from the *macOS* preference. That is wrong on its own terms, but
   * it did NOT black out Android on Windows: `macosContacts` is never written
   * there (platform-filtered in onboarding, `isMacOS`-gated in Settings) and
   * `isContactSourceEnabled` fails open, so `macosEnabled` is `true` on Windows
   * and the catch-all never fired. It fired only for users who explicitly
   * disabled the Mac address book.
   *
   * What this change buys is that the picker no longer depends on a fail-open
   * default of an unrelated preference to be correct.
   *
   * The corpus carries one record per source plus one deliberately unrecognised
   * source. Every record has a DISTINCT name, email and phone so that no
   * assertion here can be satisfied by the dedup or already-imported paths — if
   * a record is missing from the returned set, the source filter dropped it.
   */
  describe("BACKLOG-2478: per-source picker gating", () => {
    /** Every id in the corpus, so "absent" is always proved against a known whole. */
    const ALL_IDS = [
      "ext-android",
      "ext-google",
      "ext-iphone",
      "ext-macos",
      "ext-outlook",
      "ext-unknown",
    ];

    beforeEach(() => {
      resetContactIngestionFunnel();
      mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);
      mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const externalContactDb = require("../services/db/externalContactDbService");
      (externalContactDb.getCount as jest.Mock).mockReturnValue(6);
      (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
        {
          id: "ext-macos", user_id: TEST_USER_ID, name: "Mac Person",
          phones: ["+15551110001"], emails: ["mac@example.com"],
          external_record_id: "rec-macos", external_uuid: null,
          source: "macos", company: null, last_message_at: null,
          synced_at: new Date().toISOString(),
        },
        {
          id: "ext-iphone", user_id: TEST_USER_ID, name: "iPhone Person",
          phones: ["+15551110002"], emails: ["iphone@example.com"],
          external_record_id: "rec-iphone", external_uuid: null,
          source: "iphone", company: null, last_message_at: null,
          synced_at: new Date().toISOString(),
        },
        {
          id: "ext-outlook", user_id: TEST_USER_ID, name: "Outlook Person",
          phones: ["+15551110003"], emails: ["outlook@example.com"],
          external_record_id: "rec-outlook", external_uuid: null,
          source: "outlook", company: null, last_message_at: null,
          synced_at: new Date().toISOString(),
        },
        {
          id: "ext-google", user_id: TEST_USER_ID, name: "Google Person",
          phones: ["+15551110004"], emails: ["google@example.com"],
          external_record_id: "rec-google", external_uuid: null,
          source: "google_contacts", company: null, last_message_at: null,
          synced_at: new Date().toISOString(),
        },
        {
          id: "ext-android", user_id: TEST_USER_ID, name: "Android Person",
          phones: ["+15551110005"], emails: ["android@example.com"],
          external_record_id: "rec-android", external_uuid: "uuid-android",
          source: "android_sync", company: null, last_message_at: null,
          synced_at: new Date().toISOString(),
        },
        {
          id: "ext-unknown", user_id: TEST_USER_ID, name: "Unknown Person",
          phones: ["+15551110006"], emails: ["unknown@example.com"],
          external_record_id: "rec-unknown", external_uuid: null,
          // Deliberately outside EXTERNAL_SOURCE_TYPES. `external_contacts.source`
          // is `TEXT DEFAULT 'macos'` with NO CHECK constraint (schema.sql:1262),
          // so this is a reachable state, not a hypothetical one.
          source: "carrier_pigeon", company: null, last_message_at: null,
          synced_at: new Date().toISOString(),
        },
      ]);
    });

    /** Enable exactly the named preference keys; everything else is OFF. */
    function enableOnly(...keys: string[]) {
      mockIsContactSourceEnabled.mockImplementation(
        async (_u: string, _c: string, key: string) => keys.includes(key),
      );
    }

    async function getAvailable() {
      const handler = registeredHandlers.get("contacts:get-available");
      return handler(mockEvent, TEST_USER_ID);
    }

    async function shownIds(): Promise<string[]> {
      const result = await getAvailable();
      expect(result.success).toBe(true);
      return result.contacts.map((c: { id: string }) => c.id).sort();
    }

    describe("android_sync is gated when macOS is explicitly disabled", () => {
      /**
       * NOTE ON WHAT THIS BLOCK DOES AND DOES NOT PROVE.
       *
       * `enableOnly()` forces every unnamed key to `false`. That models a user
       * who EXPLICITLY switched the Mac address book off — 2 of 13 production
       * preference rows, both macOS users. It is NOT what a Windows machine
       * looks like: there `macosContacts` is never written at all, and
       * `isContactSourceEnabled` fails open to `true`.
       *
       * An earlier revision of this file described these as "the founder's case:
       * Windows", which was wrong and helped a false root cause survive review.
       * The Windows configuration is covered by the
       * "real preference semantics" block below, which honours the default
       * argument instead of discarding it. Do not reintroduce the Windows
       * framing here.
       */
      it("returns the Android contact when macOS and iPhone are both disabled", async () => {
        enableOnly("androidContacts", "outlookContacts", "googleContacts");

        // Identity, not count. A count of 4 is equally satisfied by returning
        // ext-macos instead of ext-android, which is the exact wrong answer.
        expect(await shownIds()).toEqual([
          "ext-android",
          "ext-google",
          "ext-outlook",
          "ext-unknown",
        ]);
      });

      it("returns the Android contact even when it is the ONLY enabled source", async () => {
        // The narrowest statement of the bug: nothing but Android is on, and
        // the picker must not come back without it.
        enableOnly("androidContacts");

        expect(await shownIds()).toEqual(["ext-android", "ext-unknown"]);
      });

      it("does not count the Android contact as source-disabled", async () => {
        enableOnly("androidContacts", "outlookContacts", "googleContacts");
        await getAvailable();

        const picker = getContactIngestionFunnel().picker;
        expect(picker).toBeDefined();
        // ext-macos + ext-iphone only. Counting ext-android here would be the
        // funnel lying about a record the user can actually see (BACKLOG-2391).
        expect(picker!.sourceDisabled).toBe(2);
        expect(picker!.shown).toBe(4);
      });

      it("carries the Android record's source identity through to import", async () => {
        // These rows never used to reach the push site, so the identity fields
        // are asserted rather than assumed. `android_sync` is in
        // EXTERNAL_SOURCE_TYPES, so it must NOT be flattened to contacts_app.
        enableOnly("androidContacts");
        const result = await getAvailable();
        const android = result.contacts.find((c: { id: string }) => c.id === "ext-android");

        expect(android).toBeDefined();
        expect(android.source).toBe("android_sync");
        expect(android.externalRecordId).toBe("rec-android");
        expect(android.externalSourceType).toBe("android_sync");
        expect(android.collapsedSources).toEqual([
          { sourceType: "android_sync", sourceRecordId: "rec-android", externalUuid: "uuid-android" },
        ]);
      });
    });

    describe("android_sync respects its own preference", () => {
      it("hides the Android contact when androidContacts is disabled", async () => {
        enableOnly("outlookContacts", "googleContacts");

        const ids = await shownIds();
        expect(ids).not.toContain("ext-android");
        expect(ids).toEqual(["ext-google", "ext-outlook", "ext-unknown"]);
      });

      it("counts the disabled Android contact as source-disabled", async () => {
        enableOnly("outlookContacts", "googleContacts");
        await getAvailable();

        const picker = getContactIngestionFunnel().picker;
        // ext-macos + ext-iphone + ext-android.
        expect(picker!.sourceDisabled).toBe(3);
        expect(picker!.shown).toBe(3);
      });

      it("hides the Android contact even when macOS is enabled", async () => {
        // The preference is the ONLY thing that decides this now. Under the old
        // catch-all, macOS being on was enough to show an Android record — the
        // same wrong coupling as the bug, in the permissive direction.
        enableOnly("macosContacts", "iphoneContacts");

        const ids = await shownIds();
        expect(ids).not.toContain("ext-android");
        expect(ids).toEqual(["ext-iphone", "ext-macos", "ext-unknown"]);
      });
    });

    describe("the other four sources are gated exactly as before", () => {
      it("shows every source when all preferences are on", async () => {
        mockIsContactSourceEnabled.mockResolvedValue(true);
        expect(await shownIds()).toEqual(ALL_IDS);
      });

      it("hides outlook when outlookContacts is off", async () => {
        enableOnly("macosContacts", "iphoneContacts", "googleContacts", "androidContacts");
        expect(await shownIds()).not.toContain("ext-outlook");
      });

      it("hides google_contacts when googleContacts is off", async () => {
        enableOnly("macosContacts", "iphoneContacts", "outlookContacts", "androidContacts");
        expect(await shownIds()).not.toContain("ext-google");
      });

      it("hides macos when macosContacts is off", async () => {
        enableOnly("iphoneContacts", "outlookContacts", "googleContacts", "androidContacts");
        expect(await shownIds()).not.toContain("ext-macos");
      });

      it("keeps the iphone OR-rule: shown when macOS is on but iPhone is off", async () => {
        // Pre-existing behaviour: `iphone && !iphoneEnabled && !macosEnabled`.
        // The Mac address book being enabled is enough to show an iPhone record,
        // because on macOS they are the same address book. Unchanged here.
        enableOnly("macosContacts");
        expect(await shownIds()).toContain("ext-iphone");
      });

      it("keeps the iphone OR-rule: hidden only when BOTH macOS and iPhone are off", async () => {
        enableOnly("outlookContacts");
        expect(await shownIds()).not.toContain("ext-iphone");
      });
    });

    describe("an unrecognised source is shown, not silently dropped", () => {
      it("shows the unknown source when macOS is disabled", async () => {
        // This is the branch that produced the bug. Under the old catch-all an
        // unrecognised source vanished on every Windows machine, with no error
        // and no counter — the failure mode that let BACKLOG-2478 reach the field.
        enableOnly("androidContacts");
        expect(await shownIds()).toContain("ext-unknown");
      });

      it("does not count the unknown source as source-disabled", async () => {
        enableOnly("androidContacts");
        await getAvailable();

        const picker = getContactIngestionFunnel().picker;
        // Shown records must never be counted as suppressed, or the funnel
        // cannot distinguish "missing" from "never read" (BACKLOG-2391).
        expect(picker!.sourceDisabled).toBe(4); // macos, iphone, outlook, google
        expect(picker!.shown).toBe(2);          // android + unknown
      });
    });

    describe("the funnel arithmetic still closes", () => {
      it.each([
        ["Android only", ["androidContacts"]],
        ["Android + cloud", ["androidContacts", "outlookContacts", "googleContacts"]],
        ["Android off", ["outlookContacts", "googleContacts"]],
        ["all sources on", ["macosContacts", "iphoneContacts", "outlookContacts", "googleContacts", "androidContacts"]],
      ])("balances for %s", async (_label, keys) => {
        enableOnly(...(keys as string[]));
        await getAvailable();

        const picker = getContactIngestionFunnel().picker;
        expect(picker!.externalRowsIn).toBe(6);
        expect(
          picker!.rowsIn -
            picker!.sourceDisabled -
            picker!.alreadyImported -
            picker!.duplicateSuppressed,
        ).toBe(picker!.shown);
      });

      /**
       * The cases above cannot detect a mis-count in `alreadyImported` or
       * `duplicateSuppressed`: the corpus gives every record a distinct
       * identity and mocks the imported/unimported DB reads to `[]`, so both
       * terms are always 0 and the assertion degenerates to
       * `6 - sourceDisabled === shown`.
       *
       * This case makes all four terms non-zero WITH an Android record present,
       * so the invariant is actually load-bearing.
       */
      it("balances when every drop reason is non-zero and Android is in the mix", async () => {
        enableOnly("androidContacts", "outlookContacts", "googleContacts");

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue([
          {
            id: "ext-android", user_id: TEST_USER_ID, name: "Android Person",
            phones: ["+15551110005"], emails: ["android@example.com"],
            external_record_id: "rec-android", external_uuid: "uuid-android",
            source: "android_sync", company: null, last_message_at: null,
            synced_at: new Date().toISOString(),
          },
          {
            // Source disabled: macos is off under enableOnly above.
            id: "ext-macos", user_id: TEST_USER_ID, name: "Mac Person",
            phones: ["+15551110001"], emails: ["mac@example.com"],
            external_record_id: "rec-macos", external_uuid: null,
            source: "macos", company: null, last_message_at: null,
            synced_at: new Date().toISOString(),
          },
          {
            // Already imported: email matches the imported contact below.
            id: "ext-imported", user_id: TEST_USER_ID, name: "Imported Person",
            phones: ["+15551110007"], emails: ["imported@example.com"],
            external_record_id: "rec-imported", external_uuid: null,
            source: "android_sync", company: null, last_message_at: null,
            synced_at: new Date().toISOString(),
          },
          {
            // Duplicate: shares ext-android's email, so it collapses into it.
            id: "ext-dup", user_id: TEST_USER_ID, name: "Android Person",
            phones: ["+15551110008"], emails: ["android@example.com"],
            external_record_id: "rec-dup", external_uuid: null,
            source: "android_sync", company: null, last_message_at: null,
            synced_at: new Date().toISOString(),
          },
        ]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([
          { id: "imp-1", name: "Imported Person", email: "imported@example.com", phone: "+15551110007" } as Contact,
        ]);

        const result = await getAvailable();
        expect(result.contacts.map((c: { id: string }) => c.id).sort()).toEqual(["ext-android"]);

        const picker = getContactIngestionFunnel().picker;
        expect(picker!.sourceDisabled).toBe(1);      // ext-macos
        expect(picker!.alreadyImported).toBe(1);     // ext-imported
        expect(picker!.duplicateSuppressed).toBe(1); // ext-dup
        expect(picker!.shown).toBe(1);
        expect(
          picker!.rowsIn -
            picker!.sourceDisabled -
            picker!.alreadyImported -
            picker!.duplicateSuppressed,
        ).toBe(picker!.shown);
      });
    });

    /**
     * REAL PREFERENCE SEMANTICS — the block that would have caught the
     * misdiagnosis this PR originally shipped with.
     *
     * `enableOnly()` above forces every unnamed key to `false` and DISCARDS the
     * `defaultValue` argument. No real machine is ever in that state, and the
     * discarded argument is exactly where the truth lives: a key that onboarding
     * never wrote is ABSENT, and `isContactSourceEnabled` returns the caller's
     * default for absent keys.
     *
     * `withStoredPreferences` mirrors `preferenceHelper.ts:36-37` exactly, so
     * these cases exercise the same fail-open path production does — and a
     * change of the handler's default from `true` to `false` turns them red,
     * which under `enableOnly()` it would not.
     */
    describe("real preference semantics (stored[key] ?? defaultValue)", () => {
      /** Exactly `preferenceHelper.ts:36-37`. Honours the 4th argument. */
      function withStoredPreferences(stored: Record<string, boolean>) {
        mockIsContactSourceEnabled.mockImplementation(
          async (_u: string, _c: string, key: string, defaultValue: boolean) =>
            typeof stored[key] === "boolean" ? stored[key] : defaultValue,
        );
      }

      it("reads androidContacts with a default of TRUE", async () => {
        // The default argument is the whole mechanism. If someone "tightens"
        // this to false, every absent-key user loses their Android contacts —
        // and no enableOnly()-based test would notice.
        withStoredPreferences({});
        await getAvailable();

        expect(mockIsContactSourceEnabled).toHaveBeenCalledWith(
          TEST_USER_ID,
          "direct",
          "androidContacts",
          true,
        );
      });

      it("shows Android for a Windows + Android user (exactly the keys onboarding writes)", async () => {
        // On Windows, `visibleSources` excludes macosContacts (platforms:
        // ["macos"]) and iphoneContacts (phoneType: "iphone"), so onboarding
        // writes only these three. macos/iphone are ABSENT, not false — which
        // is why they are shown too, and why the old catch-all never fired here.
        withStoredPreferences({
          androidContacts: true,
          googleContacts: true,
          outlookContacts: true,
        });

        expect(await shownIds()).toEqual(ALL_IDS);
      });

      it("shows Android for a Windows + iPhone user who later pairs Android", async () => {
        // THE DISPROOF OF THE "KNOWN LIMITATION" THIS PR ONCE CLAIMED.
        //
        // androidContacts has `phoneType: "android"`, so an iPhone-declaring
        // user never has it written. Absent -> default true -> SHOWN. There is
        // no stored `false` to strand them, and zero production rows have one.
        withStoredPreferences({
          iphoneContacts: true,
          outlookContacts: true,
          googleContacts: false,
        });

        const ids = await shownIds();
        expect(ids).toContain("ext-android");
        expect(ids).not.toContain("ext-google");
      });

      it("hides Android only when the preference is EXPLICITLY false", async () => {
        withStoredPreferences({
          macosContacts: true,
          iphoneContacts: true,
          outlookContacts: true,
          googleContacts: true,
          androidContacts: false,
        });

        const ids = await shownIds();
        expect(ids).not.toContain("ext-android");
        expect(ids).toEqual(["ext-google", "ext-iphone", "ext-macos", "ext-outlook", "ext-unknown"]);
      });

      it("shows Android when macOS is explicitly disabled but Android is absent", async () => {
        // The only configuration in which the old catch-all actually fired:
        // a user who deliberately turned the Mac address book off. Android is
        // absent -> true -> shown. Base behaviour dropped it here.
        withStoredPreferences({ macosContacts: false });

        expect(await shownIds()).toContain("ext-android");
      });
    });

    /**
     * BACKLOG-2478: a NULL source is the one state the "visible but auditable"
     * argument cannot afford to lose, because a nullable column with no CHECK
     * is what that argument leans on. `external_contacts.source` is
     * `TEXT DEFAULT 'macos'` with neither constraint, and
     * `externalContactDbService` casts `row.source as ExternalContactSource`
     * over it — so the union type is a promise the database does not keep.
     */
    describe("null and unrecognised sources are shown AND logged", () => {
      function withCorpus(rows: Array<Record<string, unknown>>) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const externalContactDb = require("../services/db/externalContactDbService");
        (externalContactDb.getAllForUserAsync as jest.Mock).mockResolvedValue(rows);
      }

      function row(id: string, source: string | null, n: number) {
        return {
          id, user_id: TEST_USER_ID, name: `Person ${n}`,
          phones: [`+1555222000${n}`], emails: [`p${n}@example.com`],
          external_record_id: `rec-${id}`, external_uuid: null,
          source, company: null, last_message_at: null,
          synced_at: new Date().toISOString(),
        };
      }

      it("shows a record whose source is NULL", async () => {
        mockIsContactSourceEnabled.mockResolvedValue(true);
        withCorpus([row("ext-null", null, 1)]);

        const result = await getAvailable();
        expect(result.contacts.map((c: { id: string }) => c.id)).toEqual(["ext-null"]);
      });

      it("logs the NULL source under a sentinel rather than staying silent", async () => {
        mockIsContactSourceEnabled.mockResolvedValue(true);
        withCorpus([row("ext-null", null, 1)]);
        await getAvailable();

        const warned = (logService.warn as jest.Mock).mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes("unrecognised source"));
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain("(null/empty)");
      });

      it("does not count a NULL-source record as source-disabled", async () => {
        mockIsContactSourceEnabled.mockResolvedValue(true);
        withCorpus([row("ext-null", null, 1)]);
        await getAvailable();

        const picker = getContactIngestionFunnel().picker;
        expect(picker!.sourceDisabled).toBe(0);
        expect(picker!.shown).toBe(1);
      });

      it("warns ONCE for two records sharing one unrecognised source", async () => {
        // The loop runs over ~1000 rows; a per-record line would be a log flood.
        mockIsContactSourceEnabled.mockResolvedValue(true);
        withCorpus([row("ext-p1", "carrier_pigeon", 1), row("ext-p2", "carrier_pigeon", 2)]);

        const result = await getAvailable();
        expect(result.contacts.map((c: { id: string }) => c.id).sort()).toEqual(["ext-p1", "ext-p2"]);

        const warned = (logService.warn as jest.Mock).mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes("unrecognised source"));
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain("1 unrecognised source(s): carrier_pigeon");
      });

      it("lists each distinct unrecognised source once, sorted", async () => {
        mockIsContactSourceEnabled.mockResolvedValue(true);
        withCorpus([
          row("ext-p1", "zebra_sync", 1),
          row("ext-p2", "carrier_pigeon", 2),
          row("ext-p3", null, 3),
        ]);
        await getAvailable();

        const warned = (logService.warn as jest.Mock).mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes("unrecognised source"));
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain("3 unrecognised source(s): (null/empty), carrier_pigeon, zebra_sync");
      });

      it("says nothing when every source is recognised", async () => {
        mockIsContactSourceEnabled.mockResolvedValue(true);
        withCorpus([row("ext-a", "android_sync", 1), row("ext-m", "macos", 2)]);
        await getAvailable();

        const warned = (logService.warn as jest.Mock).mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes("unrecognised source"));
        expect(warned).toHaveLength(0);
      });
    });
  });

  // TASK-1991: Contact source stats tests
  describe("contacts:getSourceStats", () => {
    it("should return per-source contact counts", async () => {
      const externalContactDb = require("../services/db/externalContactDbService");
      (externalContactDb.getContactSourceStats as jest.Mock).mockReturnValue({
        macos: 42,
        iphone: 15,
        outlook: 8,
      });

      const handler = registeredHandlers.get("contacts:getSourceStats");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.stats).toEqual({ macos: 42, iphone: 15, outlook: 8 });
    });

    it("should return zeros when no contacts exist", async () => {
      const externalContactDb = require("../services/db/externalContactDbService");
      (externalContactDb.getContactSourceStats as jest.Mock).mockReturnValue({
        macos: 0,
        iphone: 0,
        outlook: 0,
      });

      const handler = registeredHandlers.get("contacts:getSourceStats");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.stats).toEqual({ macos: 0, iphone: 0, outlook: 0 });
    });

    it("should return error for invalid user", async () => {
      const handler = registeredHandlers.get("contacts:getSourceStats");
      const result = await handler(mockEvent, "invalid-user-id");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // BACKLOG-1933: contact-scoped emails/texts
  describe("contacts:get-emails", () => {
    it("returns hydrated emails on success", async () => {
      const emails = [
        { id: "email-1", subject: "Hi", sender: "a@x.com", has_attachments: false },
      ];
      mockDatabaseService.getEmailsForContact.mockResolvedValue(emails as never);

      const handler = registeredHandlers.get("contacts:get-emails");
      const result = await handler(mockEvent, TEST_CONTACT_ID);

      expect(result.success).toBe(true);
      expect(result.emails).toEqual(emails);
      expect(mockDatabaseService.getEmailsForContact).toHaveBeenCalledWith(
        TEST_CONTACT_ID,
      );
    });

    it("returns a validation error for an invalid contact id (no silent catch)", async () => {
      const handler = registeredHandlers.get("contacts:get-emails");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockDatabaseService.getEmailsForContact).not.toHaveBeenCalled();
    });

    it("surfaces service errors as { success:false, error } (not swallowed)", async () => {
      mockDatabaseService.getEmailsForContact.mockRejectedValue(
        new Error("db down"),
      );

      const handler = registeredHandlers.get("contacts:get-emails");
      const result = await handler(mockEvent, TEST_CONTACT_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("db down");
      expect(mockLogService.error).toHaveBeenCalled();
    });
  });

  describe("contacts:get-messages", () => {
    it("returns thread groups on success", async () => {
      const threads = [
        {
          thread_id: "t1",
          phoneNumber: "+14155550001",
          messages: [{ id: "m1", has_attachments: false }],
          transaction_id: undefined,
        },
      ];
      mockDatabaseService.getMessagesForContact.mockResolvedValue(
        threads as never,
      );

      const handler = registeredHandlers.get("contacts:get-messages");
      const result = await handler(mockEvent, TEST_CONTACT_ID);

      expect(result.success).toBe(true);
      expect(result.messages).toEqual(threads);
      expect(mockDatabaseService.getMessagesForContact).toHaveBeenCalledWith(
        TEST_CONTACT_ID,
      );
    });

    it("returns a validation error for an invalid contact id", async () => {
      const handler = registeredHandlers.get("contacts:get-messages");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockDatabaseService.getMessagesForContact).not.toHaveBeenCalled();
    });

    it("surfaces service errors as { success:false, error }", async () => {
      mockDatabaseService.getMessagesForContact.mockRejectedValue(
        new Error("scan failed"),
      );

      const handler = registeredHandlers.get("contacts:get-messages");
      const result = await handler(mockEvent, TEST_CONTACT_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("scan failed");
      expect(mockLogService.error).toHaveBeenCalled();
    });
  });
});
