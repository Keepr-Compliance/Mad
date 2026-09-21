/**
 * Unit tests for resolveIphoneSyncEnabled (BACKLOG-1706, amended by BACKLOG-3423)
 *
 * The resolver is pure and takes platform + import source as plain arguments,
 * so these tests need no process.platform stubbing.
 *
 * BACKLOG-3423 changed three expectations that pinned the BACKLOG-1706 rule
 * "an explicit preference always wins" and its Windows/Linux "always on
 * regardless of source" corollary. A known non-iPhone source now wins over
 * both. The cases below carry their old values in the names where they moved.
 *
 * BACKLOG-3418 (founder decision 2026-09-21, pm_comments f59ce258) changed two
 * more, deliberately, as part of that decision: an UNKNOWN source (`null`) on
 * Windows / Linux was ON under BACKLOG-1706 (as kept by 3423) and is now OFF,
 * as it already was on macOS. `null` is the signed-out / preferences-loading
 * state, so the old `true` ran device detection on the login screen.
 */

import {
  resolveIphoneSyncEnabled,
  importSourceForPhoneType,
} from "../iphoneSyncEnabled";

describe("resolveIphoneSyncEnabled (BACKLOG-1706)", () => {
  describe("explicit preference wins over the platform/source defaults", () => {
    it("returns false when pref=false on Windows (overrides always-on default)", () => {
      expect(resolveIphoneSyncEnabled(false, "windows", "iphone-sync")).toBe(false);
    });

    it("returns false when pref=false on macOS even with iphone-sync source", () => {
      expect(resolveIphoneSyncEnabled(false, "macos", "iphone-sync")).toBe(false);
    });

    it("returns true when pref=true on macOS with an iphone-sync source", () => {
      expect(resolveIphoneSyncEnabled(true, "macos", "iphone-sync")).toBe(true);
    });

    it("returns true when pref=true and the source is not known yet", () => {
      expect(resolveIphoneSyncEnabled(true, "macos", null)).toBe(true);
      // BACKLOG-3418 keeps rule order: an explicit preference still decides
      // before the unknown-source default. IPhoneSyncProvider sets the stored
      // preference and the source in the same batch once preferences are read,
      // so a known preference beside an unknown source is not a state the
      // provider produces from a preference read.
      expect(resolveIphoneSyncEnabled(true, "windows", null)).toBe(true);
    });
  });

  describe("BACKLOG-3423: a known non-iPhone source overrides the preference", () => {
    // The founder's own stored state on 2026-09-17: the toggle had been set ON
    // at some earlier point and the preference follows the account into every
    // fresh profile, so "pref=true + macos-native" gave a macOS Messages user
    // USB device detection and a toggle reading ON. Was `true` before 3423.
    it("is OFF on macOS for macos-native even when pref=true", () => {
      expect(resolveIphoneSyncEnabled(true, "macos", "macos-native")).toBe(false);
    });

    it("is OFF on macOS for android-companion even when pref=true", () => {
      expect(resolveIphoneSyncEnabled(true, "macos", "android-companion")).toBe(false);
    });

    it("is OFF on Windows for android-companion even when pref=true", () => {
      expect(resolveIphoneSyncEnabled(true, "windows", "android-companion")).toBe(false);
    });

    it("is OFF on Linux for android-companion even when pref=true", () => {
      expect(resolveIphoneSyncEnabled(true, "linux", "android-companion")).toBe(false);
    });

    it("leaves the iPhone source alone: pref=true stays ON everywhere", () => {
      expect(resolveIphoneSyncEnabled(true, "macos", "iphone-sync")).toBe(true);
      expect(resolveIphoneSyncEnabled(true, "windows", "iphone-sync")).toBe(true);
      expect(resolveIphoneSyncEnabled(true, "linux", "iphone-sync")).toBe(true);
    });
  });

  describe("macOS default is opt-in (off) when preference is unset", () => {
    it("is OFF for a fresh macOS user (default macos-native source)", () => {
      expect(resolveIphoneSyncEnabled(undefined, "macos", "macos-native")).toBe(false);
    });

    it("is OFF on macOS when source is unknown/null", () => {
      expect(resolveIphoneSyncEnabled(undefined, "macos", null)).toBe(false);
    });

    it("is OFF on macOS for android-companion source", () => {
      expect(resolveIphoneSyncEnabled(undefined, "macos", "android-companion")).toBe(false);
    });

    it("is ON on macOS when the user selected iphone-sync as their source", () => {
      expect(resolveIphoneSyncEnabled(undefined, "macos", "iphone-sync")).toBe(true);
    });
  });

  describe("Windows/Linux when unset: ON for an iPhone source, OFF while unknown", () => {
    it("is ON on Windows for an iPhone source", () => {
      // Unchanged by BACKLOG-3418. A signed-in Windows user with no stored
      // source gets `iphone-sync` derived by IPhoneSyncContext (unless their
      // phone type is Android), so nobody signed in loses detection.
      expect(resolveIphoneSyncEnabled(undefined, "windows", "iphone-sync")).toBe(true);
    });

    // BACKLOG-3418: was `true` under BACKLOG-1706 (and kept by 3423: "stay ON
    // while the source is unknown"). Rewritten as part of the 2026-09-21
    // decision, not to fit an implementation: `null` is signed out or
    // preferences still loading, and no detection runs in that state on any
    // platform.
    it("is OFF on Windows while the source is unknown (signed out / preferences loading)", () => {
      expect(resolveIphoneSyncEnabled(undefined, "windows", null)).toBe(false);
    });

    it("is OFF on Linux while the source is unknown (signed out / preferences loading)", () => {
      expect(resolveIphoneSyncEnabled(undefined, "linux", null)).toBe(false);
    });

    it("is ON on Linux for an iPhone source", () => {
      expect(resolveIphoneSyncEnabled(undefined, "linux", "iphone-sync")).toBe(true);
    });

    // BACKLOG-3423: both of these were `true` under BACKLOG-1706's "Windows and
    // Linux are always on regardless of source". `macos-native` is not offered
    // on those platforms (ImportSourceSettings renders that radio under
    // isMacOS), so in practice the change bites an Android-source user, for
    // whom a 2s USB iPhone poll is pure waste.
    it("is OFF on Windows for a known non-iPhone source", () => {
      expect(resolveIphoneSyncEnabled(undefined, "windows", "android-companion")).toBe(false);
      expect(resolveIphoneSyncEnabled(undefined, "windows", "macos-native")).toBe(false);
    });

    it("is OFF on Linux for a known non-iPhone source", () => {
      expect(resolveIphoneSyncEnabled(undefined, "linux", "android-companion")).toBe(false);
    });
  });
});

describe("importSourceForPhoneType (BACKLOG-2408 mapping, shared by BACKLOG-3418)", () => {
  // The values usePhoneTypeApi persisted inline before BACKLOG-3418 extracted
  // them (usePhoneTypeApi.ts, BACKLOG-2408 block), for every answer x platform.
  it.each([
    ["android", true, "android-companion"],
    ["android", false, "android-companion"],
    ["iphone", true, "macos-native"],
    ["iphone", false, "iphone-sync"],
  ] as const)("%s answer, isMacOS=%s -> %s", (phoneType, isMacOS, expected) => {
    expect(importSourceForPhoneType(phoneType, isMacOS)).toBe(expected);
  });
});
