/**
 * BACKLOG-2709 — precedence for the development data directory.
 *
 * `resolveAppDataDir` is the whole decision. Each case below flips ONE input
 * away from a known-good baseline, so a regression in any single branch fails
 * on its own rather than being masked by the others.
 *
 * The case that matters most is `isPackaged: true -> null`: that is the guard
 * standing between a code change and the founder's real 247MB database.
 */

import path from "path";
import {
  DEV_DIR_NAME,
  USER_DATA_ENV_VAR,
  resolveAppDataDir,
  buildFirstRunNotice,
  buildConsoleNotice,
  type AppDataDirInput,
  type AppliedAppDataPaths,
} from "../appDataPaths";

const APP_DATA = "/Users/someone/Library/Application Support";

/** Unpackaged dev launch with no overrides — the case that must move. */
function baseline(overrides: Partial<AppDataDirInput> = {}): AppDataDirInput {
  return {
    isPackaged: false,
    hasUserDataDirSwitch: false,
    envOverride: undefined,
    appDataPath: APP_DATA,
    ...overrides,
  };
}

describe("resolveAppDataDir", () => {
  it("moves an unpackaged dev launch to the development directory", () => {
    expect(resolveAppDataDir(baseline())).toBe(
      path.join(APP_DATA, DEV_DIR_NAME),
    );
  });

  it("never moves a packaged build — the installed app keeps its real path", () => {
    expect(resolveAppDataDir(baseline({ isPackaged: true }))).toBeNull();
  });

  it("leaves paths alone when --user-data-dir was supplied", () => {
    // E2E hermetic profiles depend on Electron's own handling of this switch.
    expect(
      resolveAppDataDir(baseline({ hasUserDataDirSwitch: true })),
    ).toBeNull();
  });

  it("uses KEEPR_USER_DATA_DIR verbatim when set", () => {
    expect(
      resolveAppDataDir(baseline({ envOverride: "/tmp/keepr-fixture" })),
    ).toBe("/tmp/keepr-fixture");
  });

  it("honours KEEPR_USER_DATA_DIR in a packaged build, so a QA build can run on a fixture", () => {
    expect(
      resolveAppDataDir(
        baseline({ isPackaged: true, envOverride: "/tmp/keepr-fixture" }),
      ),
    ).toBe("/tmp/keepr-fixture");
  });

  it("gives --user-data-dir precedence over KEEPR_USER_DATA_DIR", () => {
    expect(
      resolveAppDataDir(
        baseline({
          hasUserDataDirSwitch: true,
          envOverride: "/tmp/keepr-fixture",
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
  ])("treats an %s KEEPR_USER_DATA_DIR as unset", (_label, value) => {
    expect(resolveAppDataDir(baseline({ envOverride: value }))).toBe(
      path.join(APP_DATA, DEV_DIR_NAME),
    );
  });

  it("ignores an empty override in a packaged build rather than falling through to dev", () => {
    expect(
      resolveAppDataDir(baseline({ isPackaged: true, envOverride: "  " })),
    ).toBeNull();
  });

  it("derives the dev directory from the supplied appData root", () => {
    expect(
      resolveAppDataDir(baseline({ appDataPath: "/custom/root" })),
    ).toBe(path.join("/custom/root", DEV_DIR_NAME));
  });
});

describe("notice text", () => {
  const applied: AppliedAppDataPaths = {
    dir: path.join(APP_DATA, DEV_DIR_NAME),
    previousDir: path.join(APP_DATA, "keepr"),
    isFirstRun: true,
    isExplicitOverride: false,
  };

  it("names both directories, so the real one is locatable from the message", () => {
    const notice = buildFirstRunNotice(applied);
    expect(notice.detail).toContain(applied.dir);
    expect(notice.detail).toContain(applied.previousDir);
  });

  it("states that starting empty is expected, not data loss", () => {
    expect(buildFirstRunNotice(applied).detail).toMatch(/NOT data loss/i);
  });

  it("prints both directories in the terminal banner", () => {
    const banner = buildConsoleNotice(applied);
    expect(banner).toContain(applied.dir);
    expect(banner).toContain(applied.previousDir);
  });

  it("attributes the directory to the env var when one was used", () => {
    expect(
      buildConsoleNotice({ ...applied, isExplicitOverride: true }),
    ).toContain(USER_DATA_ENV_VAR);
  });
});
