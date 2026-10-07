/**
 * C1: keepr://link only opens the link screen; parameters change nothing.
 * Mutation: another keepr:// path accepted, or a non-keepr URL → red.
 */
import { isRcsLinkDeepLink } from "../rcsLinkDeepLink";

describe("keepr://link", () => {
  it("opens the link screen whatever its parameters", () => {
    expect(isRcsLinkDeepLink("keepr://link")).toBe(true);
    expect(isRcsLinkDeepLink("keepr://link?code=123456&user=x")).toBe(true);
    expect(isRcsLinkDeepLink("keepr:///link")).toBe(true);
  });

  it("nothing else", () => {
    expect(isRcsLinkDeepLink("keepr://callback?access_token=x")).toBe(false);
    expect(isRcsLinkDeepLink("keepr://payment-callback")).toBe(false);
    expect(isRcsLinkDeepLink("https://link")).toBe(false);
    expect(isRcsLinkDeepLink("not a url")).toBe(false);
  });
});

// Live (founder 2026-10-03): keepr://open — the extension's Open Keepr when
// /focus can't be used. It only shows + focuses the window (parameters
// ignored); the second instance (Windows) restores + focuses, flashing if
// refused. Mutations: another path accepted → red; main.ts without the
// branch, or a second instance that only focus()es → red.
import { isRcsOpenDeepLink } from "../rcsLinkDeepLink";
import * as fs from "fs";
import * as path from "path";

describe("keepr://open", () => {
  it("opens (shows + focuses) whatever its parameters; nothing else", () => {
    expect(isRcsOpenDeepLink("keepr://open")).toBe(true);
    expect(isRcsOpenDeepLink("keepr://open?x=1")).toBe(true);
    expect(isRcsOpenDeepLink("keepr:///open")).toBe(true);
    expect(isRcsOpenDeepLink("keepr://link")).toBe(false);
    expect(isRcsOpenDeepLink("keepr://callback?access_token=x")).toBe(false);
    expect(isRcsOpenDeepLink("https://open")).toBe(false);
    expect(isRcsOpenDeepLink("not a url")).toBe(false);
  });

  it("main.ts: the open branch and the second instance bring the window forward (or flash)", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "..", "main.ts"), "utf8").replace(/\r\n/g, "\n");
    const branch = /if \(isRcsOpenDeepLink\(url\)\) \{[\s\S]*?return;\n {4}\}/.exec(main);
    expect(branch && branch[0]).toContain("bringAppToFrontOrFlash(mainWindow)");
    const second = /app\.on\("second-instance"[\s\S]*?\n\}\);/.exec(main)![0];
    expect(second).toContain("bringAppToFrontOrFlash(mainWindow)");
    expect(second).not.toMatch(/mainWindow\.focus\(\)/);
  });
});
