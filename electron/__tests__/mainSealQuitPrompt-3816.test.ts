/**
 * BACKLOG-3816: main.ts / updaterHandlers.ts wire the "securing your iPhone backup" quit
 * prompt. TEXT CHECK (no loadable seam for main.ts), same approach as
 * mainQuitDeferral-3785. The behaviour is tested in utils/__tests__/sealQuitPrompt-3816.
 */
import * as fs from "fs";
import * as path from "path";

const MAIN = fs.readFileSync(path.resolve(__dirname, "../main.ts"), "utf8");
const UPDATER = fs.readFileSync(path.resolve(__dirname, "../handlers/updaterHandlers.ts"), "utf8");

describe("main.ts seal quit prompt wiring (BACKLOG-3816)", () => {
  it("before-quit asks the prompt first, before every quit deferral", () => {
    const m = MAIN.match(/app\.on\("before-quit",\s*\(event\)\s*=>\s*\{([\s\S]*?)\n\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    const prompt = body.indexOf("if (sealQuitPrompt.check(event)) return;");
    const stop = body.indexOf("if (deferQuitForBackupStop(event)) return;");
    const link = body.indexOf("if (deferQuitForLink(event)) return;");
    const seal = body.indexOf("if (deferQuitForBackupSeal(event)) return;");
    expect(prompt).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(prompt);
    expect(link).toBeGreaterThan(stop);
    expect(seal).toBeGreaterThan(link);
  });

  it("the prompt reads the running seal pass", () => {
    expect(MAIN).toMatch(/sealPercent: \(\) => getBackupAtRest\(\)\.sealPassPercent\(\)/);
  });

  it("an OS shutdown (powerMonitor; Windows session end) is marked as not the user's quit", () => {
    expect(MAIN).toMatch(/powerMonitor\.on\("shutdown", \(\) => noteSystemQuit\("os-shutdown"\)\)/);
    expect(MAIN).toMatch(/mainWindow\.on\("query-session-end", \(\) => noteSystemQuit\("os-shutdown"\)\)/);
    expect(MAIN).toMatch(/mainWindow\.on\("session-end", \(\) => noteSystemQuit\("os-shutdown"\)\)/);
  });

  it("closing the window on Windows asks while the window is still open", () => {
    expect(MAIN).toMatch(
      /if \(process\.platform !== "darwin"\) \{\s*mainWindow\.on\("close", \(e\) => \{[\s\S]*?sealQuitPrompt\.check\(e\);/,
    );
  });

  it("Restart to update marks the quit before waiting on the quit blockers", () => {
    const handler = UPDATER.slice(UPDATER.indexOf('ipcMain.on("install-update"'));
    const note = handler.indexOf('noteSystemQuit("update");');
    const wait = handler.indexOf("waitForQuitBlockers()");
    expect(note).toBeGreaterThan(0);
    expect(wait).toBeGreaterThan(note);
  });
});
