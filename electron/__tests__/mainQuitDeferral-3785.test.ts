/**
 * BACKLOG-3785: main.ts registers the link quit deferral in its before-quit handler.
 * TEXT CHECK of electron/main.ts (no loadable seam), same approach as
 * mainResponsiveIdle-3833.
 */
import * as fs from "fs";
import * as path from "path";

const MAIN = fs.readFileSync(path.resolve(__dirname, "../main.ts"), "utf8");

describe("main.ts before-quit wiring (BACKLOG-3785)", () => {
  it("builds the link deferral from waitForLinksToFinish via createBackupStopOnQuit", () => {
    expect(MAIN).toMatch(/const deferQuitForLink = createBackupStopOnQuit\(app,[\s\S]*?waitForLinksToFinish\(/);
  });

  it("before-quit asks the backup deferral, then the link deferral, before any cleanup", () => {
    const m = MAIN.match(/app\.on\("before-quit",\s*\(event\)\s*=>\s*\{([\s\S]*?)\n\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    const a = body.indexOf("if (deferQuitForBackupStop(event)) return;");
    const b = body.indexOf("if (deferQuitForLink(event)) return;");
    const cleanup = body.indexOf("cleanupDeviceHandlers()");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(cleanup).toBeGreaterThan(b);
  });
});
