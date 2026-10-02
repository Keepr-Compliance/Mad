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
 *   L1 a launch failure ('error') unhandled, or reported as opened  → "launchChrome"
 *   L2 "opened" before the process really started                   → "launchChrome"
 *   S1 copied over the old folder (stale files of an older build kept) → "a real folder"
 */

import * as path from "path";
import * as nodeFs from "fs";
import * as os from "os";
import {
  chromeCandidates,
  extensionSourceDir,
  launchChrome,
  type LaunchedProcess,
  prepareExtensionFolder,
  RCS_EXTENSION_FOLDER_NAME,
  type DeliveryFs,
} from "../rcsExtensionDelivery";

function fakeFs(files: Record<string, string>): DeliveryFs & { copies: Array<[string, string]>; renames: Array<[string, string]> } {
  const copies: Array<[string, string]> = [];
  const renames: Array<[string, string]> = [];
  return {
    copies,
    renames,
    exists: async (p) => p in files,
    readText: async (p) => files[p],
    copyDir: async (from, to) => {
      copies.push([from, to]);
    },
    removeDir: async () => undefined,
    rename: async (from, to) => {
      renames.push([from, to]);
    },
  };
}

import { EventEmitter } from "events";

function fakeChild(): LaunchedProcess & EventEmitter & { unrefs: number } {
  const e = new EventEmitter() as EventEmitter & { unrefs: number; unref: () => void };
  e.unrefs = 0;
  e.unref = () => {
    e.unrefs += 1;
  };
  return e as unknown as LaunchedProcess & EventEmitter & { unrefs: number };
}

describe("launchChrome (SR F1)", () => {
  it("opened only after 'spawn'; an async 'error' is handled and reported as not opened (L1, L2)", async () => {
    const ok = fakeChild();
    let settled = false;
    const p = launchChrome(["/c/chrome"], async () => true, () => ok).then((v) => {
      settled = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false); // not before the process started
    ok.emit("spawn");
    expect(await p).toBe(true);
    expect(ok.unrefs).toBe(1);

    const bad = fakeChild();
    const q = launchChrome(["/c/chrome"], async () => true, () => bad);
    await new Promise((r) => setTimeout(r, 0));
    // With no 'error' listener an EventEmitter throws here (uncaught in main).
    expect(() => bad.emit("error", new Error("EACCES"))).not.toThrow();
    expect(await q).toBe(false);
  });

  it("skips missing candidates; none installed or a throwing start → false", async () => {
    const tried: string[] = [];
    const child = fakeChild();
    const p = launchChrome(["/a", "/b"], async (c) => c === "/b", (c) => (tried.push(c), child));
    await new Promise((r) => setTimeout(r, 0));
    child.emit("spawn");
    expect(await p).toBe(true);
    expect(tried).toEqual(["/b"]);
    expect(await launchChrome(["/a"], async () => false, () => child)).toBe(false);
    expect(await launchChrome(["/a"], async () => true, () => {
      throw new Error("ENOENT");
    })).toBe(false);
  });
});

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
    const target = path.join("/home/u/Downloads", "Keepr Extension");
    expect(fs.copies).toHaveLength(1);
    expect(fs.copies[0][0]).toBe(src);
    expect(fs.renames).toEqual([[fs.copies[0][1], target]]);
  });

  it("a real folder: an older build's stale files are gone after the copy (S1)", async () => {
    const tmp = nodeFs.mkdtempSync(path.join(os.tmpdir(), "keepr-ext-3659-"));
    try {
      const src = path.join(tmp, "res", "chrome-extension");
      nodeFs.mkdirSync(src, { recursive: true });
      nodeFs.writeFileSync(path.join(src, "manifest.json"), JSON.stringify({ version: "0.3.5" }));
      nodeFs.writeFileSync(path.join(src, "job.js"), "new");
      const downloads = path.join(tmp, "Downloads");
      const old = path.join(downloads, "Keepr Extension");
      nodeFs.mkdirSync(old, { recursive: true });
      nodeFs.writeFileSync(path.join(old, "job.js"), "old");
      nodeFs.writeFileSync(path.join(old, "removed-in-new-build.js"), "stale");
      const out = await prepareExtensionFolder(src, downloads, {
        exists: async (p) => nodeFs.existsSync(p),
        readText: async (p) => nodeFs.readFileSync(p, "utf8"),
        copyDir: (from, to) => nodeFs.promises.cp(from, to, { recursive: true, errorOnExist: true }),
        removeDir: (p) => nodeFs.promises.rm(p, { recursive: true, force: true }),
        rename: (from, to) => nodeFs.promises.rename(from, to),
      });
      expect(out.folder).toBe(old);
      expect(nodeFs.readdirSync(old).sort()).toEqual(["job.js", "manifest.json"]);
      expect(nodeFs.readFileSync(path.join(old, "job.js"), "utf8")).toBe("new");
      expect(nodeFs.readdirSync(downloads)).toEqual(["Keepr Extension"]);
    } finally {
      nodeFs.rmSync(tmp, { recursive: true, force: true });
    }
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
