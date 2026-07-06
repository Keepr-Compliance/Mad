/**
 * Unit tests for resolveIphoneSyncEnabled (BACKLOG-1706)
 *
 * The resolver is pure and takes platform + import source as plain arguments,
 * so these tests need no process.platform stubbing.
 */

import { resolveIphoneSyncEnabled } from "../iphoneSyncEnabled";

describe("resolveIphoneSyncEnabled (BACKLOG-1706)", () => {
  describe("explicit preference always wins", () => {
    it("returns true when pref=true on macOS even with a non-iphone source", () => {
      expect(resolveIphoneSyncEnabled(true, "macos", "macos-native")).toBe(true);
    });

    it("returns false when pref=false on Windows (overrides always-on default)", () => {
      expect(resolveIphoneSyncEnabled(false, "windows", "iphone-sync")).toBe(false);
    });

    it("returns false when pref=false on macOS even with iphone-sync source", () => {
      expect(resolveIphoneSyncEnabled(false, "macos", "iphone-sync")).toBe(false);
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

  describe("Windows/Linux keep current always-on behavior when unset", () => {
    it("is ON on Windows regardless of source", () => {
      expect(resolveIphoneSyncEnabled(undefined, "windows", "iphone-sync")).toBe(true);
      expect(resolveIphoneSyncEnabled(undefined, "windows", "macos-native")).toBe(true);
      expect(resolveIphoneSyncEnabled(undefined, "windows", null)).toBe(true);
    });

    it("is ON on Linux regardless of source", () => {
      expect(resolveIphoneSyncEnabled(undefined, "linux", null)).toBe(true);
      expect(resolveIphoneSyncEnabled(undefined, "linux", "android-companion")).toBe(true);
    });
  });
});
