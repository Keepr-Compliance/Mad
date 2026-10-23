/**
 * BACKLOG-3436: the installer must NOT carry the per-machine -> per-user install
 * migration (the `customInit` macro BACKLOG-3432 added). app-builder-lib's
 * installer.nsi wraps `customInit` in `!ifmacrodef customInit`, so ANY definition of
 * the macro (even an empty stub) is inserted into the installer.
 *
 * NSIS cannot be compiled in this test environment, so this reads the .nsh files as
 * text. Inline `;` and `#` comments are stripped first, so a trailing comment cannot
 * hide a definition and a comment that merely mentions a name cannot trip a check.
 * The Store build includes installer.nsh via installer-store.nsh, so both are scanned.
 */
import * as fs from "fs";
import * as path from "path";

const BUILD = path.resolve(__dirname, "..", "..", "build");

// Strip `;...` and `#...` comments (outside double-quoted strings), drop blank lines.
export function codeLines(src: string): string[] {
  return src
    .split(/\r?\n/)
    .map((line) => {
      let inStr = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') inStr = !inStr;
        else if (!inStr && (c === ";" || c === "#")) return line.slice(0, i);
      }
      return line;
    })
    .filter((l) => l.trim() !== "");
}

const read = (f: string) => fs.readFileSync(path.join(BUILD, f), "utf8");
const FILES = ["installer.nsh", "installer-store.nsh"];
const count = (lines: string[], re: RegExp) => lines.filter((l) => re.test(l)).length;

describe("BACKLOG-3436: installer has no per-machine migration", () => {
  describe.each(FILES)("%s", (file) => {
    const code = codeLines(read(file));

    it("defines no customInit macro (not even a stub)", () => {
      expect(count(code, /^\s*!macro\s+customInit\b/i)).toBe(0);
    });
    it("does not reference the old uninstaller", () => {
      expect(count(code, /keepr-old-uninstaller/i)).toBe(0);
    });
    it("does not read an HKLM Uninstall key", () => {
      expect(count(code, /HKLM.*Uninstall|Uninstall.*HKLM/i)).toBe(0);
    });
  });

  describe("installer.nsh keeps the macros that belong there", () => {
    const code = codeLines(read("installer.nsh"));

    it("has exactly one customUnInstall and one customInstall", () => {
      expect(count(code, /^\s*!macro\s+customUnInstall\b/i)).toBe(1);
      expect(count(code, /^\s*!macro\s+customInstall\b/i)).toBe(1);
    });
    it("every !macro is closed by a !macroend", () => {
      expect(count(code, /^\s*!macro\s/i)).toBe(count(code, /^\s*!macroend\b/i));
    });
  });
});
