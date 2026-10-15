/**
 * BACKLOG-3802: the NSIS uninstaller must ALWAYS remove electron-updater's download
 * cache (%LOCALAPPDATA%\keepr-updater), whatever the user answers to the data question
 * and when the caller passed /S -- but NEVER during an auto-update (`--updated`), when the
 * running new installer lives inside that directory.
 *
 * NSIS cannot be compiled or run in this test environment, so these tests read
 * build/installer.nsh and assert the structure of the `customUnInstall` macro. Each
 * assertion names the wrong implementation it catches.
 */
import * as fs from "fs";
import * as path from "path";

const REPO = path.resolve(__dirname, "..", "..");
const NSH = fs.readFileSync(path.join(REPO, "build", "installer.nsh"), "utf8");

// Code lines of the customUnInstall macro, comments stripped (a comment that merely
// mentions RMDir or isUpdated must never satisfy an assertion).
function macroLines(name: string): string[] {
  const lines = NSH.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `!macro ${name}`);
  if (start < 0) throw new Error(`!macro ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l.trim() === "!macroend");
  if (end < 0) throw new Error(`!macroend for ${name} not found`);
  return lines
    .slice(start + 1, end)
    .map((l) => l.replace(/^\s*;.*$/, "").trim());
}

const BODY = macroLines("customUnInstall");

// app-builder-lib appInfo.js:126-127 -> sanitizedName.toLowerCase() + "-updater".
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PKG_NAME: string = require(path.join(REPO, "package.json")).name;
const CACHE_DIR = `${PKG_NAME.toLowerCase()}-updater`;
const REMOVAL = `RMDir /r "$LOCALAPPDATA\\${CACHE_DIR}"`;

const isOpen = (l: string) => /^\$\{(if|ifnot)\}/i.test(l);
const isClose = (l: string) => /^\$\{endif\}/i.test(l);

/** [openIndex, closeIndex] of the `${ifNot} ${isUpdated}` block. */
function isUpdatedGuardSpan(): [number, number] {
  const open = BODY.findIndex((l) => /^\$\{ifNot\}\s+\$\{isUpdated\}$/i.test(l));
  if (open < 0) return [-1, -1];
  let depth = 0;
  for (let i = open; i < BODY.length; i++) {
    if (isOpen(BODY[i])) depth++;
    else if (isClose(BODY[i])) {
      depth--;
      if (depth === 0) return [open, i];
    }
  }
  return [open, -1];
}

describe("customUnInstall removes the updater cache (BACKLOG-3802)", () => {
  const removalIdx = BODY.indexOf(REMOVAL);

  it("removes the updater cache dir, named as electron-builder names it", () => {
    // Wrong implementation caught: no removal at all, or a misspelled / renamed dir.
    expect(CACHE_DIR).toBe("keepr-updater");
    expect(removalIdx).toBeGreaterThanOrEqual(0);
    // The in-app reset removes the same directory.
    const cleanup = fs.readFileSync(
      path.join(REPO, "electron", "services", "appCleanupService.ts"),
      "utf8",
    );
    expect(cleanup).toContain(`"${CACHE_DIR}"`);
  });

  it("skips the removal during an auto-update (inside the ${ifNot} ${isUpdated} guard)", () => {
    // Wrong implementation caught: removal outside the guard, which would delete the
    // keepr-updater\pending directory the running update installer executes from.
    const [open, close] = isUpdatedGuardSpan();
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    expect(removalIdx).toBeGreaterThan(open);
    expect(removalIdx).toBeLessThan(close);
  });

  it("runs on Yes, on No and on /S (before the /S check and the data question)", () => {
    // Wrong implementation caught: removal placed in the Yes-only delete branch, or after
    // the /S bail-out, so No and silent uninstalls still leave the cache behind.
    const slashSBranch = BODY.findIndex((l) => /^IfErrors\s+keepr_maybe_prompt\s+keepr_skip_data_cleanup$/.test(l));
    const prompt = BODY.findIndex((l) => l.startsWith("MessageBox"));
    expect(slashSBranch).toBeGreaterThan(0);
    expect(prompt).toBeGreaterThan(0);
    expect(removalIdx).toBeLessThan(slashSBranch);
    expect(removalIdx).toBeLessThan(prompt);
  });

  it("targets the user's profile on a per-machine install", () => {
    // Wrong implementation caught: under SetShellVarContext all, $LOCALAPPDATA is
    // C:\ProgramData and the user's cache survives.
    const [open] = isUpdatedGuardSpan();
    const between = BODY.slice(open, removalIdx);
    expect(between).toContain("SetShellVarContext current");
    const after = BODY.slice(removalIdx + 1);
    const restore = after.findIndex((l) => l === "SetShellVarContext all");
    const nextAction = after.findIndex((l) => /^(RMDir|MessageBox|ClearErrors)/.test(l));
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(nextAction);
  });

  it("the data question says where kept data lives", () => {
    const prompt = BODY.find((l) => l.startsWith("MessageBox")) ?? "";
    expect(prompt).toContain("%APPDATA%\\keepr");
    expect(prompt).toContain("%LOCALAPPDATA%\\keepr");
  });
});
