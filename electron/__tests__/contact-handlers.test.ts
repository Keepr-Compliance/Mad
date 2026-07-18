/**
 * Unit tests for Contact Handlers
 * Tests contact IPC handlers including:
 * - CRUD operations
 * - Contact import
 * - Activity-based sorting
 * - Delete protection
 */

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
    backfillContactEngagementTimestamps: jest.fn(),
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
import auditService from "../services/auditService";
import logService from "../services/logService";

// Get typed references to mocked services
const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;
const mockContactsService = {
  getContactNames: getContactNames as jest.MockedFunction<
    typeof getContactNames
  >,
};
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
  let registeredHandlers: Map<string, Function>;
  const mockEvent = {} as IpcMainInvokeEvent;

  beforeAll(() => {
    // Capture registered handlers
    registeredHandlers = new Map();
    mockIpcHandle.mockImplementation((channel: string, handler: Function) => {
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
      ];
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
        { name: "John Doe", email: "john@example.com" },
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
          },
        ]);
        mockContactsService.getContactNames.mockResolvedValue({
          phoneToContactInfo: {
            "555-9999": {
              name: "John D.", // Slightly different name
              phones: ["555-9999"],
              emails: ["john@example.com"], // Same email
            },
          },
          status: "loaded",
        });
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
          },
        ]);
        mockContactsService.getContactNames.mockResolvedValue({
          phoneToContactInfo: {
            "555-9999": {
              name: "John D.",
              phones: ["555-9999"],
              emails: ["john@example.com"], // Same email, different case
            },
          },
          status: "loaded",
        });
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
          },
        ]);
        mockContactsService.getContactNames.mockResolvedValue({
          phoneToContactInfo: {
            "(555) 123-4567": {
              name: "Jane S.", // Slightly different name
              phones: ["(555) 123-4567"], // Same phone, different format
              emails: ["janes@other.com"], // Different email
            },
          },
          status: "loaded",
        });
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        // Should only have 1 contact (iPhone-synced takes precedence)
        expect(result.contacts).toHaveLength(1);
        expect(result.contacts[0].id).toBe("db-1");
      });

      it("should handle phone numbers with and without country code", async () => {
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          { id: "db-1", name: "Bob Jones", phone: "5559876543" }, // No country code
        ]);
        mockContactsService.getContactNames.mockResolvedValue({
          phoneToContactInfo: {
            "+1 555 987 6543": {
              name: "Robert Jones",
              phones: ["+1 555 987 6543"], // With country code
              emails: [],
            },
          },
          status: "loaded",
        });
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.contacts).toHaveLength(1);
        expect(result.contacts[0].id).toBe("db-1");
      });
    });

    describe("deduplication by name (fallback)", () => {
      it("should dedupe contacts with same name when no email or phone overlap", async () => {
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          { id: "db-1", name: "Alice Brown" }, // No email or phone
        ]);
        mockContactsService.getContactNames.mockResolvedValue({
          phoneToContactInfo: {
            "555-0000": {
              name: "Alice Brown", // Same name
              phones: ["555-0000"],
              emails: ["alice@work.com"],
            },
          },
          status: "loaded",
        });
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.contacts).toHaveLength(1);
        expect(result.contacts[0].id).toBe("db-1");
      });

      it("should be case-insensitive when deduping by name", async () => {
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([
          { id: "db-1", name: "CHARLIE DAVIS" },
        ]);
        mockContactsService.getContactNames.mockResolvedValue({
          phoneToContactInfo: {
            "555-1111": {
              name: "charlie davis", // Same name, different case
              phones: ["555-1111"],
              emails: [],
            },
          },
          status: "loaded",
        });
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.contacts).toHaveLength(1);
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
          },
        ]);
        mockContactsService.getContactNames.mockResolvedValue({
          phoneToContactInfo: {
            "555-2222": {
              name: "Priority Contact",
              phones: ["555-2222"],
              emails: ["priority@example.com"],
            },
          },
          status: "loaded",
        });
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
          },
        ]);
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        // Should have both contacts (no deduplication)
        expect(result.contacts).toHaveLength(2);
      });
    });

    describe("already imported contacts filtered by phone", () => {
      it("should filter out macOS contacts if phone matches already imported", async () => {
        mockDatabaseService.getUnimportedContactsByUserId.mockResolvedValue([]);
        mockContactsService.getContactNames.mockResolvedValue({
          phoneToContactInfo: {
            "(555) 333-4444": {
              name: "Already Imported Person",
              phones: ["(555) 333-4444"],
              emails: ["different@email.com"],
            },
          },
          status: "loaded",
        });
        mockDatabaseService.getImportedContactsByUserIdAsync.mockResolvedValue([
          {
            name: "Other Name",
            email: "other@email.com",
            phone: "+15553334444",
          }, // Same phone normalized
        ]);

        const handler = registeredHandlers.get("contacts:get-available");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        // Should be empty - phone matches already imported contact
        expect(result.contacts).toHaveLength(0);
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
        })
        .mockResolvedValueOnce({
          id: "contact-jane",
          name: "Jane Smith",
          email: "jane@example.com",
          phone: "555-5678",
        });

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
      ];
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
      const createdContact = { id: "contact-new", ...validContactData };
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
        });

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
      });

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

    // BACKLOG-1745 Part 2 follow-up: the handler short-circuits when an
    // imported contact with the same display_name already exists. Without
    // backfill, that existing row keeps its NULL engagement timestamps and
    // sinks to the bottom of the unified sort — reproducing the symptom the
    // Part 2 INSERT-path fix was supposed to eliminate.
    describe("duplicate-by-name short-circuit: engagement-timestamp backfill", () => {
      it("backfills NULL last_inbound_at / last_outbound_at on existing imported row when caller supplies them", async () => {
        const existing = {
          id: "existing-contact-id",
          user_id: TEST_USER_ID,
          display_name: "Annie Hamburgen",
          source: "messages",
          last_inbound_at: null,
          last_outbound_at: null,
        };
        const refreshed = {
          ...existing,
          last_inbound_at: "2026-05-31T16:39:50.164Z",
        };
        mockDatabaseService.findContactByName.mockResolvedValue(existing);
        mockDatabaseService.backfillContactEngagementTimestamps.mockResolvedValue(1);
        mockDatabaseService.getContactById.mockResolvedValue(refreshed);

        const handler = registeredHandlers.get("contacts:create");
        const result = await handler(mockEvent, TEST_USER_ID, {
          name: "Annie Hamburgen",
          source: "messages",
          last_communication_at: "2026-05-31T16:39:50.164Z",
          last_inbound_at: null,
          last_outbound_at: null,
        });

        // 1. Backfill was invoked with the synthesized last_inbound_at
        //    (last_communication_at fallback used because last_inbound_at was null)
        expect(mockDatabaseService.backfillContactEngagementTimestamps).toHaveBeenCalledWith(
          "existing-contact-id",
          expect.objectContaining({ last_inbound_at: "2026-05-31T16:39:50.164Z" }),
        );
        // 2. Returned contact reflects the refreshed row, NOT the stale existing one
        expect(result.success).toBe(true);
        expect(result.contact.last_inbound_at).toBe("2026-05-31T16:39:50.164Z");
        // 3. createContact was NOT called (short-circuit was taken)
        expect(mockDatabaseService.createContact).not.toHaveBeenCalled();
      });

      it("does NOT call backfill when caller supplies no timestamps", async () => {
        const existing = {
          id: "existing-contact-id",
          user_id: TEST_USER_ID,
          display_name: "Plain Contact",
          source: "manual",
        };
        mockDatabaseService.findContactByName.mockResolvedValue(existing);

        const handler = registeredHandlers.get("contacts:create");
        const result = await handler(mockEvent, TEST_USER_ID, {
          name: "Plain Contact",
        });

        expect(mockDatabaseService.backfillContactEngagementTimestamps).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.contact).toEqual(existing);
      });

      it("returns existing row unchanged when backfill reports 0 rows changed (e.g. row already had timestamps)", async () => {
        const existing = {
          id: "existing-contact-id",
          user_id: TEST_USER_ID,
          display_name: "Already Stamped",
          source: "messages",
          last_inbound_at: "2026-06-01T00:00:00Z",
        };
        mockDatabaseService.findContactByName.mockResolvedValue(existing);
        mockDatabaseService.backfillContactEngagementTimestamps.mockResolvedValue(0);

        const handler = registeredHandlers.get("contacts:create");
        const result = await handler(mockEvent, TEST_USER_ID, {
          name: "Already Stamped",
          last_communication_at: "2026-05-01T00:00:00Z",
        });

        // Backfill called, but no refresh because COALESCE kept the newer value
        expect(mockDatabaseService.backfillContactEngagementTimestamps).toHaveBeenCalled();
        expect(mockDatabaseService.getContactById).not.toHaveBeenCalled();
        expect(result.contact).toEqual(existing);
      });
    });

    // BACKLOG-1745 Part 2 follow-up #2: live runtime diagnostic on Sue Ubqt
    // (external SMS-derived contact, NEW UUID assigned → findContactByName
    // returned null → create-new path was taken) showed the returned contact
    // had last_inbound_at = null despite caller supplying last_communication_at.
    // Static read says the chain is correct; defensive backfill belt-and-braces
    // guarantees the timestamps land regardless of where it actually breaks.
    describe("create-new path: defensive engagement-timestamp backfill (Sue Ubqt scenario)", () => {
      it("invokes backfill when createContact returns a row with NULL timestamps despite caller supplying last_communication_at", async () => {
        // findContactByName returns null → create-new path executes.
        mockDatabaseService.findContactByName.mockResolvedValue(null);

        // Simulate the live-runtime symptom: createContact succeeds but the
        // returned row has NULL engagement timestamps.
        const createdWithNullTs = {
          id: "new-contact-id",
          user_id: TEST_USER_ID,
          display_name: "Sue ubqt",
          source: "contacts_app",
          last_inbound_at: null,
          last_outbound_at: null,
        };
        mockDatabaseService.createContact.mockResolvedValue(createdWithNullTs);

        // backfillContactEngagementTimestamps reports 1 row changed.
        mockDatabaseService.backfillContactEngagementTimestamps.mockResolvedValue(1);

        const refreshed = {
          ...createdWithNullTs,
          last_inbound_at: "2026-05-29T16:13:31.667Z",
        };
        mockDatabaseService.getContactById.mockResolvedValue(refreshed);

        const handler = registeredHandlers.get("contacts:create");
        const result = await handler(mockEvent, TEST_USER_ID, {
          name: "Sue ubqt",
          source: "contacts_app",
          // Mirrors the renderer payload: only last_communication_at is set
          // (external SMS-derived contacts don't carry per-direction timestamps).
          last_communication_at: "2026-05-29T16:13:31.667Z",
          last_inbound_at: null,
          last_outbound_at: null,
        });

        // 1. createContact was called with last_inbound_at synthesized from
        //    last_communication_at via the handler's ?? chain.
        expect(mockDatabaseService.createContact).toHaveBeenCalledWith(
          expect.objectContaining({
            last_inbound_at: "2026-05-29T16:13:31.667Z",
          }),
        );
        // 2. Defensive backfill fired because the returned row had NULLs.
        expect(mockDatabaseService.backfillContactEngagementTimestamps).toHaveBeenCalledWith(
          "new-contact-id",
          expect.objectContaining({ last_inbound_at: "2026-05-29T16:13:31.667Z" }),
        );
        // 3. Result reflects the refreshed (post-backfill) row.
        expect(result.success).toBe(true);
        expect(result.contact.last_inbound_at).toBe("2026-05-29T16:13:31.667Z");
        // 4. Diagnostic warn was logged (so we can spot this in production logs).
        expect(mockLogService.warn).toHaveBeenCalledWith(
          expect.stringContaining("[BACKLOG-1745 #2]"),
          "Contacts",
        );
      });

      it("does NOT invoke defensive backfill when createContact returns a row with non-NULL timestamps (happy path)", async () => {
        mockDatabaseService.findContactByName.mockResolvedValue(null);
        const createdHappy = {
          id: "new-contact-happy",
          user_id: TEST_USER_ID,
          display_name: "Happy Path",
          source: "contacts_app",
          last_inbound_at: "2026-05-29T16:13:31.667Z",
          last_outbound_at: null,
        };
        mockDatabaseService.createContact.mockResolvedValue(createdHappy);

        const handler = registeredHandlers.get("contacts:create");
        const result = await handler(mockEvent, TEST_USER_ID, {
          name: "Happy Path",
          source: "contacts_app",
          last_communication_at: "2026-05-29T16:13:31.667Z",
        });

        expect(result.success).toBe(true);
        // Backfill should NOT have been called — the row already has the timestamp.
        expect(mockDatabaseService.backfillContactEngagementTimestamps).not.toHaveBeenCalled();
        // No diagnostic warn either.
        expect(mockLogService.warn).not.toHaveBeenCalledWith(
          expect.stringContaining("[BACKLOG-1745 #2]"),
          expect.anything(),
        );
      });

      it("does NOT invoke defensive backfill when caller supplies NO timestamps (manual-add path)", async () => {
        mockDatabaseService.findContactByName.mockResolvedValue(null);
        const createdManual = {
          id: "new-contact-manual",
          user_id: TEST_USER_ID,
          display_name: "Manual Add",
          source: "manual",
          last_inbound_at: null,
          last_outbound_at: null,
        };
        mockDatabaseService.createContact.mockResolvedValue(createdManual);

        const handler = registeredHandlers.get("contacts:create");
        const result = await handler(mockEvent, TEST_USER_ID, {
          name: "Manual Add",
          // No timestamps supplied — defensive backfill should not fire.
        });

        expect(result.success).toBe(true);
        expect(mockDatabaseService.backfillContactEngagementTimestamps).not.toHaveBeenCalled();
      });
    });
  });

  describe("contacts:update", () => {
    const existingContact = {
      id: TEST_CONTACT_ID,
      user_id: TEST_USER_ID,
      name: "Old Name",
      email: "old@example.com",
    };

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
      ];
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
    };

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
        { id: "txn-1" },
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
        { id: "txn-1" },
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
      mockContactsService.getContactNames.mockResolvedValue({
        phoneToContactInfo: {
          "+1234567890": {
            name: "Test Contact",
            phones: ["+1234567890"],
            emails: ["test@example.com"],
            company: "Test Corp",
            recordId: "rec-1",
          },
        },
      } as any);

      const handler = registeredHandlers.get("contacts:syncExternal");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(mockContactsService.getContactNames).toHaveBeenCalled();
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
        },
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
        },
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
