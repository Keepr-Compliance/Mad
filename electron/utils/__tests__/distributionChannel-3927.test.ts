/**
 * BACKLOG-3927: the build's distribution channel. Packaged builds trust only
 * the package.json field electron-builder writes; the env override is dev-only.
 */
import {
  APPLE_DEVICES_STORE_URL,
  APPLE_DEVICES_WEB_URL,
  STORE_BUILD_ARGV_TOKEN,
  argvHasStoreBuildToken,
  resolveDistributionChannel,
} from "../distributionChannel";

describe("resolveDistributionChannel", () => {
  it.each([
    // [packageField, envOverride, isPackaged, expected]
    ["store", undefined, true, "store"],
    [undefined, undefined, true, "website"],
    ["website", undefined, true, "website"],
    ["STORE", undefined, true, "website"],
    [true, undefined, true, "website"],
    // A user environment variable never changes a packaged build.
    [undefined, "store", true, "website"],
    ["store", "website", true, "store"],
    // Dev (`npm run dev`): the env override selects the Store flavor.
    [undefined, "store", false, "store"],
    [undefined, undefined, false, "website"],
    [undefined, "1", false, "website"],
    ["store", undefined, false, "store"],
  ] as const)("field=%p env=%p packaged=%p -> %s", (packageField, envOverride, isPackaged, expected) => {
    expect(resolveDistributionChannel({ packageField, envOverride, isPackaged })).toBe(expected);
  });
});

describe("argvHasStoreBuildToken", () => {
  it("matches the exact token only", () => {
    expect(argvHasStoreBuildToken(["app", STORE_BUILD_ARGV_TOKEN])).toBe(true);
    expect(argvHasStoreBuildToken(["app"])).toBe(false);
    expect(argvHasStoreBuildToken(["app", `${STORE_BUILD_ARGV_TOKEN}x`])).toBe(false);
    expect(argvHasStoreBuildToken(["app", "--keepr-distribution=website"])).toBe(false);
  });
});

describe("Apple Devices links", () => {
  it("point at Apple's Apple Devices app (product 9NP83LWLPZ9K)", () => {
    expect(APPLE_DEVICES_STORE_URL).toBe("ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K");
    expect(APPLE_DEVICES_WEB_URL).toBe("https://apps.microsoft.com/detail/9NP83LWLPZ9K");
  });
});
