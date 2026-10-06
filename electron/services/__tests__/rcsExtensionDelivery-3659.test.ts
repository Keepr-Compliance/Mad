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
 *   S1b the old folder emptied before the swap can fail                → "old folder in use"
 *   S1c no rollback when the copy cannot be renamed into place          → "the copy cannot be put in place"
 *   S1d the copy left behind on a failure                               → "old folder in use", "copy cannot be put in place"
 *   S1e an old leftover (.old-* / .new-*) never swept                   → "a real folder"
 *   P1 concurrent calls not sharing one run (live ENOENT)               → "two concurrent calls"
 *   P2 the sweep deleting a temp folder of a run in flight              → "the sweep never touches"
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
  prepareExtensionFolderShared,
  RCS_EXTENSION_FOLDER_BUSY,
  RCS_EXTENSION_FOLDER_NAME,
  isOlderVersion,
  refreshExtensionFolderIfOlder,
  type DeliveryFs,
} from "../rcsExtensionDelivery";

// Live (founder, 2026-10-05): after a Keepr update, Downloads/"Keepr
// Extension" stayed at the old version (copied only by the install step).
// Mutations: no refresh when older; a refresh when the same / newer or with
// no folder; the busy message lost; the version compare as text → red.
describe("the extension folder refreshed at app start (live)", () => {
  const withOldManifest = (version: string | null) => {
    const r = realSetup();
    if (version !== null) nodeFs.writeFileSync(path.join(r.old, "manifest.json"), JSON.stringify({ version }));
    return r;
  };

  it("an older folder is replaced by the bundled extension (no file of the old build left)", async () => {
    const r = withOldManifest("0.3.4");
    try {
      const out = await refreshExtensionFolderIfOlder(r.src, r.downloads, r.fsOps());
      expect(out).toEqual({ refreshed: true, bundledVersion: "0.3.5" });
      expect(JSON.parse(nodeFs.readFileSync(path.join(r.old, "manifest.json"), "utf8")).version).toBe("0.3.5");
      expect(nodeFs.existsSync(path.join(r.old, "removed-in-new-build.js"))).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it("the same or a newer folder, or no folder at all: left as it is", async () => {
    for (const v of ["0.3.5", "0.3.10"]) {
      const r = withOldManifest(v);
      try {
        expect(await refreshExtensionFolderIfOlder(r.src, r.downloads, r.fsOps())).toEqual({ refreshed: false, bundledVersion: "0.3.5" });
        expect(nodeFs.readFileSync(path.join(r.old, "job.js"), "utf8")).toBe("old");
      } finally {
        r.cleanup();
      }
    }
    const r = realSetup();
    try {
      nodeFs.rmSync(r.old, { recursive: true, force: true });
      expect(await refreshExtensionFolderIfOlder(r.src, r.downloads, r.fsOps())).toEqual({ refreshed: false, bundledVersion: "0.3.5" });
      expect(nodeFs.existsSync(r.old)).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it("Windows holding the folder: the existing message, the old folder untouched", async () => {
    const r = withOldManifest("0.3.4");
    try {
      const out = await refreshExtensionFolderIfOlder(r.src, r.downloads, r.fsOps((from) => from === r.old));
      expect(out).toEqual({ refreshed: false, bundledVersion: "0.3.5", error: RCS_EXTENSION_FOLDER_BUSY });
      expect(nodeFs.readFileSync(path.join(r.old, "job.js"), "utf8")).toBe("old");
    } finally {
      r.cleanup();
    }
  });

  it("isOlderVersion: numeric parts, not text", () => {
    expect(isOlderVersion("0.3.80", "0.3.84")).toBe(true);
    expect(isOlderVersion("0.3.9", "0.3.10")).toBe(true);
    expect(isOlderVersion("0.3.10", "0.3.9")).toBe(false);
    expect(isOlderVersion("0.3.84", "0.3.84")).toBe(false);
    expect(isOlderVersion("0.3", "0.3.1")).toBe(true);
    expect(isOlderVersion(null, "0.3.84")).toBe(false);
    expect(isOlderVersion("x", "0.3.84")).toBe(false);
  });
});

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
    listDir: async () => [],
  };
}

/** A real temp Downloads with an old extension folder, and fs ops that can fail one rename. */
function realSetup() {
  const tmp = nodeFs.mkdtempSync(path.join(os.tmpdir(), "keepr-ext-3659-"));
  const src = path.join(tmp, "res", "chrome-extension");
  nodeFs.mkdirSync(src, { recursive: true });
  nodeFs.writeFileSync(path.join(src, "manifest.json"), JSON.stringify({ version: "0.3.5" }));
  nodeFs.writeFileSync(path.join(src, "job.js"), "new");
  const downloads = path.join(tmp, "Downloads");
  const old = path.join(downloads, "Keepr Extension");
  nodeFs.mkdirSync(old, { recursive: true });
  nodeFs.writeFileSync(path.join(old, "job.js"), "old");
  nodeFs.writeFileSync(path.join(old, "removed-in-new-build.js"), "stale");
  const fsOps = (failRename?: (from: string, to: string) => boolean): DeliveryFs => ({
    exists: async (p) => nodeFs.existsSync(p),
    readText: async (p) => nodeFs.readFileSync(p, "utf8"),
    copyDir: (from, to) => nodeFs.promises.cp(from, to, { recursive: true, errorOnExist: true }),
    removeDir: (p) => nodeFs.promises.rm(p, { recursive: true, force: true }),
    rename: async (from, to) => {
      if (failRename && failRename(from, to)) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      await nodeFs.promises.rename(from, to);
    },
    listDir: async (p) => (nodeFs.existsSync(p) ? nodeFs.readdirSync(p) : []),
  });
  return { tmp, src, downloads, old, fsOps, cleanup: () => nodeFs.rmSync(tmp, { recursive: true, force: true }) };
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

  it("a real folder: an older build's stale files are gone; leftovers of an earlier attempt are swept (S1, S1e)", async () => {
    const s = realSetup();
    try {
      nodeFs.mkdirSync(path.join(s.downloads, "Keepr Extension.old-1-1"));
      nodeFs.mkdirSync(path.join(s.downloads, "Keepr Extension.new-1-1"));
      nodeFs.mkdirSync(path.join(s.downloads, "Something else"));
      const out = await prepareExtensionFolder(s.src, s.downloads, s.fsOps());
      expect(out.folder).toBe(s.old);
      expect(nodeFs.readdirSync(s.old).sort()).toEqual(["job.js", "manifest.json"]);
      expect(nodeFs.readFileSync(path.join(s.old, "job.js"), "utf8")).toBe("new");
      expect(nodeFs.readdirSync(s.downloads).sort()).toEqual(["Keepr Extension", "Something else"]);
    } finally {
      s.cleanup();
    }
  });

  it("old folder in use (rename refused): it is left untouched, the copy is removed, a clear error (S1b, S1d)", async () => {
    const s = realSetup();
    try {
      const fsOps = s.fsOps((from) => from === s.old);
      await expect(prepareExtensionFolder(s.src, s.downloads, fsOps)).rejects.toThrow(RCS_EXTENSION_FOLDER_BUSY);
      expect(nodeFs.readdirSync(s.old).sort()).toEqual(["job.js", "removed-in-new-build.js"]);
      expect(nodeFs.readFileSync(path.join(s.old, "job.js"), "utf8")).toBe("old");
      expect(nodeFs.readdirSync(s.downloads)).toEqual(["Keepr Extension"]);
    } finally {
      s.cleanup();
    }
  });

  it("the copy cannot be put in place: the old folder is renamed back, the copy removed (S1c, S1d)", async () => {
    const s = realSetup();
    try {
      const fsOps = s.fsOps((from, to) => to === s.old && from.includes(".new-"));
      await expect(prepareExtensionFolder(s.src, s.downloads, fsOps)).rejects.toThrow(RCS_EXTENSION_FOLDER_BUSY);
      expect(nodeFs.readFileSync(path.join(s.old, "job.js"), "utf8")).toBe("old");
      expect(nodeFs.readdirSync(s.downloads)).toEqual(["Keepr Extension"]);
    } finally {
      s.cleanup();
    }
  });

  it("deleting the renamed old folder may fail: the new one is in place anyway", async () => {
    const s = realSetup();
    try {
      const base = s.fsOps();
      const fsOps: DeliveryFs = {
        ...base,
        removeDir: async (p) => {
          if (p.includes(".old-")) throw new Error("EPERM");
          await base.removeDir(p);
        },
      };
      const out = await prepareExtensionFolder(s.src, s.downloads, fsOps);
      expect(nodeFs.readFileSync(path.join(out.folder, "job.js"), "utf8")).toBe("new");
    } finally {
      s.cleanup();
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

  // Live ENOENT: StrictMode ran the install effect twice; the second run's
  // sweep deleted the first run's temp folder mid-copy.
  it("two concurrent calls: both succeed with one copy (P1)", async () => {
    const s1 = realSetup();
    try {
      const base = s1.fsOps();
      let copies = 0;
      const fsOps: DeliveryFs = {
        ...base,
        copyDir: async (from, to) => {
          copies += 1;
          await new Promise((r) => setTimeout(r, 20));
          await base.copyDir(from, to);
        },
      };
      const [a, b] = await Promise.all([
        prepareExtensionFolderShared(s1.src, s1.downloads, fsOps),
        prepareExtensionFolderShared(s1.src, s1.downloads, fsOps),
      ]);
      expect(a).toEqual(b);
      expect(copies).toBe(1);
      expect(nodeFs.readFileSync(path.join(a.folder, "job.js"), "utf8")).toBe("new");
      // Done: the next call copies again (a newer build).
      await prepareExtensionFolderShared(s1.src, s1.downloads, fsOps);
      expect(copies).toBe(2);
    } finally {
      s1.cleanup();
    }
  });

  it("the sweep never touches a temp folder of a run in flight (P2)", async () => {
    const s1 = realSetup();
    try {
      const base = s1.fsOps();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let copying: () => void = () => undefined;
      const atCopy = new Promise<void>((r) => {
        copying = r;
      });
      const slow: DeliveryFs = {
        ...base,
        copyDir: async (from, to) => {
          await base.copyDir(from, to);
          copying();
          await gate;
        },
      };
      const first = prepareExtensionFolder(s1.src, s1.downloads, slow);
      await atCopy;
      // A second, unshared run (another window) sweeps while the first copies.
      const second = prepareExtensionFolder(s1.src, s1.downloads, base);
      await second;
      release();
      await expect(first).resolves.toMatchObject({ folder: s1.old });
      expect(nodeFs.readFileSync(path.join(s1.old, "job.js"), "utf8")).toBe("new");
    } finally {
      s1.cleanup();
    }
  });
});
