/**
 * @jest-environment node
 */
/**
 * BACKLOG-3659 — delivering the extension (Release 1: unpacked).
 *
 * Mutations that turn this suite red:
 *   X1 the packaged build reads the repo folder (or the reverse)   → "source folder"
 *   X2 the copy lands anywhere but Downloads/"Keepr Extension"      → "copies to Downloads"
 *   X3 a build without the extension copies nothing / no error      → "a build without the extension"
 *   X4 Chrome's usual Windows paths missing                        → "where Chrome is"
 */

import * as path from "path";
import {
  chromeCandidates,
  extensionSourceDir,
  prepareExtensionFolder,
  RCS_EXTENSION_FOLDER_NAME,
  type DeliveryFs,
} from "../rcsExtensionDelivery";

function fakeFs(files: Record<string, string>): DeliveryFs & { copies: Array<[string, string]> } {
  const copies: Array<[string, string]> = [];
  return {
    copies,
    exists: async (p) => p in files,
    readText: async (p) => files[p],
    copyDir: async (from, to) => {
      copies.push([from, to]);
    },
  };
}

describe("extension delivery (BACKLOG-3659)", () => {
  it("source folder: resources when packaged, the repo in development (X1)", () => {
    const opts = { resourcesPath: "/opt/keepr/resources", appPath: "/src/keepr" };
    expect(extensionSourceDir({ ...opts, isPackaged: true })).toBe(path.join("/opt/keepr/resources", "chrome-extension"));
    expect(extensionSourceDir({ ...opts, isPackaged: false })).toBe(path.join("/src/keepr", "chrome-extension"));
  });

  it("copies to Downloads/'Keepr Extension' and reports the version (X2)", async () => {
    const src = path.join("/res", "chrome-extension");
    const fs = fakeFs({ [path.join(src, "manifest.json")]: JSON.stringify({ version: "0.3.4" }) });
    const out = await prepareExtensionFolder(src, "/home/u/Downloads", fs);
    expect(out).toEqual({ folder: path.join("/home/u/Downloads", RCS_EXTENSION_FOLDER_NAME), version: "0.3.4" });
    expect(fs.copies).toEqual([[src, path.join("/home/u/Downloads", "Keepr Extension")]]);
  });

  it("a build without the extension: a plain error, nothing copied (X3)", async () => {
    const fs = fakeFs({});
    await expect(prepareExtensionFolder("/res/chrome-extension", "/d", fs)).rejects.toThrow(/does not include/);
    expect(fs.copies).toEqual([]);
  });

  it("where Chrome is: the usual Windows folders; macOS app; none elsewhere (X4)", () => {
    const win = chromeCandidates("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", PROGRAMFILES: "C:\\Program Files" });
    expect(win).toEqual([
      "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ]);
    expect(chromeCandidates("darwin", {})).toEqual(["/Applications/Google Chrome.app"]);
    expect(chromeCandidates("linux", {})).toEqual([]);
  });
});
