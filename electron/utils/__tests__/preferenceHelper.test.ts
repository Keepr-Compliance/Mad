/**
 * Unit tests for preferenceHelper
 *
 * Tests the isContactSourceEnabled helper function with various
 * preference shapes including missing keys, explicit values, and error cases.
 */

// Mock supabaseService before import
const mockGetPreferences = jest.fn();
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getPreferences: mockGetPreferences,
  },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import {
  isContactSourceEnabled,
  getEmailCacheDurationMonths,
  computeEmailCacheSinceDate,
  isShadowDeltaSyncEnabled,
} from "../preferenceHelper";
import logService from "../../services/logService";

describe("preferenceHelper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("isContactSourceEnabled", () => {
    it("should return true when preference is explicitly true", async () => {
      mockGetPreferences.mockResolvedValue({
        contactSources: {
          direct: {
            outlookContacts: true,
          },
        },
      });

      const result = await isContactSourceEnabled("user-1", "direct", "outlookContacts");
      expect(result).toBe(true);
    });

    it("should return false when preference is explicitly false", async () => {
      mockGetPreferences.mockResolvedValue({
        contactSources: {
          direct: {
            outlookContacts: false,
          },
        },
      });

      const result = await isContactSourceEnabled("user-1", "direct", "outlookContacts");
      expect(result).toBe(false);
    });

    it("should return defaultValue when preference key is missing", async () => {
      mockGetPreferences.mockResolvedValue({
        contactSources: {
          direct: {},
        },
      });

      const result = await isContactSourceEnabled("user-1", "direct", "outlookContacts", true);
      expect(result).toBe(true);
    });

    it("should return defaultValue when contactSources is missing", async () => {
      mockGetPreferences.mockResolvedValue({});

      const result = await isContactSourceEnabled("user-1", "direct", "outlookContacts", true);
      expect(result).toBe(true);
    });

    it("should return defaultValue when preferences are empty", async () => {
      mockGetPreferences.mockResolvedValue({});

      const result = await isContactSourceEnabled("user-1", "direct", "macosContacts");
      expect(result).toBe(true); // default is true
    });

    it("should return defaultValue when category is missing", async () => {
      mockGetPreferences.mockResolvedValue({
        contactSources: {},
      });

      const result = await isContactSourceEnabled("user-1", "direct", "macosContacts", true);
      expect(result).toBe(true);
    });

    it("should return custom default when specified and key is missing", async () => {
      mockGetPreferences.mockResolvedValue({});

      const result = await isContactSourceEnabled("user-1", "direct", "macosContacts", false);
      expect(result).toBe(false);
    });

    it("should support inferred category", async () => {
      mockGetPreferences.mockResolvedValue({
        contactSources: {
          inferred: {
            outlookEmails: false,
          },
        },
      });

      const result = await isContactSourceEnabled("user-1", "inferred", "outlookEmails");
      expect(result).toBe(false);
    });

    it("should return defaultValue on error (fail-open)", async () => {
      mockGetPreferences.mockRejectedValue(new Error("Network error"));

      const result = await isContactSourceEnabled("user-1", "direct", "outlookContacts", true);
      expect(result).toBe(true);
    });

    // =========================================================================
    // BACKLOG-2476: what an ABSENT preference means
    //
    // This is the half of the fix that survives a skipped onboarding step. The
    // onboarding UI cannot help these users: they either skipped, onboarded
    // before the step existed, or their best-effort preference write failed.
    //
    // process.platform is stubbed rather than read, because CI runs this suite
    // on BOTH macOS and Windows — reading the real value would make the
    // assertions flip by runner.
    // =========================================================================
    describe("absent preference derives the onboarding default (BACKLOG-2476)", () => {
      const realPlatform = process.platform;

      const setPlatform = (platform: NodeJS.Platform) => {
        Object.defineProperty(process, "platform", {
          value: platform,
          configurable: true,
        });
      };

      afterEach(() => {
        // MUST restore: jest workers are reused across suites, and a leaked
        // stub surfaces later as an unrelated, baffling failure.
        Object.defineProperty(process, "platform", {
          value: realPlatform,
          configurable: true,
        });
      });

      it("turns iPhone Contacts OFF on macOS when nothing is stored", async () => {
        setPlatform("darwin");
        mockGetPreferences.mockResolvedValue({ phone_type: "iphone" });

        // The 2479 default, now surviving a skipped step.
        expect(
          await isContactSourceEnabled("user-1", "direct", "iphoneContacts", true),
        ).toBe(false);
      });

      it("keeps iPhone Contacts ON on Windows when nothing is stored", async () => {
        setPlatform("win32");
        mockGetPreferences.mockResolvedValue({ phone_type: "iphone" });

        // No macOS address book exists there, so the iPhone is the only one.
        expect(
          await isContactSourceEnabled("user-1", "direct", "iphoneContacts", true),
        ).toBe(true);
      });

      it("turns iPhone Contacts OFF on macOS even with no phone_type recorded", async () => {
        setPlatform("darwin");
        mockGetPreferences.mockResolvedValue({});

        // Deliberate, not fallout: every macOS user has the Mac address book,
        // which stays ON, so this cannot leave anyone with no contact source.
        expect(
          await isContactSourceEnabled("user-1", "direct", "iphoneContacts", true),
        ).toBe(false);
      });

      // =====================================================================
      // BACKLOG-2986 — the BACKEND half of "the Android switch is OFF".
      //
      // THIS IS THE CONTROL THAT MATTERS, and it is here rather than in the
      // renderer suite on purpose. A test that asserts only the switch's
      // aria-checked passes while the main process happily keeps importing:
      // the switch would be a picture. These assertions pin what
      // `contactHandlers.ts` will actually do with the same absent key.
      //
      // Note the 4th argument is `true` in every case below — exactly what the
      // caller passes. The derived rule has to BEAT it; a test that passed
      // `false` here would prove nothing at all.
      // =====================================================================
      it("turns Android Contacts OFF when nothing is stored and no Android phone was declared", async () => {
        // The reported state. `androidContacts` is written by onboarding ONLY
        // for a user who declared an Android phone, so absent is where nearly
        // everyone is — and absent used to mean `true`, which is why 389
        // Android contacts imported for a user who never asked for them.
        for (const platform of ["darwin", "win32"] as NodeJS.Platform[]) {
          setPlatform(platform);
          mockGetPreferences.mockResolvedValue({ phone_type: "iphone" });

          expect(
            await isContactSourceEnabled("user-1", "direct", "androidContacts", true),
          ).toBe(false);
        }
      });

      it("turns Android Contacts OFF when nothing is stored and no phone_type was recorded either", async () => {
        setPlatform("darwin");
        mockGetPreferences.mockResolvedValue({});

        expect(
          await isContactSourceEnabled("user-1", "direct", "androidContacts", true),
        ).toBe(false);
      });

      it("keeps Android Contacts ON for a user who declared an Android phone", async () => {
        // Not a hole in "default OFF" — it is the same clause that keeps
        // iPhone Contacts ON on Windows. This user told us the companion is
        // their address book, and it is the card onboarding would have
        // pre-ticked. Zero production rows are in this state today (every
        // absent row is phone_type=iphone); the ones that declared Android
        // carry an explicit `true`, which wins before this branch is reached.
        for (const platform of ["darwin", "win32"] as NodeJS.Platform[]) {
          setPlatform(platform);
          mockGetPreferences.mockResolvedValue({ phone_type: "android" });

          expect(
            await isContactSourceEnabled("user-1", "direct", "androidContacts", true),
          ).toBe(true);
        }
      });

      it("lets an explicitly stored androidContacts win over the derived default", async () => {
        // The 3 production rows carrying an explicit `true` must not lose their
        // Android contacts to this change. They now get a switch instead.
        setPlatform("darwin");
        mockGetPreferences.mockResolvedValue({
          phone_type: "iphone",
          contactSources: { direct: { androidContacts: true } },
        });

        expect(
          await isContactSourceEnabled("user-1", "direct", "androidContacts", true),
        ).toBe(true);
      });

      it("still fails OPEN on androidContacts when preferences cannot be read at all", async () => {
        // Case 3, not case 2. A failed read cannot see `phone_type`, so
        // deriving would be guessing — and guessing OFF silently breaks a
        // working import on a network blip. This is why the call site in
        // contactHandlers.ts keeps passing `true` as the 4th argument.
        setPlatform("darwin");
        mockGetPreferences.mockRejectedValue(new Error("Network error"));

        expect(
          await isContactSourceEnabled("user-1", "direct", "androidContacts", true),
        ).toBe(true);
      });

      it("does NOT derive macosContacts — Android contacts are gated on it", async () => {
        // THE GUARD. contactHandlers.ts:1294 gates every external contact whose
        // source is not outlook/google_contacts/iphone/macos on macosContacts,
        // and Android companion contacts are written with source
        // 'android_sync'. An Android user never sees the macOS card, so this
        // absent-preference branch is the only thing deciding the key. If it
        // ever answers false, every Android contact silently vanishes from the
        // picker.
        for (const platform of ["darwin", "win32"] as NodeJS.Platform[]) {
          setPlatform(platform);
          mockGetPreferences.mockResolvedValue({ phone_type: "android" });

          expect(
            await isContactSourceEnabled("user-1", "direct", "macosContacts", true),
          ).toBe(true);
        }
      });

      it("does NOT derive the mailbox sources — authProvider is not visible here", async () => {
        setPlatform("darwin");
        mockGetPreferences.mockResolvedValue({ phone_type: "iphone" });

        // Guessing OFF would silently stop a working mailbox import. The
        // onboarding step writes these on both continue and skip instead.
        expect(
          await isContactSourceEnabled("user-1", "direct", "outlookContacts", true),
        ).toBe(true);
        expect(
          await isContactSourceEnabled("user-1", "direct", "googleContacts", true),
        ).toBe(true);
      });

      it("lets an explicitly stored value win over the derived default", async () => {
        setPlatform("darwin");
        mockGetPreferences.mockResolvedValue({
          phone_type: "iphone",
          contactSources: { direct: { iphoneContacts: true } },
        });

        // The user turned it on knowing iCloud sync is off. Never override.
        expect(
          await isContactSourceEnabled("user-1", "direct", "iphoneContacts", true),
        ).toBe(true);
      });

      it("treats an unrecognised phone_type as unknown rather than trusting it", async () => {
        setPlatform("win32");
        mockGetPreferences.mockResolvedValue({ phone_type: "ios" });

        // "ios" is not "iphone". On Windows an unknown phone type still leaves
        // the iPhone on; the point is that it took the unknown branch.
        expect(
          await isContactSourceEnabled("user-1", "direct", "iphoneContacts", true),
        ).toBe(true);

        setPlatform("darwin");
        expect(
          await isContactSourceEnabled("user-1", "direct", "iphoneContacts", true),
        ).toBe(false);
      });

      it("never derives for the inferred category", async () => {
        setPlatform("darwin");
        mockGetPreferences.mockResolvedValue({ phone_type: "iphone" });

        // transactionService passes false for its three inferred sources and
        // must keep getting it.
        expect(
          await isContactSourceEnabled("user-1", "inferred", "outlookEmails", false),
        ).toBe(false);
        expect(
          await isContactSourceEnabled("user-1", "inferred", "gmailEmails", false),
        ).toBe(false);
        expect(
          await isContactSourceEnabled("user-1", "inferred", "messages", false),
        ).toBe(false);
      });

      it("still fails open on defaultValue when preferences cannot be READ", async () => {
        setPlatform("darwin");
        mockGetPreferences.mockRejectedValue(new Error("Supabase offline"));

        // Distinct from "no preference stored": a failed read cannot see
        // phone_type either, so applying the rule would be guessing.
        expect(
          await isContactSourceEnabled("user-1", "direct", "iphoneContacts", true),
        ).toBe(true);
      });
    });

    it("should return false as defaultValue on error when defaultValue is false", async () => {
      mockGetPreferences.mockRejectedValue(new Error("Network error"));

      const result = await isContactSourceEnabled("user-1", "direct", "outlookContacts", false);
      expect(result).toBe(false);
    });

    it("should ignore non-boolean values in preferences", async () => {
      mockGetPreferences.mockResolvedValue({
        contactSources: {
          direct: {
            outlookContacts: "yes", // string, not boolean
          },
        },
      });

      const result = await isContactSourceEnabled("user-1", "direct", "outlookContacts", true);
      expect(result).toBe(true); // falls back to default since not boolean
    });

    it("should handle null preference value", async () => {
      mockGetPreferences.mockResolvedValue({
        contactSources: {
          direct: {
            outlookContacts: null,
          },
        },
      });

      const result = await isContactSourceEnabled("user-1", "direct", "outlookContacts", true);
      expect(result).toBe(true); // null is not boolean, uses default
    });

    it("should handle undefined preference value", async () => {
      mockGetPreferences.mockResolvedValue({
        contactSources: {
          direct: {
            outlookContacts: undefined,
          },
        },
      });

      const result = await isContactSourceEnabled("user-1", "direct", "outlookContacts", true);
      expect(result).toBe(true); // undefined is not boolean, uses default
    });
  });

  describe("getEmailCacheDurationMonths", () => {
    it("should return stored value when emailCache.durationMonths is a valid positive number", async () => {
      mockGetPreferences.mockResolvedValue({
        emailCache: { durationMonths: 6 },
      });

      const result = await getEmailCacheDurationMonths("user-1");
      expect(result).toBe(6);
    });

    it("should fall back to 3 when preference key is missing", async () => {
      mockGetPreferences.mockResolvedValue({});

      const result = await getEmailCacheDurationMonths("user-1");
      expect(result).toBe(3);
    });

    it("should fall back to 3 when value is not a number", async () => {
      mockGetPreferences.mockResolvedValue({
        emailCache: { durationMonths: "6" },
      });

      const result = await getEmailCacheDurationMonths("user-1");
      expect(result).toBe(3);
    });

    it("should fall back to 3 when value is zero", async () => {
      mockGetPreferences.mockResolvedValue({
        emailCache: { durationMonths: 0 },
      });

      const result = await getEmailCacheDurationMonths("user-1");
      expect(result).toBe(3);
    });

    it("should fall back to 3 when value is negative", async () => {
      mockGetPreferences.mockResolvedValue({
        emailCache: { durationMonths: -2 },
      });

      const result = await getEmailCacheDurationMonths("user-1");
      expect(result).toBe(3);
    });

    it("should fall back to 3 and log warning when getPreferences throws", async () => {
      mockGetPreferences.mockRejectedValue(new Error("DB unavailable"));

      const result = await getEmailCacheDurationMonths("user-1");
      expect(result).toBe(3);
      expect(logService.warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not load email cache duration"),
        "Preferences",
        expect.objectContaining({ userId: "user-1" }),
      );
    });

    /**
     * BACKLOG-2565 bullet 1 — the legacy key the UI honours and this reader did not.
     *
     * THE BUG: `emailSync.lookbackMonths` is the pre-TASK-2072 name for the email
     * cache window. `EmailSettings.tsx:40-44` still falls back to it, so a user
     * who set 12 before the rename sees "12 months" on screen. This reader read
     * only `emailCache.durationMonths` and returned the default 3, and it is this
     * reader that `emailSyncService` caches against. The screen and the cache
     * disagreed about one setting.
     *
     * CONTROL: the first case below is RED on the pre-fix reader (returns 3,
     * expects 12). Reverting either legacy-key branch in
     * `resolveEmailCacheDurationMonths` turns it red again.
     *
     * The fixture shape is the one the bug requires and the only one a legacy
     * carrier can hold: the legacy key present, the canonical key ABSENT. No
     * writer has produced `emailSync.lookbackMonths` since TASK-2072 (verified:
     * `EmailSettings.tsx:249` writes `emailCache` only, and a repo-wide grep for
     * `emailSync?.lookbackMonths` finds the UI read and the type declaration and
     * nothing else), so a bag carrying both keys can only come from a user who
     * predates the rename AND has since touched Settings.
     */
    describe("legacy emailSync.lookbackMonths key (BACKLOG-2565)", () => {
      it("honours the legacy key when the canonical key is absent", async () => {
        mockGetPreferences.mockResolvedValue({
          emailSync: { lookbackMonths: 12 },
        });

        // RED before the fix: the pre-fix reader returned 3 here while
        // Settings displayed 12.
        await expect(getEmailCacheDurationMonths("user-1")).resolves.toBe(12);
      });

      it("lets the canonical key win when BOTH keys are stored", async () => {
        mockGetPreferences.mockResolvedValue({
          emailCache: { durationMonths: 6 },
          emailSync: { lookbackMonths: 12 },
        });

        // Precedence, not merge: the key the current writer produces wins, so a
        // later one-time fixup or server backfill silences the legacy branch
        // rather than fighting it.
        await expect(getEmailCacheDurationMonths("user-1")).resolves.toBe(6);
      });

      it("falls back to 3 when the legacy key holds a value the domain rejects", async () => {
        // Sweep, not sample: every non-positive / non-numeric shape the stored
        // JSON can hold must land on the default, exactly as the canonical key
        // already does. A single case here could not catch an off-by-one at 0.
        const rejected: unknown[] = [0, -2, "12", null, undefined, NaN, true];

        for (const value of rejected) {
          mockGetPreferences.mockResolvedValue({
            emailSync: { lookbackMonths: value },
          });
          await expect(getEmailCacheDurationMonths("user-1")).resolves.toBe(3);
        }
      });

      it("returns the same answer the Settings screen computes, for every shape", async () => {
        /**
         * The bug was DISAGREEMENT between two readers, so the assertion is
         * agreement — not "the backend returns 12".
         *
         * `EmailSettings.tsx:40-44` is a renderer module and cannot be imported
         * here (`electron/` has `rootDir` set, and the renderer cannot
         * value-import from `electron/` either). Its expression is TRANSCRIBED
         * below verbatim from that file so a future edit to either side that
         * breaks agreement trips this test.
         */
        const settingsScreenValue = (prefs: Record<string, any>): number => {
          const val =
            prefs?.emailCache?.durationMonths ?? prefs?.emailSync?.lookbackMonths;
          return typeof val === "number" && val > 0 ? val : 3;
        };

        const bags: Array<Record<string, any>> = [
          {},
          { emailCache: { durationMonths: 6 } },
          { emailSync: { lookbackMonths: 12 } },
          { emailCache: { durationMonths: 6 }, emailSync: { lookbackMonths: 12 } },
          { emailCache: { durationMonths: 0 }, emailSync: { lookbackMonths: 12 } },
          { emailSync: { lookbackMonths: 0 } },
          { emailSync: { lookbackMonths: "12" } },
        ];

        for (const bag of bags) {
          mockGetPreferences.mockResolvedValue(bag);
          await expect(getEmailCacheDurationMonths("user-1")).resolves.toBe(
            settingsScreenValue(bag),
          );
        }
      });
    });
  });

  describe("computeEmailCacheSinceDate", () => {
    it("should return a date approximately N months in the past", () => {
      const durationMonths = 6;
      const before = Date.now();
      const result = computeEmailCacheSinceDate(durationMonths);

      const expectedMs = durationMonths * 30 * 24 * 60 * 60 * 1000;
      const toleranceMs = 24 * 60 * 60 * 1000; // 1 day

      // The result should be approximately expectedMs ago
      const resultAge = before - result.getTime();
      expect(resultAge).toBeGreaterThanOrEqual(expectedMs - toleranceMs);
      expect(resultAge).toBeLessThanOrEqual(expectedMs + toleranceMs);

      // Also verify it's a valid Date
      expect(result).toBeInstanceOf(Date);
      expect(isNaN(result.getTime())).toBe(false);
    });

    it("should return a date very close to now for durationMonths = 0", () => {
      const before = Date.now();
      const result = computeEmailCacheSinceDate(0);
      const after = Date.now();

      // With 0 months, the date should be essentially now
      expect(result.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.getTime()).toBeLessThanOrEqual(after);
    });
  });

  // BACKLOG-1831: the shadow delta sync flag is DEFAULT OFF; enabled only by an
  // explicit env var or an explicit `true` preference.
  describe("isShadowDeltaSyncEnabled", () => {
    const ORIGINAL_ENV = process.env.KEEPR_SHADOW_DELTA_SYNC;
    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.KEEPR_SHADOW_DELTA_SYNC;
      else process.env.KEEPR_SHADOW_DELTA_SYNC = ORIGINAL_ENV;
    });

    it("defaults to OFF when the preference is unset", async () => {
      delete process.env.KEEPR_SHADOW_DELTA_SYNC;
      mockGetPreferences.mockResolvedValue({});
      expect(await isShadowDeltaSyncEnabled("user-1")).toBe(false);
    });

    it("is ON when the env var is '1' (no preference read needed)", async () => {
      process.env.KEEPR_SHADOW_DELTA_SYNC = "1";
      expect(await isShadowDeltaSyncEnabled("user-1")).toBe(true);
      expect(mockGetPreferences).not.toHaveBeenCalled();
    });

    it("is ON when the preference is explicitly true", async () => {
      delete process.env.KEEPR_SHADOW_DELTA_SYNC;
      mockGetPreferences.mockResolvedValue({ shadowDeltaSync: { enabled: true } });
      expect(await isShadowDeltaSyncEnabled("user-1")).toBe(true);
    });

    it("stays OFF when the preference is explicitly false", async () => {
      delete process.env.KEEPR_SHADOW_DELTA_SYNC;
      mockGetPreferences.mockResolvedValue({ shadowDeltaSync: { enabled: false } });
      expect(await isShadowDeltaSyncEnabled("user-1")).toBe(false);
    });

    it("fails CLOSED (OFF) when preferences cannot be loaded", async () => {
      delete process.env.KEEPR_SHADOW_DELTA_SYNC;
      mockGetPreferences.mockRejectedValue(new Error("offline"));
      expect(await isShadowDeltaSyncEnabled("user-1")).toBe(false);
      expect(logService.warn).toHaveBeenCalled();
    });
  });
});
