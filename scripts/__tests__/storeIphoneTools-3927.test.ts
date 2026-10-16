/**
 * BACKLOG-3927: the Microsoft Store build ships only the iPhone tools the app runs.
 *
 * resources/pinned/libimobiledevice.manifest.json lists every pinned file (`files`, the
 * website build's set, unchanged) and the Store subset (`store.files`). scripts/afterPack.js
 * selects the Store subset when electron-builder packages with
 * --config.extraMetadata.distributionChannel=store (release.yml's store run).
 *
 * The Store subset is not trusted as written: it must equal the tools the app spawns (the
 * getCommand("...") call sites) plus every DLL they load, read from the real PE import and
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
const SERVICES = path.join(REPO, "electron", "services");
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
      const { closure, missing } = importClosure(TOOLS, spawnedTools(SERVICES));
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

    it("goes red on the website set (README.md and the 34 unused files are extra)", () => {
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

    it("website (default and explicit): every pinned file and companion, byte-identical to the repo", () => {
      const all = sorted([...Object.keys(manifest.files), ...manifest.companions]);
      expect(sorted(readdirSync(TOOLS))).toEqual(all);
      for (const dest of [placed(), placed("website")]) {
        expect(sorted(readdirSync(dest))).toEqual(all);
        for (const f of all) expect(readFileSync(path.join(dest, f)).equals(readFileSync(path.join(TOOLS, f)))).toBe(true);
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

    it("an unmarked build places the full website set", () => {
      const r = runAfterPack({ extraMetadata: {} });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Placed 45 pinned iPhone tool files (sha256-verified)");
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

    it("--packaged with --channel website still checks the full set", () => {
      const app = tmp();
      const dest = path.join(app, "resources", "win", "libimobiledevice");
      mkdirSync(dest, { recursive: true });
      for (const f of STORE_KEEP) copyFileSync(path.join(TOOLS, f), path.join(dest, f));
      const r = cli("--packaged", app, "--channel", "website");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("missing pinned file: libusb0.dll");
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

  describe("the Store installer deletes what it does not ship (over a website install)", () => {
    it("customInstall's Delete list is exactly (files + companions) - store.files", () => {
      const nsh = readFileSync(path.join(REPO, "build", "installer.nsh"), "utf8");
      const deleted = [...nsh.matchAll(/^\s*Delete "\$INSTDIR\\resources\\win\\libimobiledevice\\([^"]+)"\s*$/gm)].map((m) => m[1]);
      const expected = [...Object.keys(manifest.files), ...manifest.companions].filter((f) => !manifest.store.files.includes(f));
      expect(sorted(deleted)).toEqual(sorted(expected));
      expect(deleted.filter((f) => manifest.store.files.includes(f))).toEqual([]);
    });
  });
});
