/**
 * BACKLOG-2127: precacheEmails must surface a `providerError` for auth-class
 * (expired/revoked token) failures so the sync UI can prompt a reconnect,
 * while leaving transient/network failures unflagged (they still complete).
 *
 * The DB and provider fetch layers are mocked so no native modules run.
 */

const mockDbGet = jest.fn();
const mockDbAll = jest.fn();
const mockGetRawDatabase = jest.fn();
jest.mock("../db/core/dbConnection", () => ({
  dbGet: (...a: unknown[]) => mockDbGet(...a),
  dbAll: (...a: unknown[]) => mockDbAll(...a),
  getRawDatabase: (...a: unknown[]) => mockGetRawDatabase(...a),
}));

const mockGetOAuthToken = jest.fn();
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { getOAuthToken: (...a: unknown[]) => mockGetOAuthToken(...a) },
}));

const mockOutlookInit = jest.fn();
const mockOutlookSearch = jest.fn();
const mockOutlookSearchAll = jest.fn();
const mockOutlookAttachments = jest.fn();
jest.mock("../outlookFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...a: unknown[]) => mockOutlookInit(...a),
    searchEmails: (...a: unknown[]) => mockOutlookSearch(...a),
    searchAllFolders: (...a: unknown[]) => mockOutlookSearchAll(...a),
    getAttachments: (...a: unknown[]) => mockOutlookAttachments(...a),
  },
}));

const mockGmailInit = jest.fn();
const mockGmailSearch = jest.fn();
const mockGmailSearchAll = jest.fn();
jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...a: unknown[]) => mockGmailInit(...a),
    searchEmails: (...a: unknown[]) => mockGmailSearch(...a),
    searchAllLabels: (...a: unknown[]) => mockGmailSearchAll(...a),
  },
}));

// retryOnNetwork just invokes the fn once (no retry semantics needed here).
jest.mock("../networkResilience", () => ({
  retryOnNetwork: (fn: () => Promise<unknown>) => fn(),
  networkResilienceService: {},
}));

jest.mock("../../utils/preferenceHelper", () => ({
  getEmailCacheDurationMonths: jest.fn().mockResolvedValue(12),
  computeEmailCacheSinceDate: jest.fn(() => new Date("2025-01-01T00:00:00Z")),
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

// Avoid pulling logService's real transports.
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import emailSyncService from "../emailSyncService";

const TOKEN = { access_token: "at", connected_email_address: "me@example.com" };

describe("precacheEmails providerError surfacing (BACKLOG-2127)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // No previously-cached email → incremental starts from the cache window.
    mockDbGet.mockReturnValue({ latest: null });
    mockOutlookSearchAll.mockResolvedValue([]);
    mockGmailSearchAll.mockResolvedValue([]);
    mockOutlookAttachments.mockResolvedValue([]);
  });

  it("returns providerError{microsoft,tokenExpired} when the Outlook fetch throws a reconnect error", async () => {
    // Only Outlook connected.
    mockGetOAuthToken.mockImplementation((_uid: string, provider: string) =>
      provider === "microsoft" ? TOKEN : null,
    );
    mockOutlookInit.mockRejectedValue(
      new Error("Microsoft access token expired. Please reconnect Outlook."),
    );

    const result = await emailSyncService.precacheEmails("user-1");

    expect(result.providerError).toEqual({
      provider: "microsoft",
      message: "Your email connection has expired. Please reconnect in Settings.",
      tokenExpired: true,
    });
  });

  it("returns providerError{google,tokenExpired} when the Gmail fetch throws invalid_grant", async () => {
    // Only Gmail connected.
    mockGetOAuthToken.mockImplementation((_uid: string, provider: string) =>
      provider === "google" ? TOKEN : null,
    );
    mockGmailInit.mockRejectedValue(
      new Error("invalid_grant: Token has been expired or revoked"),
    );

    const result = await emailSyncService.precacheEmails("user-1");

    expect(result.providerError).toEqual({
      provider: "google",
      message: "Your email connection has expired. Please reconnect in Settings.",
      tokenExpired: true,
    });
  });

  it("does NOT set providerError for a transient (network) Outlook failure", async () => {
    mockGetOAuthToken.mockImplementation((_uid: string, provider: string) =>
      provider === "microsoft" ? TOKEN : null,
    );
    // A non-auth error (network) — precache should complete with no providerError.
    mockOutlookInit.mockRejectedValue(
      Object.assign(new Error("getaddrinfo ENOTFOUND graph.microsoft.com"), {
        code: "ENOTFOUND",
      }),
    );

    const result = await emailSyncService.precacheEmails("user-1");

    expect(result.providerError).toBeUndefined();
  });

  it("returns a clean result with no providerError when no provider is connected", async () => {
    mockGetOAuthToken.mockResolvedValue(null);

    const result = await emailSyncService.precacheEmails("user-1");

    expect(result).toEqual({ fetched: 0, stored: 0 });
    expect(result.providerError).toBeUndefined();
  });
});
