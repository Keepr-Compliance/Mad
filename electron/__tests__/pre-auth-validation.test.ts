/**
 * Pre-Auth Validation Handler Tests (TASK-2086)
 *
 * Tests for the pre-DB auth validation handler that validates
 * Supabase auth tokens before database decryption (SOC 2 CC6.1).
 *
 * @module __tests__/pre-auth-validation.test
 */

import { AuthApiError } from "@supabase/auth-js";
import { handlePreAuthValidation } from "../handlers/preAuthValidationHandler";

// ============================================
// MOCKS
// ============================================

// Mock electron net module
const mockIsOnline = jest.fn();
jest.mock("electron", () => ({
  ipcMain: { handle: jest.fn() },
  net: { get isOnline() { return mockIsOnline(); } },
}));

// Mock session service
const mockLoadSession = jest.fn();
const mockClearSession = jest.fn();
const mockUpdateSession = jest.fn();
jest.mock("../../electron/services/sessionService", () => ({
  __esModule: true,
  default: {
    loadSession: (...args: unknown[]) => mockLoadSession(...args),
    clearSession: (...args: unknown[]) => mockClearSession(...args),
    updateSession: (...args: unknown[]) => mockUpdateSession(...args),
  },
}));

// Mock supabase service
const mockSetSession = jest.fn();
const mockGetUser = jest.fn();
jest.mock("../../electron/services/supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      auth: {
        setSession: (...args: unknown[]) => mockSetSession(...args),
        getUser: (...args: unknown[]) => mockGetUser(...args),
      },
    }),
  },
}));

// Mock log service
jest.mock("../../electron/services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  },
}));

// ============================================
// TEST FIXTURES
// ============================================

const mockSession = {
  user: { id: "user-123", email: "test@example.com" },
  sessionToken: "session-token",
  provider: "google",
  expiresAt: Date.now() + 86400000,
  createdAt: Date.now() - 3600000,
  supabaseTokens: {
    access_token: "access-token-123",
    refresh_token: "refresh-token-123",
  },
  lastServerValidatedAt: Date.now() - 3600000, // 1 hour ago
};

// ============================================
// TESTS
// ============================================

describe("handlePreAuthValidation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsOnline.mockReturnValue(true);
    // sessionService.clearSession() resolves true on success (and on ENOENT).
    mockClearSession.mockResolvedValue(true);
  });

  // ------------------------------------------
  // No session cases
  // ------------------------------------------

  describe("no session", () => {
    it("returns valid with noSession when session.json does not exist", async () => {
      mockLoadSession.mockResolvedValue(null);

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: true, noSession: true });
      expect(mockSetSession).not.toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
      // BACKLOG-3147: this guard is why this caller cannot produce "No session to update"
      // on a signed-out startup. Goes red if the early return is ever removed.
      expect(mockUpdateSession).not.toHaveBeenCalled();
    });

    it("returns valid with noSession when session exists but no supabaseTokens", async () => {
      mockLoadSession.mockResolvedValue({
        ...mockSession,
        supabaseTokens: undefined,
      });

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: true, noSession: true });
      expect(mockSetSession).not.toHaveBeenCalled();
      // BACKLOG-3147: same guard, the no-tokens half of it.
      expect(mockUpdateSession).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------
  // Online + valid session
  // ------------------------------------------

  describe("online, valid session", () => {
    it("returns valid when server confirms session", async () => {
      mockLoadSession.mockResolvedValue(mockSession);
      mockSetSession.mockResolvedValue({ error: null });
      mockGetUser.mockResolvedValue({
        data: { user: { id: "user-123", email: "test@example.com" } },
        error: null,
      });
      mockUpdateSession.mockResolvedValue(true);

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: true });
      expect(mockSetSession).toHaveBeenCalledWith({
        access_token: "access-token-123",
        refresh_token: "refresh-token-123",
      });
      expect(mockGetUser).toHaveBeenCalled();
      expect(mockUpdateSession).toHaveBeenCalledWith({
        lastServerValidatedAt: expect.any(Number),
      });
    });
  });

  // ------------------------------------------
  // Online + revoked session
  // ------------------------------------------

  describe("online, revoked session", () => {
    it("returns invalid with session_revoked when server rejects (user deleted)", async () => {
      mockLoadSession.mockResolvedValue(mockSession);
      mockSetSession.mockResolvedValue({ error: null });
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: "User not found" },
      });

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: false, reason: "session_revoked" });
      expect(mockClearSession).toHaveBeenCalled();
    });

    it("returns invalid with token_invalid when setSession fails (expired tokens)", async () => {
      mockLoadSession.mockResolvedValue(mockSession);
      mockSetSession.mockResolvedValue({
        error: { message: "Token expired" },
      });

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: false, reason: "token_invalid" });
      expect(mockClearSession).toHaveBeenCalled();
      expect(mockGetUser).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------
  // BACKLOG-3410: the renderer opens the DB after token_invalid /
  // session_revoked because the session was deleted. If the delete fails, the
  // reason must be one the renderer does not route to DB init.
  // ------------------------------------------

  describe("rejected session: clear outcome (BACKLOG-3410)", () => {
    // Real shape of the server rejection: auth-js 2.110.2 builds it in
    // lib/fetch.js handleError -> new AuthApiError(message, status, code);
    // message text as seen verbatim in the desktop app's main.log.
    const refreshTokenNotFound = () =>
      new AuthApiError(
        "Invalid Refresh Token: Refresh Token Not Found",
        400,
        "refresh_token_not_found"
      );

    it("setSession rejected + clear succeeds -> token_invalid", async () => {
      mockLoadSession.mockResolvedValue(mockSession);
      mockSetSession.mockResolvedValue({
        data: { user: null, session: null },
        error: refreshTokenNotFound(),
      });

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: false, reason: "token_invalid" });
      expect(mockClearSession).toHaveBeenCalledTimes(1);
    });

    it("setSession rejected + clear fails -> session_clear_failed", async () => {
      mockLoadSession.mockResolvedValue(mockSession);
      mockSetSession.mockResolvedValue({
        data: { user: null, session: null },
        error: refreshTokenNotFound(),
      });
      mockClearSession.mockResolvedValue(false);

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: false, reason: "session_clear_failed" });
    });

    it("getUser rejected + clear succeeds -> session_revoked", async () => {
      mockLoadSession.mockResolvedValue(mockSession);
      mockSetSession.mockResolvedValue({ error: null });
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "User not found" } });

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: false, reason: "session_revoked" });
      expect(mockClearSession).toHaveBeenCalledTimes(1);
    });

    it("getUser rejected + clear fails -> session_clear_failed", async () => {
      mockLoadSession.mockResolvedValue(mockSession);
      mockSetSession.mockResolvedValue({ error: null });
      mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "User not found" } });
      mockClearSession.mockResolvedValue(false);

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: false, reason: "session_clear_failed" });
    });
  });

  // ------------------------------------------
  // Offline + within grace period
  // ------------------------------------------

  describe("offline, within grace period", () => {
    it("returns valid when lastServerValidatedAt is within 24h", async () => {
      mockIsOnline.mockReturnValue(false);
      mockLoadSession.mockResolvedValue({
        ...mockSession,
        lastServerValidatedAt: Date.now() - 3600000, // 1 hour ago
      });

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: true });
      expect(mockSetSession).not.toHaveBeenCalled(); // No server calls when offline
    });
  });

  // ------------------------------------------
  // Offline + expired grace period
  // ------------------------------------------

  describe("offline, expired grace period", () => {
    it("returns invalid when lastServerValidatedAt is older than 24h", async () => {
      mockIsOnline.mockReturnValue(false);
      mockLoadSession.mockResolvedValue({
        ...mockSession,
        lastServerValidatedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      });

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: false, reason: "offline_grace_expired" });
    });

    it("returns invalid when lastServerValidatedAt is missing (migration)", async () => {
      mockIsOnline.mockReturnValue(false);
      mockLoadSession.mockResolvedValue({
        ...mockSession,
        lastServerValidatedAt: undefined,
      });

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: false, reason: "offline_grace_expired" });
    });
  });

  // ------------------------------------------
  // Network error during validation (falls back to grace period)
  // ------------------------------------------

  describe("network error during validation", () => {
    it("falls back to grace period check when getUser throws", async () => {
      mockLoadSession.mockResolvedValue({
        ...mockSession,
        lastServerValidatedAt: Date.now() - 3600000, // 1 hour ago
      });
      mockSetSession.mockResolvedValue({ error: null });
      mockGetUser.mockRejectedValue(new Error("Network error"));

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: true }); // Within grace period
    });

    it("returns invalid when network error and grace period expired", async () => {
      mockLoadSession.mockResolvedValue({
        ...mockSession,
        lastServerValidatedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      });
      mockSetSession.mockResolvedValue({ error: null });
      mockGetUser.mockRejectedValue(new Error("Network error"));

      const result = await handlePreAuthValidation();

      expect(result).toEqual({ valid: false, reason: "offline_grace_expired" });
    });
  });
});
