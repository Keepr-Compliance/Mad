/**
 * BACKLOG-3283: main.ts wiring for hide-on-close (macOS). TEXT CHECK (no loadable
 * seam for main.ts), as mainSealQuitPrompt-3816. Behaviour: bootstrap/__tests__/hideOnClose-3283.
 */
import * as fs from "fs";
import * as path from "path";

const MAIN = fs.readFileSync(path.resolve(__dirname, "../main.ts"), "utf8");
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

  it("activate shows the existing (hidden) main window and creates one only when there is none", () => {
    const a = activateBody();
    expect(a).not.toMatch(/getAllWindows/);
    const get = a.indexOf("const existing = getMainWindow();");
    const show = a.indexOf("bringAppToFront(existing);");
    const ret = a.indexOf("return;", show);
    const create = a.indexOf("createWindow();");
    expect(get).toBeGreaterThan(a.indexOf("if (getStartupFailure()) return;"));
    expect(show).toBeGreaterThan(get);
    expect(ret).toBeGreaterThan(show);
    expect(create).toBeGreaterThan(ret);
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
    expect(g.indexOf("clearQuitting();")).toBeGreaterThan(prevent);
    expect(g).toMatch(/mainWindow\?\.destroy\(\);\s*if \(wasQuitting\) app\.quit\(\);/);
  });

  it("deep-link focus shows a hidden window", () => {
    expect(body(/function focusMainWindow\(\): void \{([\s\S]*?)\n\}/)).toMatch(
      /if \(!mainWindow\.isVisible\(\)\) mainWindow\.show\(\);/,
    );
  });

  it("the quit prompt is not sheeted onto a hidden window", () => {
    expect(MAIN).toMatch(/parent && !parent\.isDestroyed\(\) && parent\.isVisible\(\)/);
  });
});
