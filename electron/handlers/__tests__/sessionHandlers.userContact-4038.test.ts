/**
 * @jest-environment node
 *
 * BACKLOG-4038: auth:get-user-contact feeds the support form on the
 * license-blocked screen. It returns name and email only, and only for the
 * user it is asked about.
 *
 * The deep-link sign-in block returns before sessionService.saveSession
 * (electron/main.ts), so the saved session is empty there and only the
 * Supabase client's in-memory session (set by setSession) knows the user.
 */

const mockGetSession = jest.fn();
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getClient: () => ({ auth: { getSession: (...a: unknown[]) => mockGetSession(...a) } }) },
}));

const mockLoadSession = jest.fn();
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: (...a: unknown[]) => mockLoadSession(...a) },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { handleGetUserContact } from "../sessionHandlers";

/** supabase-js auth.getSession() result shape: { data: { session }, error }. */
function supabaseSession(user: Record<string, unknown> | null) {
  return {
    data: {
      session: user
        ? { access_token: "at-secret", refresh_token: "rt-secret", user }
        : null,
    },
    error: null,
  };
}

const BLOCKED_USER = {
  id: "u1",
  email: "agent@example.com",
  user_metadata: { full_name: "Agent Name" },
};

/** SessionData shape from sessionService.loadSession(). */
const SAVED = {
  user: { id: "u2", email: "saved@example.com", display_name: "Saved User" },
  sessionToken: "st-secret",
  supabaseTokens: { access_token: "at-saved", refresh_token: "rt-saved" },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue(supabaseSession(null));
  mockLoadSession.mockResolvedValue(null);
});

describe("handleGetUserContact (BACKLOG-4038)", () => {
  it("deep-link block: no saved session, reads the in-memory session for that user id", async () => {
    mockGetSession.mockResolvedValue(supabaseSession(BLOCKED_USER));
    const result = await handleGetUserContact(null, "u1");
    expect(result).toEqual({ success: true, name: "Agent Name", email: "agent@example.com" });
  });

  it("returns exactly success, name and email: no token field reaches the renderer", async () => {
    mockGetSession.mockResolvedValue(supabaseSession(BLOCKED_USER));
    mockLoadSession.mockResolvedValue(SAVED);
    for (const id of ["u1", undefined]) {
      const result = await handleGetUserContact(null, id);
      expect(Object.keys(result).sort()).toEqual(["email", "name", "success"]);
      expect(JSON.stringify(result)).not.toMatch(/secret|at-saved|rt-saved/);
    }
  });

  it("startup block: no user id, reads the saved session", async () => {
    mockLoadSession.mockResolvedValue(SAVED);
    const result = await handleGetUserContact(null);
    expect(result).toEqual({ success: true, name: "Saved User", email: "saved@example.com" });
  });

  it("a saved session for a different user is never used for the blocked user id", async () => {
    mockLoadSession.mockResolvedValue(SAVED);
    mockGetSession.mockResolvedValue(supabaseSession(BLOCKED_USER));
    expect(await handleGetUserContact(null, "u1")).toEqual({
      success: true,
      name: "Agent Name",
      email: "agent@example.com",
    });
    mockGetSession.mockResolvedValue(supabaseSession(null));
    expect(await handleGetUserContact(null, "u1")).toEqual({ success: false, name: "", email: "" });
  });

  it("name falls back to the email when the user has no name", async () => {
    mockGetSession.mockResolvedValue(supabaseSession({ id: "u1", email: "agent@example.com", user_metadata: {} }));
    expect(await handleGetUserContact(null, "u1")).toEqual({
      success: true,
      name: "agent@example.com",
      email: "agent@example.com",
    });
  });

  it("never throws: a failing source yields empty fields", async () => {
    mockGetSession.mockRejectedValue(new Error("offline"));
    mockLoadSession.mockRejectedValue(new Error("no keychain"));
    expect(await handleGetUserContact(null, "u1")).toEqual({ success: false, name: "", email: "" });
  });
});
