/**
 * The contact-source default rule itself (BACKLOG-2479 / BACKLOG-2476).
 *
 * Every case asserts the EXACT SET of enabled keys, never a count and never a
 * single key in isolation — "iPhone is off" is only the right answer if nothing
 * else moved at the same time.
 *
 * @module utils/__tests__/contactSourceDefaults.test
 */

import {
  BACKEND_DERIVED_DEFAULT_KEYS,
  CONTACT_SOURCE_KEYS,
  getDefaultContactSourceSelection,
  isContactSourceKey,
  normalizePhoneType,
  type ContactSourceDefaultContext,
  type ContactSourceKey,
} from "../contactSourceDefaults";

/** The set of keys the rule turns ON, as a sorted array for exact comparison. */
function enabledKeys(ctx: ContactSourceDefaultContext): ContactSourceKey[] {
  const selection = getDefaultContactSourceSelection(ctx);
  return CONTACT_SOURCE_KEYS.filter((key) => selection[key]).sort();
}

describe("getDefaultContactSourceSelection", () => {
  // ===========================================================================
  // BACKLOG-2479: the founder's case — a Mac with an iPhone
  // ===========================================================================

  describe("macOS + iPhone (the reported bug)", () => {
    it("Microsoft login enables exactly macOS Contacts + Outlook — NOT iPhone", () => {
      expect(
        enabledKeys({
          platform: "macos",
          phoneType: "iphone",
          authProvider: "microsoft",
        })
      ).toEqual(["macosContacts", "outlookContacts"]);
    });

    it("Google login enables exactly macOS Contacts + Google — NOT iPhone", () => {
      expect(
        enabledKeys({
          platform: "macos",
          phoneType: "iphone",
          authProvider: "google",
        })
      ).toEqual(["googleContacts", "macosContacts"]);
    });

    it("leaves iPhone off regardless of which provider the user signed in with", () => {
      for (const authProvider of ["google", "microsoft", null] as const) {
        expect(
          getDefaultContactSourceSelection({
            platform: "macos",
            phoneType: "iphone",
            authProvider,
          }).iphoneContacts
        ).toBe(false);
      }
    });
  });

  // ===========================================================================
  // Windows: no macOS address book exists, so the iPhone is the only one
  // ===========================================================================

  describe("Windows + iPhone", () => {
    it("Microsoft login enables exactly iPhone + Outlook", () => {
      expect(
        enabledKeys({
          platform: "windows",
          phoneType: "iphone",
          authProvider: "microsoft",
        })
      ).toEqual(["iphoneContacts", "outlookContacts"]);
    });

    it("Google login enables exactly iPhone + Google", () => {
      expect(
        enabledKeys({
          platform: "windows",
          phoneType: "iphone",
          authProvider: "google",
        })
      ).toEqual(["googleContacts", "iphoneContacts"]);
    });

    it("keeps iPhone ON — there is no macOS source to cover it", () => {
      expect(
        getDefaultContactSourceSelection({
          platform: "windows",
          phoneType: "iphone",
          authProvider: "microsoft",
        }).iphoneContacts
      ).toBe(true);
    });
  });

  // ===========================================================================
  // Android must be untouched by BACKLOG-2479 on either platform
  // ===========================================================================

  describe("Android (must be unchanged on both platforms)", () => {
    it("on macOS enables exactly Android + Google", () => {
      expect(
        enabledKeys({
          platform: "macos",
          phoneType: "android",
          authProvider: "google",
        })
      ).toEqual(["androidContacts", "googleContacts"]);
    });

    it("on Windows enables exactly Android + Google", () => {
      expect(
        enabledKeys({
          platform: "windows",
          phoneType: "android",
          authProvider: "google",
        })
      ).toEqual(["androidContacts", "googleContacts"]);
    });

    it("forces Google on even for a Microsoft login (the companion app's own account)", () => {
      expect(
        enabledKeys({
          platform: "macos",
          phoneType: "android",
          authProvider: "microsoft",
        })
      ).toEqual(["androidContacts", "googleContacts"]);
    });

    it("never enables iPhone or macOS Contacts for an Android user", () => {
      for (const platform of ["macos", "windows"] as const) {
        const selection = getDefaultContactSourceSelection({
          platform,
          phoneType: "android",
          authProvider: "google",
        });
        expect(selection.iphoneContacts).toBe(false);
        expect(selection.macosContacts).toBe(false);
      }
    });
  });

  // ===========================================================================
  // Phone type never recorded — a real population (pre-step users)
  // ===========================================================================

  describe("phone type unknown", () => {
    it("on macOS enables exactly macOS Contacts + the SSO provider, iPhone stays off", () => {
      expect(
        enabledKeys({
          platform: "macos",
          phoneType: null,
          authProvider: "microsoft",
        })
      ).toEqual(["macosContacts", "outlookContacts"]);
    });

    it("on Windows falls back to iPhone + the SSO provider", () => {
      // Deliberate: Windows has no address book of its own, so leaving the
      // iPhone off for an unknown phone type would leave the user with only
      // their mailbox. macOS does not have that problem.
      expect(
        enabledKeys({
          platform: "windows",
          phoneType: null,
          authProvider: "microsoft",
        })
      ).toEqual(["iphoneContacts", "outlookContacts"]);
    });
  });

  // ===========================================================================
  // Auth provider unknown — the main process cannot see it
  // ===========================================================================

  describe("auth provider unknown", () => {
    it("enables neither mailbox source on macOS", () => {
      expect(
        enabledKeys({
          platform: "macos",
          phoneType: "iphone",
          authProvider: null,
        })
      ).toEqual(["macosContacts"]);
    });

    it("still resolves the phone/platform keys, which is all the backend derives", () => {
      const selection = getDefaultContactSourceSelection({
        platform: "windows",
        phoneType: "iphone",
        authProvider: null,
      });
      expect(selection.iphoneContacts).toBe(true);
      expect(selection.macosContacts).toBe(false);
      expect(selection.androidContacts).toBe(false);
    });
  });
});

describe("BACKEND_DERIVED_DEFAULT_KEYS", () => {
  it("is exactly {androidContacts, iphoneContacts}", () => {
    // BACKLOG-2986 added `androidContacts`. Before it, an absent key was
    // answered by the blanket `true` contactHandlers.ts passes as its 4th
    // argument — and since onboarding writes the key ONLY for a user who
    // declared an Android phone, absent is where nearly everyone is, so Android
    // contacts imported for essentially every user with no way to switch them
    // off. Founder, 2026-08-30: "contacts aren't auto imported."
    expect([...BACKEND_DERIVED_DEFAULT_KEYS].sort()).toEqual([
      "androidContacts",
      "iphoneContacts",
    ]);
  });

  it("excludes macosContacts — contactHandlers.ts:1294 gates Android contacts on it", () => {
    // Deriving macosContacts would answer `false` for every Android user, and
    // the catch-all at contactHandlers.ts:1294 gates every `android_sync`
    // external contact on exactly this key. See the constant's docblock.
    expect(BACKEND_DERIVED_DEFAULT_KEYS).not.toContain("macosContacts");
  });

  it("excludes the two mailbox keys — the main process cannot see authProvider", () => {
    expect(BACKEND_DERIVED_DEFAULT_KEYS).not.toContain("outlookContacts");
    expect(BACKEND_DERIVED_DEFAULT_KEYS).not.toContain("googleContacts");
  });

  it("contains only real source keys", () => {
    for (const key of BACKEND_DERIVED_DEFAULT_KEYS) {
      expect(isContactSourceKey(key)).toBe(true);
    }
  });
});

describe("normalizePhoneType", () => {
  it("passes through the two real values", () => {
    expect(normalizePhoneType("iphone")).toBe("iphone");
    expect(normalizePhoneType("android")).toBe("android");
  });

  it("maps anything else to null rather than into the rule", () => {
    // `getPreferences` returns Record<string, any>, so this value is unchecked.
    for (const value of ["ios", "Android", "IPHONE", "", null, undefined, 0, {}]) {
      expect(normalizePhoneType(value)).toBeNull();
    }
  });
});

describe("isContactSourceKey", () => {
  it("accepts exactly the five direct source keys", () => {
    expect([...CONTACT_SOURCE_KEYS].sort()).toEqual([
      "androidContacts",
      "googleContacts",
      "iphoneContacts",
      "macosContacts",
      "outlookContacts",
    ]);
  });

  it("rejects the inferred-category keys", () => {
    // These share the isContactSourceEnabled signature but are not direct
    // sources, and must never pick up a derived default.
    expect(isContactSourceKey("outlookEmails")).toBe(false);
    expect(isContactSourceKey("gmailEmails")).toBe(false);
    expect(isContactSourceKey("messages")).toBe(false);
  });
});
