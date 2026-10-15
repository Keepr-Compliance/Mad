/**
 * BACKLOG-3833: the window "responsive" event must not restart the session
 * idle clock (a freeze can end while nobody is at the machine). Only the
 * user's Reload click does.
 *
 * TEXT CHECK of electron/main.ts: main.ts has no seam a behavioural test can
 * load, so this reads the source.
 */
import * as fs from "fs";
import * as path from "path";

const MAIN = fs.readFileSync(path.resolve(__dirname, "../main.ts"), "utf8");

describe("main.ts session idle hooks (BACKLOG-3833)", () => {
  it("no 'responsive' listener touches the session idle clock", () => {
    const listeners = [...MAIN.matchAll(/\.on\(\s*["']responsive["'][\s\S]*?\);/g)].map((m) => m[0]);
    for (const l of listeners) {
      expect(l).not.toMatch(/sessionSecurityService|noteUserReload|idleFloor|recordActivity/);
    }
  });

  it("the idle clock is restarted only from the Reload callback", () => {
    const calls = [...MAIN.matchAll(/sessionSecurityService\.\w+\(/g)].map((m) => m[0]);
    expect(calls).toEqual(["sessionSecurityService.noteUserReload("]);
    const reloadBlock = MAIN.match(/reload:\s*\(\)\s*=>\s*\{[\s\S]*?\n\s*\},/);
    expect(reloadBlock?.[0]).toContain("sessionSecurityService.noteUserReload()");
  });
});
