/**
 * BACKLOG-3956 C4 (main.ts deep-link half) — the `auth:deep-link-callback`
 * payload carries "microsoft" for a Microsoft sign-in.
 *
 * Fixture: the Supabase auth user main.ts receives from setSession — its
 * `app_metadata.provider` is "azure" for Microsoft (auth.users
 * raw_app_meta_data.provider).
 */
import { buildDeepLinkAuthPayload } from "../deepLinkAuthPayload";

const input = (provider: string | undefined) => ({
  accessToken: "at",
  refreshToken: "rt",
  localUserId: "local-1",
  userEmail: "user@example.com",
  supabaseUser: {
    user_metadata: { full_name: "Test User" },
    app_metadata: provider === undefined ? {} : { provider, providers: [provider] },
  },
  licenseStatus: { isValid: true },
  device: { id: "d1" },
  isNewUser: true,
});

describe("buildDeepLinkAuthPayload (BACKLOG-3956)", () => {
  it("C4: azure is sent as microsoft", () => {
    expect(buildDeepLinkAuthPayload(input("azure")).provider).toBe("microsoft");
  });

  it("google and email are sent as-is", () => {
    expect(buildDeepLinkAuthPayload(input("google")).provider).toBe("google");
    expect(buildDeepLinkAuthPayload(input("email")).provider).toBe("email");
  });

  it("keeps the rest of the payload the renderer reads", () => {
    expect(buildDeepLinkAuthPayload(input("azure"))).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      userId: "local-1",
      user: { id: "local-1", email: "user@example.com", name: "Test User" },
      provider: "microsoft",
      licenseStatus: { isValid: true },
      device: { id: "d1" },
      isNewUser: true,
    });
  });
});
