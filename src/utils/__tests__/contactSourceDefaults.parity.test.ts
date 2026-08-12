/**
 * Canonical/mirror parity for the contact-source default rule.
 *
 * BACKLOG-2479 / BACKLOG-2476. The rule lives in two files because
 * `tsconfig.electron.json` sets `rootDir: "./electron"` and nothing under
 * `electron/` may import from `src/` or `shared/`. This test is the mechanism
 * that keeps them one rule rather than two: it imports BOTH implementations and
 * asserts an identical verdict at every point in the full cross-product.
 *
 * Edit one copy without the other and this goes red. That — not the docblocks —
 * is what makes "single source of truth" true here.
 *
 * NOTE: this test proves the two copies AGREE. It does not prove they are
 * CORRECT; `contactSourceDefaults.test.ts` does that.
 *
 * @module utils/__tests__/contactSourceDefaults.parity.test
 */

import * as canonical from "../../../electron/utils/contactSourceDefaults";
import * as mirror from "../contactSourceDefaults";

type Platform = "macos" | "windows";
type PhoneType = "iphone" | "android" | null;
type AuthProvider = "google" | "microsoft" | null;

const PLATFORMS: Platform[] = ["macos", "windows"];
const PHONE_TYPES: PhoneType[] = ["iphone", "android", null];
const AUTH_PROVIDERS: AuthProvider[] = ["google", "microsoft", null];

describe("contactSourceDefaults parity (canonical vs renderer mirror)", () => {
  it("exports the identical key list", () => {
    expect([...mirror.CONTACT_SOURCE_KEYS]).toEqual([
      ...canonical.CONTACT_SOURCE_KEYS,
    ]);
  });

  it("exports the identical backend-derived key list", () => {
    expect([...mirror.BACKEND_DERIVED_DEFAULT_KEYS]).toEqual([
      ...canonical.BACKEND_DERIVED_DEFAULT_KEYS,
    ]);
  });

  it("agrees on isContactSourceKey for every key and a non-key", () => {
    for (const key of canonical.CONTACT_SOURCE_KEYS) {
      expect(mirror.isContactSourceKey(key)).toBe(
        canonical.isContactSourceKey(key)
      );
    }
    for (const notAKey of ["outlookEmails", "gmailEmails", "messages", ""]) {
      expect(mirror.isContactSourceKey(notAKey)).toBe(
        canonical.isContactSourceKey(notAKey)
      );
    }
  });

  it("agrees on normalizePhoneType for valid, invalid and absent values", () => {
    const inputs: unknown[] = [
      "iphone",
      "android",
      "ios",
      "Android",
      "IPHONE",
      "",
      null,
      undefined,
      0,
      {},
    ];
    for (const value of inputs) {
      expect(mirror.normalizePhoneType(value)).toBe(
        canonical.normalizePhoneType(value)
      );
    }
  });

  // The load-bearing one: 2 x 3 x 3 x 5 = 90 assertions.
  describe("isContactSourceOnByDefault agrees across the full cross-product", () => {
    for (const platform of PLATFORMS) {
      for (const phoneType of PHONE_TYPES) {
        for (const authProvider of AUTH_PROVIDERS) {
          const ctx = { platform, phoneType, authProvider };
          const label = `${platform} / phone=${phoneType ?? "none"} / auth=${authProvider ?? "none"}`;

          it(label, () => {
            for (const key of canonical.CONTACT_SOURCE_KEYS) {
              expect({
                key,
                value: mirror.isContactSourceOnByDefault(key, ctx),
              }).toEqual({
                key,
                value: canonical.isContactSourceOnByDefault(key, ctx),
              });
            }

            // And the aggregate helper, so a divergence in the object builder
            // cannot hide behind agreeing per-key answers.
            expect(mirror.getDefaultContactSourceSelection(ctx)).toEqual(
              canonical.getDefaultContactSourceSelection(ctx)
            );
          });
        }
      }
    }
  });
});
