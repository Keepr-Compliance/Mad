/**
 * BACKLOG-2142: connectionStatusService.lastSyncAt population.
 *
 * A provider's last SUCCESSFUL email-sync timestamp (oauth_tokens.last_sync_at,
 * read via databaseService.getOAuthTokenSyncTime) must be surfaced on the
 * connection status for every branch where a token row exists (connected AND
 * broken-token), as an ISO string, and omitted (null) for NOT_CONNECTED. This
 * feeds the "No email captured since <date>" reconnect subtitle.
 */

const mockGetOAuthToken = jest.fn();
const mockGetOAuthTokenSyncTime = jest.fn();
const mockRefreshGoogle = jest.fn();
const mockRefreshMicrosoft = jest.fn();

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getOAuthToken: (...args: unknown[]) => mockGetOAuthToken(...args),
    getOAuthTokenSyncTime: (...args: unknown[]) => mockGetOAuthTokenSyncTime(...args),
  },
}));

jest.mock("../googleAuthService", () => ({
  __esModule: true,
  default: { refreshAccessToken: (...args: unknown[]) => mockRefreshGoogle(...args) },
}));

jest.mock("../microsoftAuthService", () => ({
  __esModule: true,
  default: { refreshAccessToken: (...args: unknown[]) => mockRefreshMicrosoft(...args) },
}));

jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import connectionStatusService from "../connectionStatusService";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const LAST_SYNC = new Date("2026-07-10T12:00:00.000Z");

describe("connectionStatusService lastSyncAt (BACKLOG-2142)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    connectionStatusService.clearCache();
  });

  describe("checkGoogleConnection", () => {
    it("populates lastSyncAt (ISO) on a valid connected token", async () => {
      mockGetOAuthToken.mockResolvedValue({
        access_token: "tok",
        token_expires_at: FUTURE,
        connected_email_address: "user@gmail.com",
      });
      mockGetOAuthTokenSyncTime.mockResolvedValue(LAST_SYNC);

      const status = await connectionStatusService.checkGoogleConnection(USER_ID);

      expect(status.connected).toBe(true);
      expect(status.lastSyncAt).toBe(LAST_SYNC.toISOString());
      expect(mockGetOAuthTokenSyncTime).toHaveBeenCalledWith(USER_ID, "google");
    });

    it("populates lastSyncAt on a broken (refresh-failed) token", async () => {
      mockGetOAuthToken.mockResolvedValue({
        access_token: "tok",
        token_expires_at: PAST,
        connected_email_address: "user@gmail.com",
      });
      mockRefreshGoogle.mockResolvedValue({ success: false, error: "boom" });
      mockGetOAuthTokenSyncTime.mockResolvedValue(LAST_SYNC);

      const status = await connectionStatusService.checkGoogleConnection(USER_ID);

      expect(status.connected).toBe(false);
      expect(status.error?.type).toBe("TOKEN_REFRESH_FAILED");
      expect(status.lastSyncAt).toBe(LAST_SYNC.toISOString());
    });

    it("does NOT read or set lastSyncAt for a NOT_CONNECTED provider", async () => {
      mockGetOAuthToken.mockResolvedValue(null);

      const status = await connectionStatusService.checkGoogleConnection(USER_ID);

      expect(status.connected).toBe(false);
      expect(status.error?.type).toBe("NOT_CONNECTED");
      expect(status.lastSyncAt).toBeUndefined();
      expect(mockGetOAuthTokenSyncTime).not.toHaveBeenCalled();
    });

    it("returns lastSyncAt null (never synced) without throwing", async () => {
      mockGetOAuthToken.mockResolvedValue({
        access_token: "tok",
        token_expires_at: FUTURE,
        connected_email_address: "user@gmail.com",
      });
      mockGetOAuthTokenSyncTime.mockResolvedValue(null);

      const status = await connectionStatusService.checkGoogleConnection(USER_ID);

      expect(status.connected).toBe(true);
      expect(status.lastSyncAt).toBeNull();
    });

    it("degrades to null lastSyncAt when the sync-time read throws (best-effort)", async () => {
      mockGetOAuthToken.mockResolvedValue({
        access_token: "tok",
        token_expires_at: FUTURE,
        connected_email_address: "user@gmail.com",
      });
      mockGetOAuthTokenSyncTime.mockRejectedValue(new Error("db down"));

      const status = await connectionStatusService.checkGoogleConnection(USER_ID);

      // Connection check still succeeds; only the subtitle data is dropped.
      expect(status.connected).toBe(true);
      expect(status.lastSyncAt).toBeNull();
    });
  });

  describe("checkMicrosoftConnection", () => {
    it("populates lastSyncAt (ISO) on a valid connected token", async () => {
      mockGetOAuthToken.mockResolvedValue({
        access_token: "tok",
        token_expires_at: FUTURE,
        connected_email_address: "user@outlook.com",
      });
      mockGetOAuthTokenSyncTime.mockResolvedValue(LAST_SYNC);

      const status = await connectionStatusService.checkMicrosoftConnection(USER_ID);

      expect(status.connected).toBe(true);
      expect(status.lastSyncAt).toBe(LAST_SYNC.toISOString());
      expect(mockGetOAuthTokenSyncTime).toHaveBeenCalledWith(USER_ID, "microsoft");
    });

    it("populates lastSyncAt on a broken (refresh-failed) token", async () => {
      mockGetOAuthToken.mockResolvedValue({
        access_token: "tok",
        token_expires_at: PAST,
        connected_email_address: "user@outlook.com",
      });
      mockRefreshMicrosoft.mockResolvedValue({ success: false, error: "boom" });
      mockGetOAuthTokenSyncTime.mockResolvedValue(LAST_SYNC);

      const status = await connectionStatusService.checkMicrosoftConnection(USER_ID);

      expect(status.connected).toBe(false);
      expect(status.error?.type).toBe("TOKEN_REFRESH_FAILED");
      expect(status.lastSyncAt).toBe(LAST_SYNC.toISOString());
    });

    it("does NOT read or set lastSyncAt for a NOT_CONNECTED provider", async () => {
      mockGetOAuthToken.mockResolvedValue(null);

      const status = await connectionStatusService.checkMicrosoftConnection(USER_ID);

      expect(status.error?.type).toBe("NOT_CONNECTED");
      expect(status.lastSyncAt).toBeUndefined();
      expect(mockGetOAuthTokenSyncTime).not.toHaveBeenCalled();
    });
  });
});
