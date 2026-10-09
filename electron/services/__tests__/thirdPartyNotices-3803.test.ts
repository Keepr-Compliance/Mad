/**
 * BACKLOG-3803: the path Settings > About opens must be the file the package ships.
 */
import { existsSync, readFileSync } from "fs";
import path from "path";
import { THIRD_PARTY_NOTICES_FILE, thirdPartyNoticesPath } from "../thirdPartyNotices";

const REPO = path.resolve(__dirname, "..", "..", "..");

describe("thirdPartyNoticesPath (BACKLOG-3803)", () => {
  it("points into <resources>/third-party when packaged", () => {
    expect(
      thirdPartyNoticesPath({ isPackaged: true, resourcesPath: "/r", appPath: "/a" }),
    ).toBe(path.join("/r", "third-party", "THIRD_PARTY_NOTICES.txt"));
  });

  it("points at the repo copy in development, and that file exists", () => {
    const p = thirdPartyNoticesPath({ isPackaged: false, resourcesPath: "/r", appPath: REPO });
    expect(p).toBe(path.join(REPO, "resources", "third-party", THIRD_PARTY_NOTICES_FILE));
    expect(existsSync(p)).toBe(true);
  });

  it("the packaged folder name matches the extraResources entry that ships it", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
    const entry = (pkg.build.extraResources as Array<string | { from: string; to: string }>).find(
      (e) => typeof e === "object" && e.from === "resources/third-party",
    ) as { from: string; to: string };
    const packaged = thirdPartyNoticesPath({ isPackaged: true, resourcesPath: "/r", appPath: "/a" });
    expect(packaged).toBe(path.join("/r", entry.to, THIRD_PARTY_NOTICES_FILE));
  });
});
