/**
 * BACKLOG-3956 C4 — the Supabase-session fallback of auth:get-current-user
 * carries the sign-in provider (azure -> microsoft, others as-is).
 *
 * Fixture shape: a Supabase auth user as `client.auth.getSession()` returns it
 * — `app_metadata.provider` holds the raw provider ("azure" for Microsoft).
 */
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { buildSupabaseFallbackUserResponse } from "../sessionHandlers";

const supaUser = (provider: string | undefined) => ({
  id: "00000000-0000-0000-0000-000000000001", // pii-allow-uuid: synthetic fixture id
  email: "user@example.com",
  user_metadata: { full_name: "Test User" },
  app_metadata: provider === undefined ? {} : { provider, providers: [provider] },
});

describe("buildSupabaseFallbackUserResponse (BACKLOG-3956)", () => {
  it("C4: azure comes back as provider microsoft", () => {
    const res = buildSupabaseFallbackUserResponse(supaUser("azure"));
    expect(res.success).toBe(true);
    expect(res.provider).toBe("microsoft");
  });

  it("keeps google and email as-is", () => {
    expect(buildSupabaseFallbackUserResponse(supaUser("google")).provider).toBe("google");
    expect(buildSupabaseFallbackUserResponse(supaUser("email")).provider).toBe("email");
  });

  it("no provider on the session -> no provider in the answer", () => {
    expect(buildSupabaseFallbackUserResponse(supaUser(undefined)).provider).toBeUndefined();
  });

  it("still returns the partial user", () => {
    const res = buildSupabaseFallbackUserResponse(supaUser("azure"));
    expect(res.user).toEqual({
      id: "00000000-0000-0000-0000-000000000001", // pii-allow-uuid: synthetic fixture id
      email: "user@example.com",
      display_name: "Test User",
    });
  });
});
