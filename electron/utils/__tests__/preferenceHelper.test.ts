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
