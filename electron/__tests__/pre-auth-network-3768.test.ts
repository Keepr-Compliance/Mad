/**
 * @jest-environment node
 */

/**
 * BACKLOG-3768: launch-time pre-auth keeps the session on a network error
 * (founder answer "3768 A", built as A′ per SR ruling f3d7522a):
 *  - retryable error AND last server check within 24 h -> { valid: true }, not cleared
 *  - retryable error AND last server check older       -> today's clear + reason
 *  - a 4xx AuthApiError still clears
 *
 * Mock setup copied from pre-auth-validation.test.ts. Error objects come from a
 * REAL supabase-js client (helpers/realAuthJsErrors). Node environment because
 * the real client needs fetch's Response.
 *
 * Controls: P1, P2, N1, N2, A1.
 */

import { handlePreAuthValidation } from "../handlers/preAuthValidationHandler";
import logService from "../services/logService";
import {
  apiError400Refresh,
  apiError401,
  retryable503Error,
  retryableCertError,
  retryableDnsError,
} from "./helpers/realAuthJsErrors";

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

const HOUR = 60 * 60 * 1000;
function sessionValidatedAgo(ms: number) {
  return {
    user: { id: "user-123", email: "test@example.com" },
    sessionToken: "session-token",
    provider: "google",
    expiresAt: Date.now() + 86400000,
    createdAt: Date.now() - 3600000,
    supabaseTokens: { access_token: "access-token-123", refresh_token: "refresh-token-123" },
    lastServerValidatedAt: Date.now() - ms,
  };
}

describe("BACKLOG-3768: pre-auth on network errors (A′)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsOnline.mockReturnValue(true);
    mockClearSession.mockResolvedValue(true);
    (logService.warn as jest.Mock).mockReset().mockResolvedValue(undefined);
  });

  it("P1: setSession returns a transport AuthRetryableFetchError, checked 1 h ago -> valid, not cleared", async () => {
    mockLoadSession.mockResolvedValue(sessionValidatedAgo(1 * HOUR));
    mockSetSession.mockResolvedValue({ data: { session: null, user: null }, error: await retryableCertError() });

    const result = await handlePreAuthValidation();

    expect(result).toEqual({ valid: true });
    expect(mockClearSession).not.toHaveBeenCalled();
  });

  it("P2: getUser returns a transport AuthRetryableFetchError, checked 1 h ago -> valid, not cleared", async () => {
    mockLoadSession.mockResolvedValue(sessionValidatedAgo(1 * HOUR));
    mockSetSession.mockResolvedValue({ data: {}, error: null });
    mockGetUser.mockResolvedValue({ data: { user: null }, error: await retryableDnsError() });

    const result = await handlePreAuthValidation();

    expect(result).toEqual({ valid: true });
    expect(mockClearSession).not.toHaveBeenCalled();
  });

  it("N2: a 503 (retryable WITH a status) inside 24 h -> valid, not cleared", async () => {
    mockLoadSession.mockResolvedValue(sessionValidatedAgo(1 * HOUR));
    const err = await retryable503Error();
    expect(err.status).toBe(503);
    mockSetSession.mockResolvedValue({ data: { session: null, user: null }, error: err });

    expect(await handlePreAuthValidation()).toEqual({ valid: true });
    expect(mockClearSession).not.toHaveBeenCalled();
  });

  it("A1: retryable error, last server check 25 h ago -> today's path: cleared, token_invalid", async () => {
    mockLoadSession.mockResolvedValue(sessionValidatedAgo(25 * HOUR));
    mockSetSession.mockResolvedValue({ data: { session: null, user: null }, error: await retryableCertError() });

    const result = await handlePreAuthValidation();

    expect(result).toEqual({ valid: false, reason: "token_invalid" });
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  it("A1: retryable error, never validated -> cleared, token_invalid", async () => {
    mockLoadSession.mockResolvedValue({ ...sessionValidatedAgo(0), lastServerValidatedAt: undefined });
    mockSetSession.mockResolvedValue({ data: { session: null, user: null }, error: await retryableCertError() });

    expect(await handlePreAuthValidation()).toEqual({ valid: false, reason: "token_invalid" });
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  it("N1: setSession returns 400 refresh_token_not_found, checked 1 h ago -> STILL cleared", async () => {
    mockLoadSession.mockResolvedValue(sessionValidatedAgo(1 * HOUR));
    mockSetSession.mockResolvedValue({ data: { session: null, user: null }, error: await apiError400Refresh() });

    expect(await handlePreAuthValidation()).toEqual({ valid: false, reason: "token_invalid" });
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  it("N1: getUser returns 401 bad_jwt, checked 1 h ago -> STILL cleared", async () => {
    mockLoadSession.mockResolvedValue(sessionValidatedAgo(1 * HOUR));
    mockSetSession.mockResolvedValue({ data: {}, error: null });
    mockGetUser.mockResolvedValue({ data: { user: null }, error: await apiError401() });

    expect(await handlePreAuthValidation()).toEqual({ valid: false, reason: "session_revoked" });
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });
});
