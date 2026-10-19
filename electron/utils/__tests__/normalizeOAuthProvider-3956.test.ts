/**
 * BACKLOG-3956 — main-process provider mapping. "azure" is the value Supabase
 * stores for a Microsoft sign-in (auth.users raw_app_meta_data.provider).
 * Every other value passes through: an "email" sign-in must stay truthy.
 */
import { normalizeOAuthProvider } from "../normalizeOAuthProvider";

describe("normalizeOAuthProvider (BACKLOG-3956)", () => {
  it("maps azure to microsoft", () => {
    expect(normalizeOAuthProvider("azure")).toBe("microsoft");
  });

  it.each(["google", "microsoft", "email"])("passes %s through", (v) => {
    expect(normalizeOAuthProvider(v)).toBe(v);
  });

  it.each([undefined, null, "", 7])("returns undefined for %p", (v) => {
    expect(normalizeOAuthProvider(v)).toBeUndefined();
  });
});
