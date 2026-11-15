/**
 * BACKLOG-3283: main.ts wiring for hide-on-close (macOS). TEXT CHECK (no loadable
 * seam for main.ts), as mainSealQuitPrompt-3816. Behaviour: bootstrap/__tests__/hideOnClose-3283.
 */
import * as fs from "fs";
import * as path from "path";

// Windows CI checks out CRLF; the patterns below are written with \n.
const MAIN = fs.readFileSync(path.resolve(__dirname, "../main.ts"), "utf8").replace(/\r\n/g, "\n");
const body = (re: RegExp) => {
  const m = MAIN.match(re);
  expect(m).not.toBeNull();
  return m![1];
};
const createWindowBody = () => body(/\nfunction createWindow\(\): void \{([\s\S]*?)\n\}\n/);
const activateBody = () => body(/app\.on\("activate", \(\) => \{([\s\S]*?)\n\}\);/);
const beforeQuitBody = () => body(/app\.on\("before-quit",\s*\(event\)\s*=>\s*\{([\s\S]*?)\n\}\);/);
const submissionGuard = () =>
  body(/\/\/ Prevent closing while a submission is uploading\n  mainWindow\.on\("close", \(e\) => \{([\s\S]*?)\n  \}\);/);

describe("main.ts hide-on-close wiring (BACKLOG-3283)", () => {
  it("every window gets hide-on-close: attached inside createWindow(), once", () => {
    expect(createWindowBody().match(/attachHideOnClose\(mainWindow, process\.platform\);/g)).toHaveLength(1);
    expect(MAIN.match(/attachHideOnClose\(/g)).toHaveLength(1);
  });

  it("hide-on-close is registered BEFORE the submission guard (the guard clears the quit flag during the same dispatch)", () => {
    const c = createWindowBody();
    const attach = c.indexOf("attachHideOnClose(mainWindow, process.platform);");
    // The guard LISTENER itself (not its comment): a move to anywhere below the comment must fail.
    const guard = c.indexOf(
      'mainWindow.on("close", (e) => {\n    // BACKLOG-3283: on macOS a close that is not a quit only hides',
    );
    expect(attach).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThanOrEqual(0);
    // Listeners run in registration order. Attached after the guard, the hide
    // listener sees isQuitting() already cleared and hides the window the sheet is on.
    expect(attach).toBeLessThan(guard);
  });

  it("activate shows the existing (hidden) main window and creates one only when there is none", () => {
    const a = activateBody();
    expect(a).not.toMatch(/getAllWindows/);
    // Exact shape: any extra condition on `existing` (e.g. isVisible) builds a
    // second window on a Dock click and leaks the hidden one.
    expect(a).toMatch(
      /const existing = getMainWindow\(\);\s*if \(existing\) \{\s*bringAppToFront\(existing\);\s*return;\s*\}\s*createWindow\(\);/,
    );
    expect(a).not.toMatch(/isVisible|isDestroyed/);
    expect(a.indexOf("const existing = getMainWindow();")).toBeGreaterThan(
      a.indexOf("if (getStartupFailure()) return;"),
    );
  });

  it("before-quit marks the quit AFTER every check that can hold it", () => {
    const b = beforeQuitBody();
    const mark = b.indexOf("markQuitting();");
    expect(mark).toBeGreaterThan(b.indexOf("if (deferQuitForBackupSeal(event)) return;"));
    expect(b.indexOf("markQuitting();", mark + 1)).toBe(-1);
  });

  it("the submission guard: a macOS close that is not a quit only hides; a quit it cancels is cleared", () => {
    const g = submissionGuard();
    expect(g.indexOf('if (process.platform === "darwin" && !isQuitting()) return;')).toBeGreaterThanOrEqual(0);
    const prevent = g.indexOf("e.preventDefault();");
    const read = g.indexOf("const wasQuitting = isQuitting();");
    const clear = g.indexOf("clearQuitting();");
    // wasQuitting must be read before the clear, or "Quit Anyway" never quits.
    expect(prevent).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(prevent);
    expect(clear).toBeGreaterThan(read);
    // The window may be hidden (Dock Quit): show it before the sheet attaches to it.
    expect(g).toMatch(
      /e\.preventDefault\(\);[\s\S]*?if \(mainWindow && !mainWindow\.isVisible\(\)\) mainWindow\.show\(\);[\s\S]*?\.showMessageBox\(/,
    );
    expect(g).toMatch(/mainWindow\?\.destroy\(\);\s*if \(wasQuitting\) app\.quit\(\);/);
  });

  it("deep-link focus shows a hidden window", () => {
    expect(body(/function focusMainWindow\(\): void \{([\s\S]*?)\n\}/)).toMatch(
      /if \(!mainWindow\.isVisible\(\)\) mainWindow\.show\(\);/,
    );
  });

  it("closing the last window still quits on Windows and Linux", () => {
    expect(body(/app\.on\("window-all-closed", \(\) => \{([\s\S]*?)\n\}\);/)).toMatch(
      /if \(process\.platform !== "darwin"\) \{\s*app\.quit\(\);\s*\}/,
    );
  });

  it("the quit prompt is not sheeted onto a hidden window", () => {
    expect(MAIN).toMatch(/parent && !parent\.isDestroyed\(\) && parent\.isVisible\(\)/);
  });
});
