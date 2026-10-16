/**
 * BACKLOG-3956 — the renderer's two provider functions.
 *
 * "azure" is the value Supabase stores for a Microsoft sign-in
 * (auth.users raw_app_meta_data.provider) and the value the deep-link
 * callback carried before the main-process fix. "email" is what an email
 * sign-in carries on the same path.
 */
import {
  normalizeAuthProvider,
  toOnboardingAuthProvider,
} from "../authProvider";

describe("normalizeAuthProvider (transport / app state)", () => {
  it("maps azure to microsoft", () => {
    expect(normalizeAuthProvider("azure")).toBe("microsoft");
  });

  it.each(["google", "microsoft", "email"])("passes %s through unchanged", (v) => {
    expect(normalizeAuthProvider(v)).toBe(v);
  });

  it.each([undefined, null, "", 42])("returns null for %p", (v) => {
    expect(normalizeAuthProvider(v)).toBeNull();
  });
});

describe("toOnboardingAuthProvider (onboarding boundary only)", () => {
  it("maps azure to microsoft", () => {
    expect(toOnboardingAuthProvider("azure")).toBe("microsoft");
  });

  it.each(["google", "microsoft"])("keeps %s", (v) => {
    expect(toOnboardingAuthProvider(v)).toBe(v);
  });

  // No fallback to either mailbox provider: an unknown sign-in is "neither".
  it.each(["email", "github", undefined, null, ""])("narrows %p to null", (v) => {
    expect(toOnboardingAuthProvider(v)).toBeNull();
  });
});
