/**
 * BACKLOG-4148 — the `auth:deep-link-callback` payload carries the provisioned
 * row's created_at / last_login_at, so Account settings can show "Member since"
 * and "Last login" right after a browser sign-in, without a relaunch.
 *
 * Fixture: `localUser` is the row main.ts holds after provisionDeepLinkSignIn
 * (`provisioned.user`, re-read after the stamp); the date shapes are SQLite's
 * CURRENT_TIMESTAMP text. Supabase user shape copied from deepLinkAuthPayload-3956.
 */
import { buildDeepLinkAuthPayload } from "../deepLinkAuthPayload";

const base = {
  accessToken: "at",
  refreshToken: "rt",
  localUserId: "local-1",
  userEmail: "user@example.com",
  supabaseUser: { user_metadata: { full_name: "Test User" }, app_metadata: { provider: "google" } },
  licenseStatus: { isValid: true },
  device: { id: "d1" },
  isNewUser: false,
};

describe("buildDeepLinkAuthPayload dates (BACKLOG-4148)", () => {
  it("P1 a provisioned row: user carries its created_at and last_login_at", () => {
    const p = buildDeepLinkAuthPayload({
      ...base,
      localUser: { created_at: "2026-01-02 03:04:05", last_login_at: "2026-11-05 03:30:00" },
    });
    expect(p.user).toEqual({
      id: "local-1",
      email: "user@example.com",
      name: "Test User",
      created_at: "2026-01-02 03:04:05",
      last_login_at: "2026-11-05 03:30:00",
    });
  });

  it("P2 the database was not open (row provisioned later): no dates, nothing invented", () => {
    const p = buildDeepLinkAuthPayload({ ...base, localUser: null });
    expect(p.user.created_at).toBeUndefined();
    expect(p.user.last_login_at).toBeUndefined();
  });
});
