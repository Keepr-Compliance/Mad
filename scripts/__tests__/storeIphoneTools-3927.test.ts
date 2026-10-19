/**
 * BACKLOG-3927: the Microsoft Store build ships only the iPhone tools the app runs.
 *
 * resources/pinned/libimobiledevice.manifest.json lists every pinned file (`files`, the
 * committed repo folder) and the shipped subset (`store.files`). BACKLOG-3689: both the
 * website and the Store build ship that subset; the repo folder keeps every file.
 *
 * The Store subset is not trusted as written: it must equal the tools the app spawns (the
 * getCommand("...") / getExecutablePath("...") call sites anywhere under electron/) plus every DLL they load, read from the real PE import and
 * delay-import tables of the pinned binaries. Reads bytes only; nothing is executed.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import os from "os";
import path from "path";
import { importClosure, spawnedTools } from "./helpers/peImports";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pinned = require("../release/pinnedIphoneTools");

const REPO = path.resolve(__dirname, "..", "..");
const TOOLS = path.join(REPO, "resources", "win", "libimobiledevice");
const ELECTRON = path.join(REPO, "electron");
const SCRIPT = path.join(REPO, "scripts", "release", "pinnedIphoneTools.js");

interface Manifest {
  files: Record<string, string>;
  companions: string[];
  store: { files: string[] };
}
const manifest: Manifest = pinned.loadManifest();
const quiet = (): void => undefined;

/** The Store keep-list, written out so a change to it is a visible diff in this file too. */
const STORE_KEEP = [
  "getopt.dll",
  "idevice_id.exe",
  "idevicebackup2.exe",
  "ideviceinfo.exe",
  "idevicepair.exe",
  "imobiledevice.dll",
  "libcrypto-1_1-x64.dll",
  "libssl-1_1-x64.dll",
  "plist.dll",
  "usbmuxd.dll",
  "vcruntime140.dll",
];

let tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "imd-3927-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  tmps = [];
});

/** A temp folder holding copies of the named pinned files. */
function folderWith(names: string[]): string {
  const d = tmp();
  for (const n of names) copyFileSync(path.join(TOOLS, n), path.join(d, n));
  return d;
}

const sorted = (xs: string[]): string[] => [...xs].sort((a, b) => a.localeCompare(b));

describe("Store iPhone tools set (BACKLOG-3927)", () => {
  describe("the manifest's store.files", () => {
    it("is exactly the spawned tools plus every DLL they load (from the PE tables)", () => {
      const { closure, missing } = importClosure(TOOLS, spawnedTools(ELECTRON));
      expect(missing).toEqual([]);
      expect(sorted(manifest.store.files.map((f) => f.toLowerCase()))).toEqual(closure);
    });

    it("is the 11-file keep-list", () => {
      expect(sorted(manifest.store.files)).toEqual(sorted(STORE_KEEP));
    });

    it("holds no libusb library and no driver file", () => {
      expect(manifest.store.files.filter((f) => /^libusb|\.(sys|inf|cat)$/i.test(f))).toEqual([]);
    });

    it("names only pinned files (a typo is refused at load)", () => {
      const p = path.join(tmp(), "m.json");
      writeFileSync(p, JSON.stringify({ ...manifest, store: { files: [...manifest.store.files, "nope.dll"] } }));
      expect(() => pinned.loadManifest(p)).toThrow("manifest store.files names nope.dll, which is not a pinned file");
    });
  });

  describe("spawnedTools scan", () => {
    function electronWith(files: Record<string, string>): string {
      const d = tmp();
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
        writeFileSync(path.join(d, rel), body);
      }
      return d;
    }
    it("finds both quote styles, getExecutablePath, subfolders; skips tests", () => {
      const d = electronWith({
        "services/a.ts": 'getCommand("one");',
        "handlers/b.ts": "getCommand('two');",
        "handlers/deep/c.tsx": 'getExecutablePath("three");',
        "handlers/__tests__/d.ts": 'getCommand("skipped1");',
        "handlers/e.test.ts": 'getCommand("skipped2");',
      });
      expect(spawnedTools(d)).toEqual(["one", "three", "two"]);
    });
    it("fails on a non-literal argument", () => {
      expect(() => spawnedTools(electronWith({ "handlers/x.ts": "getCommand(tool);" }))).toThrow(/non-literal.*x\.ts:1 getCommand\(tool\)/s);
      expect(() => spawnedTools(electronWith({ "x.ts": "getExecutablePath(`${n}`);" }))).toThrow(/non-literal/);
    });
  });

  describe("shipped set vs repo set (BACKLOG-3689)", () => {
    it("both channels ship the same 11 files and no companions", () => {
      expect(pinned.expectedFor(manifest, "website")).toEqual({ files: STORE_KEEP, companions: [] });
      expect(pinned.expectedFor(manifest, "store")).toEqual({ files: STORE_KEEP, companions: [] });
      expect(pinned.expectedFor(manifest)).toEqual(pinned.expectedFor(manifest, "store"));
    });

    it("the repo set stays every pinned file plus README.md (46, what the folder holds)", () => {
      const repo = pinned.repoSet(manifest);
      expect(repo.files).toHaveLength(45);
      expect(repo.companions).toEqual(["README.md"]);
      expect(sorted([...repo.files, ...repo.companions])).toEqual(sorted(readdirSync(TOOLS)));
      expect(pinned.verifyRepo(TOOLS, manifest)).toEqual([]);
    });

    it("the website channel refuses libusb and driver files too", () => {
      const d = folderWith([...STORE_KEEP, "libusb0.dll"]);
      expect(pinned.verifyDir(d, manifest, "website")).toEqual([
        "extra file not in manifest: libusb0.dll",
        "forbidden in a website build: libusb0.dll",
      ]);
    });
  });

  describe("verifyDir with channel store", () => {
    it("passes on exactly the keep-list", () => {
      expect(pinned.verifyDir(folderWith(STORE_KEEP), manifest, "store")).toEqual([]);
    });

    it("goes red when libusb0.dll is present", () => {
      const d = folderWith([...STORE_KEEP, "libusb0.dll"]);
      expect(pinned.verifyDir(d, manifest, "store")).toEqual([
        "extra file not in manifest: libusb0.dll",
        "forbidden in a Store build: libusb0.dll",
      ]);
    });

    it("goes red on a driver file even with an innocent name", () => {
      const d = folderWith(STORE_KEEP);
      writeFileSync(path.join(d, "x.inf"), "");
      expect(pinned.verifyDir(d, manifest, "store")).toEqual([
        "extra file not in manifest: x.inf",
        "forbidden in a Store build: x.inf",
      ]);
    });

    it("goes red when a needed DLL is missing", () => {
      const d = folderWith(STORE_KEEP.filter((f) => f !== "usbmuxd.dll"));
      expect(pinned.verifyDir(d, manifest, "store")).toEqual(["missing pinned file: usbmuxd.dll"]);
    });

    it("goes red on the full repo folder (README.md and the 34 unused files are extra)", () => {
      const problems: string[] = pinned.verifyDir(TOOLS, manifest, "store");
      expect(problems).toHaveLength(35 + 2); // 35 extra + forbidden libusb0.dll and libusb-1.0.dll
      expect(problems).toContain("extra file not in manifest: README.md");
      expect(problems).toContain("forbidden in a Store build: libusb-1.0.dll");
    });
  });

  describe("placePinnedTools", () => {
    function placed(channel?: string): string {
      const resources = path.join(tmp(), "resources");
      mkdirSync(resources);
      return pinned.placePinnedTools(resources, { manifest, log: quiet, ...(channel ? { channel } : {}) });
    }

    it("store: the packaged folder holds exactly the keep-list", () => {
      expect(sorted(readdirSync(placed("store")))).toEqual(sorted(STORE_KEEP));
    });

    it("website (default and explicit): exactly the keep-list, byte-identical to the repo", () => {
      for (const dest of [placed(), placed("website")]) {
        expect(sorted(readdirSync(dest))).toEqual(sorted(STORE_KEEP));
        for (const f of STORE_KEEP) expect(readFileSync(path.join(dest, f)).equals(readFileSync(path.join(TOOLS, f)))).toBe(true);
      }
    });

    it("an unknown channel is refused", () => {
      expect(() => placed("beta")).toThrow("unknown channel: beta");
    });
  });

  describe("channelOf (afterPack's channel source)", () => {
    it("store only when extraMetadata.distributionChannel is store", () => {
      const ctx = (extraMetadata?: object) => ({ packager: { config: extraMetadata ? { extraMetadata } : {} } });
      expect(pinned.channelOf(ctx({ distributionChannel: "store" }))).toBe("store");
      expect(pinned.channelOf(ctx({ distributionChannel: "website" }))).toBe("website");
      expect(pinned.channelOf(ctx())).toBe("website");
      expect(pinned.channelOf({ packager: {} })).toBe("website");
    });
  });

  describe("the real afterPack hook", () => {
    function runAfterPack(config: object | undefined): { appOutDir: string; stdout: string; stderr: string; status: number | null } {
      const appOutDir = tmp();
      mkdirSync(path.join(appOutDir, "resources"));
      const harness = `
        const Module = require("module");
        const load = Module._load;
        Module._load = function (req, ...rest) {
          if (req === "@electron/fuses") return { flipFuses: async () => {}, FuseVersion: {}, FuseV1Options: {} };
          return load.call(this, req, ...rest);
        };
        const afterPack = require(${JSON.stringify(path.join(REPO, "scripts", "afterPack.js"))});
        afterPack({
          appOutDir: ${JSON.stringify(appOutDir)},
          electronPlatformName: "win32",
          packager: {
            appInfo: { productFilename: "Keepr" },
            getResourcesDir: (d) => require("path").join(d, "resources"),
            ${config ? `config: ${JSON.stringify(config)},` : ""}
          },
        }).then(() => {}, (e) => { console.error(e.message); process.exit(1); });
      `;
      const r = spawnSync(process.execPath, ["-e", harness], { encoding: "utf8", env: { ...process.env, CI: "" } });
      return { appOutDir, stdout: r.stdout, stderr: r.stderr, status: r.status };
    }
    const toolsIn = (appOutDir: string) => path.join(appOutDir, "resources", "win", "libimobiledevice");

    it("a store-marked build places the keep-list", () => {
      const r = runAfterPack({ extraMetadata: { distributionChannel: "store" } });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Placed 11 pinned iPhone tool files for the Microsoft Store build");
      expect(sorted(readdirSync(toolsIn(r.appOutDir)))).toEqual(sorted(STORE_KEEP));
    });

    it("an unmarked (website) build places the keep-list", () => {
      const r = runAfterPack({ extraMetadata: {} });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Placed 11 pinned iPhone tool files (sha256-verified)");
      expect(sorted(readdirSync(toolsIn(r.appOutDir)))).toEqual(sorted(STORE_KEEP));
      expect(pinned.verifyDir(toolsIn(r.appOutDir), manifest)).toEqual([]);
    });
  });

  describe("CLI --channel", () => {
    const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

    it("--dir <keep-list> --channel store passes; with libusb0.dll it fails", () => {
      expect(cli("--dir", folderWith(STORE_KEEP), "--channel", "store").status).toBe(0);
      const r = cli("--dir", folderWith([...STORE_KEEP, "libusb0.dll"]), "--channel", "store");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("forbidden in a Store build: libusb0.dll");
    });

    it("--packaged with --channel website (and with no channel) checks the keep-list", () => {
      const app = tmp();
      const dest = path.join(app, "resources", "win", "libimobiledevice");
      mkdirSync(dest, { recursive: true });
      for (const f of STORE_KEEP) copyFileSync(path.join(TOOLS, f), path.join(dest, f));
      expect(cli("--packaged", app, "--channel", "website").status).toBe(0);
      expect(cli("--packaged", app).status).toBe(0);
      rmSync(path.join(dest, "usbmuxd.dll"));
      const r = cli("--packaged", app, "--channel", "website");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("missing pinned file: usbmuxd.dll");
    });

    it("--repo checks the full repo folder and reports 45", () => {
      const r = cli("--repo");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("PINNED IPHONE TOOLS: OK — 45 files");
    });

    it("refuses an unknown channel and --repo with a channel", () => {
      expect(cli("--dir", TOOLS, "--channel", "beta").status).toBe(2);
      expect(cli("--repo", "--channel", "store").status).toBe(2);
    });
  });

  describe("release.yml passes the channel to the packaged-tools check", () => {
    const RELEASE = readFileSync(path.join(REPO, ".github", "workflows", "release.yml"), "utf8");
    it("both --packaged checks carry --channel $env:KEEPR_CHANNEL, and the step sets it", () => {
      const lines = RELEASE.split("\n").filter((l) => l.includes("pinnedIphoneTools.js --packaged"));
      expect(lines).toHaveLength(2);
      for (const l of lines) expect(l).toContain("--channel $env:KEEPR_CHANNEL");
      const step = RELEASE.slice(RELEASE.indexOf("- name: Verify the pinned iPhone tools shipped byte-identical"));
      expect(step.slice(0, step.indexOf("run:"))).toContain(
        "KEEPR_CHANNEL: ${{ inputs.channel == 'store' && 'store' || 'website' }}"
      );
    });
  });

  describe("both installers delete what no build ships (over an earlier install)", () => {
    const nsh = readFileSync(path.join(REPO, "build", "installer.nsh"), "utf8");
    const deleted = [...nsh.matchAll(/^\s*Delete "\$INSTDIR\\resources\\win\\libimobiledevice\\([^"]+)"\s*$/gm)].map((m) => m[1]);

    it("customInstall's Delete list is exactly (files + companions) - store.files", () => {
      const expected = [...Object.keys(manifest.files), ...manifest.companions].filter((f) => !manifest.store.files.includes(f));
      expect(sorted(deleted)).toEqual(sorted(expected));
      expect(deleted.filter((f) => manifest.store.files.includes(f))).toEqual([]);
    });

    it("never names a file either channel ships (case-insensitive)", () => {
      const del = new Set(deleted.map((f) => f.toLowerCase()));
      for (const channel of ["website", "store"]) {
        const { files, companions } = pinned.expectedFor(manifest, channel);
        expect([...files, ...companions].filter((f: string) => del.has(f.toLowerCase()))).toEqual([]);
      }
    });
  });
});
