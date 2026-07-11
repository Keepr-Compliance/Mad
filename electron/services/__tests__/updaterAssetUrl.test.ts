/**
 * Tests for the pure manual-installer URL builder (BACKLOG-1905, Deliverable 2).
 *
 * Verifies:
 * - correct asset name per platform × arch (mac x64/arm64 .dmg, win .exe)
 * - canonical `v<version>` tag + Keepr-Compliance/keepr-releases owner/repo
 * - a leading "v" in the version is tolerated
 * - the legacy `5hdaniel` owner is REFUSED (BACKLOG-1909 hard constraint)
 * - unsupported platform/arch and missing config resolve to undefined
 */

import {
  buildManualInstallerUrl,
  resolveInstallerAssetName,
} from "../updaterAssetUrl";

const CANONICAL = { provider: "github", owner: "Keepr-Compliance", repo: "keepr-releases" };

describe("resolveInstallerAssetName", () => {
  it("macOS arm64 → Keepr-<v>-arm64.dmg", () => {
    expect(resolveInstallerAssetName("Keepr", "2.99.0", "darwin", "arm64")).toBe(
      "Keepr-2.99.0-arm64.dmg",
    );
  });

  it("macOS x64 → Keepr-<v>.dmg (no arch suffix)", () => {
    expect(resolveInstallerAssetName("Keepr", "2.99.0", "darwin", "x64")).toBe(
      "Keepr-2.99.0.dmg",
    );
  });

  it("Windows → Keepr-Setup-<v>.exe (arch-agnostic)", () => {
    expect(resolveInstallerAssetName("Keepr", "2.99.0", "win32", "x64")).toBe(
      "Keepr-Setup-2.99.0.exe",
    );
  });

  it("unsupported platform (linux) → undefined", () => {
    expect(resolveInstallerAssetName("Keepr", "2.99.0", "linux", "x64")).toBeUndefined();
  });

  it("empty version → undefined", () => {
    expect(resolveInstallerAssetName("Keepr", "", "darwin", "arm64")).toBeUndefined();
  });
});

describe("buildManualInstallerUrl", () => {
  it("builds the canonical mac arm64 download URL", () => {
    expect(
      buildManualInstallerUrl({
        version: "2.99.0",
        platform: "darwin",
        arch: "arm64",
        publish: CANONICAL,
      }),
    ).toBe(
      "https://github.com/Keepr-Compliance/keepr-releases/releases/download/v2.99.0/Keepr-2.99.0-arm64.dmg",
    );
  });

  it("builds the canonical mac x64 download URL", () => {
    expect(
      buildManualInstallerUrl({
        version: "2.99.0",
        platform: "darwin",
        arch: "x64",
        publish: CANONICAL,
      }),
    ).toBe(
      "https://github.com/Keepr-Compliance/keepr-releases/releases/download/v2.99.0/Keepr-2.99.0.dmg",
    );
  });

  it("builds the canonical Windows download URL", () => {
    expect(
      buildManualInstallerUrl({
        version: "2.99.0",
        platform: "win32",
        arch: "x64",
        publish: CANONICAL,
      }),
    ).toBe(
      "https://github.com/Keepr-Compliance/keepr-releases/releases/download/v2.99.0/Keepr-Setup-2.99.0.exe",
    );
  });

  it("tolerates a leading 'v' in the version", () => {
    expect(
      buildManualInstallerUrl({
        version: "v2.99.0",
        platform: "darwin",
        arch: "arm64",
        publish: CANONICAL,
      }),
    ).toBe(
      "https://github.com/Keepr-Compliance/keepr-releases/releases/download/v2.99.0/Keepr-2.99.0-arm64.dmg",
    );
  });

  it("REFUSES the legacy 5hdaniel owner (BACKLOG-1909)", () => {
    expect(() =>
      buildManualInstallerUrl({
        version: "2.99.0",
        platform: "darwin",
        arch: "arm64",
        publish: { provider: "github", owner: "5hdaniel", repo: "keepr-releases" },
      }),
    ).toThrow(/5hdaniel|legacy/i);
  });

  it("never emits a 5hdaniel URL for the canonical config", () => {
    const url = buildManualInstallerUrl({
      version: "2.99.0",
      platform: "win32",
      arch: "x64",
      publish: CANONICAL,
    });
    expect(url).not.toContain("5hdaniel");
    expect(url).toContain("Keepr-Compliance/keepr-releases");
  });

  it("returns undefined for unsupported platform", () => {
    expect(
      buildManualInstallerUrl({
        version: "2.99.0",
        platform: "linux",
        arch: "x64",
        publish: CANONICAL,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when owner/repo are missing", () => {
    expect(
      buildManualInstallerUrl({
        version: "2.99.0",
        platform: "darwin",
        arch: "arm64",
        publish: {},
      }),
    ).toBeUndefined();
  });

  it("honours a custom productName", () => {
    expect(
      buildManualInstallerUrl({
        version: "3.0.0",
        platform: "win32",
        arch: "x64",
        publish: CANONICAL,
        productName: "KeeprPro",
      }),
    ).toBe(
      "https://github.com/Keepr-Compliance/keepr-releases/releases/download/v3.0.0/KeeprPro-Setup-3.0.0.exe",
    );
  });
});
