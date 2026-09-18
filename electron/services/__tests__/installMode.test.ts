/**
 * Install-mode derivation tests (BACKLOG-3432)
 *
 * The value this produces is the only signal that tells us a Windows user's
 * per-machine -> per-user migration did not happen, so a wrong "other" is a
 * user we never find. The boundary cases below are swept, not sampled.
 *
 * Fixture paths are transcribed from the measured census recorded on
 * BACKLOG-3431, which read them off a real Windows 11 machine, with the
 * account name replaced by a placeholder. They are not invented.
 */

import {
  deriveInstallMode,
  type InstallModeInput,
} from "../diagnostics/installMode";

/** The env a real 64-bit Windows 11 process sees. */
const WINDOWS_ENV = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ProgramW6432: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
};

const PER_MACHINE_EXE = "C:\\Program Files\\Keepr\\Keepr.exe";
const PER_USER_EXE =
  "C:\\Users\\tester\\AppData\\Local\\Programs\\keepr\\Keepr.exe";

function input(overrides: Partial<InstallModeInput> = {}): InstallModeInput {
  return {
    platform: "win32",
    execPath: PER_MACHINE_EXE,
    isPackaged: true,
    env: WINDOWS_ENV,
    ...overrides,
  };
}

describe("deriveInstallMode", () => {
  describe("the two states the migration is about", () => {
    it("classifies the measured per-machine path as per-machine", () => {
      expect(deriveInstallMode(input({ execPath: PER_MACHINE_EXE }))).toBe(
        "per-machine",
      );
    });

    it("classifies the measured per-user path as per-user", () => {
      expect(deriveInstallMode(input({ execPath: PER_USER_EXE }))).toBe(
        "per-user",
      );
    });

    it("classifies a 32-bit Program Files path as per-machine", () => {
      expect(
        deriveInstallMode(
          input({ execPath: "C:\\Program Files (x86)\\Keepr\\Keepr.exe" }),
        ),
      ).toBe("per-machine");
    });
  });

  describe("segment boundaries — a raw string prefix would get these wrong", () => {
    it("does NOT call a sibling directory per-machine", () => {
      // "C:\Program Files Backup" starts with "C:\Program Files" as a string.
      expect(
        deriveInstallMode(
          input({ execPath: "C:\\Program Files Backup\\Keepr\\Keepr.exe" }),
        ),
      ).toBe("other");
    });

    it("does NOT call a sibling directory per-user", () => {
      // "...\AppData\Locality" starts with "...\AppData\Local" as a string.
      expect(
        deriveInstallMode(
          input({
            execPath:
              "C:\\Users\\tester\\AppData\\Locality\\Programs\\keepr\\Keepr.exe",
          }),
        ),
      ).toBe("other");
    });

    it("does NOT treat the root itself as an install under it", () => {
      expect(
        deriveInstallMode(input({ execPath: "C:\\Program Files" })),
      ).toBe("other");
    });

    it("tolerates a trailing separator on the configured root", () => {
      expect(
        deriveInstallMode(
          input({
            execPath: PER_MACHINE_EXE,
            env: { ...WINDOWS_ENV, ProgramFiles: "C:\\Program Files\\" },
          }),
        ),
      ).toBe("per-machine");
    });

    it("is case-insensitive, as Windows paths are", () => {
      expect(
        deriveInstallMode(
          input({ execPath: "c:\\PROGRAM FILES\\keepr\\KEEPR.EXE" }),
        ),
      ).toBe("per-machine");
    });
  });

  describe("fallback patterns when the environment does not name the root", () => {
    it("recognises Program Files with no env roots at all", () => {
      expect(
        deriveInstallMode(input({ execPath: PER_MACHINE_EXE, env: {} })),
      ).toBe("per-machine");
    });

    it("recognises a per-user path with no env roots at all", () => {
      expect(deriveInstallMode(input({ execPath: PER_USER_EXE, env: {} }))).toBe(
        "per-user",
      );
    });

    it("recognises Program Files (x86) when only that env key is missing", () => {
      const env = { ...WINDOWS_ENV } as Record<string, string>;
      delete env["ProgramFiles(x86)"];
      expect(
        deriveInstallMode(
          input({
            execPath: "C:\\Program Files (x86)\\Keepr\\Keepr.exe",
            env,
          }),
        ),
      ).toBe("per-machine");
    });

    it("still refuses the sibling directory with no env roots", () => {
      expect(
        deriveInstallMode(
          input({
            execPath: "C:\\Program Files Backup\\Keepr\\Keepr.exe",
            env: {},
          }),
        ),
      ).toBe("other");
    });

    it("ignores an empty-string env root rather than matching everything", () => {
      expect(
        deriveInstallMode(
          input({
            execPath: "D:\\Portable\\Keepr\\Keepr.exe",
            env: { ProgramFiles: "", LOCALAPPDATA: "" },
          }),
        ),
      ).toBe("other");
    });
  });

  describe("everything that is not one of the two install shapes", () => {
    it("reports n/a on macOS", () => {
      expect(
        deriveInstallMode(
          input({
            platform: "darwin",
            execPath: "/Applications/Keepr.app/Contents/MacOS/Keepr",
            env: {},
          }),
        ),
      ).toBe("n/a");
    });

    it("reports n/a on Linux", () => {
      expect(
        deriveInstallMode(
          input({ platform: "linux", execPath: "/opt/keepr/keepr", env: {} }),
        ),
      ).toBe("n/a");
    });

    it("reports other for an unpackaged dev build sitting under Program Files", () => {
      expect(
        deriveInstallMode(
          input({ execPath: PER_MACHINE_EXE, isPackaged: false }),
        ),
      ).toBe("other");
    });

    it("reports other for a portable copy on another drive", () => {
      expect(
        deriveInstallMode(
          input({ execPath: "D:\\KeeprPortable\\Keepr.exe" }),
        ),
      ).toBe("other");
    });

    it("reports other for an empty execPath", () => {
      expect(deriveInstallMode(input({ execPath: "" }))).toBe("other");
    });
  });

  describe("the value carries no personal data", () => {
    it("never returns anything but the four fixed values", () => {
      const accountName = "tester";
      const results = [
        deriveInstallMode(input({ execPath: PER_USER_EXE })),
        deriveInstallMode(input({ execPath: PER_MACHINE_EXE })),
        deriveInstallMode(input({ execPath: "D:\\KeeprPortable\\Keepr.exe" })),
        deriveInstallMode(input({ platform: "darwin" })),
      ];

      expect(results).toEqual(["per-user", "per-machine", "other", "n/a"]);
      for (const result of results) {
        expect(result).not.toContain(accountName);
        expect(result).not.toContain("\\");
      }
    });
  });
});
