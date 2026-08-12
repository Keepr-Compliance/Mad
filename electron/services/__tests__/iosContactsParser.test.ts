/**
 * Unit tests for iOS Contacts Parser Service
 * Tests parsing of AddressBook.sqlitedb from iOS backups
 */

import type {
  Database as _Database,
  Statement as _Statement,
} from "better-sqlite3";

// Mock data representing iOS AddressBook database structure
const mockContacts = [
  { ROWID: 1, First: "John", Last: "Doe", Organization: null },
  { ROWID: 2, First: "Jane", Last: "Smith", Organization: "Acme Corp" },
  { ROWID: 3, First: null, Last: null, Organization: "Test Company" },
  { ROWID: 4, First: null, Last: null, Organization: null },
];

const mockMultiValues = [
  // John Doe's phone and email
  {
    record_id: 1,
    property: 3,
    label: "_$!<Mobile>!$_",
    value: "(555) 555-0112",
  },
  {
    record_id: 1,
    property: 4,
    label: "_$!<Home>!$_",
    value: "john.doe@example.com",
  },
  // Jane Smith's multiple phones
  {
    record_id: 2,
    property: 3,
    label: "_$!<Work>!$_",
    value: "+1 555 555 0121",
  },
  { record_id: 2, property: 3, label: "_$!<Mobile>!$_", value: "555-555-0104" },
  { record_id: 2, property: 4, label: "_$!<Work>!$_", value: "jane@acme.com" },
  // Test Company's contact info
  { record_id: 3, property: 3, label: null, value: "5555550107" },
  {
    record_id: 3,
    property: 4,
    label: "_$!<Work>!$_",
    value: "info@testcompany.com",
  },
  // Contact with no info (id 4 has nothing)
];

// Mock statement that tracks SQL and returns appropriate data
interface MockStatement {
  get: jest.Mock;
  all: jest.Mock;
  run: jest.Mock;
}

const createMockStatement = (): MockStatement => ({
  get: jest.fn(),
  all: jest.fn(),
  run: jest.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
});

// Track mock database state
let mockPreparedStatements: Map<string, MockStatement>;
let _lastPreparedSQL: string = "";

const createMockDatabase = () => {
  mockPreparedStatements = new Map();

  return {
    prepare: jest.fn((sql: string) => {
      _lastPreparedSQL = sql;
      const stmt = createMockStatement();

      // Configure statement based on SQL query
      if (sql.includes("FROM ABPerson") && sql.includes("ORDER BY ROWID")) {
        // All contacts query
        stmt.all.mockReturnValue(mockContacts);
      } else if (
        sql.includes("FROM ABMultiValue") &&
        sql.includes("ORDER BY mv.record_id")
      ) {
        // All multi-values query
        stmt.all.mockImplementation(() => mockMultiValues);
      } else if (
        sql.includes("FROM ABPerson") &&
        sql.includes("WHERE ROWID = ?")
      ) {
        // Single contact by ID
        stmt.get.mockImplementation(
          (id: number) => mockContacts.find((c) => c.ROWID === id) || null,
        );
      } else if (
        sql.includes("FROM ABMultiValue") &&
        sql.includes("WHERE mv.record_id = ?")
      ) {
        // Multi-values for a specific contact
        stmt.all.mockImplementation((id: number) =>
          mockMultiValues.filter((mv) => mv.record_id === id),
        );
      }

      mockPreparedStatements.set(sql, stmt);
      return stmt;
    }),
    close: jest.fn(),
  };
};

let mockDb: ReturnType<typeof createMockDatabase>;

// Mock electron-log
jest.mock("electron-log", () => ({
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock better-sqlite3-multiple-ciphers
jest.mock("better-sqlite3-multiple-ciphers", () => {
  return jest.fn().mockImplementation(() => {
    mockDb = createMockDatabase();
    return mockDb;
  });
});

// Import after mocks are set up
import { iOSContactsParser } from "../iosContactsParser";

describe("iOSContactsParser", () => {
  let parser: iOSContactsParser;

  beforeEach(() => {
    jest.clearAllMocks();
    parser = new iOSContactsParser();
  });

  afterEach(() => {
    if (parser.isOpen()) {
      parser.close();
    }
  });

  describe("open", () => {
    it("should open the database in readonly mode", () => {
      const Database = require("better-sqlite3-multiple-ciphers");

      parser.open("/path/to/backup");

      expect(Database).toHaveBeenCalledWith(
        expect.stringContaining("31bb7ba8914766d4ba40d6dfb6113c8b614be442"),
        { readonly: true },
      );
    });

    it("should prepare SQL statements on open", () => {
      parser.open("/path/to/backup");

      // Should have prepared statements for contacts and multi-values
      expect(mockDb.prepare).toHaveBeenCalled();
    });

    it("should build lookup indexes on open", () => {
      parser.open("/path/to/backup");

      const stats = parser.getStats();
      expect(stats.contactCount).toBe(mockContacts.length);
      expect(stats.phoneIndexSize).toBeGreaterThan(0);
      expect(stats.emailIndexSize).toBeGreaterThan(0);
    });
  });

  describe("close", () => {
    it("should close the database and clear caches", () => {
      parser.open("/path/to/backup");
      parser.close();

      expect(mockDb.close).toHaveBeenCalled();
      expect(parser.isOpen()).toBe(false);
      expect(parser.getStats().contactCount).toBe(0);
    });
  });

  describe("getAllContacts", () => {
    it("should return all contacts with parsed data", () => {
      parser.open("/path/to/backup");

      const contacts = parser.getAllContacts();

      expect(contacts.length).toBe(mockContacts.length);
    });

    it("should compute display names correctly", () => {
      parser.open("/path/to/backup");

      const contacts = parser.getAllContacts();
      const contactMap = new Map(contacts.map((c) => [c.id, c]));

      // John Doe - has first and last name
      expect(contactMap.get(1)?.displayName).toBe("John Doe");

      // Jane Smith - has first and last name (and org)
      expect(contactMap.get(2)?.displayName).toBe("Jane Smith");

      // Test Company - only has organization
      expect(contactMap.get(3)?.displayName).toBe("Test Company");

      // Unknown - no name or org
      expect(contactMap.get(4)?.displayName).toBe("Unknown");
    });

    it("should parse phone numbers correctly", () => {
      parser.open("/path/to/backup");

      const contacts = parser.getAllContacts();
      const johnDoe = contacts.find((c) => c.id === 1);

      expect(johnDoe?.phoneNumbers.length).toBe(1);
      expect(johnDoe?.phoneNumbers[0].label).toBe("mobile");
      expect(johnDoe?.phoneNumbers[0].number).toBe("(555) 555-0112");
      expect(johnDoe?.phoneNumbers[0].normalizedNumber).toBe("+15555550112");
    });

    it("should parse email addresses correctly", () => {
      parser.open("/path/to/backup");

      const contacts = parser.getAllContacts();
      const johnDoe = contacts.find((c) => c.id === 1);

      expect(johnDoe?.emails.length).toBe(1);
      expect(johnDoe?.emails[0].label).toBe("home");
      expect(johnDoe?.emails[0].email).toBe("john.doe@example.com");
    });

    it("should handle contacts with multiple phones", () => {
      parser.open("/path/to/backup");

      const contacts = parser.getAllContacts();
      const janeSmith = contacts.find((c) => c.id === 2);

      expect(janeSmith?.phoneNumbers.length).toBe(2);
    });
  });

  describe("getContactById", () => {
    it("should return contact from cache", () => {
      parser.open("/path/to/backup");

      const contact = parser.getContactById(1);

      expect(contact).not.toBeNull();
      expect(contact?.id).toBe(1);
      expect(contact?.firstName).toBe("John");
    });

    it("should return null for non-existent contact", () => {
      parser.open("/path/to/backup");

      const contact = parser.getContactById(999);

      expect(contact).toBeNull();
    });
  });

  describe("lookupByPhone", () => {
    it("should find contact by exact phone number", () => {
      parser.open("/path/to/backup");

      const result = parser.lookupByPhone("(555) 555-0112");

      expect(result.contact).not.toBeNull();
      expect(result.contact?.id).toBe(1);
      expect(result.matchedOn).toBe("phone");
    });

    it("should find contact by normalized phone number", () => {
      parser.open("/path/to/backup");

      // Different format but same number
      const result = parser.lookupByPhone("+1 555 555 0112");

      expect(result.contact).not.toBeNull();
      expect(result.contact?.id).toBe(1);
      expect(result.matchedOn).toBe("phone");
    });

    it("should return null for non-existent phone", () => {
      parser.open("/path/to/backup");

      const result = parser.lookupByPhone("1234567890");

      expect(result.contact).toBeNull();
      expect(result.matchedOn).toBeNull();
    });
  });

  describe("lookupByEmail", () => {
    it("should find contact by email (case-insensitive)", () => {
      parser.open("/path/to/backup");

      const result = parser.lookupByEmail("JOHN.DOE@EXAMPLE.COM");

      expect(result.contact).not.toBeNull();
      expect(result.contact?.id).toBe(1);
      expect(result.matchedOn).toBe("email");
    });

    it("should return null for non-existent email", () => {
      parser.open("/path/to/backup");

      const result = parser.lookupByEmail("nonexistent@example.com");

      expect(result.contact).toBeNull();
      expect(result.matchedOn).toBeNull();
    });
  });

  describe("lookupByHandle", () => {
    it("should lookup phone number handles", () => {
      parser.open("/path/to/backup");

      const result = parser.lookupByHandle("5555550112");

      expect(result.contact).not.toBeNull();
      expect(result.matchedOn).toBe("phone");
    });

    it("should lookup email handles", () => {
      parser.open("/path/to/backup");

      const result = parser.lookupByHandle("john.doe@example.com");

      expect(result.contact).not.toBeNull();
      expect(result.matchedOn).toBe("email");
    });

    it("should return null for empty handle", () => {
      parser.open("/path/to/backup");

      const result = parser.lookupByHandle("");

      expect(result.contact).toBeNull();
      expect(result.matchedOn).toBeNull();
    });

    it("should return null for whitespace-only handle", () => {
      parser.open("/path/to/backup");

      const result = parser.lookupByHandle("   ");

      expect(result.contact).toBeNull();
      expect(result.matchedOn).toBeNull();
    });
  });

  describe("label cleaning", () => {
    it("should clean iOS label format", () => {
      parser.open("/path/to/backup");

      const contacts = parser.getAllContacts();
      const johnDoe = contacts.find((c) => c.id === 1);

      // "_$!<Mobile>!$_" should become "mobile"
      expect(johnDoe?.phoneNumbers[0].label).toBe("mobile");
      // "_$!<Home>!$_" should become "home"
      expect(johnDoe?.emails[0].label).toBe("home");
    });

    it("should handle null labels", () => {
      parser.open("/path/to/backup");

      const contacts = parser.getAllContacts();
      const testCompany = contacts.find((c) => c.id === 3);

      // null label should become "other"
      expect(testCompany?.phoneNumbers[0].label).toBe("other");
    });
  });

  describe("getStats", () => {
    it("should return accurate statistics", () => {
      parser.open("/path/to/backup");

      const stats = parser.getStats();

      expect(stats.contactCount).toBe(mockContacts.length);
      expect(stats.phoneIndexSize).toBeGreaterThan(0);
      expect(stats.emailIndexSize).toBeGreaterThan(0);
    });

    it("should return zeros when database is closed", () => {
      const stats = parser.getStats();

      expect(stats.contactCount).toBe(0);
      expect(stats.phoneIndexSize).toBe(0);
      expect(stats.emailIndexSize).toBe(0);
    });
  });

  describe("ADDRESSBOOK_DB_HASH", () => {
    it("should have the correct hash for AddressBook.sqlitedb", () => {
      expect(iOSContactsParser.ADDRESSBOOK_DB_HASH).toBe(
        "31bb7ba8914766d4ba40d6dfb6113c8b614be442",
      );
    });
  });

  describe("edge cases", () => {
    it("should handle contacts with no phone or email", () => {
      parser.open("/path/to/backup");

      const contacts = parser.getAllContacts();
      const noInfo = contacts.find((c) => c.id === 4);

      expect(noInfo).not.toBeNull();
      expect(noInfo?.phoneNumbers.length).toBe(0);
      expect(noInfo?.emails.length).toBe(0);
      expect(noInfo?.displayName).toBe("Unknown");
    });

    it("should handle organization-only contacts", () => {
      parser.open("/path/to/backup");

      const contacts = parser.getAllContacts();
      const orgOnly = contacts.find((c) => c.id === 3);

      expect(orgOnly?.firstName).toBeNull();
      expect(orgOnly?.lastName).toBeNull();
      expect(orgOnly?.organization).toBe("Test Company");
      expect(orgOnly?.displayName).toBe("Test Company");
    });
  });
});
