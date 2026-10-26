/**
 * BACKLOG-4050 C1 / C1s: the auto-link Sentry calls never carry the property
 * address, and keep the record ids support needs.
 *
 * Three sites in autoLinkService.ts wrote `txnNormalizedAddress.full`:
 * the `auto_link.start` and `auto_link.email_match` breadcrumbs and the
 * zero-results `captureMessage` extra. They now write "[address]" (or
 * "(none)" when the transaction has no address). One fixture reaches all three:
 * a contact with one email, a transaction with an address, and no matching
 * communications.
 *
 * Mocks transcribed from autoLinkService.test.ts (db, logService, matching,
 * communicationDbService) and databaseService.sentryEmail-3819.test.ts
 * (errorReporterProvider). Synthetic data only.
 */
import { autoLinkCommunicationsForContact } from "../autoLinkService";

const mockAddBreadcrumb = jest.fn();
const mockCaptureMessage = jest.fn();
const mockDbAll = jest.fn();
const mockDbGet = jest.fn();
const mockDbRun = jest.fn();

jest.mock("../../capabilities/errorReporterProvider", () => ({
  hostErrorReporter: {
    setUser: jest.fn(),
    addBreadcrumb: (...a: unknown[]) => mockAddBreadcrumb(...a),
    captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
    captureException: jest.fn(),
    flush: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock("../db/core/dbConnection", () => ({
  dbAll: (...args: unknown[]) => mockDbAll(...args),
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbRun: (...args: unknown[]) => mockDbRun(...args),
}));

jest.mock("../logService", () => {
  const mockLogFn = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: mockLogFn, warn: mockLogFn, error: mockLogFn, debug: mockLogFn } };
});

jest.mock("../messageMatchingService", () => ({
  normalizePhone: jest.fn(() => null),
}));

jest.mock("../db/communicationDbService", () => ({
  createThreadCommunicationReference: jest.fn().mockResolvedValue("comm-ref-id"),
  isThreadLinkedToTransaction: jest.fn().mockResolvedValue(false),
  getIgnoredEmailIdsForTransaction: jest.fn().mockResolvedValue(new Set()),
  getIgnoredThreadIdsForTransaction: jest.fn().mockResolvedValue(new Set()),
  getIgnoredCommunicationIdsForTransaction: jest.fn().mockResolvedValue(new Set()),
}));

// pii-allow-uuid: invented all-zero fixture id, not from any live row
const CONTACT_ID = "00000000-0000-4000-8000-000000000002";
// pii-allow-uuid: invented all-zero fixture id, not from any live row
const TRANSACTION_ID = "00000000-0000-4000-8000-000000000001";
const ADDRESS = "742 Evergreen Terrace, Springfield, IL 62704";

function setup(propertyAddress: string | null): void {
  mockDbGet.mockImplementation((sql: string) => {
    if (sql.includes("FROM contacts")) return { id: CONTACT_ID };
    if (sql.includes("FROM transactions")) {
      return {
        user_id: "user-1",
        started_at: "2024-01-01T00:00:00Z",
        created_at: "2024-01-01T00:00:00Z",
        closed_at: null,
        property_address: propertyAddress,
        property_street: propertyAddress ? "742 Evergreen Terrace" : null,
      };
    }
    if (sql.includes("FROM users_local")) return { email: "user@example.com" };
    return null;
  });
  mockDbAll.mockImplementation((sql: string) => {
    if (sql.includes("FROM contact_emails")) return [{ email: "jane.doe@example.com" }];
    return [];
  });
}

/** Every argument handed to the reporter for the three address sites. */
function addressSiteCalls(): { start: Record<string, unknown>; emailMatch: Record<string, unknown>; zero: Record<string, unknown> } {
  const crumb = (category: string) => {
    const call = mockAddBreadcrumb.mock.calls.find((c) => (c[0] as { category?: string }).category === category);
    expect(call).toBeDefined();
    return (call![0] as { data: Record<string, unknown> }).data;
  };
  const zeroCall = mockCaptureMessage.mock.calls.find((c) => String(c[0]).startsWith("Auto-link completed with 0 results"));
  expect(zeroCall).toBeDefined();
  return {
    start: crumb("auto_link.start"),
    emailMatch: crumb("auto_link.email_match"),
    zero: (zeroCall![1] as { extra: Record<string, unknown> }).extra,
  };
}

describe("BACKLOG-4050 C1: auto-link Sentry calls carry no property address", () => {
  beforeEach(() => jest.clearAllMocks());

  it("C1: no address text in any reporter call, at any of the three sites", async () => {
    setup(ADDRESS);
    await autoLinkCommunicationsForContact({ contactId: CONTACT_ID, transactionId: TRANSACTION_ID });
    const sites = addressSiteCalls();
    for (const [name, data] of Object.entries(sites)) {
      expect({ name, normalizedAddress: data.normalizedAddress }).toEqual({ name, normalizedAddress: "[address]" });
    }
    const everything = JSON.stringify([mockAddBreadcrumb.mock.calls, mockCaptureMessage.mock.calls]).toLowerCase();
    expect(everything).not.toContain("evergreen");
    expect(everything).not.toContain("742");
  });

  it("C1s: the record ids and counts support needs are still there", async () => {
    setup(ADDRESS);
    await autoLinkCommunicationsForContact({ contactId: CONTACT_ID, transactionId: TRANSACTION_ID });
    const sites = addressSiteCalls();
    for (const data of Object.values(sites)) {
      expect(data.transactionId).toBe(TRANSACTION_ID);
      expect(data.contactId).toBe(CONTACT_ID);
      expect(data.contactEmailCount).toBe(1);
    }
  });

  it("C1s: a transaction with no address still reports \"(none)\"", async () => {
    setup(null);
    await autoLinkCommunicationsForContact({ contactId: CONTACT_ID, transactionId: TRANSACTION_ID });
    const sites = addressSiteCalls();
    for (const data of Object.values(sites)) expect(data.normalizedAddress).toBe("(none)");
  });
});
