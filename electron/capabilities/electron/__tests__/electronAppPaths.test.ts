/**
 * `ElectronAppPaths` — the Electron shell's AppPaths (BACKLOG-2962, seams PR A).
 *
 * As with the other two adapters, `tests/helpers/installTestCapabilities.js`
 * installs a call-time forwarder rather than this class, so **no other suite
 * exercises it.** The two properties that would actually break the product are
 * the KEY STRING and the PER-CALL READ, and both are pinned here.
 */

import { app } from "electron";

import { ElectronAppPaths } from "../electronAppPaths";

const mockGetPath = app.getPath as unknown as jest.Mock;

describe("ElectronAppPaths (BACKLOG-2962)", () => {
  beforeEach(() => {
    mockGetPath.mockClear();
  });

  it("asks for exactly the key the four replaced call sites asked for", () => {
    // `dbConnection.ts:163`, `databaseEncryptionService.ts:59` and `:386`, and
    // `databaseService.ts:203` all passed "userData" and nothing else —
    // enumerated by the compiler across the whole extraction closure, not by
    // eye. A change to this literal is a change to which directory the database,
    // the key store and the backups live in.
    new ElectronAppPaths().userData();
    expect(mockGetPath).toHaveBeenCalledTimes(1);
    expect(mockGetPath).toHaveBeenCalledWith("userData");
  });

  it("returns app.getPath's answer unchanged — no join, no normalisation", () => {
    mockGetPath.mockReturnValueOnce("/Users/someone/Library/Application Support/Keepr");
    expect(new ElectronAppPaths().userData()).toBe(
      "/Users/someone/Library/Application Support/Keepr",
    );
  });

  it("reads app.getPath on EVERY call, never once at construction", () => {
    // `installAppDataPaths` (main.ts:6) repoints userData with `app.setPath` for
    // development builds. An adapter that cached the value at construction would
    // answer with the pre-override directory — the installed app's real mad.db —
    // which is precisely the BACKLOG-2709 incident.
    const paths = new ElectronAppPaths();
    mockGetPath.mockReturnValueOnce("/tmp/before-setPath");
    expect(paths.userData()).toBe("/tmp/before-setPath");
    mockGetPath.mockReturnValueOnce("/tmp/after-setPath");
    expect(paths.userData()).toBe("/tmp/after-setPath");
    expect(mockGetPath).toHaveBeenCalledTimes(2);
  });

  it("constructing it calls nothing at all", () => {
    // The other half of the case above, stated separately so the reason a
    // construction-time read is wrong does not depend on the mock's ordering.
    new ElectronAppPaths();
    expect(mockGetPath).not.toHaveBeenCalled();
  });
});
