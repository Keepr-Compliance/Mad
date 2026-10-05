/**
 * BACKLOG-3749 — the stored import source is account-wide; a value from
 * another device or a newer build must never silently switch a platform's
 * sync off.
 *
 * Mutations (each turns a test red):
 *   M1 an unknown value passed through as is            → "unknown → the platform default"
 *   M2 Mac Messages gated on "=== macos-native" again   → "only iPhone Sync turns Mac Messages off"
 */
import {
  defaultImportSource,
  effectiveImportSource,
  isKnownImportSource,
  KNOWN_IMPORT_SOURCES,
  macMessagesSyncOn,
} from "../importSourcePolicy";

describe("importSourcePolicy (BACKLOG-3749)", () => {
  it("the four sources this build knows", () => {
    expect([...KNOWN_IMPORT_SOURCES].sort()).toEqual(["android-companion", "android-messages-web", "iphone-sync", "macos-native"]);
    expect(isKnownImportSource("android-messages-web")).toBe(true);
    expect(isKnownImportSource("some-future-source")).toBe(false);
    expect(isKnownImportSource(undefined)).toBe(false);
    expect(isKnownImportSource(42)).toBe(false);
  });

  it("unknown → the platform default; a known value is kept as is", () => {
    expect(effectiveImportSource("some-future-source", true)).toBe("macos-native");
    expect(effectiveImportSource("some-future-source", false)).toBe("iphone-sync");
    expect(effectiveImportSource(null, true)).toBe(defaultImportSource(true));
    expect(effectiveImportSource("android-messages-web", true)).toBe("android-messages-web");
    expect(effectiveImportSource("iphone-sync", true)).toBe("iphone-sync");
  });

  it("only iPhone Sync turns Mac Messages off; Android and unknown values never do", () => {
    expect(macMessagesSyncOn("iphone-sync")).toBe(false);
    for (const v of ["macos-native", "android-messages-web", "android-companion", "some-future-source", undefined, null]) {
      expect([v, macMessagesSyncOn(v)]).toEqual([v, true]);
    }
  });
});
