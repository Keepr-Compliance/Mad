/**
 * BACKLOG-3800 — the vendor name Windows shows for Keepr comes from package.json.
 *
 * electron-builder (app-builder-lib 26.x) derives every vendor field from package.json:
 *   - appInfo.js `get companyName()` returns `author.name`; with `"author": ""` it is null.
 *   - winPackager.js signAndEditResources: CompanyName is written into Keepr.exe's version
 *     resource only when companyName != null. When it is null, Electron's own default
 *     ("GitHub, Inc.") stays in place.
 *   - NsisTarget.js configureDefinesForAllTypeOfInstaller: COMPANY_NAME (the Add/Remove
 *     Programs "Publisher") is defined only when companyName != null.
 *   - appInfo.js `get copyright()` falls back to "Copyright © <year> <companyName>".
 *   - NsisTarget.js: the installer's FileDescription is appInfo.description.
 *
 * This test runs electron-builder's real AppInfo over the real package.json, so it reads
 * the same values the Windows build will write.
 *
 * Not checked here: updater signature verification. electron-updater compares against
 * `publisherName`, which comes from `win.azureSignOptions.publisherName`
 * (release.yml passes "Blue Spaces LLC"), not from `author`.
 */
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AppInfo } = require("app-builder-lib/out/appInfo");

const ROOT = path.resolve(__dirname, "../..");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require(path.join(ROOT, "package.json"));

function appInfo() {
  return new AppInfo(
    { metadata: pkg, config: pkg.build, devMetadata: null },
    null,
    pkg.build.win,
  );
}

describe("Windows vendor info (BACKLOG-3800)", () => {
  it("package.json author is an object naming Blue Spaces LLC", () => {
    expect(pkg.author).toEqual({
      name: "Blue Spaces LLC",
      email: "support@keeprcompliance.com",
    });
  });

  it("electron-builder derives CompanyName / Publisher = Blue Spaces LLC", () => {
    const info = appInfo();
    expect(info.companyName).toBe("Blue Spaces LLC");
    expect(info.companyName).not.toMatch(/GitHub/i);
  });

  it("LegalCopyright names Blue Spaces LLC", () => {
    expect(appInfo().copyright).toMatch(/^Copyright © \d{4} Blue Spaces LLC$/);
  });

  it("description is set and no longer the iMessage-export wording", () => {
    const { description } = appInfo();
    expect(description.trim().length).toBeGreaterThan(20);
    expect(description).not.toMatch(/iMessage/);
    expect(description).toMatch(/real estate/);
  });

  it("product name and app id are unchanged (install path, updater, signing)", () => {
    const info = appInfo();
    expect(info.productName).toBe("Keepr");
    expect(info.id).toBe("com.keeprcompliance.keepr");
  });
});
