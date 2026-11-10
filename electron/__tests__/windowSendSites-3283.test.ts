/**
 * BACKLOG-3283: a new main->renderer push must not target a window it captured
 * once.
 *
 * Every push to the main window goes through `sendToMainWindow`
 * (`windowRegistry.ts`, BACKLOG-3454), which resolves the live window on each
 * call. The other direct `webContents.send(` sites are listed below, and each one
 * also resolves its target on each call. The list is a CEILING per file:
 *   - a file that is not listed fails;
 *   - a listed file whose count rises above its entry fails;
 *   - a count that falls is fine, so moving a send onto `sendToMainWindow` never
 *     turns this red. Lower the entry when that happens; the list only shrinks.
 * Fix a red by routing the push through `sendToMainWindow`, or add an entry that
 * says how the new site resolves its window.
 *
 * BLIND SPOTS (measured, not assumed):
 *   - `event.sender.send(` / `sender.send(` do not match the pattern
 *     (`ccpaHandlers.ts`, `learnModeHandlers.ts`). Both reply to the invoking
 *     renderer per invoke today.
 *   - A window captured once and passed into a helper, such as
 *     `bringAppToFront(captured)`, is invisible here. Only the runtime suites
 *     (`windowRecreation-3454`, `dockReopenAuth-3283`) see that.
 */

import fs from "fs";
import path from "path";

const ELECTRON = path.resolve(__dirname, "..");

/** file (relative to electron/) -> the most direct sends allowed, and why each is live. */
const CEILING: Record<string, number> = {
  "windowRegistry.ts": 1, // the accessor itself
  "main.ts": 7, // reads the module `mainWindow`, which every createWindow() reassigns
  "capabilities/electron/electronWindows.ts": 1, // BrowserWindow.getAllWindows() per broadcast
  "services/messagesBackgroundImportSignal.ts": 1, // getAllWindows() per broadcast
  "services/supportAccess/index.ts": 1, // getAllWindows() per broadcast
  "handlers/driverHandlers.ts": 2, // BrowserWindow.fromWebContents(event.sender) per invoke
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

describe("direct webContents.send sites in the main process (BACKLOG-3283)", () => {
  const found: Record<string, number> = {};
  const files = sourceFiles(ELECTRON);
  for (const file of files) {
    const n = (fs.readFileSync(file, "utf8").match(/\.webContents\??\.send\(/g) ?? []).length;
    if (n > 0) found[path.relative(ELECTRON, file).split(path.sep).join("/")] = n;
  }

  it("walked the source tree and found the accessor's own send", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(found["windowRegistry.ts"]).toBe(1); // proves the pattern still matches
  });

  it("appear only in listed files", () => {
    expect(Object.keys(found).filter((f) => !(f in CEILING))).toEqual([]);
  });

  it("never exceed a file's ceiling", () => {
    const over = Object.entries(found)
      .filter(([f, n]) => f in CEILING && n > CEILING[f])
      .map(([f, n]) => `${f}: ${n} > ${CEILING[f]}`);
    expect(over).toEqual([]);
  });
});
