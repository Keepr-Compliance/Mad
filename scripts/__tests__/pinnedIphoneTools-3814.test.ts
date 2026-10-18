/**
 * BACKLOG-3814: the iPhone tool binaries ship byte-identical in every release.
 *
 * The committed folder must match the manifest exactly (no mismatch, no missing file, no
 * extra file); electron-builder must not copy the folder (its Windows extraResources copy
 * signs every .exe/.dll, which changes the bytes); afterPack must place and re-verify it.
 * BACKLOG-3689: the committed folder is checked with verifyRepo (all 45 + README.md); a
 * packaged folder with verifyDir (the 11 files every build ships).
 */
import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pinned = require("../release/pinnedIphoneTools");

const REPO = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO, "scripts", "release", "pinnedIphoneTools.js");
const TOOLS = path.join(REPO, "resources", "win", "libimobiledevice");

interface Manifest {
  schemaVersion: number;
  dir: string;
  packagedDir: string;
  companions: string[];
  files: Record<string, string>;
  store: { files: string[] };
}

const manifest: Manifest = pinned.loadManifest();
const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "pinned-3814-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** A copy of the committed folder, to break on purpose. */
function copyOfTools(): string {
  const d = tmp();
  for (const n of readdirSync(TOOLS)) copyFileSync(path.join(TOOLS, n), path.join(d, n));
  return d;
}

/** Size of the PE certificate table (IMAGE_DIRECTORY_ENTRY_SECURITY); 0 = unsigned. */
function certTableSize(file: string): number {
  const d = readFileSync(file);
  const pe = d.readUInt32LE(0x3c);
  if (d.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error(`not a PE file: ${file}`);
  const opt = pe + 24;
  const dataDirs = opt + (d.readUInt16LE(opt) === 0x20b ? 112 : 96);
  return d.readUInt32LE(dataDirs + 8 * 4 + 4);
}

describe("BACKLOG-3814 pinned iPhone tools", () => {
  describe("the committed folder", () => {
    it("matches the manifest exactly", () => {
      expect(pinned.verifyRepo(TOOLS, manifest)).toEqual([]);
    });

    it("pins all 45 tool files, each one already signed", () => {
      const names = Object.keys(manifest.files);
      expect(names).toHaveLength(45);
      expect(names.filter((n) => /\.exe$/i.test(n))).toHaveLength(23);
      expect(names.filter((n) => /\.dll$/i.test(n))).toHaveLength(22);
      const unsigned = names.filter((n) => certTableSize(path.join(TOOLS, n)) === 0);
      expect(unsigned).toEqual([]);
    });

    it("CLI --repo reports OK", () => {
      const r = spawnSync(process.execPath, [SCRIPT, "--repo"], { encoding: "utf8" });
      expect(r.stdout).toContain("PINNED IPHONE TOOLS: OK — 45 files");
      expect(r.status).toBe(0);
    });
  });

  describe("verifyRepo goes red", () => {
    it("on a changed byte (what a re-sign does)", () => {
      const d = copyOfTools();
      const f = path.join(d, "ideviceinfo.exe");
      const b = readFileSync(f);
      b[b.length - 1] ^= 0xff;
      writeFileSync(f, b);
      expect(pinned.verifyRepo(d, manifest)).toEqual([
        expect.stringMatching(/^sha256 mismatch: ideviceinfo\.exe is [0-9a-f]{64}, manifest pins /),
      ]);
    });

    it("on a missing pinned file", () => {
      const d = copyOfTools();
      rmSync(path.join(d, "plist.dll"));
      expect(pinned.verifyRepo(d, manifest)).toEqual(["missing pinned file: plist.dll"]);
    });

    it("on an extra file", () => {
      const d = copyOfTools();
      writeFileSync(path.join(d, "iproxy.exe"), "MZ");
      expect(pinned.verifyRepo(d, manifest)).toEqual(["extra file not in manifest: iproxy.exe"]);
    });

    it("on a renamed file (missing AND extra)", () => {
      const d = copyOfTools();
      renameSync(path.join(d, "idevice_id.exe"), path.join(d, "idevice_id.old.exe"));
      expect(pinned.verifyRepo(d, manifest)).toEqual([
        "extra file not in manifest: idevice_id.old.exe",
        "missing pinned file: idevice_id.exe",
      ]);
    });

    it("on a subfolder", () => {
      const d = copyOfTools();
      mkdirSync(path.join(d, "nested"));
      expect(pinned.verifyRepo(d, manifest)).toEqual(["not a regular file: nested"]);
    });

    it("on a missing companion", () => {
      const d = copyOfTools();
      rmSync(path.join(d, "README.md"));
      expect(pinned.verifyRepo(d, manifest)).toEqual(["missing companion file: README.md"]);
    });

    it("on a folder that does not exist", () => {
      const problems = pinned.verifyRepo(path.join(tmp(), "absent"), manifest);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^folder not readable: .*ENOENT/);
    });

    it("CLI exits 1 and names the problem", () => {
      const d = copyOfTools();
      // --dir checks the shipped set, so the full repo copy also reports its 35 unused files.
      writeFileSync(path.join(d, "extra.dll"), "");
      const r = spawnSync(process.execPath, [SCRIPT, "--dir", d], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("extra file not in manifest: extra.dll");
    });

    it("a manifest with a malformed hash is refused", () => {
      const d = tmp();
      const p = path.join(d, "m.json");
      writeFileSync(p, JSON.stringify({ ...manifest, files: { ...manifest.files, "plist.dll": "abc" } }));
      expect(() => pinned.loadManifest(p)).toThrow("manifest sha256 for plist.dll is not 64 hex characters");
    });
  });

  describe("placePinnedTools (afterPack)", () => {
    const quiet = () => undefined;

    it("copies the set into <resources>/win/libimobiledevice and it verifies", () => {
      const resources = tmp();
      const dest = pinned.placePinnedTools(resources, { manifest, log: quiet });
      expect(dest).toBe(path.join(resources, "win", "libimobiledevice"));
      expect(pinned.verifyDir(dest, manifest)).toEqual([]);
      expect(readdirSync(dest).sort()).toEqual([...manifest.store.files].sort());
    });

    it("refuses when electron-builder already copied the folder (exclusion lost)", () => {
      const resources = tmp();
      mkdirSync(path.join(resources, "win", "libimobiledevice"), { recursive: true });
      expect(() => pinned.placePinnedTools(resources, { manifest, log: quiet })).toThrow(
        /already exists before afterPack placed it/
      );
    });

    it("refuses a tampered source and writes nothing", () => {
      const src = copyOfTools();
      writeFileSync(path.join(src, "zip.dll"), "not the pinned bytes");
      const resources = tmp();
      expect(() => pinned.placePinnedTools(resources, { sourceDir: src, manifest, log: quiet })).toThrow(
        /sha256 mismatch: zip\.dll/
      );
      expect(existsSync(path.join(resources, "win"))).toBe(false);
    });

    it("re-checks the copy it made (a corrupted copy fails)", () => {
      const resources = tmp();
      const copyFile = (from: string, to: string) => {
        copyFileSync(from, to);
        if (path.basename(to) === "plist.dll") writeFileSync(to, "corrupted in transit");
      };
      expect(() => pinned.placePinnedTools(resources, { manifest, log: quiet, copyFile })).toThrow(
        /packaged .*\n  sha256 mismatch: plist\.dll/
      );
    });

    it("CLI --packaged reads win-unpacked/resources and Keepr.app/Contents/Resources", () => {
      const win = tmp();
      pinned.placePinnedTools(path.join(win, "resources"), { manifest, log: quiet });
      const mac = path.join(tmp(), "Keepr.app");
      pinned.placePinnedTools(path.join(mac, "Contents", "Resources"), { manifest, log: quiet });
      for (const appDir of [win, mac]) {
        const r = spawnSync(process.execPath, [SCRIPT, "--packaged", appDir], { encoding: "utf8" });
        expect(r.stdout).toContain("PINNED IPHONE TOOLS: OK");
        expect(r.status).toBe(0);
      }
    });
  });

  describe("electron-builder never copies the folder itself", () => {
    // Runs electron-builder's own extraResources matcher over the real resources/win folder,
    // with the real package.json config. Any file it accepts would be copied through
    // createTransformerForExtraFiles, which signs every .exe/.dll on Windows.
    async function filesElectronBuilderCopies(): Promise<string[]> {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getFileMatchers } = require("app-builder-lib/out/fileMatcher");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { walk } = require("builder-util");
      const config = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).build;
      const matchers = getFileMatchers(config, "extraResources", "/out/resources", {
        defaultSrc: REPO,
        macroExpander: (s: string) => s,
        customBuildOptions: config.win,
        globalOutDir: path.join(REPO, "release"),
      });
      const winMatcher = matchers.find((m: { from: string }) => m.from === path.join(REPO, "resources", "win"));
      expect(winMatcher).toBeDefined();
      const files: string[] = await walk(winMatcher.from, winMatcher.createFilter());
      return files.map((f) => path.relative(winMatcher.from, f).split(path.sep).join("/"));
    }

    it("the resources/win extraResources entry copies nothing from libimobiledevice", async () => {
      const copied = await filesElectronBuilderCopies();
      expect(copied.filter((f) => f.startsWith("libimobiledevice"))).toEqual([]);
      // ...and still copies the rest of the folder (the filter did not switch the entry off).
      expect(copied).toContain("README.md");
    });

    it("the real afterPack hook places and verifies the folder", () => {
      // Runs scripts/afterPack.js in a plain node child (jest maps @electron/* to electron/),
      // with only @electron/fuses stubbed so no Electron binary is needed.
      const appOutDir = tmp();
      mkdirSync(path.join(appOutDir, "resources"));
      const harness = `
        const Module = require("module");
        const load = Module._load;
        let flips = 0;
        Module._load = function (req, ...rest) {
          if (req === "@electron/fuses") return { flipFuses: async () => { flips++; }, FuseVersion: {}, FuseV1Options: {} };
          return load.call(this, req, ...rest);
        };
        const afterPack = require(${JSON.stringify(path.join(REPO, "scripts", "afterPack.js"))});
        afterPack({
          appOutDir: ${JSON.stringify(appOutDir)},
          electronPlatformName: "win32",
          packager: { appInfo: { productFilename: "Keepr" }, getResourcesDir: (d) => require("path").join(d, "resources") },
        }).then(() => console.log("FLIPS=" + flips), (e) => { console.error(e.message); process.exit(1); });
      `;
      const r = spawnSync(process.execPath, ["-e", harness], { encoding: "utf8", env: { ...process.env, CI: "" } });
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("Placed 11 pinned iPhone tool files");
      expect(r.stdout).toContain("FLIPS=1");
      expect(r.status).toBe(0);
      expect(pinned.verifyDir(path.join(appOutDir, "resources", "win", "libimobiledevice"), manifest)).toEqual([]);
    });
  });
});
